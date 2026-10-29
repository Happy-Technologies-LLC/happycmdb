// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 window identity steps (v16 §1.1 / §12 step 6, N-21 P-6):
 * the platform-admin grant refuses seeded, marked, ambiguous and colliding
 * identities, and writes the flag on exactly one node otherwise; the default
 * password scan marks only false → true transitions and audits each one.
 * Neo4j is an in-memory model of the exported statements.
 */

import { describe, expect, it } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import neo4j from 'neo4j-driver';

import {
  ASSIGN_ORGANIZATION_CYPHER, assignOrganization, main,
  GRANT_HOLDERS_CYPHER, GRANT_IDENTITY_CYPHER, GRANT_PLATFORM_ADMIN_CYPHER, GrantRefused, SCAN_MARK_CYPHER,
  SCAN_USERS_CYPHER, grantPlatformAdmin, scanDefaultPasswords,
} from '../identity-window';
import type { RotationGraph, Row } from '../rotate-user-password';

type Node = { elementId: string; props: Row };
const norm = (cypher: string) => cypher.replace(/\s+/g, ' ').trim();
const marked = (u: Node) => u.props['defaultPasswordSuspect'] === true || u.props['_defaultPasswordSuspect'] === true;
const admin = (u: Node) => u.props['_platformAdmin'] === true || u.props['platformAdmin'] === true;
const orgOf = (u: Node) => u.props['_organizationId'] ?? u.props['organizationId'] ?? null;
const hashOf = (u: Node) => u.props['_passwordHash'] ?? u.props['passwordHash'] ?? null;
const num = (value: unknown) => (neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value));
const epochOf = (u: Node) => num(u.props['credentialEpoch'] ?? 0);

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
          platformAdmin: admin(u), org: orgOf(u),
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
        if (ok) Object.assign(u!.props, { platformAdmin: true, platformAdminGrantedBy: params['operator'] });
        return [{ n: neo4j.int(ok ? 1 : 0) }];
      }
      if (q === norm(SCAN_MARK_CYPHER)) {
        // Guards evaluated on the current node, as after the statement's lock.
        const ok = u !== undefined && !marked(u)
          && hashOf(u) === params['verifiedHash'] && epochOf(u) === num(params['verifiedEpoch']);
        if (ok) u!.props['defaultPasswordSuspect'] = true;
        return [{ n: neo4j.int(ok ? 1 : 0) }];
      }
      if (q === norm(ASSIGN_ORGANIZATION_CYPHER)) {
        // Each guard and the written property are read from the statement, so a dropped guard shows.
        const ok = u !== undefined && (u.props['_id'] === params['id'] || u.props['id'] === params['id'])
          && (!q.includes('u.seedProvenance IS NULL') || u.props['seedProvenance'] === undefined)
          && (!q.includes('AND NOT (coalesce(u.defaultPasswordSuspect') || !marked(u))
          && (!q.includes('AND NOT (coalesce(u._platformAdmin') || !admin(u))
          && (!q.includes('observed = $observed') || orgOf(u) === params['observed']);
        const property = /SET u\.(\w+) = \$organizationId/.exec(q)![1]!;
        if (ok) Object.assign(u!.props, { [property]: params['organizationId'], organizationAssignedBy: params['operator'] });
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

describe('assign-organization (FD-5)', () => {
  const [ORG, ORG_X] = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const user = (props: Row): Node[] => [{ elementId: '4:p', props: { _id: 'p', _username: 'pat', ...props } }];
  const keys = { query: async (_text: string, params?: unknown[]) => ({ rows: [{ n: params?.[0] === 'p' ? '2' : '0' }] }) };
  const assign = (users: Node[], graph = fakeGraph(users)) => assignOrganization(graph, keys, 'p', ORG, 'nick');
  const refused = (reason: string) => new Error(`organization assignment refused: ${reason}`);

  it.each([
    ['no organization', {}],
    ['an invalid _organizationId over a valid organizationId', { _organizationId: 'not-a-uuid', organizationId: ORG_X }],
  ])('A1: assigns a user with %s through _organizationId, stamped by the operator', async (_label, props) => {
    const users = user(props);
    await expect(assign(users)).resolves.toEqual({ userId: 'p', organizationId: ORG, outcome: 'assigned', enabledApiKeys: 2 });
    expect(users[0]!.props).toMatchObject({ _organizationId: ORG, organizationAssignedBy: 'nick' });
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
