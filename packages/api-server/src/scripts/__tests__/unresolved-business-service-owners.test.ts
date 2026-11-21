// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The stale-owner report: which business services name an owner that no longer resolves, per organization, and that
 * producing it writes nothing.
 *
 * The services are real rows on PGlite (dim_business_services from 001, then 008 verbatim, plus the two 043 columns the
 * report reads). The graph is an in-memory set of :User property maps answering OWNER_USERS_CYPHER the way Neo4j would
 * (a node matches by `_id` or `id`; enabled and organization read in either spelling); the real statement runs against
 * Neo4j in the integration suite's environment, not here.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  main, OWNER_USERS_CYPHER, reportUnresolvedOwners, type OwnerReport,
} from '../unresolved-business-service-owners';

const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise as Promise<Array<Record<string, unknown>>>;
}

/** What the report's SELECT saw as `transaction_read_only`, recorded when that statement arrives. */
let readOnlyAtSelect: unknown[] = [];
const sql = {
  transaction: async <T>(callback: (client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>) => {
    await send('exec', 'BEGIN');
    const client = {
      query: async (text: string, params: unknown[] = []) => {
        if (/^\s*SELECT/i.test(text)) readOnlyAtSelect.push((await send('query', 'SHOW transaction_read_only'))[0]!['transaction_read_only']);
        return { rows: await send('query', text, params) };
      },
    };
    try {
      const result = await callback(client);
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
};

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');

/** :User nodes as properties; both spellings exist in the store, a node may use either. */
type UserNode = { node: string; props: Record<string, unknown> };
let users: UserNode[] = [];
let graphQueries: Array<{ cypher: string; ids: string[] }> = [];
const graph = {
  read: async (cypher: string, params: Record<string, unknown>) => {
    const ids = params['ids'] as string[];
    graphQueries.push({ cypher, ids });
    if (cypher !== OWNER_USERS_CYPHER) throw new Error('unexpected statement');
    return ids.flatMap(id => users
      .filter(({ props }) => props['_id'] === id || props['id'] === id)
      .map(({ node, props }) => ({
        id, node, enabled: props['_enabled'] ?? props['enabled'] ?? null, organization_id: props['_organizationId'] ?? props['organizationId'] ?? null,
      })));
  },
};

const insert = (id: string, org: string, lifecycle: string, owner: string | null) => send('query',
  `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status,
     organization_id, lifecycle, owner_principal_id) VALUES ($1, $2, 'application', 'application', 'high', 'active', $3, $4, $5)`,
  [id, `name of ${id}`, org, lifecycle, owner]);
const tableDigest = async () => (await send('query', `SELECT md5(string_agg(t::text, '|' ORDER BY service_id)) AS digest FROM dim_business_services t`))[0]!['digest'];

beforeAll(async () => {
  const ddl = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS dim_business_services \([\s\S]*?\n\);/);
  if (!ddl) throw new Error('DDL for dim_business_services not found in 001_complete_schema.sql');
  await send('exec', ddl[0]);
  await send('exec', `BEGIN;\n${readFileSync(join(MIGRATIONS, '008_business_service_organization_scope.sql'), 'utf8')}\nCOMMIT;`);
  // The two columns of 043 the report reads (types as asserted by the 043 migration test).
  await send('exec', `ALTER TABLE dim_business_services ADD COLUMN lifecycle VARCHAR(20) NOT NULL DEFAULT 'planned',
    ADD COLUMN owner_principal_id VARCHAR(255);`);
  await insert('bs-ok', ORG_A, 'live', 'u-ok');
  await insert('bs-legacy-spelling', ORG_A, 'live', 'u-legacy');
  await insert('bs-disabled', ORG_A, 'live', 'u-disabled');
  await insert('bs-other-org', ORG_A, 'retiring', 'u-b');
  await insert('bs-unknown', ORG_A, 'planned', 'u-gone');
  await insert('bs-no-org', ORG_B, 'live', 'u-no-org');
  await insert('bs-ambiguous', ORG_B, 'live', 'u-twice');
  await insert('bs-ok-b', ORG_B, 'live', 'u-b');
  await insert('bs-no-owner-live', ORG_B, 'live', null);
  await insert('bs-no-owner-planned', ORG_B, 'planned', null);
  await insert('bs-no-owner-retired', ORG_B, 'retired', null);
}, 60000);
afterAll(() => { host.kill(); });

beforeEach(() => {
  graphQueries = [];
  readOnlyAtSelect = [];
  users = [
    { node: 'n1', props: { _id: 'u-ok', _enabled: true, _organizationId: ORG_A } },
    // The legacy spelling only: id / enabled / organizationId.
    { node: 'n2', props: { id: 'u-legacy', enabled: true, organizationId: ORG_A } },
    { node: 'n3', props: { _id: 'u-disabled', _enabled: false, _organizationId: ORG_A } },
    { node: 'n4', props: { _id: 'u-b', _enabled: true, _organizationId: ORG_B } },
    { node: 'n5', props: { _id: 'u-no-org', _enabled: true } },
    { node: 'n6', props: { _id: 'u-twice', _enabled: true, _organizationId: ORG_B } },
    { node: 'n7', props: { id: 'u-twice', enabled: true, organizationId: ORG_B } },
  ];
});

const listed = (report: OwnerReport) => Object.fromEntries(report.organizations.map(org =>
  [org.organization_id, org.services.map(service => [service.service_id, service.reason])]));

describe('reportUnresolvedOwners', () => {
  it('lists, per organization, every service whose owner does not resolve, with the reason', async () => {
    const report = await reportUnresolvedOwners(sql, graph);
    expect(report.checked).toBe(11);
    expect(listed(report)).toEqual({
      [ORG_A]: [['bs-disabled', 'disabled'], ['bs-other-org', 'other_organization'], ['bs-unknown', 'unknown']],
      [ORG_B]: [['bs-ambiguous', 'ambiguous_identity'], ['bs-no-org', 'no_organization'], ['bs-no-owner-live', 'no_owner']],
    });
    expect(report.unresolved).toBe(6);
    expect(report.organizations.flatMap(org => org.services)).toContainEqual({
      service_id: 'bs-other-org', name: 'name of bs-other-org', lifecycle: 'retiring', owner_principal_id: 'u-b', reason: 'other_organization',
    });
  });

  it('an owner is judged against the service\'s own organization: the same user resolves in one and not in the other', async () => {
    const report = await reportUnresolvedOwners(sql, graph);
    const reasons = Object.fromEntries(report.organizations.flatMap(org => org.services.map(service => [service.service_id, service.reason])));
    // u-b serves bs-ok-b (org B) and bs-other-org (org A).
    expect(reasons['bs-ok-b']).toBeUndefined();
    expect(reasons['bs-other-org']).toBe('other_organization');
  });

  it('a fully resolved estate reports nothing', async () => {
    users = [{ node: 'x', props: { _id: 'u-everyone', _enabled: true, _organizationId: ORG_A } }];
    await send('query', 'CREATE TEMP TABLE hold AS SELECT * FROM dim_business_services');
    await send('query', 'DELETE FROM dim_business_services');
    try {
      await insert('bs-only', ORG_A, 'live', 'u-everyone');
      expect(await reportUnresolvedOwners(sql, graph)).toEqual({ checked: 1, unresolved: 0, organizations: [] });
    } finally {
      await send('query', 'DELETE FROM dim_business_services');
      await send('query', 'INSERT INTO dim_business_services SELECT * FROM hold');
      await send('query', 'DROP TABLE hold');
    }
  });

  it('WRITES NOTHING: the PostgreSQL read runs in a READ ONLY transaction, the tables are unchanged and each owner is asked for once', async () => {
    const before = await tableDigest();
    await reportUnresolvedOwners(sql, graph);
    expect(readOnlyAtSelect).toEqual(['on']);
    expect(await tableDigest()).toBe(before);
    expect(graphQueries.map(query => [...query.ids].sort())).toEqual([['u-b', 'u-disabled', 'u-gone', 'u-legacy', 'u-no-org', 'u-ok', 'u-twice']]);
  });

  it('an unreadable identity store fails the whole report: no partial list', async () => {
    const down = { read: async () => { throw new Error('graph unavailable'); } };
    await expect(reportUnresolvedOwners(sql, down)).rejects.toThrow('graph unavailable');
  });
});

describe('main', () => {
  it('prints the report only when both stores answer; a store that cannot be opened is exit 1 with nothing on stdout', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main([], {}, { stdout: line => out.push(line), stderr: line => err.push(line) });
    expect([code, out]).toEqual([1, []]);
    expect(err).toHaveLength(1);
  });

  it('refuses arguments (it takes none) before opening any store', async () => {
    const err: string[] = [];
    expect(await main(['--apply'], {}, { stdout: () => undefined, stderr: line => err.push(line) })).toBe(1);
    expect(err[0]).toContain('usage: unresolved-business-service-owners');
  });
});
