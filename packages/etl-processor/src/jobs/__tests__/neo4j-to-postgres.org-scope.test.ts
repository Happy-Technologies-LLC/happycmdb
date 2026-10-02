// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * cmdb.dim_ci.organization_id written by the neo4j-to-postgres ETL job
 * (migration 011). The real Neo4jToPostgresJob runs against PGlite (hosted
 * in a forked child process, ../../../../api-server/src/rest/routes/__tests__/
 * fixtures/pglite-host.cjs) with the cmdb.dim_ci and cmdb.fact_discovery
 * CREATE TABLE blocks read verbatim from 001_complete_schema.sql plus
 * 011_ci_organization_scope.sql. Neo4j is a session returning fixed :CI nodes.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Job } from 'bullmq';
import type { Neo4jClient, PostgresClient } from '@cmdb/database';
import type { CI } from '@cmdb/common';

const host = fork(
  join(__dirname, '../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'),
  [],
  { serialization: 'advanced' }
);
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const query = async (sql: string, params: unknown[] = []) => ({ rows: await send('query', sql, params) });

// The package index opens a Redis connection at import (bullmq queue-manager);
// the job only needs the unscoped-access token from it.
jest.mock('@cmdb/database', () => ({ UNSCOPED_CI_ACCESS: Symbol('UNSCOPED_CI_ACCESS') }));

import { Neo4jToPostgresJob } from '../neo4j-to-postgres.job';
import { ReconciliationJob } from '../reconciliation.job';

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');

// Every statement the job sends, for the query-shape assertion.
const statements: string[] = [];
const recordingQuery: typeof query = async (sql, params) => {
  statements.push(sql);
  return query(sql, params);
};

// One PGlite connection: BEGIN/COMMIT around the callback is a real transaction.
const postgresClient = {
  query: recordingQuery,
  getCurrentCIKey: async (ciId: string) => {
    const result = await recordingQuery(
      'SELECT ci_key FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = TRUE', [ciId]
    );
    return result.rows[0]?.ci_key ?? null;
  },
  transaction: async <T>(callback: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
    await send('exec', 'BEGIN');
    try {
      const result = await callback({ query: recordingQuery });
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
} as unknown as PostgresClient;

let nodes: Array<Record<string, unknown>> = [];
let relationships: Record<string, Array<{ _ci: { _id: string }; _type: string }>> = {};
const neo4jClient = {
  getCI: async (ciId: string, scope: string | symbol) => {
    const properties = nodes.find(ci => ci.id === ciId);
    return properties && (typeof scope === 'symbol' || properties.organization_id === scope)
      ? { _id: ciId, name: properties.name, _status: properties.status } : null;
  },
  createCI: async (ci: CI, scope: string | symbol) => {
    // The production Neo4jClient.createCI stamps only its scope, not CI input.
    nodes.push(node(ci._id, typeof scope === 'string' ? scope : undefined, { name: ci.name }));
    return ci;
  },
  getSession: () => ({
    run: async () => ({ records: nodes.map(properties => ({ get: () => ({ properties }) })) }),
    close: async () => undefined,
  }),
  getRelationships: async (ciId: string) => relationships[ciId] ?? [],
} as unknown as Neo4jClient;

// Attributes equal to the stored rows below, so no CI is re-versioned for them.
const node = (id: string, organizationId?: string, overrides: Record<string, unknown> = {}) => ({
  id, name: id, type: 'server', status: 'active', environment: 'production',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', discovered_at: '2026-01-01T00:00:00Z',
  metadata: JSON.stringify({ discovery_source: 'test', discovery_method: 'manual' }),
  ...(organizationId === undefined ? {} : { organization_id: organizationId }),
  ...overrides,
});

// Incremental by default: the relationship pass (not under test) is skipped.
// complete: every node is visited (no incrementalSince).
async function sync(complete = false): Promise<void> {
  const data = complete ? {} : { incrementalSince: '2026-01-01T00:00:00Z' };
  const job = { id: 'job-1', data, updateProgress: async () => undefined };
  await new Neo4jToPostgresJob(neo4jClient, postgresClient).execute(job as unknown as Job);
}

const versions = (ciId: string) => send(
  'query', 'SELECT is_current, organization_id, ci_name, org_backfilled FROM cmdb.dim_ci WHERE ci_id = $1 ORDER BY ci_key', [ciId]
) as Promise<Array<{ is_current: boolean; organization_id: string; ci_name: string; org_backfilled: boolean }>>;

// Rows as migration 011 leaves a CI synced before it: internal, marked backfilled.
const backfilled = (ciId: string) => send('exec', `INSERT INTO cmdb.dim_ci
  (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, org_backfilled) VALUES
  ('${ciId}', '${ciId}', 'server', 'active', 'production', FALSE, '${INTERNAL_ORG}', TRUE),
  ('${ciId}', '${ciId}', 'server', 'active', 'production', TRUE, '${INTERNAL_ORG}', TRUE);`);

beforeAll(async () => {
  const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const ddl = ['cmdb.dim_ci', 'cmdb.fact_discovery', 'cmdb.fact_ci_relationships'].map(table => {
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  });
  await send('exec', `CREATE SCHEMA cmdb;\n${ddl.join('\n')}\n${readFileSync(join(MIGRATIONS, '011_ci_organization_scope.sql'), 'utf8')}`);
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  await send('exec', 'TRUNCATE cmdb.dim_ci, cmdb.fact_discovery, cmdb.fact_ci_relationships RESTART IDENTITY');
  relationships = {};
  statements.length = 0;
});

it('a 011-backfilled CI whose node names another org gets a new version there; no stored row changes org', async () => {
  await backfilled('ci-b');
  nodes = [node('ci-b', ORG_B)];

  await sync();

  expect(await versions('ci-b')).toEqual([
    { is_current: false, organization_id: INTERNAL_ORG, ci_name: 'ci-b', org_backfilled: false },
    { is_current: false, organization_id: INTERNAL_ORG, ci_name: 'ci-b', org_backfilled: false },
    { is_current: true, organization_id: ORG_B, ci_name: 'ci-b', org_backfilled: false },
  ]);
});

it('post-011 internal rows never move', async () => {
  // Written after 011 (org_backfilled defaults to FALSE), even by an old node.
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('ci-internal', 'ci-internal', 'server', 'active', 'production', TRUE, '${INTERNAL_ORG}');`);
  nodes = [node('ci-internal', ORG_A, { created_at: '2020-01-01T00:00:00Z', name: 'A takeover' })];

  await sync();

  expect(await versions('ci-internal')).toEqual([
    { is_current: true, organization_id: INTERNAL_ORG, ci_name: 'ci-internal', org_backfilled: false },
  ]);
});

it('a CI whose node created_at was rewritten via baseline restore does not get the internal history relabelled', async () => {
  // Internal CI X backfilled by 011, its node already deleted. The complete
  // sync right after 011 closes the backfill window.
  await backfilled('ci-x');
  nodes = [];
  await sync(true);

  // Org A recreates X and restores an old baseline snapshot onto it, so its
  // created_at predates X's whole history.
  nodes = [node('ci-x', ORG_A, { created_at: '2020-01-01T00:00:00Z' })];
  await sync();

  expect((await versions('ci-x')).map(v => v.organization_id)).toEqual([INTERNAL_ORG, INTERNAL_ORG]);
});

it('a node reusing a customer CI id writes nothing into its history; customer orgs never move', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('ci-of-b', 'ci-of-b', 'server', 'active', 'production', TRUE, '${ORG_B}'),
    ('ci-orgless', 'ci-orgless', 'server', 'active', 'production', TRUE, '${ORG_B}'),
    ('ci-renamed', 'ci-renamed', 'server', 'active', 'production', TRUE, '${ORG_B}');`);
  nodes = [
    // Recreated by org A with the same id.
    node('ci-of-b', ORG_A, { name: 'A takeover' }),
    // Recreated without an organization (reconciliation), then named the
    // internal one by a Neo4j backfill re-run.
    node('ci-orgless'),
    node('ci-renamed', INTERNAL_ORG),
    node('ci-new'),
    node('ci-new-b', ORG_B),
  ];

  await sync();

  const orgAndName = async (ciId: string) => (await versions(ciId)).map(v => [v.organization_id, v.ci_name]);
  expect(await orgAndName('ci-of-b')).toEqual([[ORG_B, 'ci-of-b']]);
  expect(await orgAndName('ci-orgless')).toEqual([[ORG_B, 'ci-orgless']]);
  expect(await orgAndName('ci-renamed')).toEqual([[ORG_B, 'ci-renamed']]);
  // A CI new to cmdb.dim_ci: its node's organization, or the internal one.
  expect(await orgAndName('ci-new')).toEqual([[INTERNAL_ORG, 'ci-new']]);
  expect(await orgAndName('ci-new-b')).toEqual([[ORG_B, 'ci-new-b']]);
});

it('does not sync an org-less replacement of a deleted org-B CI into B from an org-A merge', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, tbm_attributes) VALUES
    ('deleted-b', 'B original', 'server', 'active', 'production', TRUE, '${ORG_B}',
     '{"monthly_cost": 75, "resource_tower": "compute"}'),
    ('ci-a', 'ci-a', 'server', 'active', 'production', TRUE, '${ORG_A}', '{}');`);
  // createNewCI spreads user-supplied attributes after its generated id and
  // strips organization_id. Org A can therefore replace a deleted B id.
  nodes = [
    node('generated-id', undefined, { id: 'deleted-b', name: 'A controlled replacement' }),
    node('ci-a', ORG_A, { name: 'A legitimate update' }),
  ];

  await sync();

  expect(await versions('deleted-b')).toEqual([
    { is_current: true, organization_id: ORG_B, ci_name: 'B original', org_backfilled: false },
  ]);
  expect(await send('query',
    'SELECT tbm_attributes FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = TRUE', ['deleted-b']
  )).toEqual([{ tbm_attributes: { monthly_cost: 75, resource_tower: 'compute' } }]);
  expect((await versions('ci-a')).map(v => [v.is_current, v.organization_id, v.ci_name])).toEqual([
    [false, ORG_A, 'ci-a'],
    [true, ORG_A, 'A legitimate update'],
  ]);
});

it('complete sync never attributes an org-less replacement relationship to the deleted org-B CI', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, tbm_attributes) VALUES
    ('deleted-b', 'B original', 'server', 'active', 'production', TRUE, '${ORG_B}',
      '{"monthly_cost": 75, "resource_tower": "compute"}'),
    ('a-source', 'a-source', 'server', 'active', 'production', TRUE, '${ORG_A}', '{}'),
    ('a-target', 'a-target', 'server', 'active', 'production', TRUE, '${ORG_A}', '{}');`);
  nodes = [
    node('generated-id', undefined, { id: 'deleted-b', name: 'A controlled replacement' }),
    node('a-source', ORG_A),
    node('a-target', ORG_A),
  ];
  relationships = {
    'deleted-b': [{ _ci: { _id: 'a-target' }, _type: 'DEPENDS_ON' }],
    'a-source': [
      { _ci: { _id: 'a-target' }, _type: 'DEPENDS_ON' },
      { _ci: { _id: 'deleted-b' }, _type: 'RUNS_ON' },
    ],
  };

  await sync(true);

  expect(await versions('deleted-b')).toEqual([
    { is_current: true, organization_id: ORG_B, ci_name: 'B original', org_backfilled: false },
  ]);
  expect(await send('query',
    'SELECT tbm_attributes FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = TRUE', ['deleted-b']
  )).toEqual([{ tbm_attributes: { monthly_cost: 75, resource_tower: 'compute' } }]);
  expect(await send('query', `SELECT f.relationship_type, source.ci_id AS from_id,
      source.organization_id AS from_org, target.ci_id AS to_id, target.organization_id AS to_org
    FROM cmdb.fact_ci_relationships f
    JOIN cmdb.dim_ci source ON source.ci_key = f.from_ci_key
    JOIN cmdb.dim_ci target ON target.ci_key = f.to_ci_key
    WHERE f.is_active = TRUE ORDER BY from_id`)).toEqual([
    { relationship_type: 'DEPENDS_ON', from_id: 'a-source', from_org: ORG_A, to_id: 'a-target', to_org: ORG_A },
  ]);
});

it('postgres-wins restores a missing org-B node in B without changing its current cost or admitting A', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, tbm_attributes) VALUES
    ('restore-b', 'B original', 'server', 'active', 'production', TRUE, '${ORG_B}',
     '{"monthly_cost": 75, "resource_tower": "compute"}'),
    ('ci-a', 'ci-a', 'server', 'active', 'production', TRUE, '${ORG_A}', '{}');`);
  nodes = [node('ci-a', ORG_A)];
  const job = {
    id: 'restore-1',
    data: { ciIds: ['restore-b'], autoResolve: true, conflictStrategy: 'postgres-wins' },
    updateProgress: async () => undefined,
  };

  const restored = await new ReconciliationJob(neo4jClient, postgresClient).execute(job as unknown as Job);
  expect(restored._conflictsResolved).toBe(1);
  expect(await neo4jClient.getCI('restore-b', ORG_B)).not.toBeNull();
  expect(await neo4jClient.getCI('restore-b', ORG_A)).toBeNull();

  await sync();

  expect(await versions('restore-b')).toEqual([
    { is_current: true, organization_id: ORG_B, ci_name: 'B original', org_backfilled: false },
  ]);
  expect(await send('query',
    'SELECT tbm_attributes FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = TRUE', ['restore-b']
  )).toEqual([{ tbm_attributes: { monthly_cost: 75, resource_tower: 'compute' } }]);
  expect((await versions('ci-a')).map(v => v.organization_id)).toEqual([ORG_A]);
});

it('issues no per-CI history aggregate and no relabel when no relabel is possible', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('ci-b', 'ci-b', 'server', 'active', 'production', TRUE, '${ORG_B}');`);
  nodes = [node('ci-b', ORG_B)];

  await sync();

  expect(statements.filter(sql => /MIN\s*\(\s*effective_from|SET organization_id/i.test(sql))).toEqual([]);
});
