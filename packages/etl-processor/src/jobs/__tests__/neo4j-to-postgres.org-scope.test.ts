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
// the jobs only need the unscoped-access token and, for sync-cis-to-datamart,
// the client singletons (resolved when the job runs).
const mockClients: { graph?: unknown; pool?: unknown } = {};
jest.mock('@cmdb/database', () => ({
  UNSCOPED_CI_ACCESS: Symbol('UNSCOPED_CI_ACCESS'),
  getNeo4jClient: () => mockClients.graph,
  getPostgresClient: () => ({ pool: mockClients.pool }),
}));

import { Neo4jToPostgresJob } from '../neo4j-to-postgres.job';
import { FullRefreshJob } from '../full-refresh.job';
import { ReconciliationJob } from '../reconciliation.job';
import { processSyncCIsToDatamart } from '../sync-cis-to-datamart.job';

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
let afterCommit: (() => void | Promise<void>) | undefined;
let beforeReconciliationGraphRead: (() => void) | undefined;

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
      await afterCommit?.();
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
      ? { _id: ciId, name: properties.name, _type: properties.type,
          _status: properties.status, environment: properties.environment } : null;
  },
  createCI: async (ci: CI, scope: string | symbol) => {
    // The production Neo4jClient.createCI stamps only its scope, not CI input.
    nodes.push(node(ci._id, typeof scope === 'string' ? scope : undefined, { name: ci.name }));
    return ci;
  },
  updateCI: async (ciId: string, updates: Record<string, unknown>, scope: string | symbol) => {
    // As the production update: unscoped matches every organization.
    const properties = nodes.find(ci => ci.id === ciId && (typeof scope === 'symbol' || ci.organization_id === scope));
    if (properties) Object.assign(properties, updates);
    return properties;
  },
  getSession: () => ({
    run: async (cypher: string, params: { ciId?: string; id?: string; ciTypes?: string[] } = {}) => {
      if (cypher.includes('SET ci.status = $status')) {
        const { id, organizationId, internalOrganizationId, status } = params as Record<string, string>;
        const properties = nodes.find(ci => ci.id === id && (
          ci.organization_id === undefined || ci.organization_id === null || ci.organization_id === ''
            ? internalOrganizationId : String(ci.organization_id).toLowerCase()) === organizationId);
        if (properties) properties.status = status;
        return { records: properties ? [{ get: () => id }] : [] };
      }
      if (cypher.includes('MATCH (ci:CI {id: $id})')) {
        beforeReconciliationGraphRead?.();
        beforeReconciliationGraphRead = undefined;
        const properties = nodes.find(ci => ci.id === params.id);
        return { records: properties ? [{ get: (key: string) =>
          key === 'ci' ? { properties } : properties[key] }] : [] };
      }
      if (cypher.includes('MATCH (source:CI {id: $ciId})-[rel]->(target:CI)')) {
        // The edge and both node properties come from ONE graph match.
        const source = nodes.find(ci => ci.id === params.ciId);
        const records = source ? (relationships[params.ciId!] ?? []).flatMap(rel => {
          const target = nodes.find(ci => ci.id === rel._ci._id);
          if (!target) return [];
          const fields: Record<string, unknown> = {
            from_id: source.id, from_organization_id: source.organization_id,
            to_id: target.id, to_organization_id: target.organization_id,
            relationship_type: rel._type,
          };
          return [{ get: (key: string) => fields[key] }];
        }) : [];
        return { records };
      }
      if (/\bAS ci_name\b/.test(cypher)) {
        // sync-cis-to-datamart's projection: each alias reads the node property it names.
        const columns = [...cypher.matchAll(/ci\.(\w+) AS (\w+)/g)];
        return { records: nodes.map(properties => ({ get: (alias: string) =>
          properties[columns.find(column => column[2] === alias)?.[1] ?? ''] })) };
      }
      return { records: nodes.filter(properties => !params.ciTypes || params.ciTypes.includes(properties.type as string))
        .map(properties => ({ get: () => ({ properties }) })) };
    },
    close: async () => undefined,
  }),
  getRelationships: async (ciId: string) => relationships[ciId] ?? [],
} as unknown as Neo4jClient;

mockClients.graph = neo4jClient;
// sync-cis-to-datamart's pool: each connection is the one PGlite session.
mockClients.pool = {
  connect: async () => ({
    query: async (sql: string, params: unknown[] = []) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())
      ? { rows: await send('exec', sql) } : query(sql, params),
    release: () => undefined,
  }),
};

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
  afterCommit = undefined;
  beforeReconciliationGraphRead = undefined;
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

it('rejects a B id replaced after its dimension batch commits but before relationships are read', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, tbm_attributes) VALUES
    ('deleted-b', 'deleted-b', 'server', 'active', 'production', TRUE, '${ORG_B}',
     '{"monthly_cost": 75, "resource_tower": "compute"}'),
    ('a-source', 'a-source', 'server', 'active', 'production', TRUE, '${ORG_A}', '{}'),
    ('a-target', 'a-target', 'server', 'active', 'production', TRUE, '${ORG_A}', '{}');`);
  nodes = [node('deleted-b', ORG_B), node('a-source', ORG_A), node('a-target', ORG_A)];
  // The dim_ci transaction accepts the original B node. Before the subsequent
  // graph read, org A's merge replaces that node by id and adds both edges.
  afterCommit = () => {
    nodes = [
      node('generated-id', undefined, { id: 'deleted-b', name: 'A replacement' }),
      node('a-source', ORG_A),
      node('a-target', ORG_A),
    ];
    relationships = {
      'deleted-b': [{ _ci: { _id: 'a-target' }, _type: 'DEPENDS_ON' }],
      'a-source': [
        { _ci: { _id: 'deleted-b' }, _type: 'RUNS_ON' },
        { _ci: { _id: 'a-target' }, _type: 'DEPENDS_ON' },
      ],
    };
    afterCommit = undefined;
  };

  await sync(true);

  expect(await versions('deleted-b')).toEqual([
    { is_current: true, organization_id: ORG_B, ci_name: 'deleted-b', org_backfilled: false },
  ]);
  expect(await send('query',
    'SELECT tbm_attributes FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = TRUE', ['deleted-b']
  )).toEqual([{ tbm_attributes: { monthly_cost: 75, resource_tower: 'compute' } }]);
  expect(await send('query', `SELECT source.ci_id AS from_id, source.organization_id AS from_org,
      target.ci_id AS to_id, target.organization_id AS to_org
    FROM cmdb.fact_ci_relationships f
    JOIN cmdb.dim_ci source ON source.ci_key = f.from_ci_key
    JOIN cmdb.dim_ci target ON target.ci_key = f.to_ci_key
    WHERE f.is_active = TRUE`)).toEqual([
    { from_id: 'a-source', from_org: ORG_A, to_id: 'a-target', to_org: ORG_A },
  ]);
});

it('full refresh rejects edges from a B node replaced after its dimension batch', async () => {
  nodes = [node('deleted-b', ORG_B), node('a-source', ORG_A), node('a-target', ORG_A)];
  afterCommit = async () => {
    afterCommit = undefined;
    await send('exec', `UPDATE cmdb.dim_ci SET tbm_attributes = '{"monthly_cost": 75}'
      WHERE ci_id = 'deleted-b' AND is_current = TRUE`);
    nodes = [
      node('deleted-b', undefined, { name: 'A replacement' }),
      node('a-source', ORG_A),
      node('a-target', ORG_A),
    ];
    relationships = {
      'deleted-b': [{ _ci: { _id: 'a-target' }, _type: 'DEPENDS_ON' }],
      'a-source': [
        { _ci: { _id: 'deleted-b' }, _type: 'RUNS_ON' },
        { _ci: { _id: 'a-target' }, _type: 'DEPENDS_ON' },
      ],
    };
  };

  const job = {
    id: 'full-refresh-race',
    data: { truncateTables: false, rebuildIndexes: false },
    updateProgress: async () => undefined,
  };
  await new FullRefreshJob(neo4jClient, postgresClient).execute(job as unknown as Job);

  expect(await versions('deleted-b')).toEqual([
    { is_current: true, organization_id: ORG_B, ci_name: 'deleted-b', org_backfilled: false },
  ]);
  expect(await send('query', `SELECT tbm_attributes FROM cmdb.dim_ci
    WHERE ci_id = 'deleted-b' AND is_current = TRUE`)).toEqual([{ tbm_attributes: { monthly_cost: 75 } }]);
  expect(await send('query', `SELECT source.ci_id AS from_id, source.organization_id AS from_org,
      target.ci_id AS to_id, target.organization_id AS to_org
    FROM cmdb.fact_ci_relationships f
    JOIN cmdb.dim_ci source ON source.ci_key = f.from_ci_key
    JOIN cmdb.dim_ci target ON target.ci_key = f.to_ci_key
    WHERE f.is_active = TRUE`)).toEqual([
    { from_id: 'a-source', from_org: ORG_A, to_id: 'a-target', to_org: ORG_A },
  ]);
});

it('reconciles only the current A generation after replacing B, including a subsequent restore', async () => {
  nodes = [node('reused', ORG_B, { name: 'B private', type: 'database' })];
  beforeReconciliationGraphRead = () => {
    nodes = [node('reused', ORG_A, { name: 'A own', type: 'server' })];
  };
  const job = {
    id: 'reconcile-reused',
    data: { ciIds: ['reused'], autoResolve: true, conflictStrategy: 'neo4j-wins' },
    updateProgress: async () => undefined,
  };

  const reconciled = await new ReconciliationJob(neo4jClient, postgresClient).execute(job as unknown as Job);
  expect(reconciled._conflictsResolved).toBe(1);
  expect(reconciled._conflicts[0]._neo4jValue).toMatchObject({
    _id: 'reused', name: 'A own', _type: 'server', organization_id: ORG_A,
  });
  expect(await send('query', `SELECT ci_name, ci_type, organization_id
    FROM cmdb.dim_ci WHERE ci_id = 'reused' AND is_current = TRUE`)).toEqual([
    { ci_name: 'A own', ci_type: 'server', organization_id: ORG_A },
  ]);

  nodes = [];
  const restored = await new ReconciliationJob(neo4jClient, postgresClient).execute({
    ...job, data: { ...job.data, conflictStrategy: 'postgres-wins' },
  } as unknown as Job);
  expect(restored._conflictsResolved).toBe(1);
  expect((await neo4jClient.getCI('reused', ORG_A))?.name).toBe('A own');
  expect(await neo4jClient.getCI('reused', ORG_B)).toBeNull();
});

it('leaves a disappeared node unresolved instead of inserting its old attributes internally', async () => {
  nodes = [node('vanished', ORG_B, { name: 'B private' })];
  beforeReconciliationGraphRead = () => { nodes = []; };
  const job = {
    id: 'reconcile-vanished',
    data: { ciIds: ['vanished'], autoResolve: true, conflictStrategy: 'neo4j-wins' },
    updateProgress: async () => undefined,
  };

  const result = await new ReconciliationJob(neo4jClient, postgresClient).execute(job as unknown as Job);
  expect(result._conflictsResolved).toBe(0);
  expect(result._manualReviewRequired).toBe(1);
  expect(result._conflicts[0]._neo4jValue).toBeNull();
  expect(await versions('vanished')).toEqual([]);
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

it('a ciTypes-filtered complete sync keeps same-org edges to already-synced CIs outside the filter', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('srv', 'srv', 'server', 'active', 'production', TRUE, '${ORG_A}'),
    ('app', 'app', 'application', 'active', 'production', TRUE, '${ORG_A}'),
    ('reused-app', 'B app', 'application', 'active', 'production', TRUE, '${ORG_B}'),
    ('orgless-app', 'B app', 'application', 'active', 'production', TRUE, '${ORG_B}');`);
  nodes = [
    // The server changes, so its dimension gets a new current version (ci_key).
    node('srv', ORG_A, { name: 'srv v2' }),
    node('app', ORG_A, { type: 'application' }),
    // Not synced by this run: B's ids re-created by org A, or with no organization.
    node('reused-app', ORG_A, { type: 'application' }),
    node('orgless-app', undefined, { type: 'application' }),
  ];
  relationships = {
    srv: [
      { _ci: { _id: 'app' }, _type: 'RUNS_ON' },
      { _ci: { _id: 'reused-app' }, _type: 'RUNS_ON' },
      { _ci: { _id: 'orgless-app' }, _type: 'RUNS_ON' },
    ],
  };

  await new Neo4jToPostgresJob(neo4jClient, postgresClient).execute({
    id: 'servers-only', data: { ciTypes: ['server'] }, updateProgress: async () => undefined,
  } as unknown as Job);

  expect(await send('query', `SELECT source.ci_name AS from_name, source.organization_id AS from_org,
      target.ci_id AS to_id, target.organization_id AS to_org
    FROM cmdb.fact_ci_relationships f
    JOIN cmdb.dim_ci source ON source.ci_key = f.from_ci_key AND source.is_current
    JOIN cmdb.dim_ci target ON target.ci_key = f.to_ci_key AND target.is_current
    WHERE f.is_active = TRUE`)).toEqual([
    { from_name: 'srv v2', from_org: ORG_A, to_id: 'app', to_org: ORG_A },
  ]);
});

describe('status-mismatch auto-resolve with an existing row and node', () => {
  const reconcile = (ciId: string, conflictStrategy: string) => new ReconciliationJob(neo4jClient, postgresClient).execute({
    id: `status-${conflictStrategy}`,
    data: { ciIds: [ciId], autoResolve: true, conflictStrategy },
    updateProgress: async () => undefined,
  } as unknown as Job);
  const status = async (ciId: string) => send('query', `SELECT ci_status, organization_id
    FROM cmdb.dim_ci WHERE ci_id = $1 ORDER BY ci_key`, [ciId]);

  beforeEach(async () => {
    // B deleted its node, keeping its current row; org A re-created the id.
    await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
      ('reused-b', 'B private', 'server', 'active', 'production', TRUE, '${ORG_B}'),
      ('own-b', 'own-b', 'server', 'active', 'production', TRUE, '${ORG_B}'),
      ('own-internal', 'own-internal', 'server', 'active', 'production', TRUE, '${INTERNAL_ORG}');`);
    nodes = [
      node('reused-b', ORG_A, { status: 'maintenance' }),
      node('own-b', ORG_B, { status: 'maintenance' }),
      node('own-internal', undefined, { status: 'maintenance' }),
    ];
  });

  it.each(['neo4j-wins', 'postgres-wins'])('%s writes neither an A node status into B nor B row status onto A', async strategy => {
    const result = await reconcile('reused-b', strategy);

    expect(await status('reused-b')).toEqual([{ ci_status: 'active', organization_id: ORG_B }]);
    expect(nodes.find(ci => ci.id === 'reused-b')).toMatchObject({ organization_id: ORG_A, status: 'maintenance' });
    expect(result._conflictsResolved).toBe(0);
    expect(result._manualReviewRequired).toBe(1);
  });

  it('still resolves a row and node of the same organization, including internal org-less nodes', async () => {
    expect((await reconcile('own-b', 'neo4j-wins'))._conflictsResolved).toBe(1);
    expect(await status('own-b')).toEqual([{ ci_status: 'maintenance', organization_id: ORG_B }]);

    expect((await reconcile('own-internal', 'postgres-wins'))._conflictsResolved).toBe(1);
    expect(nodes.find(ci => ci.id === 'own-internal')?.status).toBe('active');
  });
});

it('issues no per-CI history aggregate and no relabel when no relabel is possible', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('ci-b', 'ci-b', 'server', 'active', 'production', TRUE, '${ORG_B}');`);
  nodes = [node('ci-b', ORG_B)];

  await sync();

  expect(statements.filter(sql => /MIN\s*\(\s*effective_from|SET organization_id/i.test(sql))).toEqual([]);
});

describe('sync-cis-to-datamart identifies a CI by its unique node id', () => {
  const syncCIs = () => processSyncCIsToDatamart({
    id: 'sync-cis', data: { incrementalSince: '2026-01-01T00:00:00Z' }, updateProgress: async () => undefined,
  } as unknown as Job);
  // The v3 job also reads ci_name/ci_type/ci_status node properties.
  const v3 = (id: string, organizationId: string | undefined, overrides: Record<string, unknown>) =>
    node(id, organizationId, { ci_type: 'server', ci_status: 'active', ...overrides });

  it.each([['org A', ORG_A], ['no organization', undefined]])(
    'a node of %s carrying ci_id = a backfilled B id claims nothing of it', async (_label, forgerOrganization) => {
      await backfilled('ci-b');
      nodes = [
        // A reconciliation merge copies any attributes, ci_id included, onto
        // the node it creates; only the node id is unique.
        v3('forged', forgerOrganization, { ci_id: 'ci-b', ci_name: 'forged' }),
        v3('ci-b', ORG_B, { ci_id: 'ci-b', ci_name: 'B real' }),
      ];

      expect((await syncCIs()).errors).toEqual([]);

      expect(await versions('ci-b')).toEqual([
        { is_current: false, organization_id: INTERNAL_ORG, ci_name: 'ci-b', org_backfilled: false },
        { is_current: false, organization_id: INTERNAL_ORG, ci_name: 'ci-b', org_backfilled: false },
        { is_current: true, organization_id: ORG_B, ci_name: 'B real', org_backfilled: false },
      ]);
      expect(await versions('forged')).toEqual([
        { is_current: true, organization_id: forgerOrganization ?? INTERNAL_ORG, ci_name: 'forged', org_backfilled: false },
      ]);
      // B's own neo4j-to-postgres sync still versions B's CI in B.
      await sync();
      expect((await versions('ci-b')).filter(v => v.is_current)).toEqual([
        { is_current: true, organization_id: ORG_B, ci_name: 'ci-b', org_backfilled: false },
      ]);
    });
});
