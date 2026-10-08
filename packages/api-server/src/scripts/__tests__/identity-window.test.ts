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
  GRANT_HOLDERS_CYPHER, GRANT_IDENTITY_CYPHER, GRANT_PLATFORM_ADMIN_CYPHER, GrantRefused, SCAN_MARK_CYPHER,
  SCAN_USERS_CYPHER, grantPlatformAdmin, scanDefaultPasswords,
} from '../identity-window';
import type { RotationGraph, Row } from '../rotate-user-password';

type Node = { elementId: string; props: Row };
const norm = (cypher: string) => cypher.replace(/\s+/g, ' ').trim();
const marked = (u: Node) => u.props['defaultPasswordSuspect'] === true || u.props['_defaultPasswordSuspect'] === true;

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
        }));
      }
      if (q === norm(GRANT_HOLDERS_CYPHER)) {
        const keys = params['keys'] as unknown[];
        return [{ holders: neo4j.int(users.filter(u => keys.includes(u.props['_id']) || keys.includes(u.props['id'])).length) }];
      }
      if (q === norm(SCAN_USERS_CYPHER)) {
        return users.map(u => ({ eid: u.elementId, id: u.props['_id'] ?? u.props['id'], hash: u.props['_passwordHash'] ?? u.props['passwordHash'] ?? null }));
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
        const ok = u !== undefined && !marked(u);
        if (ok) u!.props['defaultPasswordSuspect'] = true;
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
});
