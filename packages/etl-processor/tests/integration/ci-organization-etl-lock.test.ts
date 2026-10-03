// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The production ETL dimension writers (Neo4jToPostgresJob and
 * processSyncCIsToDatamart) run concurrently against the disposable
 * integration PostgreSQL. Two runs see the same 011-backfilled CI, one with
 * an org-A node and one with an org-B node. Only one may write the next
 * current version: the other must re-read that version under the per-CI lock
 * and refuse it, as a node of another organization.
 *
 * Neo4j is a fixed node per run; PostgreSQL is real, so the lock, the
 * READ COMMITTED re-read and the non-unique current-row index are real.
 */

import type { Pool, PoolClient } from 'pg';
import type { Job } from 'bullmq';
import { PostgresClient } from '../../../database/src/postgres/client';

const INTERNAL = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const mockPg = new PostgresClient({
  _host: process.env.POSTGRES_HOST || 'localhost',
  _port: Number(process.env.POSTGRES_PORT) || 5432,
  _database: process.env.POSTGRES_DB || 'cmdb_test',
  _user: process.env.POSTGRES_USER || 'test',
  _password: process.env.POSTGRES_PASSWORD || 'testpassword',
});
let mockSyncNodes: Array<Record<string, unknown>> = [];
// The pool processSyncCIsToDatamart takes connections from; set per test.
let mockSyncPool: { connect: () => Promise<PoolClient> } | undefined;

// processSyncCIsToDatamart reads its clients from the package singletons.
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: mockSyncPool }),
  getNeo4jClient: () => ({
    getSession: () => ({
      run: async () => ({ records: [mockSyncNodes.shift()!].map(node => ({ get: (key: string) => node[key] })) }),
      close: async () => undefined,
    }),
  }),
}));

import { Neo4jToPostgresJob } from '../../src/jobs/neo4j-to-postgres.job';
import { processSyncCIsToDatamart } from '../../src/jobs/sync-cis-to-datamart.job';

const rawQuery = mockPg.query.bind(mockPg);

afterAll(async () => { await mockPg.close(); });

async function backfilled(ciId: string): Promise<void> {
  await rawQuery(`INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, org_backfilled, tbm_attributes)
    VALUES ($1, 'backfilled', 'server', 'active', 'production', TRUE, $2, TRUE, '{"monthly_cost":75}')`,
  [ciId, INTERNAL]);
}

/**
 * Wraps each new connection so the first transaction pauses after its
 * current-row SELECT for ciId while the second transaction runs. An unlocked
 * writer's second transaction then reads the same backfilled row, writes its
 * version and commits before the first resumes from its stale read. A locked
 * writer's second transaction first requests the per-CI lock, which waits for
 * the first transaction, so the first resumes as soon as that is sent.
 */
function interleave(connect: () => Promise<PoolClient>, ciId: string): () => Promise<PoolClient> {
  let connections = 0;
  let releaseFirst!: () => void;
  const secondDoneOrWaiting = new Promise<void>(resolve => { releaseFirst = resolve; });
  return async () => {
    const client = await connect();
    const order = ++connections;
    const query = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<any>;
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') return async (sql: string, params?: unknown[]) => {
          if (order === 2 && sql.includes('pg_advisory_xact_lock') && params?.[0] === ciId) {
            const pending = query(sql, params);
            releaseFirst();
            return pending;
          }
          const result = await query(sql, params ?? []);
          if (order === 2 && /^(COMMIT|ROLLBACK)$/.test(sql.trim())) {
            releaseFirst();
          }
          if (order === 1 && /^\s*SELECT[\s\S]*FROM cmdb\.dim_ci\s+WHERE ci_id = \$1 AND is_current = true/i.test(sql)
              && params?.[0] === ciId) {
            await secondDoneOrWaiting;
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PoolClient;
  };
}

async function expectOneOrganizationClaimed(ciId: string): Promise<void> {
  const rows = (await rawQuery(
    `SELECT is_current, organization_id, org_backfilled, tbm_attributes->>'monthly_cost' AS monthly_cost
     FROM cmdb.dim_ci WHERE ci_id = $1 ORDER BY ci_key`, [ciId]
  )).rows;
  const current = rows.filter(row => row.is_current);
  expect(current).toHaveLength(1);
  const winner = current[0].organization_id;
  expect([ORG_A, ORG_B]).toContain(winner);
  // The losing organization got no version at all; the backfill stays internal with its cost.
  expect(rows.filter(row => row.organization_id !== INTERNAL && row.organization_id !== winner)).toEqual([]);
  expect(rows.filter(row => row.organization_id === INTERNAL)).toEqual([
    { is_current: false, organization_id: INTERNAL, org_backfilled: false, monthly_cost: '75' },
  ]);
}

test('concurrent neo4j-to-postgres runs for org A and org B write one current version of a backfilled CI', async () => {
  const ciId = `etl-claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await backfilled(ciId);
  const node = (organizationId: string) => ({
    id: ciId, name: `claimed ${organizationId}`, type: 'server', status: 'active', environment: 'production',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', discovered_at: '2026-01-01T00:00:00Z',
    organization_id: organizationId,
  });
  const neo4jFor = (organizationId: string) => ({
    getSession: () => ({
      run: async () => ({ records: [{ get: () => ({ properties: node(organizationId) }) }] }),
      close: async () => undefined,
    }),
  });
  const getClient = jest.spyOn(mockPg, 'getClient').mockImplementation(
    interleave(() => (mockPg.pool as Pool).connect(), ciId)
  );
  const run = (organizationId: string) => new Neo4jToPostgresJob(neo4jFor(organizationId) as any, mockPg).execute({
    id: `etl-${organizationId}`,
    data: { incrementalSince: '2026-01-01T00:00:00Z' },
    updateProgress: async () => undefined,
  } as unknown as Job);

  try {
    await Promise.all([run(ORG_A), run(ORG_B)]);
    await expectOneOrganizationClaimed(ciId);
  } finally {
    getClient.mockRestore();
    await rawQuery('DELETE FROM cmdb.fact_discovery WHERE ci_key IN (SELECT ci_key FROM cmdb.dim_ci WHERE ci_id = $1)', [ciId]);
    await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
  }
}, 30000);

test('concurrent sync-cis-to-datamart runs for org A and org B write one current version of a backfilled CI', async () => {
  const ciId = `sync-claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await backfilled(ciId);
  const node = (organizationId: string) => ({
    ci_id: ciId, ci_name: `claimed ${organizationId}`, ci_type: 'server', ci_status: 'active',
    environment: 'production', organization_id: organizationId,
  });
  mockSyncNodes = [node(ORG_A), node(ORG_B)];
  const pool = mockPg.pool as Pool;
  // Only the job's connections are interleaved; pool.query (used below) is not.
  mockSyncPool = { connect: interleave(() => pool.connect(), ciId) };
  const run = (organizationId: string) => processSyncCIsToDatamart({
    id: `sync-${organizationId}`,
    data: { incrementalSince: '2026-01-01T00:00:00Z' },
    updateProgress: async () => undefined,
  } as unknown as Job);

  try {
    const results = await Promise.all([run(ORG_A), run(ORG_B)]);
    expect(results.map(result => result.errors)).toEqual([[], []]);
    await expectOneOrganizationClaimed(ciId);
  } finally {
    mockSyncPool = undefined;
    await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
  }
}, 30000);
