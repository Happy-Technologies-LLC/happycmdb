// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 operator rotation (v16 §1.1, N-21 (c)/(e)/(f)/(g)/(h)) and the
 * signed COR16-1 acceptance: an absent decision plus intent age is never a
 * NOT_APPLIED outcome. A rotation stays PENDING until a per-event Neo4j
 * decision node has been observed. A committed `cancelled` decision fences
 * any later apply of that event, including a writer that was delayed or that
 * lost its PostgreSQL advisory-lock session while still alive.
 *
 * PostgreSQL is PGlite with the api_keys table from 001_complete_schema.sql
 * and migration 020_auth_credential_events.sql applied verbatim, so the
 * audit-table CHECKs, the one-outcome index and the append-only trigger are
 * real. Neo4j is an in-memory model of the exported statements: guards are
 * evaluated before any mutation, and the CredentialRotationDecision.eventId
 * uniqueness constraint makes a second create for the same event fail with
 * no writes. The statements themselves, and real transaction blocking, run
 * against Neo4j 5.15 in
 * tests/integration/database/credential-rotation.integration.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import neo4j from 'neo4j-driver';
import { join } from 'path';

import {
  APPLY_CYPHER, CANCEL_CYPHER, DECISION_CONSTRAINT_PRESENT_CYPHER, DECISION_CYPHER, HOLDERS_CYPHER, IDENTITY_CYPHER,
  applyRotation, prepareRotation, reconcileRotations, rotateUserPassword, RotationRefused,
  type RotationDeps, type RotationGraph, type RotationLock, type RotationSql,
} from '../rotate-user-password';

// ---------------------------------------------------------------------------
// PostgreSQL: PGlite in a child process (fixtures/pglite-host.cjs)
// ---------------------------------------------------------------------------

const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error & { code?: string }) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: rows => resolve(rows as Array<Record<string, unknown>>), reject });
    host.send({ id, op, sql, params });
  });
}
const sql: RotationSql = {
  query: async (text, params = []) => {
    const rows = await send('query', text, params);
    return { rows, rowCount: rows.length };
  },
  transaction: async callback => {
    await send('exec', 'BEGIN');
    try {
      const result = await callback({
        query: async (text, params = []) => {
          // RETURNING keeps row counts observable through PGlite's IPC hop.
          const rows = await send('query', text, params);
          return { rows, rowCount: rows.length };
        },
      });
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
};

const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');
function apiKeysTable(): string {
  const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS api_keys (');
  return schema.slice(start, schema.indexOf(');', start) + 2);
}

beforeAll(async () => {
  await send('exec', apiKeysTable());
  await send('exec', readFileSync(join(MIGRATIONS, '020_auth_credential_events.sql'), 'utf8'));
});
afterAll(() => {
  host.kill();
});

// ---------------------------------------------------------------------------
// Neo4j: in-memory model of the exported statements
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
type Node = { elementId: string; props: Props };
type Decision = { eventId: string; outcome: 'applied' | 'cancelled'; reason?: string; targetEpoch?: unknown };
type Fault = 'down' | 'lost-ack' | 'server-abort';
const norm = (cypher: string) => cypher.replace(/\s+/g, ' ').trim();
const num = (value: unknown) => (neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value));

class ConstraintValidationFailed extends Error {
  code = 'Neo.ClientError.Schema.ConstraintValidationFailed';
}

class FakeGraph implements RotationGraph {
  users: Node[] = [];
  decisions = new Map<string, Decision>();
  constraint = true;
  /** One-shot fault on the next write, or a permanent outage. */
  fault?: Fault;
  down = false;
  applyParams: Props[] = [];

  async read(cypher: string, params: Props): Promise<Props[]> {
    if (this.down) throw new Error('ServiceUnavailable');
    const q = norm(cypher);
    if (q === norm(DECISION_CONSTRAINT_PRESENT_CYPHER)) return this.constraint ? [{ present: true }] : [];
    if (q === norm(IDENTITY_CYPHER)) {
      return this.match(params['id']).map(u => ({
        eid: u.elementId, _id: u.props['_id'] ?? null, id: u.props['id'] ?? null,
        e0: neo4j.int(Math.trunc(num(u.props['credentialEpoch'] ?? 0))),
      }));
    }
    if (q === norm(HOLDERS_CYPHER)) return [{ holders: neo4j.int(this.holders(params['keys'] as unknown[])) }];
    if (q === norm(DECISION_CYPHER)) {
      const d = this.decisions.get(params['eventId'] as string);
      return d ? [{ outcome: d.outcome, reason: d.reason ?? null, targetEpoch: d.targetEpoch ?? null }] : [];
    }
    throw new Error(`unexpected read: ${q}`);
  }

  async write(cypher: string, params: Props): Promise<Props[]> {
    if (this.down) throw new Error('ServiceUnavailable');
    const fault = this.fault;
    this.fault = undefined;
    if (fault === 'server-abort') throw new Error('Neo.ClientError.Transaction.TransactionTimedOut');
    const rows = this.execute(norm(cypher), params);
    if (fault === 'lost-ack') throw new Error('connection reset after COMMIT was sent');
    return rows;
  }

  private match(id: unknown): Node[] {
    return this.users.filter(u => u.props['_id'] === id || u.props['id'] === id);
  }
  private holders(keys: unknown[]): number {
    return this.users.filter(u => keys.includes(u.props['_id']) || keys.includes(u.props['id'])).length;
  }

  /** Atomic: either every write of the statement lands or none does. */
  private execute(q: string, params: Props): Props[] {
    if (q === norm(APPLY_CYPHER)) {
      this.applyParams.push(params);
      const u = this.users.find(n => n.elementId === params['eid']);
      const holders = this.holders(params['keys'] as unknown[]);
      const guardsHold = u !== undefined
        && (u.props['_id'] === params['id'] || u.props['id'] === params['id'])
        && num(u.props['credentialEpoch'] ?? 0) === num(params['e0'])
        && holders === 1;
      if (!guardsHold) return [{ n: neo4j.int(0) }];
      if (this.decisions.has(params['eventId'] as string)) throw new ConstraintValidationFailed('decision exists');
      Object.assign(u!.props, {
        passwordHash: params['newHash'], _passwordHash: params['newHash'], defaultPasswordSuspect: false,
        credentialEpoch: params['targetEpoch'],
      });
      delete u!.props['_defaultPasswordSuspect'];
      this.decisions.set(params['eventId'] as string, {
        eventId: params['eventId'] as string, outcome: 'applied', targetEpoch: params['targetEpoch'],
      });
      return [{ n: neo4j.int(1) }];
    }
    if (q === norm(CANCEL_CYPHER)) {
      if (this.decisions.has(params['eventId'] as string)) throw new ConstraintValidationFailed('decision exists');
      this.decisions.set(params['eventId'] as string, {
        eventId: params['eventId'] as string, outcome: 'cancelled', reason: params['reason'] as string,
      });
      return [];
    }
    throw new Error(`unexpected write: ${q}`);
  }
}

class FakeLock implements RotationLock {
  held = false;
  async acquire(): Promise<void> {
    if (this.held) throw new Error('lock held by another session');
    this.held = true;
  }
  async release(): Promise<void> {
    this.held = false;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEW_PASSWORD = 'operator-rotated-16';
let graph: FakeGraph;
let lock: FakeLock;
let deps: RotationDeps;
let defaultHash: string;

const input = (userId = 'user-m') => ({ userId, operator: 'nick', password: NEW_PASSWORD });

async function events(): Promise<Array<Record<string, unknown>>> {
  return send('query', 'SELECT event, user_id, ref_event_id, target_epoch, revoked_api_keys, reason FROM auth_credential_events ORDER BY occurred_at, id');
}
async function keys(): Promise<Array<Record<string, unknown>>> {
  return send('query', 'SELECT name, enabled, credential_epoch FROM api_keys ORDER BY name');
}
async function addKey(name: string, userId: string, epoch: number): Promise<void> {
  await send('query', `INSERT INTO api_keys (user_id, key_hash, name, role, credential_epoch) VALUES ($1, $2, $3, 'admin', $4)`,
    [userId, `${name}-hash`.padEnd(64, '0'), name, epoch]);
}
function userM(): Node {
  return graph.users.find(u => u.props['_id'] === 'user-m')!;
}

beforeAll(async () => {
  defaultHash = await bcrypt.hash('Admin123!', 4);
});

beforeEach(async () => {
  // A fresh table per case: DELETE is refused by the append-only trigger, TRUNCATE too.
  await send('exec', 'DROP TABLE IF EXISTS auth_credential_events CASCADE; DROP TABLE IF EXISTS api_keys CASCADE;');
  await send('exec', apiKeysTable());
  await send('exec', readFileSync(join(MIGRATIONS, '020_auth_credential_events.sql'), 'utf8'));
  graph = new FakeGraph();
  lock = new FakeLock();
  graph.users = [
    { elementId: '4:m', props: { _id: 'user-m', _username: 'm', _passwordHash: defaultHash, defaultPasswordSuspect: true } },
    { elementId: '4:u', props: { id: 'user-u', username: 'u', passwordHash: defaultHash } },
  ];
  await addKey('m-pre', 'user-m', 0);
  deps = {
    graph, sql, lock,
    hash: password => bcrypt.hash(password, 4),
    compare: (password, hash) => bcrypt.compare(password, hash),
  };
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('N-21 (c) operator rotation, happy path', () => {
  it('writes intent → applied decision → APPLIED outcome, clears the marker and bumps the generation as INTEGER', async () => {
    const result = await rotateUserPassword(input(), deps);

    expect(result).toMatchObject({ outcome: 'APPLIED', revokedApiKeys: 1 });
    expect(await events()).toEqual([
      expect.objectContaining({ event: 'password_rotation_intent', user_id: 'user-m', target_epoch: 1, ref_event_id: null }),
      expect.objectContaining({ event: 'password_rotated_operator', ref_event_id: result.eventId, revoked_api_keys: 1 }),
    ]);
    expect(userM().props).toMatchObject({ defaultPasswordSuspect: false });
    expect(userM().props).not.toHaveProperty('_defaultPasswordSuspect');
    expect(neo4j.isInt(userM().props['credentialEpoch'])).toBe(true); // SEC16-03: never a Float
    expect(num(userM().props['credentialEpoch'])).toBe(1);
    expect(await bcrypt.compare(NEW_PASSWORD, userM().props['_passwordHash'] as string)).toBe(true);
    expect(graph.decisions.get(result.eventId)).toMatchObject({ outcome: 'applied' });
    expect(await keys()).toEqual([{ name: 'm-pre', enabled: false, credential_epoch: 0 }]);
    expect(lock.held).toBe(false);
  });

  it('repairs a Float generation left by an out-of-band write (SEC16-03)', async () => {
    userM().props['credentialEpoch'] = 1.0;

    await rotateUserPassword(input(), deps);

    expect(neo4j.isInt(userM().props['credentialEpoch'])).toBe(true);
    expect(num(userM().props['credentialEpoch'])).toBe(2);
  });
});

describe('N-21 (e) refusals write nothing anywhere', () => {
  it.each([
    ['the default', 'Admin123!'],
    ['a bcrypt-equivalent of the default', 'Admin123!\u0000'.repeat(8).slice(0, 72)],
    ['a NUL', 'long-enough-pass\u0000x'],
    ['more than 72 UTF-8 bytes', 'é'.repeat(37)],
    ['fewer than 12 characters', 'short-pass1'],
  ])('%s', async (_label, password) => {
    await expect(rotateUserPassword({ ...input(), password }, deps)).rejects.toBeInstanceOf(RotationRefused);

    expect(await events()).toEqual([]);
    expect(graph.applyParams).toEqual([]);
    expect(lock.held).toBe(false);
  });

  it('an unknown user id', async () => {
    await expect(rotateUserPassword(input('ghost'), deps)).rejects.toMatchObject({ reason: 'unknown_identity' });
    expect(await events()).toEqual([]);
  });

  it('a missing decision constraint (the fence would not be safe)', async () => {
    graph.constraint = false;

    await expect(rotateUserPassword(input(), deps)).rejects.toMatchObject({ reason: 'decision_constraint_missing' });
    expect(await events()).toEqual([]);
  });
});

describe('N-21 (f) multiple and colliding identities (COR15-3)', () => {
  it.each([
    ['two nodes with the same _id', { _id: 'user-m' }, 'ambiguous_identity'],
    ['another node whose id equals this _id', { id: 'user-m' }, 'ambiguous_identity'],
    ['another node resolvable by this node\'s second identifier', { id: 'user-m-legacy' }, 'identity_collision'],
  ])('%s → refused before any intent, no node changes', async (_label, other, reason) => {
    userM().props['id'] = 'user-m-legacy';
    graph.users.push({ elementId: '4:x', props: { ...other, passwordHash: defaultHash } });
    const before = JSON.stringify(graph.users);

    await expect(rotateUserPassword(input(), deps)).rejects.toMatchObject({ reason });

    expect(await events()).toEqual([]);
    expect(JSON.stringify(graph.users)).toBe(before);
  });

  it('a collision appearing between precheck and apply → zero writes, NOT_APPLIED guard_failed', async () => {
    await lock.acquire();
    const prepared = await prepareRotation(input(), deps);
    graph.users.push({ elementId: '4:x', props: { id: 'user-m' } });
    const before = JSON.stringify(graph.users);

    const result = await applyRotation(prepared, deps);

    expect(result).toMatchObject({ outcome: 'NOT_APPLIED', reason: 'guard_failed' });
    expect(JSON.stringify(graph.users)).toBe(before);
    expect(graph.decisions.get(prepared.eventId)).toMatchObject({ outcome: 'cancelled', reason: 'guard_failed' });
  });
});

describe('N-21 (g) uncertain commits are decided by the decision fence, never by time (COR15-1, COR16-1)', () => {
  it('(g1) lost commit acknowledgement after the server applied → APPLIED with key revocation', async () => {
    graph.fault = 'lost-ack';

    const result = await rotateUserPassword(input(), deps);

    expect(result).toMatchObject({ outcome: 'APPLIED', revokedApiKeys: 1 });
    expect(await keys()).toEqual([expect.objectContaining({ name: 'm-pre', enabled: false })]);
  });

  it('(g2) Neo4j unreachable after an applied commit → PENDING with no outcome; reconcile later records APPLIED', async () => {
    const write = graph.write.bind(graph);
    graph.write = async (cypher, params) => {
      const rows = await write(cypher, params);
      graph.down = true;
      throw new Error(`connection lost: ${rows.length}`);
    };

    const result = await rotateUserPassword(input(), deps);

    expect(result.outcome).toBe('PENDING');
    expect((await events()).map(e => e['event'])).toEqual(['password_rotation_intent']);

    graph.down = false;
    graph.write = write;
    const reconciled = await reconcileRotations(deps, 'operator:nick');

    expect(reconciled.resolved).toEqual([expect.objectContaining({ eventId: result.eventId, outcome: 'APPLIED', revokedApiKeys: 1 })]);
    expect(reconciled.pending).toEqual([]);
  });

  it('(g3) server-side abort → the cancel commits → NOT_APPLIED fenced, user unchanged', async () => {
    graph.fault = 'server-abort';
    const before = JSON.stringify(userM().props);

    const result = await rotateUserPassword(input(), deps);

    expect(result).toMatchObject({ outcome: 'NOT_APPLIED', reason: 'fenced' });
    expect(JSON.stringify(userM().props)).toBe(before);
  });

  it('(g4) delayed admission: the writer is suspended after its intent; reconcile fences it; the late apply cannot land', async () => {
    await lock.acquire();
    const prepared = await prepareRotation(input(), deps);
    await lock.release(); // the writer's session is gone; the process is merely suspended
    const before = JSON.stringify(userM().props);

    const reconciled = await reconcileRotations(deps, 'operator:nick');
    expect(reconciled.resolved).toEqual([expect.objectContaining({ eventId: prepared.eventId, outcome: 'NOT_APPLIED', reason: 'fenced' })]);

    const late = await applyRotation(prepared, deps); // the writer resumes

    expect(late).toMatchObject({ outcome: 'NOT_APPLIED', reason: 'fenced' });
    expect(JSON.stringify(userM().props)).toBe(before);
    expect((await events()).map(e => e['event'])).toEqual(['password_rotation_intent', 'password_rotation_not_applied']);
  });

  it('(g5) PG lock-session loss with the writer alive, writer commits first → reconcile records APPLIED; the writer adds no second outcome', async () => {
    await lock.acquire();
    const prepared = await prepareRotation(input(), deps);
    // The writer's apply commits, then its lock connection is terminated before it records the outcome.
    const write = graph.write.bind(graph);
    let resumeWriter!: () => void;
    const writerResumed = new Promise<void>(resolve => (resumeWriter = resolve));
    graph.write = async (cypher, params) => {
      const rows = await write(cypher, params);
      graph.write = write;
      await lock.release();
      await writerResumed;
      return rows;
    };
    const writer = applyRotation(prepared, deps);
    await new Promise(resolve => setImmediate(resolve));

    const reconciled = await reconcileRotations(deps, 'operator:nick');
    resumeWriter();
    const writerResult = await writer;

    expect(reconciled.resolved).toEqual([expect.objectContaining({ eventId: prepared.eventId, outcome: 'APPLIED', revokedApiKeys: 1 })]);
    expect(writerResult).toMatchObject({ outcome: 'APPLIED' });
    expect((await events()).map(e => e['event'])).toEqual(['password_rotation_intent', 'password_rotated_operator']);
  });

  it('(g5) PG lock-session loss with the writer alive, reconcile fences first → the writer\'s apply fails with zero writes', async () => {
    await lock.acquire();
    const prepared = await prepareRotation(input(), deps);
    await lock.release();
    const before = JSON.stringify(userM().props);

    await reconcileRotations(deps, 'operator:nick');
    const writerResult = await applyRotation(prepared, deps);

    expect(writerResult).toMatchObject({ outcome: 'NOT_APPLIED', reason: 'fenced' });
    expect(JSON.stringify(userM().props)).toBe(before);
    expect(await keys()).toEqual([expect.objectContaining({ name: 'm-pre', enabled: true })]);
  });

  it('an absent decision is never NOT_APPLIED while Neo4j cannot be written, however old the intent', async () => {
    await lock.acquire();
    const prepared = await prepareRotation(input(), deps);
    await lock.release();
    await send('exec', 'ALTER TABLE auth_credential_events DISABLE TRIGGER USER');
    await send('query', `UPDATE auth_credential_events SET occurred_at = now() - interval '30 days' WHERE id = $1`, [prepared.eventId]);
    await send('exec', 'ALTER TABLE auth_credential_events ENABLE TRIGGER USER');
    graph.write = async () => { throw new Error('ServiceUnavailable'); };

    const reconciled = await reconcileRotations(deps, 'operator:nick');

    expect(reconciled).toEqual({ resolved: [], pending: [prepared.eventId] });
    expect((await events()).map(e => e['event'])).toEqual(['password_rotation_intent']);
  });
});

describe('N-21 (h) evidence survives later operations (COR15-2, SEC15-05)', () => {
  async function appliedWithoutOutcome(): Promise<string> {
    await lock.acquire();
    const prepared = await prepareRotation(input(), deps);
    await graph.write(APPLY_CYPHER, prepared.applyParams);
    await lock.release(); // killed before its PG outcome
    return prepared.eventId;
  }

  it('(h1) an open intent blocks any further rotation, writing nothing', async () => {
    await appliedWithoutOutcome();

    await expect(rotateUserPassword(input('user-u'), deps)).rejects.toMatchObject({ reason: 'open_intent' });
    expect((await events()).filter(e => e['event'] === 'password_rotation_intent')).toHaveLength(1);
  });

  it('(h2) the user is deleted before reconcile: the decision survives → APPLIED with zero revoked keys', async () => {
    const eventId = await appliedWithoutOutcome();
    graph.users = graph.users.filter(u => u.props['_id'] !== 'user-m');
    await send('exec', "DELETE FROM api_keys WHERE user_id = 'user-m'");

    const reconciled = await reconcileRotations(deps, 'operator:nick');

    expect(reconciled.resolved).toEqual([expect.objectContaining({ eventId, outcome: 'APPLIED', revokedApiKeys: 0 })]);
  });

  it('(h3) a late reconcile revokes only pre-rotation keys', async () => {
    await appliedWithoutOutcome();
    await addKey('m-post', 'user-m', 1);

    await reconcileRotations(deps, 'operator:nick');

    expect(await keys()).toEqual([
      { name: 'm-post', enabled: true, credential_epoch: 1 },
      { name: 'm-pre', enabled: false, credential_epoch: 0 },
    ]);
  });

  it('a second reconcile writes nothing', async () => {
    await appliedWithoutOutcome();
    await reconcileRotations(deps, 'operator:nick');
    const after = await events();

    expect(await reconcileRotations(deps, 'operator:nick')).toEqual({ resolved: [], pending: [] });
    expect(await events()).toEqual(after);
  });
});

describe('auth_credential_events is append-only with one outcome per intent', () => {
  it('refuses UPDATE, DELETE, TRUNCATE, a second outcome and a not_applied reason outside the fence vocabulary', async () => {
    const result = await rotateUserPassword(input(), deps);

    await expect(send('exec', "UPDATE auth_credential_events SET actor = 'x'")).rejects.toThrow();
    await expect(send('exec', 'DELETE FROM auth_credential_events')).rejects.toThrow();
    await expect(send('exec', 'TRUNCATE auth_credential_events')).rejects.toThrow();
    await expect(send('query', `INSERT INTO auth_credential_events (user_id, event, ref_event_id, reason, actor)
      VALUES ('user-m', 'password_rotation_not_applied', $1, 'fenced', 'x')`, [result.eventId])).rejects.toMatchObject({ code: '23505' });
    for (const reason of ['error', 'crash_before_apply', 'verified_absent']) {
      await expect(send('query', `INSERT INTO auth_credential_events (user_id, event, ref_event_id, reason, actor)
        VALUES ('user-m', 'password_rotation_not_applied', gen_random_uuid(), $1, 'x')`, [reason])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('M-8/M-12: no PUBLIC privilege; existing keys read generation 0; shape CHECKs reject intents without a target and outcomes without a ref', async () => {
    expect(await send('query', "SELECT has_table_privilege('public', 'auth_credential_events', 'SELECT') AS p")).toEqual([{ p: false }]);
    expect(await keys()).toEqual([{ name: 'm-pre', enabled: true, credential_epoch: 0 }]);
    await expect(send('query', `INSERT INTO auth_credential_events (user_id, event, actor)
      VALUES ('user-m', 'password_rotation_intent', 'x')`)).rejects.toMatchObject({ code: '23514' });
    await expect(send('query', `INSERT INTO auth_credential_events (user_id, event, revoked_api_keys, actor)
      VALUES ('user-m', 'password_rotated_operator', 0, 'x')`)).rejects.toMatchObject({ code: '23514' });
    await expect(send('query', `INSERT INTO auth_credential_events (user_id, event, actor)
      VALUES ('user-m', 'default_marker_cleared_login', 'x')`)).rejects.toMatchObject({ code: '23514' });
  });
});
