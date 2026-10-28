// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * FD17-S1: tbm_cost_pools has no organization, so the cost-pool external-id
 * enrichment matches only internal-organization cmdb.dim_ci rows; a tenant CI
 * whose external_id equals a pool's resourceId is never linked to the pool.
 * The real job runs against PGlite in a forked child (pglite-host.cjs, as in
 * neo4j-to-postgres.org-scope.test.ts) with the cmdb.dim_ci and tbm_cost_pools
 * DDL read verbatim from 001_complete_schema.sql plus 011_ci_organization_scope.sql.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Job } from 'bullmq';

type Row = Record<string, any>;
const host = fork(join(__dirname, '../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'), [],
  { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: Row[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: Row[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
const send = (op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<Row[]> => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
});

// The package index opens a Redis connection at import; the job needs only the pool.
const mockPool = { query: async (sql: string, params: unknown[] = []) => ({ rows: await send('query', sql, params) }) };
jest.mock('@cmdb/database', () => ({ getPostgresClient: () => ({ pool: mockPool }) }));

import { processSyncCostsToDatamart, type SyncCostsJobData } from '../sync-costs-to-datamart.job';

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const RESOURCE = 'i-0fd17s1synthetic';
const POOL = `AWS-Resource-${RESOURCE}`;
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');

beforeAll(async () => {
  const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const ddl = ['cmdb.dim_ci', 'tbm_cost_pools'].map(table => {
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  });
  await send('exec', `CREATE SCHEMA cmdb;\n${ddl.join('\n')}\n${readFileSync(join(MIGRATIONS, '011_ci_organization_scope.sql'), 'utf8')}`);
});
afterAll(() => host.kill());
beforeEach(() => send('exec', `TRUNCATE cmdb.dim_ci, tbm_cost_pools RESTART IDENTITY;
  INSERT INTO tbm_cost_pools (name, cost_pool_type, cost_center, monthly_budget, annual_budget, allocation_rules, created_by)
  VALUES ('${POOL}', 'cloud', 'compute', 10, 120, '{"resourceId": "${RESOURCE}"}', 'test');`));

const currentCI = async (ciId: string, organizationId: string): Promise<number> => (await send('query',
  `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, external_id, is_current, organization_id)
   VALUES ($1, $1, 'server', 'active', $2, TRUE, $3) RETURNING ci_key`, [ciId, RESOURCE, organizationId]))[0]!['ci_key'];

async function sync() {
  const result = await processSyncCostsToDatamart({ id: 'job-1', data: { validateAllocations: true } } as Job<SyncCostsJobData>);
  return { result, rules: (await send('query', 'SELECT allocation_rules FROM tbm_cost_pools'))[0]!['allocation_rules'] };
}

it('a current dim_ci row of another organization with external_id = resourceId does not enrich the pool', async () => {
  await currentCI('ci-b', ORG_B);
  const { result, rules } = await sync();
  expect(result.costPoolsEnriched).toBe(0);
  expect(result.enrichmentErrors).toEqual([`Cost pool ${POOL}: CI not found for resource: ${RESOURCE}`]);
  expect(rules).toEqual({ resourceId: RESOURCE });
});

it('the internal organization row enriches the pool, even when another organization has the same external_id', async () => {
  await currentCI('ci-b', ORG_B);
  const internalKey = await currentCI('ci-internal', INTERNAL_ORG);
  const { result, rules } = await sync();
  expect(result.costPoolsEnriched).toBe(1);
  expect(rules).toMatchObject({ resourceId: RESOURCE, ci_key: internalKey, ci_name: 'ci-internal', ci_validated: true });
});
