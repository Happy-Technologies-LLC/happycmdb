// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 against real Neo4j 5.15 and PostgreSQL 15 (CI Testcontainers; all
 * migrations including 020 applied by the global setup):
 *
 * COR16-1 acceptance (signed founder ruling exchange/approvals/cmdb-hp1-slices.go):
 * - delayed Neo4j writer: an intent whose writer is suspended is fenced by
 *   reconcile; the late apply fails on the decision uniqueness with zero writes;
 * - PostgreSQL advisory-lock session loss while the writer is still alive:
 *   the writer's lock connection is terminated mid-transaction, reconcile
 *   takes the lock, and its cancel blocks on the uncommitted decision until
 *   the writer's transaction ends. Whichever commits first is the recorded
 *   outcome, in both orders.
 * - an absent decision plus intent age is never NOT_APPLIED.
 *
 * Also the real statements behind the unit models: the guarded self-service
 * password write and disable (SEC16-01), the transition-only marker setter
 * (SEC16-04) and the INTEGER generation (SEC16-03).
 *
 * FULL review 6061922930 remediation, proven on these real stores:
 * - MEDIUM 1: a default-password verification made before a rotation never
 *   marks the rotated account (real Neo4jAuthRepository and the window scan);
 * - MEDIUM 2: guarded writes take the node lock before their guards. Each
 *   write is run while a rotation transaction holds the node; the pre-fix
 *   statement form is run the same way as the contrast, and does land;
 * - MEDIUM 3: an existing database without the decision constraint refuses
 *   rotation until neo4j migration 002 (or --prepare) creates it;
 * - LOW 4: two operators that both lost their lock sessions cannot both open
 *   an intent.
 *
 * Operator FULL pair (b2eec4e) N-21 acceptance on these real stores:
 * - (h4) reconcile started while a rotation holds the operator lock never
 *   writes an outcome for the live intent (try-lock: exit 6, see PR body
 *   deviation from v16's blocking pg_advisory_lock);
 * - SEC13-02: the seed inventory returns pre-provenance seeds written with
 *   either property spelling and with overrides; stamp never overwrites
 *   provenance and leaves --except ids alone.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import * as bcrypt from 'bcrypt';
import { readFileSync } from 'fs';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { join } from 'path';
import { Pool } from 'pg';

import {
  APPLY_CYPHER, DECISION_CONSTRAINT_CYPHER, applyRotation, prepareDecisionConstraint, prepareRotation, reconcileRotations,
  rotateUserPassword, type RotationDeps, type RotationSqlQuery,
} from '../../../packages/api-server/src/scripts/rotate-user-password';
import {
  GRANT_IDENTITY_CYPHER, GRANT_PORTFOLIO_IMPORT_SCOPE_CYPHER, REVOKE_PORTFOLIO_IMPORT_SCOPE_CYPHER,
  assignOrganization, grantPlatformAdmin, grantPortfolioImportScope, inventorySeedAccounts, main as identityWindowCli,
  revokePortfolioImportScope, scanDefaultPasswords, stampSeedAccounts,
} from '../../../packages/api-server/src/scripts/identity-window';
import { PORTFOLIO_IMPORT_SCOPE, holdsScope } from '../../../packages/api-server/src/auth/scopes';
import { LockBusyError, openOperatorStores, type OperatorStores } from '../../../packages/api-server/src/scripts/operator-stores';
import { main as rotationCli, type RotationGraph } from '../../../packages/api-server/src/scripts/rotate-user-password';
import { isPlatformAdmin, isSeededAccount } from '../../../packages/api-server/src/auth/platform-admin';
import {
  GUARDED_DISABLE_CYPHER, GUARDED_PASSWORD_CYPHER, GUARDED_REHASH_CYPHER, MARK_DEFAULT_SUSPECT_CYPHER, Neo4jAuthRepository,
} from '../../../packages/api-server/src/auth/neo4j-auth.repository';

const USER = 'hp1-s6-rotation-user';
const NEW_PASSWORD = 'operator-rotated-16';
const MARKED = '(coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false))';

/** GUARDED_PASSWORD_CYPHER as reviewed at 822b479: guards in MATCH ... WHERE, evaluated before the SET takes the lock. */
const PRE_FIX_GUARDED_PASSWORD_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $elementId AND (u._id = $userId OR u.id = $userId)
  AND coalesce(u.credentialEpoch, 0) = $credentialEpoch
  AND NOT ${MARKED}
  AND coalesce(u._passwordHash, u.passwordHash) = $readHash
SET u._passwordHash = $newHash, u.passwordHash = $newHash, u._updatedAt = datetime(), u.updatedAt = datetime()
RETURN count(u) AS n`;

let driver: Driver;
let graph: Session;
let pool: Pool;
let defaultHash: string;
const stores: OperatorStores[] = [];

function operatorEnv(): NodeJS.ProcessEnv {
  return {
    CMDB_ROTATE_POSTGRES_HOST: process.env['POSTGRES_HOST'], CMDB_ROTATE_POSTGRES_PORT: process.env['POSTGRES_PORT'],
    CMDB_ROTATE_POSTGRES_DB: process.env['POSTGRES_DB'], CMDB_ROTATE_POSTGRES_USER: process.env['POSTGRES_USER'],
    CMDB_ROTATE_POSTGRES_PASSWORD: process.env['POSTGRES_PASSWORD'], CMDB_ROTATE_NEO4J_URI: process.env['NEO4J_URI'],
    CMDB_ROTATE_NEO4J_USERNAME: process.env['NEO4J_USERNAME'], CMDB_ROTATE_NEO4J_PASSWORD: process.env['NEO4J_PASSWORD'],
  };
}

/**
 * Resolves once Neo4j lists a transaction blocked on another one. Polling a
 * server-side condition: there is no client event for "now waiting on a lock".
 */
async function untilBlocked(what = 'reconcile cancel'): Promise<void> {
  const monitor = driver.session();
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await monitor.run("SHOW TRANSACTIONS YIELD status WHERE status STARTS WITH 'Blocked' RETURN count(*) AS n");
      if (neo4j.integer.toNumber(result.records[0]!.get('n')) > 0) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`${what} never blocked on the open transaction`);
  } finally {
    await monitor.close();
  }
}

/** Resolves once a PostgreSQL backend waits on an advisory lock. */
async function untilAdvisoryWait(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'"
    );
    if (rows[0].n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('the second operator never waited on the intent lock');
}

/** One operator process: its own store connections and advisory-lock session. */
function operator(): RotationDeps {
  const opened = openOperatorStores(operatorEnv());
  stores.push(opened);
  return {
    graph: opened.graph, sql: opened.sql, lock: opened.lock,
    hash: password => bcrypt.hash(password, 4),
    compare: (password, hash) => bcrypt.compare(password, hash),
  };
}

async function userProps(): Promise<Record<string, unknown>> {
  const result = await graph.run('MATCH (u:User {_id: $id}) RETURN properties(u) AS p', { id: USER });
  return result.records[0]!.get('p') as Record<string, unknown>;
}
async function events(): Promise<string[]> {
  return (await pool.query("SELECT event FROM auth_credential_events WHERE user_id = $1 ORDER BY occurred_at, id", [USER]))
    .rows.map(row => row.event as string);
}
async function keyEnabled(name: string): Promise<boolean> {
  return (await pool.query('SELECT enabled FROM api_keys WHERE name = $1', [name])).rows[0].enabled as boolean;
}

beforeAll(async () => {
  driver = neo4j.driver(process.env['NEO4J_URI']!, neo4j.auth.basic(process.env['NEO4J_USERNAME']!, process.env['NEO4J_PASSWORD']!));
  graph = driver.session();
  pool = new Pool({
    host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']), database: process.env['POSTGRES_DB'],
    user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'],
  });
  await graph.run(DECISION_CONSTRAINT_CYPHER);
  defaultHash = await bcrypt.hash('Admin123!', 4);
});
afterAll(async () => {
  await Promise.all(stores.map(s => s.close()));
  await graph?.run('MATCH (n) WHERE (n:User AND coalesce(n._id, n.id) STARTS WITH "hp1-s6-") OR n:CredentialRotationDecision DETACH DELETE n');
  await graph?.close();
  await driver?.close();
  await pool?.end();
  await getNeo4jClient().close();
  await getPostgresClient().close();
});

beforeEach(async () => {
  // Disposable CI database; the audit table is append-only, so its owner lifts the trigger to reset.
  await pool.query('ALTER TABLE auth_credential_events DISABLE TRIGGER USER');
  await pool.query('DELETE FROM auth_credential_events');
  await pool.query('ALTER TABLE auth_credential_events ENABLE TRIGGER USER');
  await pool.query("DELETE FROM api_keys WHERE user_id LIKE 'hp1-s6-%'");
  await graph.run('MATCH (n) WHERE (n:User AND coalesce(n._id, n.id) STARTS WITH "hp1-s6-") OR n:CredentialRotationDecision DETACH DELETE n');
  await graph.run(
    'CREATE (:User {_id: $id, _username: $id, _passwordHash: $hash, _enabled: true, defaultPasswordSuspect: true})',
    { id: USER, hash: defaultHash }
  );
  await pool.query(
    "INSERT INTO api_keys (user_id, key_hash, name, role, credential_epoch) VALUES ($1, md5('pre') || md5('pre'), 'hp1-s6-pre', 'admin', 0)",
    [USER]
  );
});

describe('operator rotation against Neo4j 5.15 and PostgreSQL', () => {
  it('rotates: INTEGER generation 1, marker cleared, decision applied, pre-rotation key revoked', async () => {
    const result = await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());

    expect(result).toMatchObject({ outcome: 'APPLIED', revokedApiKeys: 1 });
    const props = await userProps();
    expect(neo4j.isInt(props['credentialEpoch'])).toBe(true);
    expect(neo4j.integer.toNumber(props['credentialEpoch'] as never)).toBe(1);
    expect(props['defaultPasswordSuspect']).toBe(false);
    expect(await keyEnabled('hp1-s6-pre')).toBe(false);
    expect(await events()).toEqual(['password_rotation_intent', 'password_rotated_operator']);
  });
});

describe('COR16-1: no false NOT_APPLIED from a delayed writer or a lost lock session', () => {
  it('delayed admission: reconcile fences the suspended writer; its late apply cannot land', async () => {
    const writer = operator();
    await writer.lock.acquire();
    const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, writer);
    await writer.lock.release(); // suspended writer; its session is gone
    const before = await userProps();

    const reconciled = await reconcileRotations(operator(), 'operator:ci');
    expect(reconciled.resolved).toEqual([expect.objectContaining({ eventId: prepared.eventId, outcome: 'NOT_APPLIED', reason: 'fenced' })]);

    const late = await applyRotation(prepared, writer);

    expect(late).toMatchObject({ outcome: 'NOT_APPLIED', reason: 'fenced' });
    expect(await userProps()).toEqual(before);
    expect(await keyEnabled('hp1-s6-pre')).toBe(true);
    expect(await events()).toEqual(['password_rotation_intent', 'password_rotation_not_applied']);
  });

  it.each(['writer commits first', 'writer aborts'] as const)(
    'lock session terminated while the writer transaction is open (%s): the recorded outcome matches the graph',
    async order => {
      const writer = operator();
      await writer.lock.acquire();
      const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, writer);
      // The writer's apply is in flight (BEGIN + RUN, no COMMIT yet).
      const writerSession = driver.session();
      const tx = writerSession.beginTransaction();
      await tx.run(APPLY_CYPHER, prepared.applyParams);
      // Its advisory-lock connection dies while the process lives on.
      await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`);

      let settled = false;
      const reconciling = reconcileRotations(operator(), 'operator:ci').finally(() => { settled = true; });
      // Wait for the server to report reconcile's cancel as blocked on the writer's uncommitted decision.
      await untilBlocked();
      expect(settled).toBe(false);

      if (order === 'writer commits first') await tx.commit();
      else await tx.rollback();
      await writerSession.close();
      const { resolved } = await reconciling;

      const props = await userProps();
      if (order === 'writer commits first') {
        expect(resolved).toEqual([expect.objectContaining({ outcome: 'APPLIED', revokedApiKeys: 1 })]);
        expect(neo4j.integer.toNumber(props['credentialEpoch'] as never)).toBe(1);
      } else {
        expect(resolved).toEqual([expect.objectContaining({ outcome: 'NOT_APPLIED', reason: 'fenced' })]);
        expect(props['credentialEpoch']).toBeUndefined();
        // The writer resumes and retries its apply: fenced, zero writes.
        expect(await applyRotation(prepared, writer)).toMatchObject({ outcome: 'NOT_APPLIED' });
        expect((await userProps())['credentialEpoch']).toBeUndefined();
      }
      expect((await events()).filter(e => e !== 'password_rotation_intent')).toHaveLength(1);
      await writer.lock.release(); // discards the terminated lock connection
    },
    30_000
  );

  it('an aged intent with no decision stays PENDING while Neo4j cannot record a fence', async () => {
    const writer = operator();
    await writer.lock.acquire();
    const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, writer);
    await writer.lock.release();
    await pool.query('ALTER TABLE auth_credential_events DISABLE TRIGGER USER');
    await pool.query("UPDATE auth_credential_events SET occurred_at = NOW() - interval '30 days' WHERE id = $1", [prepared.eventId]);
    await pool.query('ALTER TABLE auth_credential_events ENABLE TRIGGER USER');
    const reconciler = operator();
    reconciler.graph.write = async () => { throw new Error('ServiceUnavailable'); };

    expect(await reconcileRotations(reconciler, 'operator:ci')).toEqual({ resolved: [], pending: [prepared.eventId] });
    expect(await events()).toEqual(['password_rotation_intent']);

    // Clean up through the normal path.
    await reconcileRotations(operator(), 'operator:ci');
  });
});

describe('guarded self-service writes and the marker setter on Neo4j (SEC16-01, SEC16-04)', () => {
  async function elementId(): Promise<string> {
    return (await graph.run('MATCH (u:User {_id: $id}) RETURN elementId(u) AS e', { id: USER })).records[0]!.get('e') as string;
  }
  async function unmark(): Promise<void> {
    await graph.run('MATCH (u:User {_id: $id}) SET u.defaultPasswordSuspect = false', { id: USER });
  }
  // HAP-1714: GUARDED_PASSWORD_CYPHER only lands on a user that holds an organization, so these users hold one.
  const SELF_SERVICE_ORGANIZATION = '33333333-3333-4333-8333-333333333333';
  beforeEach(async () => {
    await graph.run('MATCH (u:User {_id: $id}) SET u._organizationId = $organization', { id: USER, organization: SELF_SERVICE_ORGANIZATION });
  });

  it('a password write or disable authorized at the old generation lands nowhere after a rotation', async () => {
    await unmark();
    const eid = await elementId();
    const readHash = defaultHash;
    await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());
    const rotatedHash = (await userProps())['_passwordHash'];

    const write = await graph.run(GUARDED_PASSWORD_CYPHER, {
      elementId: eid, userId: USER, credentialEpoch: neo4j.int(0), readHash, newHash: 'attacker-hash',
    });
    const disable = await graph.run(GUARDED_DISABLE_CYPHER, { elementId: eid, userId: USER, credentialEpoch: neo4j.int(0) });

    expect(neo4j.integer.toNumber(write.records[0]!.get('n'))).toBe(0);
    expect(neo4j.integer.toNumber(disable.records[0]!.get('n'))).toBe(0);
    expect((await userProps())['_passwordHash']).toBe(rotatedHash);
    expect((await userProps())['_enabled']).toBe(true);
  });

  it('HAP-1285: the self-service password write at the current generation advances it with the hash, as an Integer', async () => {
    await unmark();
    const repository = new Neo4jAuthRepository();
    const written = await repository.updatePasswordHashGuarded({
      userId: USER, elementId: await elementId(), credentialEpoch: 0, readHash: defaultHash, newHash: 'changed-hash',
    });

    expect(written).toBe(true);
    const props = await userProps();
    expect(props['_passwordHash']).toBe('changed-hash');
    expect(neo4j.isInt(props['credentialEpoch'])).toBe(true); // SEC16-03: never a Float
    expect(neo4j.integer.toNumber(props['credentialEpoch'] as never)).toBe(1);
    // The key list carries each key's generation, so AuthService.listApiKeys can mark the pre-change key.
    expect((await repository.listApiKeys(USER)).map(k => k._credentialEpoch)).toEqual([0]);
  });

  it('HAP-1714: a user without an organization is not written, one holding it under either property spelling is', async () => {
    await unmark();
    await graph.run('MATCH (u:User {_id: $id}) REMOVE u._organizationId', { id: USER });
    const repository = new Neo4jAuthRepository();
    const write = async () => repository.updatePasswordHashGuarded({
      userId: USER, elementId: await elementId(), credentialEpoch: 0, readHash: defaultHash, newHash: 'changed-hash',
    });

    expect(await write()).toBe(false);
    const untouched = await userProps();
    expect([untouched['_passwordHash'], untouched['credentialEpoch']]).toEqual([defaultHash, undefined]);

    await graph.run('MATCH (u:User {_id: $id}) SET u.organizationId = $organization', { id: USER, organization: SELF_SERVICE_ORGANIZATION });
    expect(await write()).toBe(true);
    expect((await userProps())['_passwordHash']).toBe('changed-hash');
  });

  it('HAP-1669: the generation moves by exactly +1 from the guarded value; a stale or replayed write changes nothing', async () => {
    await unmark();
    await graph.run('MATCH (u:User {_id: $id}) SET u.credentialEpoch = 4', { id: USER });
    const repository = new Neo4jAuthRepository();
    const write = async (credentialEpoch: number, newHash: string) =>
      repository.updatePasswordHashGuarded({ userId: USER, elementId: await elementId(), credentialEpoch, readHash: (await userProps())['_passwordHash'] as string, newHash });
    const epoch = async () => neo4j.integer.toNumber((await userProps())['credentialEpoch'] as never);

    expect(await write(3, 'stale-lower')).toBe(false);
    expect(await write(9, 'stale-higher')).toBe(false);
    expect([await epoch(), (await userProps())['_passwordHash']]).toEqual([4, defaultHash]);

    expect(await write(4, 'first')).toBe(true);
    expect([await epoch(), (await userProps())['_passwordHash']]).toEqual([5, 'first']);
    expect(await write(4, 'replayed')).toBe(false); // the same authorizing generation cannot advance it twice
    expect([await epoch(), (await userProps())['_passwordHash']]).toEqual([5, 'first']);
  });

  describe('HAP-1716: the session revoke advances the generation by exactly one and never writes the hash', () => {
    const bump = async (over: { credentialEpoch?: number; readHash?: string } = {}) =>
      new Neo4jAuthRepository().bumpCredentialEpochGuarded({
        userId: USER, elementId: await elementId(), credentialEpoch: over.credentialEpoch ?? 0, readHash: over.readHash ?? defaultHash,
      });
    const state = async () => {
      const props = await userProps();
      return [props['_passwordHash'], props['credentialEpoch'] === undefined ? undefined : neo4j.integer.toNumber(props['credentialEpoch'] as never)];
    };

    it('lands on a clean user: +1 as an Integer, hash untouched, a replay at the old generation changes nothing', async () => {
      await unmark();

      expect(await bump()).toBe(true);
      expect(neo4j.isInt((await userProps())['credentialEpoch'])).toBe(true);
      expect(await state()).toEqual([defaultHash, 1]);
      expect(await bump()).toBe(false);
      expect(await state()).toEqual([defaultHash, 1]);
    });

    it.each([
      ['a stale generation', async () => bump({ credentialEpoch: 3 })],
      ['a hash that is not the stored one', async () => bump({ readHash: 'not-the-stored-hash' })],
    ])('%s lands nowhere', async (_label, run) => {
      await unmark();
      await graph.run('MATCH (u:User {_id: $id}) SET u.credentialEpoch = 4', { id: USER });

      expect(await run()).toBe(false);
      expect(await state()).toEqual([defaultHash, 4]);
    });

    it('a user still marked default-password-suspect is not written', async () => {
      await graph.run('MATCH (u:User {_id: $id}) SET u.defaultPasswordSuspect = true', { id: USER });

      expect(await bump()).toBe(false);
      expect(await state()).toEqual([defaultHash, undefined]);
    });

    it('a user without an organization is not written', async () => {
      await unmark();
      await graph.run('MATCH (u:User {_id: $id}) REMOVE u._organizationId', { id: USER });

      expect(await bump()).toBe(false);
      expect(await state()).toEqual([defaultHash, undefined]);
    });

    it('after an operator rotation the pre-rotation read lands nowhere: the rotated hash and generation stay', async () => {
      await unmark();
      const eid = await elementId();
      await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());
      const rotated = await state();

      expect(await new Neo4jAuthRepository().bumpCredentialEpochGuarded({ userId: USER, elementId: eid, credentialEpoch: 0, readHash: defaultHash })).toBe(false);
      expect(await state()).toEqual(rotated);
    });
  });

  it('HAP-1285 (MC): the hash and the generation land in ONE guarded statement; a failure after it cannot split them', async () => {
    await unmark();
    const client = getNeo4jClient();
    const open = client.getSession.bind(client);
    let runs = 0; // every statement after the first, on any session, fails: the shape of a crash between two writes
    jest.spyOn(client, 'getSession').mockImplementation((...args) => {
      const session = open(...args);
      const run = session.run.bind(session);
      session.run = ((...a: Parameters<typeof run>) => (++runs > 1 ? Promise.reject(new Error('injected')) : run(...a))) as typeof run;
      return session;
    });
    await new Neo4jAuthRepository().updatePasswordHashGuarded({
      userId: USER, elementId: await elementId(), credentialEpoch: 0, readHash: defaultHash, newHash: 'changed-hash',
    }).catch(() => false);
    const props = await userProps();
    // runs === 1 also proves the injection engaged (the write went through the spied client).
    expect([runs, props['_passwordHash'], neo4j.integer.toNumber((props['credentialEpoch'] ?? 0) as never)]).toEqual([1, 'changed-hash', 1]);
  });

  describe('HAP-1090: the login rehash writes the hash only, under the same guards as a password change', () => {
    const rehash = async (overrides: Partial<Parameters<Neo4jAuthRepository['rehashPasswordGuarded']>[0]> = {}) =>
      new Neo4jAuthRepository().rehashPasswordGuarded({
        userId: USER, elementId: await elementId(), credentialEpoch: 0, readHash: defaultHash, newHash: 'rehashed', ...overrides,
      });

    it('lands at the current generation and never writes one', async () => {
      await unmark();

      expect(await rehash()).toBe(true);

      const props = await userProps();
      expect([props['_passwordHash'], props['passwordHash']]).toEqual(['rehashed', 'rehashed']);
      expect(props['credentialEpoch']).toBeUndefined();
    });

    it('keeps an existing generation as the same Integer', async () => {
      await unmark();
      await graph.run('MATCH (u:User {_id: $id}) SET u.credentialEpoch = $epoch', { id: USER, epoch: neo4j.int(2) });

      expect(await rehash({ credentialEpoch: 2 })).toBe(true);

      const props = await userProps();
      expect(neo4j.isInt(props['credentialEpoch'])).toBe(true);
      expect(neo4j.integer.toNumber(props['credentialEpoch'] as never)).toBe(2);
    });

    it.each([
      ['a changed stored hash', async () => { await graph.run('MATCH (u:User {_id: $id}) SET u._passwordHash = "newer"', { id: USER }); }, {}, 'newer'],
      ['a moved generation', async () => { await graph.run('MATCH (u:User {_id: $id}) SET u.credentialEpoch = 1', { id: USER }); }, {}, undefined],
      ['a marked account', async () => { await graph.run('MATCH (u:User {_id: $id}) SET u.defaultPasswordSuspect = true', { id: USER }); }, {}, undefined],
    ] as Array<[string, () => Promise<void>, object, string | undefined]>)('writes nothing for %s', async (_label, interfere, overrides, expected) => {
      await unmark();
      await interfere();

      expect(await rehash(overrides)).toBe(false);

      // defaultHash is set in beforeAll, so "left as it was" is resolved here, not when the table is built.
      expect((await userProps())['_passwordHash']).toBe(expected ?? defaultHash);
    });
  });

  it('the login marker setter writes only the false → true transition', async () => {
    await graph.run('MATCH (u:User {_id: $id}) REMOVE u.defaultPasswordSuspect', { id: USER });
    const params = { elementId: await elementId(), userId: USER, verifiedHash: defaultHash, verifiedEpoch: neo4j.int(0) };

    const first = await graph.run(MARK_DEFAULT_SUSPECT_CYPHER, params);
    const second = await graph.run(MARK_DEFAULT_SUSPECT_CYPHER, params);

    expect(neo4j.integer.toNumber(first.records[0]!.get('n'))).toBe(1);
    expect(neo4j.integer.toNumber(second.records[0]!.get('n'))).toBe(0);
  });

  describe('MEDIUM 2: a guarded write waiting on an open rotation re-reads its guards after the lock', () => {
    /** A rotation of USER whose apply transaction has run and is not yet committed (it holds the node's write lock). */
    async function openRotation(): Promise<{ commit: () => Promise<void>; rotatedHash: string }> {
      const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());
      const session = driver.session();
      const tx = session.beginTransaction();
      await tx.run(APPLY_CYPHER, prepared.applyParams);
      return {
        rotatedHash: prepared.applyParams['newHash'] as string,
        commit: async () => {
          await tx.commit();
          await session.close();
        },
      };
    }
    /** Runs `cypher` in its own auto-commit session while the rotation holds the node; resolves to its row count. */
    async function runAgainstOpenRotation(cypher: string, params: Record<string, unknown>) {
      const rotation = await openRotation();
      const session = driver.session();
      const writing = session.run(cypher, params).then(r => neo4j.integer.toNumber(r.records[0]!.get('n')));
      try {
        await untilBlocked('the guarded write');
      } finally {
        await rotation.commit(); // never leave the node locked, whatever the wait observed
      }
      const landed = await writing;
      await session.close();
      return { landed, rotatedHash: rotation.rotatedHash };
    }
    const passwordParams = async () => ({
      elementId: await elementId(), userId: USER, credentialEpoch: neo4j.int(0), readHash: defaultHash, newHash: 'attacker-hash',
    });

    it('contrast: the pre-fix password statement does overwrite the rotation (the race is real)', async () => {
      await unmark();
      const { landed } = await runAgainstOpenRotation(PRE_FIX_GUARDED_PASSWORD_CYPHER, await passwordParams());

      expect(landed).toBe(1);
      expect((await userProps())['_passwordHash']).toBe('attacker-hash');
    }, 30_000);

    it('the shipped password write lands nowhere and the rotated hash stays', async () => {
      await unmark();
      const { landed, rotatedHash } = await runAgainstOpenRotation(GUARDED_PASSWORD_CYPHER, await passwordParams());

      expect(landed).toBe(0);
      expect((await userProps())['_passwordHash']).toBe(rotatedHash);
    }, 30_000);

    it('the shipped disable lands nowhere', async () => {
      await unmark();
      const { landed } = await runAgainstOpenRotation(
        GUARDED_DISABLE_CYPHER, { elementId: await elementId(), userId: USER, credentialEpoch: neo4j.int(0) }
      );

      expect(landed).toBe(0);
      expect((await userProps())['_enabled']).toBe(true);
    }, 30_000);

    it('the shipped marker setter, verified against the pre-rotation hash, marks nothing', async () => {
      await unmark();
      const { landed } = await runAgainstOpenRotation(MARK_DEFAULT_SUSPECT_CYPHER, {
        elementId: await elementId(), userId: USER, verifiedHash: defaultHash, verifiedEpoch: neo4j.int(0),
      });

      expect(landed).toBe(0);
      expect((await userProps())['defaultPasswordSuspect']).toBe(false);
    }, 30_000);

    it('HAP-1090: the shipped login rehash lands nowhere and the rotated hash stays', async () => {
      await unmark();
      const { landed, rotatedHash } = await runAgainstOpenRotation(GUARDED_REHASH_CYPHER, {
        elementId: await elementId(), userId: USER, credentialEpoch: neo4j.int(0), readHash: defaultHash, newHash: 'rehashed',
      });

      expect(landed).toBe(0);
      expect((await userProps())['_passwordHash']).toBe(rotatedHash);
    }, 30_000);
  });

  describe('MEDIUM 1: a default-password verification made before a rotation never marks the rotated account', () => {
    it('Neo4jAuthRepository.markDefaultSuspect with the pre-rotation read', async () => {
      await unmark();
      const repository = new Neo4jAuthRepository();
      const verified = (await repository.findUserByUsername(USER))!; // the read login compared against the default

      await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());

      expect(await repository.markDefaultSuspect(verified)).toBe(false);
      expect((await userProps())['defaultPasswordSuspect']).toBe(false);
      // The same call with a read of the current state does write (the guard is not simply closed).
      expect(await repository.markDefaultSuspect((await repository.findUserByUsername(USER))!)).toBe(true);
    });

    it('the window scan, when a rotation commits between its read and its mark', async () => {
      await unmark();
      const scanner = operator();
      const onlyThisUser = { ...scanner.graph, read: async (c: string, p: Record<string, unknown>) =>
        (await scanner.graph.read(c, p)).filter(row => row['id'] === USER) };
      let rotated = false;

      const result = await scanDefaultPasswords(onlyThisUser, scanner.sql, async (password, hash) => {
        if (!rotated) {
          rotated = true;
          await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());
        }
        return bcrypt.compare(password, hash);
      }, 'ci');

      expect(result).toMatchObject({ marked: [], alreadyMarkedOrRaced: [USER] });
      expect((await userProps())['defaultPasswordSuspect']).toBe(false);
      expect(await events()).toEqual(['password_rotation_intent', 'password_rotated_operator']);
    });
  });
});

describe('MEDIUM 3: existing databases get the decision constraint from neo4j migration 002 or --prepare', () => {
  const MIGRATION = join(__dirname, '../../../packages/database/src/neo4j/migrations/002_credential_rotation_decision.cypher');
  const migrationStatements = (): string[] => readFileSync(MIGRATION, 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    .split(';').map(statement => statement.trim()).filter(statement => statement !== '');
  async function decisionConstraints(): Promise<number> {
    const result = await graph.run(
      "SHOW CONSTRAINTS YIELD labelsOrTypes, properties WHERE labelsOrTypes = ['CredentialRotationDecision'] AND properties = ['eventId'] RETURN count(*) AS n"
    );
    return neo4j.integer.toNumber(result.records[0]!.get('n'));
  }

  afterEach(async () => {
    await graph.run(DECISION_CONSTRAINT_CYPHER);
  });

  it('refuses rotation without it, writing nothing; applying 002 (twice) and --prepare restores it; rotation then applies', async () => {
    await graph.run('DROP CONSTRAINT credential_rotation_decision_event IF EXISTS');
    expect(await decisionConstraints()).toBe(0);

    await expect(rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator()))
      .rejects.toMatchObject({ reason: 'decision_constraint_missing' });
    expect(await events()).toEqual([]);

    for (let run = 0; run < 2; run++) {
      for (const statement of migrationStatements()) await graph.run(statement);
    }
    await prepareDecisionConstraint(operator().graph);
    expect(await decisionConstraints()).toBe(1);

    expect(await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator()))
      .toMatchObject({ outcome: 'APPLIED' });
  });

  it('--prepare alone creates it on a database that lacks it', async () => {
    await graph.run('DROP CONSTRAINT credential_rotation_decision_event IF EXISTS');

    await prepareDecisionConstraint(operator().graph);

    expect(await decisionConstraints()).toBe(1);
  });
});

describe('LOW 4: the open-intent check and the intent insert are serialized across operators', () => {
  it('with both lock sessions lost, a second operator cannot open an intent while the first is inserting', async () => {
    const OTHER = 'hp1-s6-rotation-user-2';
    await graph.run('CREATE (:User {_id: $id, _username: $id, _passwordHash: $hash, _enabled: true})', { id: OTHER, hash: defaultHash });
    const first = operator();
    const second = operator();
    let reachedInsert!: () => void;
    const atInsert = new Promise<void>(resolve => { reachedInsert = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transaction = first.sql.transaction.bind(first.sql);
    first.sql = {
      ...first.sql,
      transaction: callback => transaction(client => callback({
        query: async (text: string, params?: unknown[]) => {
          if (text.includes('INSERT INTO auth_credential_events')) {
            reachedInsert();
            await gate;
          }
          return client.query(text, params);
        },
      } as RotationSqlQuery)),
    };

    const opening = prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, first);
    await atInsert;
    const competing = prepareRotation({ userId: OTHER, operator: 'ci', password: NEW_PASSWORD }, second)
      .then(() => 'opened', (error: unknown) => error);
    await untilAdvisoryWait();
    release();
    await opening;

    expect(await competing).toMatchObject({ reason: 'open_intent' });
    const intents = await pool.query("SELECT user_id FROM auth_credential_events WHERE event = 'password_rotation_intent'");
    expect(intents.rows).toEqual([{ user_id: USER }]);
  }, 30_000);
});

describe('N-21 (l): a rotated seeded account keeps seedProvenance and gains no platform power', () => {
  it('rotation clears the marker and bumps the generation but leaves provenance; the grant still refuses it', async () => {
    await graph.run("MATCH (u:User {_id: $id}) SET u.seedProvenance = 'init-neo4j', u.platformAdmin = true", { id: USER });

    expect(await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator()))
      .toMatchObject({ outcome: 'APPLIED' });

    const props = await userProps();
    expect(props['seedProvenance']).toBe('init-neo4j');
    expect(props['defaultPasswordSuspect']).toBe(false);
    const rotated = (await new Neo4jAuthRepository().findUserById(USER))!;
    expect(isSeededAccount(rotated)).toBe(true);
    expect(isPlatformAdmin(rotated)).toBe(false);
    await expect(grantPlatformAdmin(operator().graph, USER, 'ci')).rejects.toMatchObject({ reason: 'seeded_account' });
  });
});

describe('N-21 (h4): reconcile under a live rotation never writes an outcome for its intent', () => {
  it('the reconcile is refused with LockBusyError (CLI exit 6), writes nothing, and the live rotation then applies', async () => {
    const writer = operator();
    await writer.lock.acquire();
    try {
      const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, writer); // live intent

      await expect(reconcileRotations(operator(), 'operator:ci')).rejects.toBeInstanceOf(LockBusyError);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exit = await rotationCli(['--reconcile', '--operator', 'ci'], operatorEnv(), {
        stdin: process.stdin, stdout: line => stdout.push(line), stderr: line => stderr.push(line),
      });
      expect(exit).toBe(6);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(['rotate-user-password: another rotation or reconcile is running']);

      expect(await events()).toEqual(['password_rotation_intent']);
      const decisions = await graph.run('MATCH (d:CredentialRotationDecision {eventId: $e}) RETURN count(d) AS n', { e: prepared.eventId });
      expect(neo4j.integer.toNumber(decisions.records[0]!.get('n'))).toBe(0);

      expect(await applyRotation(prepared, writer)).toMatchObject({ outcome: 'APPLIED' });
      expect(await events()).toEqual(['password_rotation_intent', 'password_rotated_operator']);
    } finally {
      await writer.lock.release();
    }
  }, 30_000);
});

describe('N-21 SEC13-02: seed inventory and stamp over both property spellings', () => {
  const INTERNAL = '00000000-0000-0000-0000-000000000000';
  const OTHER_ORG = '11111111-1111-4111-8111-111111111111';
  const fixture = (props: Record<string, unknown>) =>
    graph.run('CREATE (u:User) SET u = $props', { props: { _enabled: true, _passwordHash: defaultHash, ...props } });

  beforeEach(async () => {
    // seed-data.ts shape: underscore spelling, random-looking id, username/email overrides, no provenance.
    await fixture({ _id: 'hp1-s6-seed-data', _username: 'ops-root', _email: 'ops-root@corp.example', _role: 'admin', _organizationId: INTERNAL });
    // init-neo4j.cypher shape: plain spelling, with overrides, no provenance.
    await fixture({ id: 'hp1-s6-init', username: 'hp1-s6-init', email: 'hp1-s6-init@corp.example', role: 'admin', organizationId: INTERNAL });
    // Already provenanced by its seed writer.
    await fixture({ _id: 'hp1-s6-provenanced', _role: 'viewer', _organizationId: OTHER_ORG, seedProvenance: 'seed-data' });
    // An internal admin Nick names as a human account (--except).
    await fixture({ _id: 'hp1-s6-human', _username: 'hp1-s6-human', _role: 'admin', _organizationId: INTERNAL });
    // Not seed candidates.
    await fixture({ _id: 'hp1-s6-tenant-admin', _role: 'admin', _organizationId: OTHER_ORG });
    await fixture({ id: 'hp1-s6-internal-viewer', role: 'viewer', organizationId: INTERNAL });
  });

  async function provenance(id: string): Promise<unknown> {
    const result = await graph.run('MATCH (u:User) WHERE u._id = $id OR u.id = $id RETURN u.seedProvenance AS p', { id });
    return result.records[0]!.get('p');
  }

  it('inventory returns both spellings and overrides; v13\'s literal role selector misses the seed-data shape', async () => {
    const candidates = (await inventorySeedAccounts(operator().graph)).filter(c => c.id.startsWith('hp1-s6-'));

    expect(candidates.map(({ id, reason }) => ({ id, reason })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'hp1-s6-human', reason: 'internal-org admin' },
      { id: 'hp1-s6-init', reason: 'internal-org admin' },
      { id: 'hp1-s6-provenanced', reason: 'seedProvenance' },
      { id: 'hp1-s6-seed-data', reason: 'internal-org admin' },
    ]);
    const v13 = await graph.run(
      "MATCH (u:User) WHERE u.role = 'admin' AND u.organizationId = $org AND coalesce(u._id, u.id) STARTS WITH 'hp1-s6-' RETURN coalesce(u._id, u.id) AS id",
      { org: INTERNAL }
    );
    expect(v13.records.map(r => r.get('id'))).toEqual(['hp1-s6-init']);
  });

  it('stamp: coalesce never overwrites provenance, --except ids stay unstamped and grantable, stamped seeds are refused the platform flag', async () => {
    const others = (await inventorySeedAccounts(operator().graph)).map(c => c.id).filter(id => !id.startsWith('hp1-s6-'));

    const result = await stampSeedAccounts(operator().graph, ['hp1-s6-human', ...others]);

    expect(result.excepted).toEqual(expect.arrayContaining(['hp1-s6-human']));
    expect(result.stamped).toBe(3);
    expect(await provenance('hp1-s6-seed-data')).toBe('pre-cutover-inventory');
    expect(await provenance('hp1-s6-init')).toBe('pre-cutover-inventory');
    expect(await provenance('hp1-s6-provenanced')).toBe('seed-data');
    expect(await provenance('hp1-s6-human')).toBeNull();
    expect(await provenance('hp1-s6-tenant-admin')).toBeNull();
    expect(await provenance('hp1-s6-internal-viewer')).toBeNull();

    const repository = new Neo4jAuthRepository();
    expect(isSeededAccount((await repository.findUserById('hp1-s6-seed-data'))!)).toBe(true);
    await expect(grantPlatformAdmin(operator().graph, 'hp1-s6-seed-data', 'ci')).rejects.toMatchObject({ reason: 'seeded_account' });
    await expect(grantPlatformAdmin(operator().graph, 'hp1-s6-human', 'ci')).resolves.toEqual({ userId: 'hp1-s6-human' });

    // A second stamp changes nothing already stamped.
    await stampSeedAccounts(operator().graph, ['hp1-s6-human', ...others]);
    expect(await provenance('hp1-s6-provenanced')).toBe('seed-data');
    expect(await provenance('hp1-s6-human')).toBeNull();
  });
});

describe('FD5-S1 LOW-1: assign-organization compare-and-set on Neo4j 5.15', () => {
  it('assigns a user with neither organization property (observed null = $observed null), stamped by the operator', async () => {
    const ORG = '22222222-2222-4222-8222-222222222222';
    await graph.run('CREATE (:User {_id: $id, _username: $id, _enabled: true})', { id: 'hp1-s6-orgless' });
    const window = operator();

    await expect(assignOrganization(window.graph, window.sql, 'hp1-s6-orgless', ORG, 'ci'))
      .resolves.toEqual({ userId: 'hp1-s6-orgless', organizationId: ORG, outcome: 'assigned', enabledApiKeys: 0 });
    const props = (await graph.run('MATCH (u:User {_id: $id}) RETURN properties(u) AS p', { id: 'hp1-s6-orgless' })).records[0]!.get('p');
    expect(props).toMatchObject({ _organizationId: ORG, organizationAssignedBy: 'ci' });
    expect(props['organizationId']).toBeUndefined();
    expect(neo4j.isDateTime(props['organizationAssignedAt'])).toBe(true);
  });
});

describe('HAP-1632: portfolio:import scope grant and revoke compare-and-set on Neo4j 5.15', () => {
  const ID = 'hp1-s6-scope-user';

  /** An eligible user (unmarked, unseeded); `props` may add or override stored properties, including `scopes`. */
  const createScopeUser = (props: Record<string, unknown> = {}, id = ID) =>
    graph.run('CREATE (u:User) SET u = $props', {
      props: { _id: id, _username: id, _enabled: true, _passwordHash: defaultHash, defaultPasswordSuspect: false, ...props },
    });
  async function stored(id = ID): Promise<Record<string, unknown>> {
    const result = await graph.run('MATCH (u:User {_id: $id}) RETURN properties(u) AS p', { id });
    return result.records[0]!.get('p') as Record<string, unknown>;
  }
  async function elementId(id = ID): Promise<string> {
    return (await graph.run('MATCH (u:User {_id: $id}) RETURN elementId(u) AS e', { id })).records[0]!.get('e') as string;
  }
  async function loadedHolds(id = ID): Promise<boolean> {
    return holdsScope((await new Neo4jAuthRepository().findUserById(id))!, PORTFOLIO_IMPORT_SCOPE);
  }
  /** The graph, but `interfere` runs once right after the resolution read: a writer landing between read and write. */
  function racing(inner: RotationGraph, interfere: () => Promise<unknown>): RotationGraph {
    let done = false;
    return {
      write: (cypher, params) => inner.write(cypher, params),
      read: async (cypher, params) => {
        const rows = await inner.read(cypher, params);
        if (cypher === GRANT_IDENTITY_CYPHER && !done) {
          done = true;
          await interfere();
        }
        return rows;
      },
    };
  }

  it('grants a user with no scopes property: the stored list is [scope], the loaded user holds it, a repeat writes nothing', async () => {
    await createScopeUser();
    const window = operator();

    await expect(grantPortfolioImportScope(window.graph, ID, 'ci')).resolves.toEqual({ userId: ID, outcome: 'granted' });

    const props = await stored();
    expect(props['scopes']).toEqual([PORTFOLIO_IMPORT_SCOPE]);
    expect(props['portfolioImportScopeGrantedBy']).toBe('ci');
    expect(neo4j.isDateTime(props['portfolioImportScopeGrantedAt'])).toBe(true);
    expect(await loadedHolds()).toBe(true);

    await expect(grantPortfolioImportScope(window.graph, ID, 'someone-else')).resolves.toEqual({ userId: ID, outcome: 'unchanged' });
    expect((await stored())['portfolioImportScopeGrantedBy']).toBe('ci');
  });

  it('grants a user holding another scope without dropping it, and revoke removes only the portfolio entry', async () => {
    await createScopeUser({ scopes: ['credentials:manage'] });
    const window = operator();

    await grantPortfolioImportScope(window.graph, ID, 'ci');
    expect((await stored())['scopes']).toEqual(['credentials:manage', PORTFOLIO_IMPORT_SCOPE]);

    await expect(revokePortfolioImportScope(window.graph, ID, 'ci')).resolves.toEqual({ userId: ID, outcome: 'revoked' });
    const props = await stored();
    expect(props['scopes']).toEqual(['credentials:manage']);
    expect(props['portfolioImportScopeRevokedBy']).toBe('ci');
    expect(neo4j.isDateTime(props['portfolioImportScopeRevokedAt'])).toBe(true);
    expect(await loadedHolds()).toBe(false);
  });

  it('revoking the last entry stores [] (not an absent property) and the next grant matches that empty list', async () => {
    await createScopeUser();
    const window = operator();
    await grantPortfolioImportScope(window.graph, ID, 'ci');

    await revokePortfolioImportScope(window.graph, ID, 'ci');
    const revoked = await stored();
    expect(revoked['scopes']).toEqual([]);
    expect(await loadedHolds()).toBe(false);
    await expect(revokePortfolioImportScope(window.graph, ID, 'ci')).resolves.toEqual({ userId: ID, outcome: 'unchanged' });

    await expect(grantPortfolioImportScope(window.graph, ID, 'ci')).resolves.toEqual({ userId: ID, outcome: 'granted' });
    expect((await stored())['scopes']).toEqual([PORTFOLIO_IMPORT_SCOPE]);
    expect(await loadedHolds()).toBe(true);
  });

  it('a seeded account never holds the scope even with it stored', async () => {
    await createScopeUser({ scopes: [PORTFOLIO_IMPORT_SCOPE], seedProvenance: 'init-neo4j' });

    expect(await loadedHolds()).toBe(false);
  });

  const changes: Array<[string, typeof grantPortfolioImportScope]> = [
    ['grant', grantPortfolioImportScope],
    ['revoke', revokePortfolioImportScope],
  ];

  it.each(changes)('%s: a scope list changed between the resolution and the write is not_applied and writes nothing', async (name, change) => {
    const start = name === 'grant' ? ['a'] : ['a', PORTFOLIO_IMPORT_SCOPE];
    await createScopeUser({ scopes: start });
    const graphWindow = operator().graph;
    const raced = racing(graphWindow, () => graph.run("MATCH (u:User {_id: $id}) SET u.scopes = ['a', 'other', 'b']", { id: ID }));

    await expect(change(raced, ID, 'ci')).rejects.toMatchObject({ name: 'GrantRefused', reason: 'not_applied' });

    const props = await stored();
    expect(props['scopes']).toEqual(['a', 'other', 'b']);
    expect(props['portfolioImportScopeGrantedBy']).toBeUndefined();
    expect(props['portfolioImportScopeRevokedBy']).toBeUndefined();
  });

  it.each(changes)('%s: a user marked or provenanced between the resolution and the write is not_applied and writes nothing', async (name, change) => {
    for (const interference of [
      "SET u.seedProvenance = 'init-neo4j'", 'SET u.defaultPasswordSuspect = true', 'SET u._defaultPasswordSuspect = true',
    ]) {
      await graph.run('MATCH (u:User) WHERE u._id = $id DETACH DELETE u', { id: ID });
      await createScopeUser({ scopes: name === 'grant' ? [] : [PORTFOLIO_IMPORT_SCOPE] });
      const raced = racing(operator().graph, () => graph.run(`MATCH (u:User {_id: $id}) ${interference}`, { id: ID }));

      await expect(change(raced, ID, 'ci')).rejects.toMatchObject({ name: 'GrantRefused', reason: 'not_applied' });

      const props = await stored();
      expect(props['scopes']).toEqual(name === 'grant' ? [] : [PORTFOLIO_IMPORT_SCOPE]);
      expect(props['portfolioImportScopeGrantedBy']).toBeUndefined();
      expect(props['portfolioImportScopeRevokedBy']).toBeUndefined();
    }
  });

  const statements: Array<[string, string, string[], string[], string]> = [
    ['grant', GRANT_PORTFOLIO_IMPORT_SCOPE_CYPHER, [], [PORTFOLIO_IMPORT_SCOPE], 'Granted'],
    ['revoke', REVOKE_PORTFOLIO_IMPORT_SCOPE_CYPHER, [PORTFOLIO_IMPORT_SCOPE], [], 'Revoked'],
  ];

  describe.each(statements)('the %s statement itself', (_name, cypher, before, after, stamp) => {
    const run = async (params: Record<string, unknown>, id = ID) => {
      const rows = await operator().graph.write(cypher, {
        eid: await elementId(id), id, observed: before, scopes: after, operator: 'ci', ...params,
      });
      return neo4j.integer.toNumber(rows[0]!['n'] as never);
    };

    it('writes when the observed list equals the stored one, and an absent property equals the observed []', async () => {
      await createScopeUser(before.length > 0 ? { scopes: before } : {});

      expect(await run({})).toBe(1);

      const props = await stored();
      expect(props['scopes']).toEqual(after);
      expect(props[`portfolioImportScope${stamp}By`]).toBe('ci');
    });

    it('refuses a stored list that differs from the observed one, whether it grew or was replaced', async () => {
      await createScopeUser({ scopes: [...before, 'extra'] });

      expect(await run({})).toBe(0); // observed is a strict prefix of the stored list
      expect(await run({ observed: ['stale'] })).toBe(0);

      expect((await stored())['scopes']).toEqual([...before, 'extra']);
    });

    const ineligible: Array<[string, Record<string, unknown>]> = [
      ['a seeded user', { seedProvenance: 'init-neo4j' }],
      ['a marked user', { defaultPasswordSuspect: true }],
      ['a marked user (underscore spelling)', { _defaultPasswordSuspect: true }],
    ];
    it.each(ineligible)('refuses %s', async (_label, extra) => {
      await createScopeUser({ scopes: before, ...extra });

      expect(await run({})).toBe(0);

      const after_ = await stored();
      expect(after_['scopes']).toEqual(before);
      expect(after_[`portfolioImportScope${stamp}By`]).toBeUndefined();
    });

    it('refuses an id that is not the node\'s own', async () => {
      await createScopeUser({ scopes: before });

      expect(await run({ id: 'hp1-s6-someone-else' })).toBe(0);

      expect((await stored())['scopes']).toEqual(before);
    });
  });

  it('the CLI dispatches grant and revoke to their own statements on the real stores, and exits 2 on a refusal', async () => {
    await createScopeUser();
    const run = async (command: string, userId: string) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await identityWindowCli([command, '--user-id', userId, '--operator', 'ci'], operatorEnv(), {
        stdout: line => out.push(line), stderr: line => err.push(line),
      });
      return { code, out, err };
    };

    expect(await run('grant-portfolio-import-scope', ID)).toEqual({ code: 0, out: [JSON.stringify({ userId: ID, outcome: 'granted' })], err: [] });
    expect((await stored())['scopes']).toEqual([PORTFOLIO_IMPORT_SCOPE]);
    expect(await loadedHolds()).toBe(true);

    expect(await run('revoke-portfolio-import-scope', ID)).toEqual({ code: 0, out: [JSON.stringify({ userId: ID, outcome: 'revoked' })], err: [] });
    expect((await stored())['scopes']).toEqual([]);
    expect(await loadedHolds()).toBe(false);

    // USER (the suite fixture) carries the default-password marker.
    expect(await run('grant-portfolio-import-scope', USER)).toEqual({
      code: 2, out: [], err: ['identity-window: portfolio-import scope grant refused: seeded_account'],
    });
  });
});
