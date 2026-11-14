// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// cm-fu-bi-tenant-scope (cmdb#318 review): every view on the metabase_readonly allowlist reads across all
// organizations, so each carries an `organization_id` column Metabase can row-filter on (migration 052).
// The real 001 schema, the tenant-scope migrations 011/012/028/035, migration 052 and the three BI view files run
// in PGlite; only Timescale (create_hypertable) and uuid-ossp are stubbed.
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const migrations = 'packages/database/src/postgres/migrations';
const viewFiles = ['bsm-analysis', 'cost-analysis', 'itil-analysis'].map(f => `infrastructure/database/views/${f}.sql`);

/** Allowlisted relations, schema-qualified (`public.` when the bootstrap names none). */
const initSql = read('infrastructure/database/metabase-init.sql');
const allowlist = [...(/ARRAY\[([^\]]*)\]/.exec(initSql)![1]).matchAll(/'([^']+)'/g)]
  .map(m => (m[1].includes('.') ? m[1] : `public.${m[1]}`));
// the same BI grant slice the hosted ACL job runs
const biSetup = initSql.slice(initSql.indexOf('-- Only audited reporting views'), initSql.indexOf('-- FD-6 health reporting'));

const host = fork(join(root, 'packages/api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'), [],
  { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, { resolve: (rows: Record<string, unknown>[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, unknown>[]; error?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(new Error(error)); else reply.resolve(rows);
});
const run = (sql: string, op: 'exec' | 'query' = 'exec') => {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params: [] });
  return promise;
};
const query = (sql: string) => run(sql, 'query');
const asBi = async (sql: string) => {
  await run('SET ROLE metabase_readonly');
  try { return await query(sql); } finally { await run('RESET ROLE'); }
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const down052 = read(`${migrations}/rollback/052_bi_views_organization_id.down.sql`);
const up052 = read(`${migrations}/052_bi_views_organization_id.sql`);

/** Column names of a relation in attnum order, with the format_type of the last one. */
async function columns(relation: string) {
  return query(`SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
    WHERE a.attrelid = to_regclass('${relation}') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
}
/** Allowlisted views whose last column is not `organization_id uuid`, or that do not exist. */
async function withoutOrganizationId() {
  const bad: string[] = [];
  for (const view of allowlist) {
    const cols = await columns(view);
    const last = cols.at(-1);
    if (last?.attname !== 'organization_id' || last.type !== 'uuid') bad.push(view);
  }
  return bad;
}

beforeAll(async () => {
  const hypertable = "CREATE FUNCTION create_hypertable(text, text, if_not_exists boolean DEFAULT false, chunk_time_interval interval DEFAULT NULL) RETURNS void LANGUAGE sql AS 'SELECT'";
  await run(`${hypertable}; CREATE ROLE metabase_readonly;`);
  const schema = read(`${migrations}/001_complete_schema.sql`)
    .replace('CREATE EXTENSION IF NOT EXISTS timescaledb;', '')
    .replace('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
      () => "CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';");
  await run(schema);
  for (const file of ['011_ci_organization_scope', '012_itil_baseline_organization_scope', '035_itil_record_ownership',
    '028_change_history_reconciliation_org_provenance']) await run(read(`${migrations}/${file}.sql`));
  await run('CREATE TABLE IF NOT EXISTS cmdb.schema_migrations (migration_name text PRIMARY KEY, checksum text)');
}, 120000);
afterAll(() => { host.kill(); });

describe('BI views carry organization_id (migration 052)', () => {
  it('052 skips BI views the operator never created and appends the column to the views it finds', async () => {
    await run(up052);
    expect(await query(`SELECT to_regclass('public.v_cost_by_tower') AS absent`)).toEqual([{ absent: null }]);
    // defined by the 001 schema (the other 26 come from the BI view files)
    const migrated = ['recent_audit_activity', 'v_business_service_summary', 'v_application_service_summary',
      'v_business_capability_summary', 'v_service_dependency_graph', 'v_itil_incident_summary', 'v_itil_change_summary',
      'v_tbm_cost_pool_summary', 'v_tbm_depreciation_tracking', 'v_unified_service_health']
      .map(v => `public.${v}`).concat('cmdb.v_ci_discovery_summary');
    expect(migrated).toHaveLength(11);
    for (const view of migrated) expect((await columns(view)).at(-1)).toEqual({ attname: 'organization_id', type: 'uuid' });
  }, 60000);

  describe('with the BI view files installed', () => {
    beforeAll(async () => {
      for (const file of viewFiles) await run(read(file));
      await run(biSetup);
    }, 60000);

    it('every allowlisted view exists and ends in organization_id uuid', async () => {
      expect(allowlist).toHaveLength(37);
      expect(await withoutOrganizationId()).toEqual([]);
    }, 30000);

    it('BI reads organization_id from every allowlisted view, and still not the metadata-carrying v_top_cost_drivers', async () => {
      for (const view of allowlist) await asBi(`SELECT organization_id FROM ${view} LIMIT 1`);
      await expect(asBi('SELECT * FROM v_top_cost_drivers')).rejects.toThrow(/permission denied/);
    }, 30000);

    it('re-running the migration over the finished views changes nothing, and keeps a security_barrier set on one', async () => {
      await run('ALTER VIEW v_cost_by_tower SET (security_barrier = true)');
      const before = await query(`SELECT c.relname, pg_get_viewdef(c.oid) AS def FROM pg_class c WHERE c.relkind = 'v'
        AND c.relnamespace IN ('public'::regnamespace, 'cmdb'::regnamespace) ORDER BY 1`);
      await run(up052);
      const after = await query(`SELECT c.relname, pg_get_viewdef(c.oid) AS def FROM pg_class c WHERE c.relkind = 'v'
        AND c.relnamespace IN ('public'::regnamespace, 'cmdb'::regnamespace) ORDER BY 1`);
      expect(after).toEqual(before);
      expect(await query(`SELECT reloptions FROM pg_class WHERE oid = 'v_cost_by_tower'::regclass`))
        .toEqual([{ reloptions: ['security_barrier=true'] }]);
    }, 60000);

    describe('rows carry the tenant that owns them', () => {
      const incident = (n: number, org: string) => `('INC-${n}', 'incident ${n}', 'high', 'high', 1, 'tester', '${org}')`;
      beforeAll(async () => {
        const cis = [
          ...Array.from({ length: 25 }, (_, i) => `('a-${i}', 'a-${i}', 'server', 'active', 'production', ${1000 + i}, '${i % 5 === 0 ? 'storage' : 'compute'}', '${A}')`),
          ...Array.from({ length: 3 }, (_, i) => `('b-${i}', 'b-${i}', 'server', 'active', 'production', 10, 'compute', '${B}')`),
        ];
        await run(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, tbm_attributes, organization_id)
          SELECT v.id, v.name, v.type, v.status, v.env,
                 jsonb_build_object('monthly_cost', v.cost, 'resource_tower', v.tower, 'cost_pool', 'cloud'), v.org::uuid
          FROM (VALUES ${cis.join(',')}) AS v(id, name, type, status, env, cost, tower, org);
          INSERT INTO itil_incidents (incident_number, title, impact, urgency, priority, reported_by, organization_id)
          VALUES ${[incident(1, A), incident(2, A), incident(3, B)].join(',')};
          INSERT INTO itil_baselines (name, baseline_type, baseline_data, status, created_by, scope, organization_id)
          VALUES ('a-baseline', 'configuration', '{}', 'approved', 'tester', '{"ci_types": ["server"]}', '${A}');
          INSERT INTO business_services (name, created_by, tbm_attributes, bsm_attributes)
          VALUES ('legacy service', 'seed', '{"total_monthly_cost": 500}', '{"annual_revenue_supported": 9000, "customer_count": 3}')`);
      }, 60000);

      it('v_top_cost_drivers_bi keeps the top 20 per tenant, so a tenant filter never leaves a small tenant empty', async () => {
        const a = await asBi(`SELECT monthly_cost FROM v_top_cost_drivers_bi WHERE organization_id = '${A}'`);
        const b = await asBi(`SELECT monthly_cost FROM v_top_cost_drivers_bi WHERE organization_id = '${B}'`);
        expect(a).toHaveLength(20);
        expect(Math.min(...a.map(r => Number(r['monthly_cost'])))).toBeGreaterThanOrEqual(1005);
        expect(b.map(r => Number(r['monthly_cost']))).toEqual([10, 10, 10]);
      });

      it('percent-of-total columns are shares of the tenant\'s own total', async () => {
        for (const [org, total] of [[A, 25 * 1000 + 300], [B, 30]] as const) {
          const rows = await asBi(`SELECT total_monthly_cost, pct_of_total_cost FROM v_cost_by_tower WHERE organization_id = '${org}'`);
          expect(rows.reduce((s, r) => s + Number(r['total_monthly_cost']), 0)).toBe(total);
          expect(rows.reduce((s, r) => s + Number(r['pct_of_total_cost']), 0)).toBeCloseTo(100, 0);
        }
      });

      it('incident aggregates are per tenant', async () => {
        const count = async (org: string) => (await asBi(
          `SELECT sum(incident_count) AS n FROM v_incident_summary WHERE organization_id = '${org}'`))[0]['n'];
        expect([Number(await count(A)), Number(await count(B))]).toEqual([2, 1]);
      });

      it('a baseline counts only the CIs of its own tenant', async () => {
        const rows = await asBi(`SELECT matching_ci_count FROM v_baseline_drift_detection WHERE organization_id = '${A}'`);
        expect(rows).toEqual([{ matching_ci_count: 25 }]);
        expect(await asBi(`SELECT 1 FROM v_baseline_drift_detection WHERE organization_id = '${B}'`)).toEqual([]);
      });

      it('views over tables with no tenant column expose NULL, so a tenant filter shows none of their rows', async () => {
        for (const view of ['v_unit_economics', 'v_unified_service_health', 'v_customer_impact_analysis']) {
          expect(await asBi(`SELECT organization_id FROM ${view}`)).toEqual([{ organization_id: null }]);
          for (const org of [A, B]) expect(await asBi(`SELECT 1 FROM ${view} WHERE organization_id = '${org}'`)).toEqual([]);
        }
      });
    });

    it('the rollback restores every pre-052 shape with its grants, and 052 then upgrades them again', async () => {
      await run(`INSERT INTO cmdb.schema_migrations (migration_name) VALUES ('052_bi_views_organization_id.sql')`);
      await run(down052);
      expect(await query(`SELECT 1 FROM cmdb.schema_migrations WHERE migration_name LIKE '052%'`)).toEqual([]);
      const restored: string[] = [];
      for (const view of allowlist) {
        const cols = await columns(view);
        if (cols.length > 0 && !cols.some(c => c.attname === 'organization_id')) restored.push(view);
      }
      // every view but v_baseline_drift_detection (its pre-052 definition cannot be created: dropped instead)
      expect(restored).toHaveLength(36);
      expect(await columns('public.v_baseline_drift_detection')).toEqual([]);
      await asBi('SELECT * FROM v_top_cost_drivers_bi LIMIT 1'); // grant carried over the drop
      expect(await query(`SELECT reloptions FROM pg_class WHERE oid = 'v_cost_by_tower'::regclass`))
        .toEqual([{ reloptions: ['security_barrier=true'] }]);

      await run(up052);
      for (const view of allowlist.filter(v => v !== 'public.v_baseline_drift_detection'))
        expect((await columns(view)).at(-1)).toEqual({ attname: 'organization_id', type: 'uuid' });
      expect(await asBi(`SELECT 1 FROM v_top_cost_drivers_bi WHERE organization_id = '${B}'`)).toHaveLength(3);
    }, 120000);
  });
});
