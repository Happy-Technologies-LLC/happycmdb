// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 window identity steps (v16 §1.1 / §12 step 6, N-21 P-6):
 * the platform-admin grant refuses seeded, marked, ambiguous and colliding
 * identities, and writes the flag on exactly one node otherwise; the default
 * password scan marks only false → true transitions and audits each one.
 * Neo4j is an in-memory model of the exported statements.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import neo4j from 'neo4j-driver';
import { join } from 'path';

import { holdsScope } from '../../auth/scopes';
import type { User } from '../../auth/types';
import {
  ASSIGN_ORGANIZATION_CYPHER, assignOrganization, main,
  GRANT_HOLDERS_CYPHER, GRANT_IDENTITY_CYPHER, GRANT_PLATFORM_ADMIN_CYPHER, GRANT_PORTFOLIO_IMPORT_SCOPE_CYPHER, GrantRefused,
  REVOKE_PORTFOLIO_IMPORT_SCOPE_CYPHER, SCAN_MARK_CYPHER,
  SCAN_USERS_CYPHER, grantPlatformAdmin, grantPortfolioImportScope, revokePortfolioImportScope, scanDefaultPasswords,
} from '../identity-window';
import { APPLY_CYPHER } from '../rotate-user-password';
import type { RotationGraph, Row } from '../rotate-user-password';

type Node = { elementId: string; props: Row };

// api_keys is real PostgreSQL (PGlite in a child process), so the enabledApiKeys WHERE clause is executed.
const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: Row[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: Row[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', text: string, params: unknown[] = []): Promise<Row[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql: text, params });
  });
}
const keysSql = { query: async (text: string, params: unknown[] = []) => ({ rows: await send('query', text, params) }) };
beforeAll(async () => {
  const migrations = join(__dirname, '../../../../database/src/postgres/migrations');
  const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
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
          platformAdmin: admin(u), org: orgOf(u), scopes: u.props['scopes'] ?? null, epoch: neo4j.int(epochOf(u)),
        }));
      }
      if (q === norm(GRANT_HOLDERS_CYPHER)) {
        const keys = params['keys'] as unknown[];
        return [{ holders: neo4j.int(users.filter(u => keys.includes(u.props['_id']) || keys.includes(u.props['id'])).length) }];
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

  it('adds the scope to a user with none, recording the operator, and touches nothing else', async () => {
    const users = [user({ _role: 'operator', platformAdmin: false })];

    await expect(grantPortfolioImportScope(fakeGraph(users), 'p', 'nick')).resolves.toEqual({ userId: 'p', outcome: 'granted' });
    expect(users[0]!.props).toMatchObject({ scopes: [SCOPE], portfolioImportScopeGrantedBy: 'nick', _role: 'operator', platformAdmin: false });
    expect(Object.keys(users[0]!.props).sort()).toEqual(
      ['_email', '_id', '_role', '_username', 'platformAdmin', 'portfolioImportScopeGrantedAt', 'portfolioImportScopeGrantedBy', 'scopes']);
  });

  it('keeps the other scopes, is idempotent without a second write, and never duplicates the scope', async () => {
    const users = [user({ scopes: ['credentials:manage'] })];
    const graph = fakeGraph(users);

    await expect(grantPortfolioImportScope(graph, 'p', 'nick')).resolves.toMatchObject({ outcome: 'granted' });
    expect(users[0]!.props['scopes']).toEqual(['credentials:manage', SCOPE]);
    await expect(grantPortfolioImportScope(graph, 'p', 'other')).resolves.toEqual({ userId: 'p', outcome: 'unchanged' });
    expect(users[0]!.props).toMatchObject({ scopes: ['credentials:manage', SCOPE], portfolioImportScopeGrantedBy: 'nick' });
  });

  it('revokes only the portfolio scope, records the operator, and is idempotent', async () => {
    const users = [user({ scopes: ['credentials:manage', SCOPE, 'reports:read'] })];
    const graph = fakeGraph(users);

    await expect(revokePortfolioImportScope(graph, 'p', 'nick')).resolves.toEqual({ userId: 'p', outcome: 'revoked' });
    expect(users[0]!.props).toMatchObject({ scopes: ['credentials:manage', 'reports:read'], portfolioImportScopeRevokedBy: 'nick' });
    await expect(revokePortfolioImportScope(graph, 'p', 'other')).resolves.toEqual({ userId: 'p', outcome: 'unchanged' });
    expect(users[0]!.props).toMatchObject({ scopes: ['credentials:manage', 'reports:read'], portfolioImportScopeRevokedBy: 'nick' });
    const none = [user()];
    await expect(revokePortfolioImportScope(fakeGraph(none), 'p', 'nick')).resolves.toMatchObject({ outcome: 'unchanged' });
    expect(none[0]!.props['scopes']).toBeUndefined();
  });

  it.each([
    ['seed provenance', { seedProvenance: 'pre-cutover-inventory' }],
    ['the default-password marker', { defaultPasswordSuspect: true }],
  ])('refuses an account with %s on grant and revoke with GrantRefused, writing nothing', async (_label, props) => {
    for (const change of [grantPortfolioImportScope, revokePortfolioImportScope]) {
      const users = [user({ ...props, scopes: [SCOPE] })];
      const before = structuredClone(users[0]!.props);

      await expect(change(fakeGraph(users), 'p', 'nick')).rejects.toMatchObject({ name: 'GrantRefused', reason: 'seeded_account' });
      expect(users[0]!.props).toEqual(before);
    }
  });

  it('refuses unknown, ambiguous and non-list scopes values with GrantRefused, writing nothing', async () => {
    const twin = [{ elementId: '4:a', props: { _id: 'x' } }, { elementId: '4:b', props: { id: 'x' } }];
    const text = [user({ scopes: SCOPE })];
    const mixed = [user({ scopes: [SCOPE, 7] })];

    await expect(grantPortfolioImportScope(fakeGraph([]), 'p', 'nick')).rejects.toMatchObject({ reason: 'unknown_identity' });
    await expect(revokePortfolioImportScope(fakeGraph(twin), 'x', 'nick')).rejects.toMatchObject({ reason: 'ambiguous_identity' });
    await expect(grantPortfolioImportScope(fakeGraph(text), 'p', 'nick')).rejects.toMatchObject({ reason: 'unsupported_value' });
    await expect(revokePortfolioImportScope(fakeGraph(mixed), 'p', 'nick')).rejects.toMatchObject({ reason: 'unsupported_value' });
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

      await expect(act(racing, 'p', 'nick')).rejects.toMatchObject({ name: 'GrantRefused', reason: 'not_applied' });
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
    await expect(revokePortfolioImportScope(graph, 'p', 'nick')).rejects.toMatchObject({ reason: 'seeded_account' });
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

    await expect(revokePortfolioImportScope(graph, 'p', 'nick')).resolves.toEqual({ userId: 'p', outcome: 'revoked' });
    expect(users[0]!.props['scopes']).toEqual(['credentials:manage']);
    expect(holdsScope(loaded(), SCOPE)).toBe(false);
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
