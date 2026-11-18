// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 window identity steps (v16 §1.1 / §12 step 6, N-21 P-6):
 * the platform-admin grant refuses seeded, marked, ambiguous and colliding
 * identities, and writes the flag on exactly one node otherwise; the default
 * password scan marks only false → true transitions and audits each one.
 * Neo4j is an in-memory model of the exported statements.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import neo4j from 'neo4j-driver';
import { join } from 'path';

import { holdsScope } from '../../auth/scopes';
import type { User } from '../../auth/types';
import {
  ASSIGN_ORGANIZATION_CYPHER, AuditWriteFailed, assignOrganization, main,
  GRANT_HOLDERS_CYPHER, GRANT_IDENTITY_CYPHER, GRANT_PLATFORM_ADMIN_CYPHER, GRANT_PORTFOLIO_IMPORT_SCOPE_CYPHER, GrantRefused,
  REVOKE_PORTFOLIO_IMPORT_SCOPE_CYPHER, SCAN_MARK_CYPHER,
  SCAN_USERS_CYPHER, SCOPE_MARKERS_CYPHER, grantPlatformAdmin, grantPortfolioImportScope, recordPortfolioImportScope, redactSecrets, revokePortfolioImportScope, scanDefaultPasswords,
} from '../identity-window';
import { APPLY_CYPHER } from '../rotate-user-password';
import type { RotationGraph, RotationSql, RotationSqlQuery, Row } from '../rotate-user-password';

// main() opens its stores through openOperatorStores; the tests hand it the in-memory graph and PGlite instead, and
// assert whether a store was opened at all. The default delegates to the real function (which needs CMDB_ROTATE_*).
jest.mock('../operator-stores', () => {
  const actual = jest.requireActual<typeof import('../operator-stores')>('../operator-stores');
  return { ...actual, openOperatorStores: jest.fn(actual.openOperatorStores) };
});
import * as operatorStores from '../operator-stores';

type Node = { elementId: string; props: Row };

// api_keys is real PostgreSQL (PGlite in a child process), so the enabledApiKeys WHERE clause is executed.
const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: Row[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: Row[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', text: string, params: unknown[] = []): Promise<Row[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql: text, params });
  });
}
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');
const migration = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
/** auth_credential_events as the migrations build it: the real 020 (append-only triggers included), then the real 055. */
async function resetEvents(): Promise<void> {
  await send('exec', 'DROP TABLE IF EXISTS auth_credential_events');
  await send('exec', migration('020_auth_credential_events.sql'));
  await send('exec', migration('055_auth_credential_events_scope_events.sql'));
}
/**
 * A RotationSql over the one PGlite session: BEGIN/COMMIT on it is a real PostgreSQL transaction (the advisory lock
 * statement and the audit insert run in it). Two transactions cannot overlap on one session, so concurrent runs are
 * covered on a real server in tests/integration/database/hap2129-scope-lock.integration.test.ts.
 */
const sqlOver = (query: RotationSqlQuery['query']): RotationSql => {
  const self: RotationSql = {
    query,
    transaction: async callback => {
      await send('exec', 'BEGIN');
      try {
        const result = await callback(self);
        await send('exec', 'COMMIT');
        return result;
      } catch (error) {
        await send('exec', 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
  };
  return self;
};
const keysSql = sqlOver(async (text, params = []) => ({ rows: await send('query', text, params) }));
beforeAll(async () => {
  const schema = migration('001_complete_schema.sql');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS api_keys (');
  await send('exec', schema.slice(start, schema.indexOf(');', start) + 2));
  await send('exec', 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS credential_epoch INTEGER NOT NULL DEFAULT 0');
});
afterAll(() => {
  host.kill();
});
const addKey = (name: string, userId: string, epoch: number, state: 'live' | 'disabled' | 'revoked' = 'live') =>
  send('query',
    `INSERT INTO api_keys (user_id, key_hash, name, role, credential_epoch, enabled, revoked_at)
     VALUES ($1, $2, $3, 'admin', $4, $5, ${state === 'revoked' ? 'NOW()' : 'NULL'})`,
    [userId, `${name}-hash`.padEnd(64, '0'), name, epoch, state === 'live']);
const norm = (cypher: string) => cypher.replace(/\s+/g, ' ').trim();
const marked = (u: Node) => u.props['defaultPasswordSuspect'] === true || u.props['_defaultPasswordSuspect'] === true;
const admin = (u: Node) => u.props['_platformAdmin'] === true || u.props['platformAdmin'] === true;
const orgOf = (u: Node) => u.props['_organizationId'] ?? u.props['organizationId'] ?? null;
const hashOf = (u: Node) => u.props['_passwordHash'] ?? u.props['passwordHash'] ?? null;
const num = (value: unknown) => (neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value));
const epochOf = (u: Node) => num(u.props['credentialEpoch'] ?? 0);

// Evaluates the statement's own final SET clause on the node: `$param`, `datetime()` and the `true`/`false` literals.
// The greedy prefix skips LOCK_USER's `SET u._hp1WriteLock = true REMOVE u._hp1WriteLock`, which nets to no change.
// Any other right-hand side throws, so a new expression form cannot silently be stored as text.
function applySet(u: Node, q: string, params: Row): void {
  const clause = /.*\bSET (.+?)(?: REMOVE | RETURN )/.exec(q)![1]!;
  for (const assignment of clause.split(', ')) {
    const [, key, rhs] = /^u\.(\w+) = (.+)$/.exec(assignment)!;
    if (rhs!.startsWith('$')) u.props[key!] = params[rhs!.slice(1)];
    else if (rhs === 'datetime()') u.props[key!] = new Date();
    else if (rhs === 'true') u.props[key!] = true;
    else if (rhs === 'false') u.props[key!] = false;
    else throw new Error(`fakeGraph cannot evaluate SET ${assignment}`);
  }
}

function fakeGraph(users: Node[]): RotationGraph {
  const match = (id: unknown) => users.filter(u => u.props['_id'] === id || u.props['id'] === id);
  return {
    read: async (cypher, params) => {
      const q = norm(cypher);
      if (q === norm(GRANT_IDENTITY_CYPHER)) {
        return match(params['id']).map(u => ({
          eid: u.elementId, _id: u.props['_id'] ?? null, id: u.props['id'] ?? null,
          username: u.props['_username'] ?? u.props['username'] ?? null, email: u.props['_email'] ?? u.props['email'] ?? null,
          seedProvenance: u.props['seedProvenance'] ?? null, marked: marked(u),
          platformAdmin: admin(u), org: orgOf(u), scopes: u.props['scopes'] ?? null, epoch: u.props['credentialEpoch'] ?? neo4j.int(0),
        }));
      }
      if (q === norm(GRANT_HOLDERS_CYPHER)) {
        const keys = params['keys'] as unknown[];
        return [{ holders: neo4j.int(users.filter(u => keys.includes(u.props['_id']) || keys.includes(u.props['id'])).length) }];
      }
      if (q === norm(SCOPE_MARKERS_CYPHER)) {
        return users.filter(u => u.elementId === params['eid']).map(u => ({
          grantedOp: u.props['portfolioImportScopeGrantedOpId'] ?? null, revokedOp: u.props['portfolioImportScopeRevokedOpId'] ?? null,
        }));
      }
      if (q === norm(SCAN_USERS_CYPHER)) {
        return users.map(u => ({ eid: u.elementId, id: u.props['_id'] ?? u.props['id'], hash: hashOf(u), e0: neo4j.int(epochOf(u)) }));
      }
      throw new Error(`unexpected read ${q}`);
    },
    write: async (cypher, params) => {
      const q = norm(cypher);
      const u = users.find(n => n.elementId === params['eid']);
      if (q === norm(GRANT_PLATFORM_ADMIN_CYPHER)) {
        const ok = u !== undefined && (u.props['_id'] === params['id'] || u.props['id'] === params['id'])
          && u.props['seedProvenance'] === undefined && !marked(u);
        if (ok) applySet(u!, q, params);
        return [{ n: neo4j.int(ok ? 1 : 0) }];
      }
      if (q === norm(APPLY_CYPHER)) {
        // The rotation's own statement: guards from its WHERE, assignments from its SET, REMOVE applied as written.
        const ok = u !== undefined && (u.props['_id'] === params['id'] || u.props['id'] === params['id'])
          && epochOf(u) === num(params['e0']);
        if (ok) {
          applySet(u!, q, params);
          const [, removed] = /REMOVE (\S+) CREATE/.exec(q)!;
          delete u!.props[removed!.replace('u.', '')];
        }
        return [{ n: neo4j.int(ok ? 1 : 0) }];
      }
      if (q === norm(SCAN_MARK_CYPHER)) {
        // Guards evaluated on the current node, as after the statement's lock.
        const ok = u !== undefined && !marked(u)
          && hashOf(u) === params['verifiedHash'] && epochOf(u) === num(params['verifiedEpoch']);
        if (ok) applySet(u!, q, params);
        return [{ n: neo4j.int(ok ? 1 : 0) }];
      }
      if (q === norm(ASSIGN_ORGANIZATION_CYPHER)) {
        // Each guard and the written property are read from the statement, so a dropped guard shows.
        const ok = u !== undefined && (u.props['_id'] === params['id'] || u.props['id'] === params['id'])
          && (!q.includes('u.seedProvenance IS NULL') || u.props['seedProvenance'] === undefined)
          && (!q.includes('AND NOT (coalesce(u.defaultPasswordSuspect') || !marked(u))
          && (!q.includes('AND NOT (coalesce(u._platformAdmin') || !admin(u))
          && (!q.includes('observed = $observed') || orgOf(u) === params['observed']);
        if (ok) applySet(u!, q, params);
        return [{ n: neo4j.int(ok ? 1 : 0) }];
      }
      if (q === norm(GRANT_PORTFOLIO_IMPORT_SCOPE_CYPHER) || q === norm(REVOKE_PORTFOLIO_IMPORT_SCOPE_CYPHER)) {
        // Each guard and each SET is read from the statement, so a dropped guard or an extra property write shows.
        const ok = u !== undefined && (u.props['_id'] === params['id'] || u.props['id'] === params['id'])
          && (!q.includes('u.seedProvenance IS NULL') || u.props['seedProvenance'] === undefined)
          && (!q.includes('AND NOT (coalesce(u.defaultPasswordSuspect') || !marked(u))
          && (!q.includes('= $observed') || JSON.stringify(u.props['scopes'] ?? []) === JSON.stringify(params['observed']));
        if (ok) applySet(u!, q, params);
        return [{ n: neo4j.int(ok ? 1 : 0) }];
      }
      throw new Error(`unexpected write ${q}`);
    },
  };
}

describe('grant-platform-admin (P-6)', () => {
  it('flags exactly one ordinary account', async () => {
    const users = [{ elementId: '4:p', props: { _id: 'p', _username: 'pat', _email: 'pat@example.com' } }];

    await expect(grantPlatformAdmin(fakeGraph(users), 'p', 'nick')).resolves.toEqual({ userId: 'p' });
    expect(users[0]!.props).toMatchObject({ platformAdmin: true, platformAdminGrantedBy: 'nick' });
  });

  it.each([
    ['seed provenance', { _id: 'p', seedProvenance: 'pre-cutover-inventory' }, 'seeded_account'],
    ['the init-neo4j id', { id: 'user-admin-001' }, 'seeded_account'],
    ['the admin username', { _id: 'p', _username: 'Admin' }, 'seeded_account'],
    ['the seeded admin email', { _id: 'p', email: 'admin@happycmdb.local' }, 'seeded_account'],
    ['the default-password marker', { _id: 'p', defaultPasswordSuspect: true }, 'seeded_account'],
  ])('refuses an account with %s, writing nothing', async (_label, props, reason) => {
    const users = [{ elementId: '4:p', props: { ...props } as Row }];
    const id = (props as Row)['_id'] ?? (props as Row)['id'];

    await expect(grantPlatformAdmin(fakeGraph(users), String(id), 'nick')).rejects.toMatchObject({ reason });
    expect(users[0]!.props['platformAdmin']).toBeUndefined();
  });

  it('refuses ambiguous and colliding identities', async () => {
    const twin = [{ elementId: '4:a', props: { _id: 'x' } }, { elementId: '4:b', props: { id: 'x' } }];
    const collide = [{ elementId: '4:a', props: { _id: 'x', id: 'y' } }, { elementId: '4:b', props: { id: 'x' } }];

    await expect(grantPlatformAdmin(fakeGraph(twin), 'x', 'nick')).rejects.toBeInstanceOf(GrantRefused);
    await expect(grantPlatformAdmin(fakeGraph(collide), 'y', 'nick')).rejects.toMatchObject({ reason: 'identity_collision' });
    expect([...twin, ...collide].some(u => u.props['platformAdmin'] !== undefined)).toBe(false);
  });
});

describe('portfolio-import scope grant and revoke (HAP-1632)', () => {
  const SCOPE = 'portfolio:import';
  const user = (props: Row = {}): Node => ({ elementId: '4:p', props: { _id: 'p', _username: 'pat', _email: 'pat@example.com', ...props } });
  beforeEach(resetEvents);

  it('adds the scope to a user with none, recording the operator, and touches nothing else', async () => {
    const users = [user({ _role: 'operator', platformAdmin: false })];

    await expect(grantPortfolioImportScope(fakeGraph(users), keysSql, 'p', 'nick')).resolves.toMatchObject({ userId: 'p', outcome: 'granted' });
    expect(users[0]!.props).toMatchObject({ scopes: [SCOPE], portfolioImportScopeGrantedBy: 'nick', _role: 'operator', platformAdmin: false });
    expect(Object.keys(users[0]!.props).sort()).toEqual(['_email', '_id', '_role', '_username', 'platformAdmin',
      'portfolioImportScopeGrantedAt', 'portfolioImportScopeGrantedBy', 'portfolioImportScopeGrantedOpId', 'scopes']);
  });

  it('keeps the other scopes, is idempotent without a second write, and never duplicates the scope', async () => {
    const users = [user({ scopes: ['credentials:manage'] })];
    const graph = fakeGraph(users);

    await expect(grantPortfolioImportScope(graph, keysSql, 'p', 'nick')).resolves.toMatchObject({ outcome: 'granted' });
    expect(users[0]!.props['scopes']).toEqual(['credentials:manage', SCOPE]);
    await expect(grantPortfolioImportScope(graph, keysSql, 'p', 'other')).resolves.toEqual({ userId: 'p', outcome: 'unchanged' });
    expect(users[0]!.props).toMatchObject({ scopes: ['credentials:manage', SCOPE], portfolioImportScopeGrantedBy: 'nick' });
  });

  it('revokes only the portfolio scope, records the operator, and is idempotent', async () => {
    const users = [user({ scopes: ['credentials:manage', SCOPE, 'reports:read'] })];
    const graph = fakeGraph(users);

    await expect(revokePortfolioImportScope(graph, keysSql, 'p', 'nick')).resolves.toMatchObject({ userId: 'p', outcome: 'revoked' });
    expect(users[0]!.props).toMatchObject({ scopes: ['credentials:manage', 'reports:read'], portfolioImportScopeRevokedBy: 'nick' });
    await expect(revokePortfolioImportScope(graph, keysSql, 'p', 'other')).resolves.toEqual({ userId: 'p', outcome: 'unchanged' });
    expect(users[0]!.props).toMatchObject({ scopes: ['credentials:manage', 'reports:read'], portfolioImportScopeRevokedBy: 'nick' });
    const none = [user()];
    await expect(revokePortfolioImportScope(fakeGraph(none), keysSql, 'p', 'nick')).resolves.toMatchObject({ outcome: 'unchanged' });
    expect(none[0]!.props['scopes']).toBeUndefined();
  });

  it.each([
    ['seed provenance', { seedProvenance: 'pre-cutover-inventory' }],
    ['the default-password marker', { defaultPasswordSuspect: true }],
  ])('refuses an account with %s on grant and revoke with GrantRefused, writing nothing', async (_label, props) => {
    for (const change of [grantPortfolioImportScope, revokePortfolioImportScope]) {
      const users = [user({ ...props, scopes: [SCOPE] })];
      const before = structuredClone(users[0]!.props);

      await expect(change(fakeGraph(users), keysSql, 'p', 'nick')).rejects.toMatchObject({ name: 'GrantRefused', reason: 'seeded_account' });
      expect(users[0]!.props).toEqual(before);
    }
  });

  it('refuses unknown, ambiguous and non-list scopes values with GrantRefused, writing nothing', async () => {
    const twin = [{ elementId: '4:a', props: { _id: 'x' } }, { elementId: '4:b', props: { id: 'x' } }];
    const text = [user({ scopes: SCOPE })];
    const mixed = [user({ scopes: [SCOPE, 7] })];

    await expect(grantPortfolioImportScope(fakeGraph([]), keysSql, 'p', 'nick')).rejects.toMatchObject({ reason: 'unknown_identity' });
    await expect(revokePortfolioImportScope(fakeGraph(twin), keysSql, 'x', 'nick')).rejects.toMatchObject({ reason: 'ambiguous_identity' });
    await expect(grantPortfolioImportScope(fakeGraph(text), keysSql, 'p', 'nick')).rejects.toMatchObject({ reason: 'unsupported_value' });
    await expect(revokePortfolioImportScope(fakeGraph(mixed), keysSql, 'p', 'nick')).rejects.toMatchObject({ reason: 'unsupported_value' });
    expect([text[0]!.props['scopes'], mixed[0]!.props['scopes']]).toEqual([SCOPE, [SCOPE, 7]]);
  });

  it.each([
    ['the scope list changed', { scopes: ['a', 'b'] }],
    ['the account was stamped as seed', { seedProvenance: 'pre-cutover-inventory' }],
    ['the account was marked as default-password', { defaultPasswordSuspect: true }],
  ])('writes nothing on grant or revoke when %s after the resolution (compare-and-set under the lock)', async (_label, change) => {
    for (const act of [grantPortfolioImportScope, revokePortfolioImportScope]) {
      const users = [user({ scopes: act === grantPortfolioImportScope ? ['a'] : ['a', SCOPE] })];
      const graph = fakeGraph(users);
      let raced = '';
      const racing: RotationGraph = {
        read: async (cypher, params) => {
          const rows = await graph.read(cypher, params);
          if (norm(cypher) === norm(GRANT_IDENTITY_CYPHER)) {
            Object.assign(users[0]!.props, change);
            raced = JSON.stringify(users[0]!.props);
          }
          return rows;
        },
        write: graph.write,
      };

      await expect(act(racing, keysSql, 'p', 'nick')).rejects.toMatchObject({ name: 'GrantRefused', reason: 'not_applied' });
      expect(JSON.stringify(users[0]!.props)).toBe(raced);
    }
  });

  const quiet = { stdout: () => undefined, stderr: () => undefined };
  it.each([
    ['grant-portfolio-import-scope'], ['revoke-portfolio-import-scope'],
  ])('%s exits 1 before any store opens without --operator or --user-id', async command => {
    for (const [args, message] of [
      [['--user-id', 'p'], '--operator <name> is required'],
      [['--user-id', 'p', '--operator', ' '], '--operator <name> is required'],
      [['--operator', 'nick'], '--user-id <id> is required'],
    ] as const) {
      const lines: string[] = [];
      const code = await main([command, ...args], {}, { ...quiet, stderr: line => lines.push(line) });
      expect([code, lines]).toEqual([1, [`identity-window: ${message}`]]);
    }
  });

  it('lists both commands in the usage an unknown command prints', async () => {
    const lines: string[] = [];
    const code = await main(['bogus'], {}, { ...quiet, stderr: line => lines.push(line) });

    expect(code).toBe(1);
    expect(lines.join('\n')).toEqual(expect.stringContaining('grant-portfolio-import-scope --user-id <id> --operator <name>'));
    expect(lines.join('\n')).toEqual(expect.stringContaining('revoke-portfolio-import-scope --user-id <id> --operator <name>'));
  });

  // HAP-2039 L2: holdsScope refuses a flagged account whatever it stores, but the stored list survives the reset
  // that clears the flag, so revoke (refused while flagged) must follow the reset.
  it('a flagged account holding the grant keeps no scope once its password is reset and the grant revoked', async () => {
    const users = [user({ _passwordHash: await bcrypt.hash('Admin123!', 4), scopes: ['credentials:manage', SCOPE] })];
    const graph = fakeGraph(users);
    const sql = { query: async () => ({ rows: [] }) };
    const loaded = (): User => ({
      _id: 'p', _username: 'pat', _email: 'pat@example.com', _scopes: users[0]!.props['scopes'] as string[],
      _defaultPasswordSuspect: marked(users[0]!),
    } as unknown as User);

    expect(holdsScope(loaded(), SCOPE)).toBe(true);
    await scanDefaultPasswords(graph, sql, (p, h) => bcrypt.compare(p, h), 'nick');
    expect(marked(users[0]!)).toBe(true);
    expect(holdsScope(loaded(), SCOPE)).toBe(false);
    await expect(revokePortfolioImportScope(graph, keysSql, 'p', 'nick')).rejects.toMatchObject({ reason: 'seeded_account' });
    expect(users[0]!.props['scopes']).toEqual(['credentials:manage', SCOPE]);

    // The operator password reset clears the flag; the stored grant is live again until it is revoked.
    const [applied] = await graph.write(APPLY_CYPHER, {
      eid: '4:p', id: 'p', keys: ['p'], key: 'p', eventId: 'e1', newHash: await bcrypt.hash('a-long-new-passphrase', 4),
      e0: neo4j.int(0), targetEpoch: neo4j.int(1),
    });
    expect(num(applied!['n'])).toBe(1);
    expect(marked(users[0]!)).toBe(false);
    expect(users[0]!.props['defaultPasswordSuspect']).toBe(false);
    expect(holdsScope(loaded(), SCOPE)).toBe(true);

    await expect(revokePortfolioImportScope(graph, keysSql, 'p', 'nick')).resolves.toMatchObject({ userId: 'p', outcome: 'revoked' });
    expect(users[0]!.props['scopes']).toEqual(['credentials:manage']);
    expect(holdsScope(loaded(), SCOPE)).toBe(false);
  });
});

describe('portfolio-import scope audit events (HAP-2039)', () => {
  const SCOPE = 'portfolio:import';
  const user = (props: Row = {}): Node => ({ elementId: '4:p', props: { _id: 'p', _username: 'pat', _email: 'pat@example.com', ...props } });
  // Insertion order, not ORDER BY occurred_at: two statements can share a timestamp, and the table is append-only.
  // The actor of a recovery row ends in `#<operation id>`; `actor` is the stored one without it, `operationId` the id.
  const events = async () => (await send('query', `SELECT id, user_id, event, actor, occurred_at,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_text,
    ref_event_id, target_epoch, reason, revoked_api_keys FROM auth_credential_events`)).map(row => ({
    ...row, actor: String(row['actor']).replace(/#[0-9a-f]{32}$/, ''), operationId: /#([0-9a-f]{32})$/.exec(String(row['actor']))?.[1] ?? null,
  }));
  const storesOf = (users: Node[]) => ({ graph: fakeGraph(users), sql: keysSql, lock: { acquire: async () => undefined, release: async () => undefined }, close: async () => undefined });
  const open = operatorStores.openOperatorStores as jest.MockedFunction<typeof operatorStores.openOperatorStores>;
  const realOpen = open.getMockImplementation()!;
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {}, { stdout: line => out.push(line), stderr: line => err.push(line) });
    return { code, out, err };
  };

  beforeEach(async () => {
    await resetEvents();
    open.mockReset();
    open.mockImplementation(realOpen);
  });

  it('two grant/revoke cycles leave four append-only rows in order; the node keeps only the latest pair', async () => {
    const users = [user()];
    const graph = fakeGraph(users);

    await grantPortfolioImportScope(graph, keysSql, 'p', 'alice');
    await revokePortfolioImportScope(graph, keysSql, 'p', 'alice');
    await grantPortfolioImportScope(graph, keysSql, 'p', 'bob');
    await revokePortfolioImportScope(graph, keysSql, 'p', 'bob');

    const rows = await events();
    expect(rows.map(r => [r['event'], r['user_id'], r['actor']])).toEqual([
      ['portfolio_import_scope_granted', 'p', 'window-script:alice'],
      ['portfolio_import_scope_revoked', 'p', 'window-script:alice'],
      ['portfolio_import_scope_granted', 'p', 'window-script:bob'],
      ['portfolio_import_scope_revoked', 'p', 'window-script:bob'],
    ]);
    expect(new Set(rows.map(r => r['id'])).size).toBe(4);
    const times = rows.map(r => (r['occurred_at'] as Date).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(rows.every(r => r['ref_event_id'] === null && r['target_epoch'] === null && r['reason'] === null && r['revoked_api_keys'] === null)).toBe(true);
    // History lives in the table: the node's properties name only the last operator.
    expect(users[0]!.props).toMatchObject({ scopes: [], portfolioImportScopeGrantedBy: 'bob', portfolioImportScopeRevokedBy: 'bob' });
  });

  it('prints the operator, the row time and the row id for granted and revoked', async () => {
    const graph = fakeGraph([user()]);

    const granted = await grantPortfolioImportScope(graph, keysSql, 'p', 'alice');
    const revoked = await revokePortfolioImportScope(graph, keysSql, 'p', 'alice');

    const [first, second] = await events();
    expect(Object.keys(granted)).toEqual(['userId', 'outcome', 'operator', 'occurredAt', 'eventId']);
    expect(granted).toEqual({ userId: 'p', outcome: 'granted', operator: 'alice', occurredAt: first!['occurred_text'], eventId: first!['id'] });
    expect(revoked).toEqual({ userId: 'p', outcome: 'revoked', operator: 'alice', occurredAt: second!['occurred_text'], eventId: second!['id'] });
    // Full precision: the printed value selects exactly its own row.
    for (const [printed, row] of [[granted, first], [revoked, second]] as const) {
      expect(await send('query', 'SELECT id FROM auth_credential_events WHERE occurred_at = $1', [(printed as { occurredAt: string }).occurredAt]))
        .toEqual([{ id: row!['id'] }]);
    }
  });

  it('writes no row, and prints nothing more than the id and outcome, when the scope is already as asked', async () => {
    const held = fakeGraph([user({ scopes: [SCOPE] })]);
    const absent = fakeGraph([user()]);

    await expect(grantPortfolioImportScope(held, keysSql, 'p', 'alice')).resolves.toEqual({ userId: 'p', outcome: 'unchanged' });
    await expect(revokePortfolioImportScope(absent, keysSql, 'p', 'alice')).resolves.toEqual({ userId: 'p', outcome: 'unchanged' });
    expect(await events()).toEqual([]);
  });

  it('writes no row and no node change for any refused change, including a lost compare-and-set race', async () => {
    const twin = [{ elementId: '4:a', props: { _id: 'x' } }, { elementId: '4:b', props: { id: 'x' } }];
    const collide = [{ elementId: '4:a', props: { _id: 'x', id: 'y' } }, { elementId: '4:b', props: { id: 'x' } }];
    const cases: Array<[string, Node[], string]> = [
      ['unknown', [], 'p'], ['ambiguous', twin, 'x'], ['collision', collide, 'y'],
      ['seeded', [user({ seedProvenance: 'pre-cutover-inventory' })], 'p'],
      ['default-password flagged', [user({ defaultPasswordSuspect: true })], 'p'],
      ['non-list scopes', [user({ scopes: SCOPE })], 'p'],
    ];
    for (const [label, users, id] of cases) {
      for (const change of [grantPortfolioImportScope, revokePortfolioImportScope]) {
        const before = JSON.stringify(users);
        await expect(change(fakeGraph(users), keysSql, id, 'alice')).rejects.toBeInstanceOf(GrantRefused);
        expect([label, JSON.stringify(users)]).toEqual([label, before]);
      }
    }
    for (const change of [grantPortfolioImportScope, revokePortfolioImportScope]) {
      const users = [user({ scopes: change === grantPortfolioImportScope ? ['a'] : ['a', SCOPE] })];
      const graph = fakeGraph(users);
      let raced = '';
      const racing: RotationGraph = {
        read: async (cypher, params) => {
          const rows = await graph.read(cypher, params);
          if (norm(cypher) === norm(GRANT_IDENTITY_CYPHER)) {
            users[0]!.props['scopes'] = ['b'];
            raced = JSON.stringify(users);
          }
          return rows;
        },
        write: graph.write,
      };
      await expect(change(racing, keysSql, 'p', 'alice')).rejects.toMatchObject({ reason: 'not_applied' });
      expect(JSON.stringify(users)).toBe(raced);
    }
    expect(await events()).toEqual([]);
  });

  /** keysSql, except that the audit insert answers with `onInsert`. */
  const insertting = (onInsert: () => { rows: Row[] }): RotationSql => sqlOver(async (text, params = []) =>
    /INSERT INTO auth_credential_events/.test(text) ? onInsert() : { rows: await send('query', text, params) });
  const RECORD = 'identity-window record-portfolio-import-scope';

  it('throws AuditWriteFailed with fixed text naming the record-only command of its own action when the insert fails; the Neo4j change stays applied', async () => {
    const users = [user()];
    const failing = insertting(() => { throw new Error('password=hunter2 connection refused'); });

    const error = await grantPortfolioImportScope(fakeGraph(users), failing, 'p', 'alice').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuditWriteFailed);
    expect((error as Error).message).toBe(
      `portfolio-import scope grant: the scope change is applied but its audit row was not written; record it with: ${RECORD} --grant --user-id <id> --operator <name>`);
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect(users[0]!.props).toMatchObject({ scopes: [SCOPE], portfolioImportScopeGrantedBy: 'alice' });
    await expect(revokePortfolioImportScope(fakeGraph(users), failing, 'p', 'alice')).rejects.toMatchObject({
      name: 'AuditWriteFailed',
      message: `portfolio-import scope revoke: the scope change is applied but its audit row was not written; record it with: ${RECORD} --revoke --user-id <id> --operator <name>`,
    });
    expect(users[0]!.props['scopes']).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('a commit that fails after the insert is also AuditWriteFailed: the row is not in the table, the Neo4j change stays', async () => {
    const users = [user()];
    const failingCommit: RotationSql = {
      query: keysSql.query,
      transaction: async callback => {
        await send('exec', 'BEGIN');
        try {
          await callback(keysSql);
        } finally {
          await send('exec', 'ROLLBACK');
        }
        throw new Error('commit failed: password=hunter2');
      },
    };

    const error = await grantPortfolioImportScope(fakeGraph(users), failingCommit, 'p', 'alice').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuditWriteFailed);
    expect(JSON.stringify(error)).not.toContain('hunter2');
    expect(users[0]!.props['scopes']).toEqual([SCOPE]);
    expect(await events()).toEqual([]);
  });

  it('main exits 3 with the fixed message naming the record-only command of its own action, and following that command appends the row without changing the scope', async () => {
    const users = [user()];
    open.mockReturnValue(storesOf(users));
    const recorded: Array<[string, string]> = [];
    for (const [command, scopes] of [
      ['grant-portfolio-import-scope', [SCOPE]],
      ['revoke-portfolio-import-scope', []],
    ] as const) {
      await send('exec', 'DROP TABLE auth_credential_events');

      const failed = await run([command, '--user-id', 'p', '--operator', 'alice']);

      const action = command === 'grant-portfolio-import-scope' ? 'grant' : 'revoke';
      expect([failed.code, failed.out]).toEqual([3, []]);
      expect(failed.err).toEqual([`identity-window: portfolio-import scope ${action}: the scope change is applied but its audit row was not written; record it with: ${RECORD} --${action} --user-id <id> --operator <name>`]);
      expect(users[0]!.props['scopes']).toEqual(scopes);
      expect(await send('query', `SELECT to_regclass('public.auth_credential_events')::text AS t`)).toEqual([{ t: null }]);

      // The operator follows the printed text once the audit store is writable again.
      await resetEvents();
      const [, printed] = /identity-window (record-portfolio-import-scope --(?:grant|revoke)) --user-id <id> --operator <name>$/.exec(failed.err[0]!)!;
      const [recordCommand, flag] = printed!.split(' ') as [string, string];
      const before = JSON.stringify(users);
      const record = await run([recordCommand, flag, '--user-id', 'p', '--operator', 'alice']);

      expect(record.code).toBe(0);
      expect(JSON.stringify(users)).toBe(before);
      recorded.push(...(await events()).map(r => [String(r['event']), String(r['actor'])] as [string, string]));
    }
    expect(recorded).toEqual([
      ['portfolio_import_scope_granted', 'window-script-record:alice'],
      ['portfolio_import_scope_revoked', 'window-script-record:alice'],
    ]);
  });

  it('main does not claim the audit row was not written when the insert succeeded and shaping its result fails', async () => {
    const users = [user()];
    open.mockReturnValue({ ...storesOf(users), sql: insertting(() => ({ rows: [null as never] })) });

    const { code, out, err } = await run(['grant-portfolio-import-scope', '--user-id', 'p', '--operator', 'alice']);

    expect([code, out]).toEqual([1, []]);
    expect(err).toHaveLength(1);
    expect(err[0]).not.toContain('audit row was not written');
  });

  it('main stores the trimmed operator, prints the result line, and accepts exactly 200 characters', async () => {
    const users = [user()];
    open.mockReturnValue(storesOf(users));

    const granted = await run(['grant-portfolio-import-scope', '--user-id', 'p', '--operator', '  alice  ']);
    const long = 'é'.repeat(200);
    const revoked = await run(['revoke-portfolio-import-scope', '--user-id', 'p', '--operator', long]);

    const [first, second] = await events();
    expect(granted.code).toBe(0);
    expect(JSON.parse(granted.out[0]!)).toEqual({ userId: 'p', outcome: 'granted', operator: 'alice', occurredAt: first!['occurred_text'], eventId: first!['id'] });
    expect(first!['actor']).toBe('window-script:alice');
    expect(users[0]!.props['portfolioImportScopeGrantedBy']).toBe('alice');
    expect(revoked.code).toBe(0);
    expect(second!['actor']).toBe(`window-script:${long}`);
  });

  it('main prints only the id and outcome for unchanged, and writes no row', async () => {
    open.mockReturnValue(storesOf([user()]));

    const { code, out } = await run(['revoke-portfolio-import-scope', '--user-id', 'p', '--operator', 'alice']);

    expect([code, out]).toEqual([0, ['{"userId":"p","outcome":"unchanged"}']]);
    expect(await events()).toEqual([]);
  });

  it.each([
    ['201 characters', 'a'.repeat(201)],
    ['a newline', 'ali\nce'],
    ['a NUL', 'ali\u0000ce'],
    ['a DEL', 'ali\u007fce'],
    ['a C1 control', 'ali\u0085ce'],
    ['a line separator', 'ali\u2028ce'],
    ['a right-to-left override (format character)', 'ali\u202ece'],
    ['a zero-width space (format character)', 'ali\u200bce'],
  ])('main refuses an --operator with %s before any store opens, without echoing it', async (_label, operator) => {
    for (const command of ['grant-portfolio-import-scope', 'revoke-portfolio-import-scope', 'record-portfolio-import-scope']) {
      open.mockReturnValue(storesOf([user()]));
      const { code, out, err } = await run([command, ...(command.startsWith('record') ? ['--grant'] : []), '--user-id', 'p', '--operator', operator]);

      expect([code, out, err]).toEqual([1, [], ['identity-window: --operator must be 1-200 printable characters']]);
      expect(open).not.toHaveBeenCalled();
    }
    expect(await events()).toEqual([]);
  });

  it('keeps the rows append-only: UPDATE, DELETE and TRUNCATE of a grant/revoke row fail with SQLSTATE 55000', async () => {
    await grantPortfolioImportScope(fakeGraph([user()]), keysSql, 'p', 'alice');

    for (const statement of [`UPDATE auth_credential_events SET actor = 'x'`, 'DELETE FROM auth_credential_events', 'TRUNCATE auth_credential_events']) {
      await expect(send('exec', statement)).rejects.toMatchObject({ code: '55000' });
    }
    expect(await events()).toHaveLength(1);
  });

  // HAP-2129: record-only recovery and the per-user lock.
  const RECORD_CMD = 'record-portfolio-import-scope';
  /** The graph with every read and write counted, and optionally logged in `log`. */
  const counted = (inner: RotationGraph, log: string[] = []) => {
    const calls = { reads: 0, writes: 0 };
    const graph: RotationGraph = {
      read: async (cypher, params) => { calls.reads++; log.push('neo4j-read'); return inner.read(cypher, params); },
      write: async (cypher, params) => { calls.writes++; log.push('neo4j-write'); return inner.write(cypher, params); },
    };
    return { calls, graph };
  };

  it.each([
    ['--grant', [SCOPE], 'portfolio_import_scope_granted', 'granted'],
    ['--revoke', [], 'portfolio_import_scope_revoked', 'revoked'],
  ] as const)('%s record-only appends exactly one row for the applied change and makes zero Neo4j writes', async (flag, scopes, event, outcome) => {
    const users = [user({ scopes: [...scopes] })];
    const { calls, graph } = counted(fakeGraph(users));
    open.mockReturnValue({ ...storesOf(users), graph });
    const before = JSON.stringify(users);

    const { code, out, err } = await run([RECORD_CMD, flag, '--user-id', 'p', '--operator', '  carol  ']);

    const rows = await events();
    expect([code, err]).toEqual([0, []]);
    expect(rows.map(r => [r['event'], r['user_id'], r['actor']])).toEqual([[event, 'p', 'window-script-record:carol']]);
    expect(JSON.parse(out[0]!)).toEqual({ userId: 'p', outcome, operator: 'carol', occurredAt: rows[0]!['occurred_text'], eventId: rows[0]!['id'], recordOnly: true, alreadyRecorded: false });
    expect(calls.reads).toBeGreaterThan(0);
    expect(calls.writes).toBe(0);
    expect(JSON.stringify(users)).toBe(before);
  });

  it.each([
    ['--grant', 'the user does not hold portfolio:import', []],
    ['--revoke', 'the user still holds portfolio:import', [SCOPE]],
  ] as const)('%s record-only refuses when %s: exit 2, no row, no Neo4j write', async (flag, _why, scopes) => {
    const users = [user({ scopes: [...scopes] })];
    const { calls, graph } = counted(fakeGraph(users));
    open.mockReturnValue({ ...storesOf(users), graph });

    const { code, out, err } = await run([RECORD_CMD, flag, '--user-id', 'p', '--operator', 'carol']);

    expect([code, out, err]).toEqual([2, [], ['identity-window: portfolio-import scope record refused: scope_state_mismatch']]);
    expect(await events()).toEqual([]);
    expect(calls.writes).toBe(0);
    expect(users[0]!.props['scopes']).toEqual(scopes);
  });

  it('record-only applies the identity refusals of grant and revoke: no row for an unknown, ambiguous, seeded, flagged or malformed user', async () => {
    const twin = [{ elementId: '4:a', props: { _id: 'x' } }, { elementId: '4:b', props: { id: 'x' } }];
    const cases: Array<[string, Node[], string, string]> = [
      ['unknown', [], 'p', 'unknown_identity'], ['ambiguous', twin, 'x', 'ambiguous_identity'],
      ['seeded', [user({ scopes: [SCOPE], seedProvenance: 'pre-cutover-inventory' })], 'p', 'seeded_account'],
      ['flagged', [user({ scopes: [SCOPE], defaultPasswordSuspect: true })], 'p', 'seeded_account'],
      ['non-list scopes', [user({ scopes: SCOPE })], 'p', 'unsupported_value'],
    ];
    for (const [, users, id, reason] of cases) {
      for (const grant of [true, false]) {
        await expect(recordPortfolioImportScope(fakeGraph(users), keysSql, id, 'carol', grant)).rejects.toMatchObject({ name: 'GrantRefused', reason });
      }
    }
    expect(await events()).toEqual([]);
  });

  it('record-only needs exactly one of --grant and --revoke, refused before any store opens', async () => {
    for (const flags of [[], ['--grant', '--revoke']]) {
      open.mockReturnValue(storesOf([user({ scopes: [SCOPE] })]));

      const { code, out, err } = await run([RECORD_CMD, ...flags, '--user-id', 'p', '--operator', 'carol']);

      expect([code, out, err]).toEqual([1, [], ['identity-window: exactly one of --grant or --revoke is required']]);
      expect(open).not.toHaveBeenCalled();
    }
    expect(await events()).toEqual([]);
  });

  it('record-only that cannot write its row exits 1 with fixed text, never 3, and changed nothing', async () => {
    const users = [user({ scopes: [SCOPE] })];
    const before = JSON.stringify(users);
    const { calls, graph } = counted(fakeGraph(users));
    open.mockReturnValue({ ...storesOf(users), graph, sql: insertting(() => { throw new Error('password=hunter2 connection refused'); }) });

    const { code, out, err } = await run([RECORD_CMD, '--grant', '--user-id', 'p', '--operator', 'carol']);

    expect([code, out]).toEqual([1, []]);
    expect(err).toEqual(['identity-window: portfolio-import scope record: the audit row was not written and nothing else was changed; run the same command again']);
    expect(calls.writes).toBe(0);
    expect(JSON.stringify(users)).toBe(before);
    expect(await events()).toEqual([]);
  });

  // HAP-2131: recovery rows are told apart from real ones, and a retry adds none.
  const REAL_ACTOR = 'window-script:alice';
  const RECORD_ACTOR = 'window-script-record:alice';
  const rowsOf = async () => (await events()).map(r => [String(r['event']), String(r['actor'])]);

  it('a recovery row has the same event as the real one but its own actor marker, and a retry adds no row', async () => {
    const users = [user()];
    await grantPortfolioImportScope(fakeGraph(users), keysSql, 'p', 'alice'); // a real grant row
    await revokePortfolioImportScope(fakeGraph(users), insertting(() => { throw new Error('down'); }), 'p', 'alice').catch(() => undefined); // applied, no row
    expect(users[0]!.props['scopes']).toEqual([]);
    open.mockReturnValue(storesOf(users));

    const first = await run([RECORD_CMD, '--revoke', '--user-id', 'p', '--operator', 'alice']);
    const retry = await run([RECORD_CMD, '--revoke', '--user-id', 'p', '--operator', 'bob']);

    expect(await rowsOf()).toEqual([
      ['portfolio_import_scope_granted', REAL_ACTOR], ['portfolio_import_scope_revoked', RECORD_ACTOR],
    ]);
    const rows = await events();
    expect([first.code, retry.code]).toEqual([0, 0]);
    expect(JSON.parse(first.out[0]!)).toMatchObject({ outcome: 'revoked', operator: 'alice', eventId: rows[1]!['id'], recordOnly: true, alreadyRecorded: false });
    // The retry (even by another operator) reports the row that already covers the change, and writes nothing.
    expect(JSON.parse(retry.out[0]!)).toEqual({ userId: 'p', outcome: 'revoked', operator: 'alice', occurredAt: rows[1]!['occurred_text'], eventId: rows[1]!['id'], recordOnly: true, alreadyRecorded: true });
  });

  it('a later change is recorded again: only a recovery row that is the latest scope row of the same event covers a record', async () => {
    const users = [user()];
    const failing = insertting(() => { throw new Error('down'); });
    open.mockReturnValue(storesOf(users));
    const record = (flag: string) => run([RECORD_CMD, flag, '--user-id', 'p', '--operator', 'alice']);

    await grantPortfolioImportScope(fakeGraph(users), failing, 'p', 'alice').catch(() => undefined);
    await record('--grant');
    await revokePortfolioImportScope(fakeGraph(users), failing, 'p', 'alice').catch(() => undefined); // revoked, no row
    await record('--revoke');
    await grantPortfolioImportScope(fakeGraph(users), failing, 'p', 'alice').catch(() => undefined); // granted again, no row
    await record('--grant');
    await record('--grant');

    expect(await rowsOf()).toEqual([
      ['portfolio_import_scope_granted', RECORD_ACTOR], ['portfolio_import_scope_revoked', RECORD_ACTOR], ['portfolio_import_scope_granted', RECORD_ACTOR],
    ]);
  });

  it('a real row after a recovery row of the same event means the next record appends again', async () => {
    const users = [user()];
    const failing = insertting(() => { throw new Error('down'); });
    open.mockReturnValue(storesOf(users));
    await grantPortfolioImportScope(fakeGraph(users), failing, 'p', 'alice').catch(() => undefined);
    await run([RECORD_CMD, '--grant', '--user-id', 'p', '--operator', 'alice']);
    await revokePortfolioImportScope(fakeGraph(users), keysSql, 'p', 'alice');
    await grantPortfolioImportScope(fakeGraph(users), failing, 'p', 'alice').catch(() => undefined);

    await run([RECORD_CMD, '--grant', '--user-id', 'p', '--operator', 'alice']);

    expect(await rowsOf()).toEqual([
      ['portfolio_import_scope_granted', RECORD_ACTOR], ['portfolio_import_scope_revoked', REAL_ACTOR], ['portfolio_import_scope_granted', RECORD_ACTOR],
    ]);
  });

  it('a recovery row of one user never covers another user', async () => {
    const users = [user({ scopes: [SCOPE] }), { elementId: '4:q', props: { _id: 'q', _username: 'quinn', scopes: [SCOPE] } }];
    open.mockReturnValue(storesOf(users));

    for (const id of ['p', 'q']) await run([RECORD_CMD, '--grant', '--user-id', id, '--operator', 'alice']);

    expect((await events()).map(r => r['user_id'])).toEqual(['p', 'q']);
  });

  // HAP-2131: a Neo4j write that errors on the client after the server committed it.
  /** The graph whose scope write is applied and then errors, as `tx.commit()` rejecting after the server committed. */
  const commitThenError = (inner: RotationGraph, apply: boolean, rereadFails = false): RotationGraph => {
    let failed = false;
    return {
      read: async (cypher, params) => {
        if (failed && rereadFails) throw new Error('neo4j unreachable password=hunter2');
        return inner.read(cypher, params);
      },
      write: async (cypher, params) => {
        failed = true;
        if (apply) await inner.write(cypher, params);
        throw new Error('commit acknowledgement lost password=hunter2');
      },
    };
  };

  it.each([
    ['grant-portfolio-import-scope', 'grant', [], [SCOPE]],
    ['revoke-portfolio-import-scope', 'revoke', [SCOPE], []],
  ] as const)('%s whose Neo4j commit applied but errored on the client exits 3 with the record-only recovery, and that recovery succeeds', async (command, action, before, after) => {
    const users = [user({ scopes: [...before] })];
    open.mockReturnValue({ ...storesOf(users), graph: commitThenError(fakeGraph(users), true) });

    const failed = await run([command, '--user-id', 'p', '--operator', 'alice']);

    expect([failed.code, failed.out]).toEqual([3, []]);
    expect(failed.err).toEqual([`identity-window: portfolio-import scope ${action}: the scope change is applied but its audit row was not written; record it with: ${RECORD} --${action} --user-id <id> --operator <name>`]);
    expect(JSON.stringify(failed.err)).not.toContain('hunter2');
    expect(users[0]!.props['scopes']).toEqual(after);
    expect(await events()).toEqual([]);

    open.mockReturnValue(storesOf(users));
    const record = await run([RECORD_CMD, `--${action}`, '--user-id', 'p', '--operator', 'alice']);

    expect(record.code).toBe(0);
    expect(await rowsOf()).toEqual([[action === 'grant' ? 'portfolio_import_scope_granted' : 'portfolio_import_scope_revoked', RECORD_ACTOR]]);
  });

  it('a Neo4j write error that did not apply the change exits 1 with the error text redacted, and so does one whose state cannot be re-read', async () => {
    for (const [apply, rereadFails] of [[false, false], [true, true]] as const) {
      const users = [user()];
      open.mockReturnValue({ ...storesOf(users), graph: commitThenError(fakeGraph(users), apply, rereadFails) });

      const { code, out, err } = await run(['grant-portfolio-import-scope', '--user-id', 'p', '--operator', 'alice']);

      expect([code, out]).toEqual([1, []]);
      expect(err).toEqual(['identity-window: commit acknowledgement lost password=***']);
      expect(err.join()).not.toContain('hunter2');
    }
  });

  // HAP-2136 F2: the write errored, the re-read did not show the change, and Neo4j applies it afterwards.
  const AMBIGUOUS_ACTOR = 'window-script-ambiguous:alice';
  /** The graph whose scope write errors without applying; `land()` is the server applying it afterwards. */
  const lateCommit = (users: Node[]) => {
    const inner = fakeGraph(users);
    let pendingWrite: (() => Promise<unknown>) | undefined;
    const graph: RotationGraph = {
      read: inner.read,
      write: async (cypher, params) => {
        pendingWrite = () => inner.write(cypher, params);
        throw new Error('commit acknowledgement lost password=hunter2');
      },
    };
    return { graph, land: async () => { await pendingWrite!(); } };
  };

  it.each([
    ['grant-portfolio-import-scope', [], 'portfolio_import_scope_granted', [SCOPE]],
    ['revoke-portfolio-import-scope', [SCOPE], 'portfolio_import_scope_revoked', []],
  ] as const)('%s whose write lands after the re-read exits 1 with an ambiguous row for the requested change', async (command, before, event, after) => {
    const users = [user({ scopes: [...before] })];
    const { graph, land } = lateCommit(users);
    open.mockReturnValue({ ...storesOf(users), graph });

    const { code, out, err } = await run([command, '--user-id', 'p', '--operator', 'alice']);
    await land();

    expect([code, out]).toEqual([1, []]);
    expect(err).toEqual(['identity-window: commit acknowledgement lost password=***']);
    expect(users[0]!.props['scopes']).toEqual(after);
    expect((await events()).map(r => [r['user_id'], r['event'], r['actor']])).toEqual([['p', event, AMBIGUOUS_ACTOR]]);
  });

  it('an unreadable state after the write error also leaves an ambiguous row; a failing ambiguous insert keeps exit 1 and writes nothing', async () => {
    const users = [user()];
    open.mockReturnValue({ ...storesOf(users), graph: commitThenError(fakeGraph(users), true, true) });

    const unreadable = await run(['grant-portfolio-import-scope', '--user-id', 'p', '--operator', 'alice']);

    expect(unreadable.code).toBe(1);
    expect((await events()).map(r => [r['event'], r['actor']])).toEqual([['portfolio_import_scope_granted', AMBIGUOUS_ACTOR]]);

    await resetEvents();
    const second = [user()];
    open.mockReturnValue({ ...storesOf(second), graph: lateCommit(second).graph, sql: insertting(() => { throw new Error('password=hunter2 insert refused'); }) });

    const failed = await run(['grant-portfolio-import-scope', '--user-id', 'p', '--operator', 'alice']);

    expect([failed.code, failed.out]).toEqual([1, []]);
    expect(failed.err).toEqual(['identity-window: commit acknowledgement lost password=***']);
    expect(await events()).toEqual([]);
  });

  it('an ambiguous row never counts as a recovery row: the next record appends its own', async () => {
    const users = [user()];
    const { graph, land } = lateCommit(users);
    open.mockReturnValue({ ...storesOf(users), graph });
    await run(['grant-portfolio-import-scope', '--user-id', 'p', '--operator', 'alice']);
    await land();
    open.mockReturnValue(storesOf(users));

    const record = await run([RECORD_CMD, '--grant', '--user-id', 'p', '--operator', 'alice']);

    expect(JSON.parse(record.out[0]!)).toMatchObject({ outcome: 'granted', recordOnly: true, alreadyRecorded: false });
    expect(await rowsOf()).toEqual([['portfolio_import_scope_granted', AMBIGUOUS_ACTOR], ['portfolio_import_scope_granted', RECORD_ACTOR]]);
  });

  // HAP-2136 M1: whether a recovery row covers a record is decided by the operation id alone, never by a clock. The
  // skew moves the Neo4j timestamp of each change 5 s behind, level with, or 5 s ahead of this host's clock (PostgreSQL's).
  const skewed = (users: Node[], skewMs: number): RotationGraph => {
    const inner = fakeGraph(users);
    return {
      read: inner.read,
      write: async (cypher, params) => {
        const result = await inner.write(cypher, params);
        users.find(n => n.elementId === params['eid'])!.props[cypher.includes('GrantedAt') ? 'portfolioImportScopeGrantedAt' : 'portfolioImportScopeRevokedAt'] = new Date(Date.now() + skewMs);
        return result;
      },
    };
  };
  it.each([[-5000], [0], [5000]])('a skipped recovery between two records of one event is not absorbed by the earlier recovery row, with the Neo4j clock %i ms off', async skewMs => {
    const users = [user()];
    const failing = insertting(() => { throw new Error('down'); });
    const graph = skewed(users, skewMs);
    open.mockReturnValue({ ...storesOf(users), graph });
    const record = (flag: string) => run([RECORD_CMD, flag, '--user-id', 'p', '--operator', 'alice']);
    const exit3 = (change: typeof grantPortfolioImportScope) => expect(change(graph, failing, 'p', 'alice')).rejects.toBeInstanceOf(AuditWriteFailed);

    await exit3(grantPortfolioImportScope);
    const first = await record('--grant');
    await exit3(revokePortfolioImportScope); // recovery skipped
    await exit3(grantPortfolioImportScope);
    const second = await record('--grant');
    const retry = await record('--grant');

    expect([first, second, retry].map(r => [r.code, JSON.parse(r.out[0]!).alreadyRecorded])).toEqual([[0, false], [0, false], [0, true]]);
    expect(await rowsOf()).toEqual([['portfolio_import_scope_granted', RECORD_ACTOR], ['portfolio_import_scope_granted', RECORD_ACTOR]]);
    const rows = await events();
    expect(rows[0]!['operationId']).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[1]!['operationId']).toBe(users[0]!.props['portfolioImportScopeGrantedOpId']);
    expect(rows[1]!['operationId']).not.toBe(rows[0]!['operationId']);
    expect(JSON.parse(retry.out[0]!).eventId).toBe(rows[1]!['id']);
  });

  it('a node whose marker has no operation id is never absorbed: each record appends its own row, without a suffix', async () => {
    const users = [user({ scopes: [SCOPE] })];
    open.mockReturnValue(storesOf(users));

    const results = [await run([RECORD_CMD, '--grant', '--user-id', 'p', '--operator', 'alice']), await run([RECORD_CMD, '--grant', '--user-id', 'p', '--operator', 'alice'])];

    expect(results.map(r => JSON.parse(r.out[0]!).alreadyRecorded)).toEqual([false, false]);
    expect((await events()).map(r => [r['actor'], r['operationId']])).toEqual([[RECORD_ACTOR, null], [RECORD_ACTOR, null]]);
  });

  // HAP-2136 F3
  it('redacts credential-like content of an error text before it is printed', () => {
    expect(redactSecrets('connect failed: password=hunter2 token=abc.def secret: s3cr3t client_secret="two words" Authorization: Bearer eyJhbGciOi.x.y bolt://neo4j:pw%40d@db.internal:7687/x'))
      .toBe('connect failed: password=*** token=*** secret: *** client_secret=*** Authorization: Bearer *** bolt://***@db.internal:7687/x');
    expect(redactSecrets('connect ECONNREFUSED 10.0.0.5:5432')).toBe('connect ECONNREFUSED 10.0.0.5:5432');
  });

  // HAP-2136 F4
  it.each([
    [['grant-portfolio-import-scope', '--operator', '--user-id', 'p'], '--operator'],
    [['grant-portfolio-import-scope', '--user-id', '--operator', 'alice'], '--user-id'],
    [['stamp', '--except', '--user-id', 'p'], '--except'],
  ] as const)('%j: a value flag followed by another flag is a usage error before any store opens', async (argv, flag) => {
    open.mockReturnValue(storesOf([user()]));

    const { code, out, err } = await run([...argv]);

    expect([code, out, err]).toEqual([1, [], [`identity-window: ${flag} requires a value, found another flag in its place`]]);
    expect(open).not.toHaveBeenCalled();
    expect(await events()).toEqual([]);
  });

  it('a node whose id moves between the two reads under the lock is refused with no write and no row', async () => {
    const users = [user({ id: 'alias' })];
    const graph = fakeGraph(users);
    let identityReads = 0;
    const moving: RotationGraph = {
      read: async (cypher, params) => {
        const rows = await graph.read(cypher, params);
        if (norm(cypher) === norm(GRANT_IDENTITY_CYPHER) && ++identityReads === 1) users[0]!.props['_id'] = 'q';
        return rows;
      },
      write: graph.write,
    };
    const { calls, graph: counting } = counted(moving);

    for (const act of [
      () => grantPortfolioImportScope(counting, keysSql, 'alias', 'alice'),
      () => recordPortfolioImportScope(counting, keysSql, 'alias', 'alice', false),
    ]) {
      identityReads = 0;
      users[0]!.props['_id'] = 'p';
      await expect(act()).rejects.toMatchObject({ name: 'GrantRefused', reason: 'not_applied' });
    }

    expect(calls.writes).toBe(0);
    expect(users[0]!.props['scopes']).toBeUndefined();
    expect(await events()).toEqual([]);
  });

  it('--grant and --revoke are flags only: as the value of another flag they are not a direction', async () => {
    open.mockReturnValue(storesOf([user()]));

    const none = await run([RECORD_CMD, '--operator', '--grant', '--user-id', 'p']);
    const both = await run([RECORD_CMD, '--user-id', '--revoke', '--operator', '--grant']);

    expect([none.code, none.out, none.err]).toEqual([1, [], ['identity-window: exactly one of --grant or --revoke is required']]);
    expect(both.code).toBe(1);
    expect(open).not.toHaveBeenCalled();
    expect(await events()).toEqual([]);

    // The value is the operator; the real flag still decides the direction.
    open.mockReturnValue(storesOf([user()]));
    const revoke = await run([RECORD_CMD, '--revoke', '--operator', '--grant', '--user-id', 'p']);
    expect(revoke.code).toBe(0);
    expect(await rowsOf()).toEqual([['portfolio_import_scope_revoked', 'window-script-record:--grant']]);
  });

  it.each([
    ['grant-portfolio-import-scope', [], 'portfolio-import scope grant'],
    ['revoke-portfolio-import-scope', [], 'portfolio-import scope revoke'],
    [RECORD_CMD, ['--grant'], 'portfolio-import scope record'],
  ] as const)('%s refuses before any Neo4j access when PostgreSQL cannot be reached or refuses the lock, without echoing the cause', async (command, extra, action) => {
    const unreachable: RotationSql = { query: keysSql.query, transaction: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'); } };
    const refusesLock = sqlOver(async () => { throw new Error('canceling statement due to lock timeout password=hunter2'); });
    for (const sql of [unreachable, refusesLock]) {
      const users = [user({ scopes: command === RECORD_CMD ? [SCOPE] : [] })];
      const before = JSON.stringify(users);
      const { calls, graph } = counted(fakeGraph(users));
      open.mockReturnValue({ ...storesOf(users), graph, sql });

      const { code, out, err } = await run([command, ...extra, '--user-id', 'p', '--operator', 'carol']);

      expect([code, out]).toEqual([1, []]);
      expect(err).toEqual([`identity-window: ${action} refused: PostgreSQL is unavailable, so the per-user lock could not be taken; nothing was changed`]);
      expect(calls).toEqual({ reads: 0, writes: 0 });
      expect(JSON.stringify(users)).toBe(before);
    }
    expect(await events()).toEqual([]);
  });

  it.each([
    ['grant', (graph: RotationGraph, sql: RotationSql) => grantPortfolioImportScope(graph, sql, 'p', 'carol'), []],
    ['revoke', (graph: RotationGraph, sql: RotationSql) => revokePortfolioImportScope(graph, sql, 'p', 'carol'), [SCOPE]],
    ['record', (graph: RotationGraph, sql: RotationSql) => recordPortfolioImportScope(graph, sql, 'p', 'carol', true), [SCOPE]],
  ] as const)('%s takes the user lock before the first Neo4j access and holds it, in one transaction, until after the audit insert', async (_name, act, scopes) => {
    const log: string[] = [];
    const { graph } = counted(fakeGraph([user({ scopes: [...scopes] })]), log);
    const logged: RotationSql = {
      query: keysSql.query,
      transaction: callback => {
        log.push('begin');
        return keysSql.transaction(async tx => {
          const result = await callback({
            query: (text, params) => {
              log.push(/pg_advisory_xact_lock/.test(text) ? `lock:${String(params?.[0])}` : /INSERT INTO auth_credential_events/.test(text) ? 'insert' : 'sql');
              return tx.query(text, params);
            },
          });
          log.push('commit');
          return result;
        });
      },
    };

    await act(graph, logged);

    expect(log.slice(0, 2)).toEqual(['begin', 'lock:p']);
    expect(log.slice(-2)).toEqual(['insert', 'commit']);
    expect(log.slice(2, -2).every(entry => entry.startsWith('neo4j-'))).toBe(true);
    expect(log.slice(2, -2).length).toBeGreaterThan(0);
  });

  it('a node stored under both _id and id is locked under both spellings, so a run by the other spelling queues behind it', async () => {
    const log: string[] = [];
    const users = [user({ id: 'alias' })];
    const logged: RotationSql = sqlOver(async (text, params = []) => {
      if (/pg_advisory_xact_lock/.test(text)) log.push(`lock:${String(params[0])}`);
      return { rows: await send('query', text, params) };
    });

    const granted = await grantPortfolioImportScope(fakeGraph(users), logged, 'alias', 'carol');
    await revokePortfolioImportScope(fakeGraph(users), logged, 'p', 'carol');

    expect(granted).toMatchObject({ userId: 'p', outcome: 'granted' });
    expect(log).toEqual(['lock:alias', 'lock:p', 'lock:p']);
    expect((await events()).map(r => r['user_id'])).toEqual(['p', 'p']);
  });
});

describe('assign-organization (FD-5)', () => {
  const [ORG, ORG_X] = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const user = (props: Row): Node[] => [{ elementId: '4:p', props: { _id: 'p', _username: 'pat', ...props } }];
  beforeEach(async () => {
    await send('exec', 'DELETE FROM api_keys');
    // Counted: two live keys at the user's generation (0). Never counted: disabled, revoked, another user's.
    await addKey('live-a', 'p', 0);
    await addKey('live-b', 'p', 0);
    await addKey('off', 'p', 0, 'disabled');
    await addKey('gone', 'p', 0, 'revoked');
    await addKey('theirs', 'q', 0);
  });
  const assign = (users: Node[], graph = fakeGraph(users)) => assignOrganization(graph, keysSql, 'p', ORG, 'nick');
  const refused = (reason: string) => new Error(`organization assignment refused: ${reason}`);

  it.each([
    ['no organization', {}],
    ['an invalid _organizationId over a valid organizationId', { _organizationId: 'not-a-uuid', organizationId: ORG_X }],
  ])('A1: assigns a user with %s through _organizationId, stamped by the operator', async (_label, props) => {
    const users = user(props);
    await expect(assign(users)).resolves.toEqual({ userId: 'p', organizationId: ORG, outcome: 'assigned', enabledApiKeys: 2 });
    expect(users[0]!.props).toMatchObject({ _organizationId: ORG, organizationAssignedBy: 'nick', organizationAssignedAt: expect.any(Date) });
  });

  it('A7 (HAP-1669): a key below the user\'s current generation is not counted; a current-generation key is', async () => {
    await send('exec', 'DELETE FROM api_keys');
    const users = user({ credentialEpoch: neo4j.int(3) });
    await addKey('dead', 'p', 2);
    await expect(assign(users)).resolves.toMatchObject({ enabledApiKeys: 0 });

    await addKey('current', 'p', 3);
    await expect(assign(users)).resolves.toMatchObject({ enabledApiKeys: 1 });

    // A key above the generation (after a generation-resetting rollback) cannot authenticate either (equality).
    await addKey('future', 'p', 4);
    await expect(assign(users)).resolves.toMatchObject({ enabledApiKeys: 1 });
  });

  it.each([
    ['a Float', 1.5],
    ['a whole-number Float', 0],
    ['a string', 'abc'],
    ['an Integer beyond the safe range', neo4j.int('9223372036854775807')],
  ])('A8 (HAP-2061 INFO-1): a stored generation that is %s authenticates no key, so none is counted', async (_label, credentialEpoch) => {
    // Live keys at the generations a lossy conversion would have mapped it to: 0, 1 and the unsafe value's neighbour.
    await addKey('at-one', 'p', 1);
    await expect(assign(user({ credentialEpoch }))).resolves.toMatchObject({ outcome: 'assigned', enabledApiKeys: 0 });
  });

  it('A2: the same organization again is unchanged, with no write', async () => {
    const users = user({ organizationId: ORG });
    const graph = fakeGraph(users);
    graph.write = async () => { throw new Error('unexpected write'); };
    await expect(assign(users, graph)).resolves.toEqual({ userId: 'p', organizationId: ORG, outcome: 'unchanged', enabledApiKeys: 2 });
  });

  it.each([
    ['another valid organization (A3)', user({ _organizationId: ORG_X }), 'already_assigned'],
    ['an unknown id', [{ elementId: '4:q', props: { _id: 'q' } }], 'unknown_identity'],
    ['an ambiguous id', [{ elementId: '4:a', props: { _id: 'p' } }, { elementId: '4:b', props: { id: 'p' } }], 'ambiguous_identity'],
    ['a colliding id', [{ elementId: '4:a', props: { _id: 'p', id: 'y' } }, { elementId: '4:b', props: { _id: 'y' } }], 'identity_collision'],
    ['seed provenance', user({ seedProvenance: 'seed-data' }), 'seeded_account'],
    ['the default-password marker', user({ defaultPasswordSuspect: true }), 'seeded_account'],
    ['a platform admin', user({ platformAdmin: true }), 'platform_admin_target'],
    ['a platform admin (underscore spelling)', user({ _platformAdmin: true }), 'platform_admin_target'],
    ['a non-string organization', user({ _organizationId: 7 }), 'unsupported_value'],
  ])('A3/A4: refuses %s with a value-free reason, the node unchanged', async (_label, users: Node[], reason) => {
    const before = JSON.stringify(users);
    await expect(assign(users)).rejects.toThrow(refused(reason));
    expect(JSON.stringify(users)).toBe(before);
  });

  it.each([
    ['gains an organization', { _organizationId: ORG_X }],
    ['becomes a platform admin', { platformAdmin: true }],
    ['is marked', { defaultPasswordSuspect: true }],
    ['gets seed provenance', { seedProvenance: 'seed-data' }],
  ])('A5: not_applied when the user %s between the read and the write', async (_label, change) => {
    const users = user({});
    const graph = fakeGraph(users);
    const write = graph.write;
    graph.write = async (cypher, params) => { Object.assign(users[0]!.props, change); return write(cypher, params); };
    await expect(assign(users, graph)).rejects.toThrow(refused('not_applied'));
    expect(users[0]!.props).toEqual({ _id: 'p', _username: 'pat', ...change });
  });

  it.each([
    [['--user-id', 'p', '--organization-id', 'not-a-uuid', '--operator', 'nick'], '--organization-id <uuid> is required'],
    [['--user-id', 'p', '--organization-id', 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', '--operator', 'nick'], '--organization-id must be a lowercase UUID'],
    [['--user-id', 'p', '--organization-id', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeE', '--operator', 'nick'], '--organization-id must be a lowercase UUID'],
    [['--user-id', 'p', '--organization-id', ORG, '--operator', ' '], '--operator <name> is required'],
  ])('A6: %j exits 1 before any store opens', async (args, message) => {
    const lines: string[] = [];
    const code = await main(['assign-organization', ...args], {}, { stdout: line => lines.push(line), stderr: line => lines.push(line) });
    expect([code, lines]).toEqual([1, [`identity-window: ${message}`]]);
  });
});

describe('default-password scan', () => {
  it('marks default-hash users once, audits each transition, and lists non-bcrypt hashes', async () => {
    const defaultHash = await bcrypt.hash('Admin123!', 4);
    const users: Node[] = [
      { elementId: '4:a', props: { _id: 'a', _passwordHash: defaultHash } },
      { elementId: '4:b', props: { id: 'b', passwordHash: defaultHash, defaultPasswordSuspect: true } },
      { elementId: '4:c', props: { _id: 'c', _passwordHash: await bcrypt.hash('not-a-default-pw', 4) } },
      { elementId: '4:d', props: { _id: 'd', _passwordHash: 'plaintext?' } },
    ];
    const rows: unknown[][] = [];
    const sql = { query: async (_text: string, params?: unknown[]) => { rows.push(params ?? []); return { rows: [] }; } };

    const result = await scanDefaultPasswords(fakeGraph(users), sql, (p, h) => bcrypt.compare(p, h), 'nick');

    expect(result).toEqual({ marked: ['a'], alreadyMarkedOrRaced: ['b'], nonBcrypt: ['d'] });
    expect(rows).toEqual([['a', 'window-script:nick']]);
    expect(users[2]!.props['defaultPasswordSuspect']).toBeUndefined();
    expect(users[0]!.props['defaultPasswordSuspect']).toBe(true);
  });

  it('never marks an account rotated between the scan read and its mark (review 6061922930 MEDIUM 1)', async () => {
    const users: Node[] = [{ elementId: '4:a', props: { _id: 'a', _passwordHash: await bcrypt.hash('Admin123!', 4) } }];
    const rows: unknown[][] = [];
    const sql = { query: async (_text: string, params?: unknown[]) => { rows.push(params ?? []); return { rows: [] }; } };
    const rotate = () => Object.assign(users[0]!.props, { _passwordHash: 'rotated-hash', credentialEpoch: neo4j.int(1), defaultPasswordSuspect: false });

    const result = await scanDefaultPasswords(fakeGraph(users), sql, async (p, h) => {
      rotate(); // an operator rotation commits while bcrypt runs
      return bcrypt.compare(p, h);
    }, 'nick');

    expect(result).toEqual({ marked: [], alreadyMarkedOrRaced: ['a'], nonBcrypt: [] });
    expect(users[0]!.props['defaultPasswordSuspect']).toBe(false);
    expect(rows).toEqual([]);
  });
});

describe('fakeGraph SET evaluation', () => {
  it('stores true and false literals as booleans, parameters and datetime() as values, and rejects other expressions', () => {
    const node: Node = { elementId: '4:p', props: {} };

    applySet(node, 'MATCH (u:User) SET u.a = true, u.b = false, u.c = $c, u.d = datetime() RETURN count(u) AS n', { c: 'x' });
    expect(node.props).toMatchObject({ a: true, b: false, c: 'x' });
    expect(node.props['d']).toBeInstanceOf(Date);

    expect(() => applySet(node, 'MATCH (u:User) SET u.e = TRUE RETURN count(u) AS n', {})).toThrow(/cannot evaluate/);
  });
});
