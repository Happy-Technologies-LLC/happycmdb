// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant isolation and freshness of loadImpactBusinessContext (follow-up to #382, HAP-1927). ci_business_service_mappings has
 * no organization column, so the tenant check of a mapping rides on the three CI-side predicates and the journal predicate
 * of the statement: `c.is_current`, `NOT c.org_backfilled`, `c.organization_id = $2` and `j.organization_id = $2`. The real
 * statement runs on PGlite over the production tables (migration 001 plus the org columns, and the 028 journal table); only
 * getPostgresClient is replaced. Each case below fails when its predicate is removed from the statement.
 */

import { fork } from 'child_process';
import { join } from 'path';
import { impactBusinessTablesSql, migrationSql } from '../../rest/routes/__tests__/fixtures/app-login';
import { loadImpactBusinessContext } from '../impact-business-context';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const OPTIONS = { timeoutMs: 5000 };

// PGlite loads its WASM through dynamic import(), which Jest's module VM rejects: the shared host runs it in a child process.
const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(new Error(error));
  else reply.resolve(rows);
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise;
}
const exec = (sql: string, params: unknown[] = []) => send(params.length ? 'query' : 'exec', sql, params);

const pg = {
  transaction: async <T>(work: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>) =>
    work({ query: async (sql, params = []) => ({ rows: await send('query', sql, params) }) }),
};
jest.mock('@cmdb/database', () => ({ getPostgresClient: () => pg }));

beforeAll(async () => {
  const journal = migrationSql('028_change_history_reconciliation_org_provenance.sql')
    .match(/CREATE TABLE IF NOT EXISTS ci_reconciliation_operations \([\s\S]*?\n\);/);
  if (!journal) throw new Error('Missing production table ci_reconciliation_operations');
  await exec(`${impactBusinessTablesSql()}\n${journal[0]}`);
});
beforeEach(() => exec(
  'TRUNCATE ci_business_service_mappings, dim_business_services, cmdb.dim_ci, ci_reconciliation_operations RESTART IDENTITY CASCADE'));
afterAll(() => { host.kill(); });

interface CiRow { org: string; current?: boolean; backfilled?: boolean }
let serial = 0;
/** One service of `org` mapped to `ci`, and the dim_ci versions of `ci`. */
async function seed(ci: string, cis: CiRow[], service: { org: string; lifecycle?: string; revenue?: number } = { org: ORG_A }) {
  const serviceId = `svc-${++serial}`;
  await exec(
    `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
       operational_status, metadata, organization_id, lifecycle)
     VALUES ($1, $1, 'application', 'application', 'high', 'active', $2::jsonb, $3, $4)`,
    [serviceId, JSON.stringify({ annual_revenue_supported: service.revenue ?? 8760 }), service.org, service.lifecycle ?? 'live']);
  await exec(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES ($1, $2, 'supports')`, [ci, serviceId]);
  for (const row of cis) {
    await exec(
      `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id, is_current, org_backfilled)
       VALUES ($1, $1, 'server', 'active', $2, $3, $4)`,
      [ci, row.org, row.current ?? true, row.backfilled ?? false]);
  }
  return serviceId;
}
async function journal(ci: string, org: string, state: string) {
  await exec(
    `INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state,
       actor, epoch, lease_expires_at)
     VALUES (gen_random_uuid(), gen_random_uuid(), $1, $2, 'api', 'update', true, $3, 'tester', 1, now())`, [org, ci, state]);
}
const serviceIds = async (org: string, ...ci: string[]) =>
  (await loadImpactBusinessContext(org, ci, OPTIONS)).affected_business_services.map(service => service.service_id);

describe('loadImpactBusinessContext tenant isolation and freshness', () => {
  it('returns the live service of the caller\'s own current, non-backfilled CI with its cost', async () => {
    const service = await seed('ci-own', [{ org: ORG_A }]);
    const context = await loadImpactBusinessContext(ORG_A, ['ci-own'], OPTIONS);
    expect(context.affected_business_services.map(s => s.service_id)).toEqual([service]);
    expect(context.cost_per_hour).toBe(1);
    expect(context.unavailable).toEqual(['affected_business_services[].users']);
  });

  it('does not admit a CI whose current row is foreign, though a non-current row is the caller\'s (is_current)', async () => {
    await seed('ci-moved', [{ org: ORG_A, current: false }, { org: ORG_B }]);
    expect(await serviceIds(ORG_A, 'ci-moved')).toEqual([]);
    const control = await seed('ci-moved', [], { org: ORG_B });
    expect(await serviceIds(ORG_B, 'ci-moved')).toEqual([control]);
  });

  it('does not admit an ownership-uncertain (org_backfilled) own-org row, and does once it is certain', async () => {
    const service = await seed('ci-backfilled', [{ org: ORG_A, backfilled: true }]);
    const context = await loadImpactBusinessContext(ORG_A, ['ci-backfilled'], OPTIONS);
    expect(context.affected_business_services).toEqual([]);
    expect(context.cost_per_hour).toBeNull();
    expect(context.unavailable).toEqual(['cost_per_hour']);
    await exec('UPDATE cmdb.dim_ci SET org_backfilled = false WHERE ci_id = $1', ['ci-backfilled']);
    expect(await serviceIds(ORG_A, 'ci-backfilled')).toEqual([service]);
  });

  it.each(['pending', 'failed'])('is hidden by the caller\'s own %s journal operation, not by another org\'s', async state => {
    await seed(`ci-own-${state}`, [{ org: ORG_A }]);
    const foreign = await seed(`ci-foreign-${state}`, [{ org: ORG_A }]);
    await journal(`ci-own-${state}`, ORG_A, state);
    await journal(`ci-foreign-${state}`, ORG_B, state);
    expect(await serviceIds(ORG_A, `ci-own-${state}`, `ci-foreign-${state}`)).toEqual([foreign]);
  });

  it.each(['committed', 'aborted'])('is not hidden by a settled (%s) journal operation of the caller', async state => {
    const service = await seed('ci-settled', [{ org: ORG_A }]);
    await journal('ci-settled', ORG_A, state);
    expect(await serviceIds(ORG_A, 'ci-settled')).toEqual([service]);
  });

  it('does not return another org\'s service mapped to the caller\'s CI, or a retired own-org service', async () => {
    await seed('ci-shared', [{ org: ORG_A }], { org: ORG_B });
    await seed('ci-shared', [], { org: ORG_A, lifecycle: 'retired' });
    expect(await serviceIds(ORG_A, 'ci-shared')).toEqual([]);
  });

  it('does not admit a CI owned only by another org (organization_id)', async () => {
    await seed('ci-foreign-only', [{ org: ORG_B }]);
    expect(await serviceIds(ORG_A, 'ci-foreign-only')).toEqual([]);
  });
});
