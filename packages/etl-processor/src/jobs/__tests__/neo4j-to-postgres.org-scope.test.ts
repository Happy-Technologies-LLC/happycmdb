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
const neo4jClient = {
  getSession: () => ({
    run: async () => ({ records: nodes.map(properties => ({ get: () => ({ properties }) })) }),
    close: async () => undefined,
  }),
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
  const ddl = ['cmdb.dim_ci', 'cmdb.fact_discovery'].map(table => {
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
  await send('exec', 'TRUNCATE cmdb.dim_ci, cmdb.fact_discovery RESTART IDENTITY');
  statements.length = 0;
});

it('relabels every version of a 011-backfilled CI to the organization its node names, once, without a new version', async () => {
  await backfilled('ci-b');
  nodes = [node('ci-b', ORG_B)];

  await sync();

  expect(await versions('ci-b')).toEqual([
    { is_current: false, organization_id: ORG_B, ci_name: 'ci-b', org_backfilled: false },
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

it('issues no per-CI history aggregate and no relabel when no relabel is possible', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('ci-b', 'ci-b', 'server', 'active', 'production', TRUE, '${ORG_B}');`);
  nodes = [node('ci-b', ORG_B)];

  await sync();

  expect(statements.filter(sql => /MIN\s*\(\s*effective_from|SET organization_id/i.test(sql))).toEqual([]);
});
