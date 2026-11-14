// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// cm-fu-bi-tenant-scope (cmdb#318 review): every view on the metabase_readonly allowlist reads across all
// organizations, so each carries an `organization_id` column (migration 052) that attributes the row to its tenant.
// The column is attribution for staff, not an access control: Metabase is an internal tool and tenant-facing BI is
// not supported (infrastructure/metabase/README.md, Tenancy).
// The real 001 schema, the tenant-scope migrations 011/012/028/035, migrations 051 and 052 together, and the three BI
// view files run in PGlite; only Timescale (create_hypertable) and uuid-ossp are stubbed.
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
// the migrator runs each file in a transaction (SET LOCAL needs one)
const up051 = `BEGIN;\n${read(`${migrations}/051_bi_view_security_barrier.sql`)}\nCOMMIT;`;

/** The 16 views whose rows belong to a tenant. Every other allowlisted view reads tables with no tenant column. */
const tenantViews = [
  'public.recent_audit_activity', 'cmdb.v_ci_discovery_summary', 'public.v_itil_incident_summary',
  'public.v_itil_change_summary', 'public.v_criticality_distribution', 'public.v_cost_by_tower', 'public.v_cost_trends',
  'public.v_cloud_vs_onprem_costs', 'public.v_top_cost_drivers_bi', 'public.v_underutilized_resources',
  'public.v_incident_summary', 'public.v_incident_trends', 'public.v_change_success_rates', 'public.v_change_calendar',
  'public.v_configuration_accuracy', 'public.v_baseline_drift_detection',
];
const nullViews = allowlist.filter(v => !tenantViews.includes(v));
/** Cost views a BI-supplied predicate must not be pushed into (migration 051, plus v_top_cost_drivers_bi from 052). */
const barrierViews = ['v_executive_cost_summary', 'v_cost_by_tower', 'v_cost_trends', 'v_unit_economics',
  'v_cloud_vs_onprem_costs', 'v_cost_allocation_summary', 'v_depreciation_summary', 'v_underutilized_resources',
  'v_top_cost_drivers_bi'];
const baselineView = 'public.v_baseline_drift_detection';

/** Column names of a relation in attnum order, with the format_type of the last one. */
async function columns(relation: string) {
  return query(`SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a
    WHERE a.attrelid = to_regclass('${relation}') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
}
/** Allowlisted views whose last column is not `organization_id uuid`, or that do not exist. */
async function withoutOrganizationId() {
  const bad: string[] = [];
  for (const view of allowlist) {
    const last = (await columns(view)).at(-1);
    if (last?.attname !== 'organization_id' || last.type !== 'uuid') bad.push(view);
  }
  return bad;
}
/** Tenant views (read as the BI role) whose distinct organization_id values are not exactly {A, B}. */
async function tenantOrgViolations(views: string[]) {
  const bad: string[] = [];
  for (const view of views) {
    const orgs = (await asBi(`SELECT DISTINCT organization_id::text AS org FROM ${view} ORDER BY 1`)).map(r => r['org']);
    if (JSON.stringify(orgs) !== JSON.stringify([A, B])) bad.push(view);
  }
  return bad;
}
const reloptions = async (view: string) =>
  (await query(`SELECT reloptions FROM pg_class WHERE oid = '${view}'::regclass`))[0]['reloptions'];
/** Every privilege (relation and column level, grant option included) of every non-owner grantee on the given views. */
async function aclSnapshot(views: string[]) {
  const oids = `ARRAY_REMOVE(ARRAY[${views.map(v => `to_regclass('${v}')`).join(', ')}], NULL)`;
  return query(`SELECT * FROM (
      SELECT c.oid::regclass::text AS rel, coalesce(g.rolname, 'PUBLIC') AS grantee, a.privilege_type AS privilege,
             a.is_grantable AS grantable, '' AS col
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
      WHERE c.oid = ANY(${oids}) AND a.grantee <> c.relowner
      UNION ALL
      SELECT t.attrelid::regclass::text, coalesce(g.rolname, 'PUBLIC'), a.privilege_type, a.is_grantable, t.attname::text
      FROM pg_attribute t CROSS JOIN LATERAL aclexplode(t.attacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
      WHERE t.attrelid = ANY(${oids}) AND t.attnum > 0 AND NOT t.attisdropped AND t.attname <> 'organization_id'
    ) s ORDER BY rel, grantee, privilege, col`);
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
  it('051 then 052 skip BI views the operator never created and append the column to the views they find', async () => {
    await run(up051);
    await run(up052);
    expect(await query(`SELECT to_regclass('public.v_cost_by_tower') AS absent`)).toEqual([{ absent: null }]);
    // views defined by the 001 schema (the rest come from the BI view files)
    for (const view of ['public.recent_audit_activity', 'public.v_business_service_summary', 'public.v_itil_incident_summary',
      'public.v_itil_change_summary', 'public.v_unified_service_health', 'cmdb.v_ci_discovery_summary'])
      expect((await columns(view)).at(-1)).toEqual({ attname: 'organization_id', type: 'uuid' });
  }, 60000);

  describe('with the BI view files installed', () => {
    beforeAll(async () => {
      for (const file of viewFiles) await run(read(file));
      await run(biSetup);
    }, 60000);

    it('every allowlisted view exists and ends in organization_id uuid', async () => {
      expect(await withoutOrganizationId()).toEqual([]);
    }, 30000);

    it('every tenant view is on the allowlist, and BI reads organization_id from all of them but still not the metadata-carrying v_top_cost_drivers', async () => {
      expect(tenantViews.filter(v => !allowlist.includes(v))).toEqual([]);
      for (const view of allowlist) await asBi(`SELECT organization_id FROM ${view} LIMIT 1`);
      await expect(asBi('SELECT * FROM v_top_cost_drivers')).rejects.toThrow(/permission denied/);
    }, 30000);

    it('051 and 052 compose: every cost view keeps security_barrier through either order and a re-run of the view files', async () => {
      await run(up051);
      for (const view of barrierViews) expect(await reloptions(view)).toEqual(['security_barrier=true']);
      const defs = () => query(`SELECT c.relname, pg_get_viewdef(c.oid) AS def FROM pg_class c WHERE c.relkind = 'v'
        AND c.relnamespace IN ('public'::regnamespace, 'cmdb'::regnamespace) ORDER BY 1`);
      const before = await defs();
      await run(up052); // 052 after 051: nothing to add
      await run(up051);
      for (const file of viewFiles) await run(read(file)); // the documented operator re-run
      expect(await defs()).toEqual(before);
      for (const view of barrierViews) expect(await reloptions(view)).toEqual(['security_barrier=true']);
      await asBi('SELECT organization_id FROM v_top_cost_drivers_bi LIMIT 1'); // the BI grant survived
    }, 60000);

    describe('rows carry the tenant that owns them', () => {
      const incident = (n: number, org: string) => `('INC-${n}', 'incident ${n}', 'high', 'high', 1, 'tester', '${org}')`;
      const change = (number: string, status: string, start: string, outcome: string, org: string) =>
        `('${number}', '${number}', 'normal', '${status}', 'approved', now() + interval '${start}', now() + interval '${start}' + interval '1 hour', ${outcome}, 'tester', '${org}')`;
      beforeAll(async () => {
        // (id, name, type, status, environment, monthly cost, tower, organization, audit_status, utilization %)
        const cis = [
          // tenant A: 25 production servers costing 1000..1024 (5 on the storage tower), half audited compliant, plus
          // a free staging array of another type that a baseline scoped to production servers must not match
          ...Array.from({ length: 25 }, (_, i) => `('a-${i}', 'a-${i}', 'server', 'active', 'production', ${1000 + i}, '${i % 5 === 0 ? 'storage' : 'compute'}', '${A}', '${i % 2 === 0 ? 'compliant' : 'non_compliant'}', 20)`),
          `('a-store', 'a-store', 'storage', 'active', 'staging', 0, 'storage', '${A}', 'compliant', NULL)`,
          // tenant B: 3 production servers costing 10 and a staging database costing 30
          ...Array.from({ length: 3 }, (_, i) => `('b-${i}', 'b-${i}', 'server', 'active', 'production', 10, 'compute', '${B}', '${i < 2 ? 'compliant' : 'unknown'}', 20)`),
          `('b-db', 'b-db', 'database', 'active', 'staging', 30, 'compute', '${B}', 'compliant', 20)`,
        ];
        await run(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, tbm_attributes, itil_attributes, metadata, organization_id)
          SELECT v.id, v.name, v.type, v.status, v.env,
                 jsonb_build_object('monthly_cost', v.cost, 'resource_tower', v.tower, 'cost_pool', 'cloud'),
                 jsonb_build_object('audit_status', v.audit), jsonb_build_object('utilization_pct', v.util), v.org::uuid
          FROM (VALUES ${cis.join(',')}) AS v(id, name, type, status, env, cost, tower, org, audit, util);
          INSERT INTO cmdb.fact_discovery (ci_key, date_key, discovered_at, discovery_job_id, discovery_provider, discovery_method)
            SELECT ci_key, 20260101, now(), 'job-1', 'nmap', 'scan' FROM cmdb.dim_ci WHERE ci_id IN ('a-0', 'b-0');
          INSERT INTO cmdb.fact_ci_changes (ci_key, date_key, changed_at, change_type, field_name, new_value)
            SELECT ci_key, 20260101, now(), 'update', 'monthly_cost', '100' FROM cmdb.dim_ci WHERE ci_id IN ('a-0', 'b-0');
          INSERT INTO audit_log (entity_type, entity_id, action, actor, organization_id)
          VALUES ('CI', 'a-0', 'CREATE', 'tester', '${A}'), ('CI', 'b-0', 'CREATE', 'tester', '${B}');
          INSERT INTO itil_incidents (incident_number, title, impact, urgency, priority, reported_by, organization_id)
          VALUES ${[incident(1, A), incident(2, A), incident(3, B)].join(',')};
          INSERT INTO itil_changes (change_number, title, change_type, status, approval_status, scheduled_start, scheduled_end, outcome, requested_by, organization_id)
          VALUES ${[change('CHG-A1', 'closed', '-10 days', "'successful'", A), change('CHG-A2', 'scheduled', '5 days', 'NULL', A),
            change('CHG-B1', 'closed', '-10 days', "'failed'", B), change('CHG-B2', 'scheduled', '5 days', 'NULL', B)].join(',')};
          INSERT INTO itil_baselines (name, baseline_type, baseline_data, status, created_by, scope, organization_id)
          VALUES ('a-baseline', 'configuration', '{}', 'approved', 'tester', '{"ci_types": ["server"], "environment": "production"}', '${A}'),
                 ('b-baseline', 'configuration', '{}', 'approved', 'tester', '{"ci_types": ["server"], "environment": "production"}', '${B}');
          INSERT INTO business_services (name, created_by, tbm_attributes, bsm_attributes)
          VALUES ('legacy service', 'seed', '{"total_monthly_cost": 500}', '{"annual_revenue_supported": 9000, "customer_count": 3}')`);
      }, 60000);

      it('all 16 tenant views show exactly the two tenants that own rows, never NULL or a third value', async () => {
        expect(await tenantOrgViolations(tenantViews)).toEqual([]);
      });

      // Views with a row key: each row's organization must be the tenant whose data the key names.
      const byCi = (key: string) => (key.startsWith('a-') ? A : B);
      const byChange = (key: string) => (key.startsWith('CHG-A') ? A : B);
      it.each([
        ['public.recent_audit_activity', 'entity_id', byCi],
        ['cmdb.v_ci_discovery_summary', 'ci_id', byCi],
        ['public.v_top_cost_drivers_bi', 'ci_id', byCi],
        ['public.v_underutilized_resources', 'ci_id', byCi],
        ['public.v_itil_incident_summary', 'incident_number', (key: string) => (key === 'INC-3' ? B : A)],
        ['public.v_itil_change_summary', 'change_number', byChange],
        ['public.v_change_calendar', 'change_number', byChange],
      ])('%s attributes every %s to its own tenant', async (view, keyColumn, owner) => {
        const rows = await asBi(`SELECT ${keyColumn} AS k, organization_id::text AS org FROM ${view}`);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter(r => r['org'] !== owner(String(r['k']))).map(r => r['k'])).toEqual([]);
      });

      it('v_top_cost_drivers_bi keeps the top 20 per tenant, so a tenant filter never leaves a small tenant empty', async () => {
        const a = await asBi(`SELECT monthly_cost FROM v_top_cost_drivers_bi WHERE organization_id = '${A}'`);
        const b = await asBi(`SELECT monthly_cost FROM v_top_cost_drivers_bi WHERE organization_id = '${B}' ORDER BY monthly_cost DESC`);
        expect(a).toHaveLength(20);
        expect(Math.min(...a.map(r => Number(r['monthly_cost'])))).toBeGreaterThanOrEqual(1005);
        expect(b.map(r => Number(r['monthly_cost']))).toEqual([30, 10, 10, 10]);
      });

      it('v_cost_by_tower percent-of-total is a share of the tenant\'s own total', async () => {
        for (const [org, total] of [[A, 25 * 1000 + 300], [B, 60]] as const) {
          const rows = await asBi(`SELECT total_monthly_cost, pct_of_total_cost FROM v_cost_by_tower WHERE organization_id = '${org}'`);
          expect(rows.reduce((s, r) => s + Number(r['total_monthly_cost']), 0)).toBe(total);
          expect(rows.reduce((s, r) => s + Number(r['pct_of_total_cost']), 0)).toBeCloseTo(100, 0);
        }
      });

      it('v_cloud_vs_onprem_costs percent-of-total subquery is correlated on the tenant', async () => {
        const pct = async (org: string) => (await asBi(
          `SELECT pct_of_total::float AS p FROM v_cloud_vs_onprem_costs WHERE organization_id = '${org}' ORDER BY 1`)).map(r => r['p']);
        // B: production servers 30 and the staging database 30 of B's 60. Against the global total (25360) both would be ~0.1.
        expect(await pct(B)).toEqual([50, 50]);
        expect(await pct(A)).toEqual([0, 100]);
      });

      it('incident and change aggregates are per tenant', async () => {
        const count = async (org: string) => (await asBi(
          `SELECT sum(incident_count) AS n FROM v_incident_summary WHERE organization_id = '${org}'`))[0]['n'];
        expect([Number(await count(A)), Number(await count(B))]).toEqual([2, 1]);
        const outcome = async (org: string) => (await asBi(
          `SELECT sum(successful_changes) AS ok, sum(failed_changes) AS failed FROM v_change_success_rates WHERE organization_id = '${org}'`))[0];
        expect([await outcome(A), await outcome(B)].map(r => [Number(r['ok']), Number(r['failed'])])).toEqual([[1, 0], [0, 1]]);
      });

      it('a baseline counts, and counts as compliant, only the CIs of its own tenant that its scope matches', async () => {
        const counts = (org: string) => asBi(
          `SELECT matching_ci_count::int AS matching, compliant_ci_count::int AS compliant FROM v_baseline_drift_detection WHERE organization_id = '${org}'`);
        // unscoped by tenant these would be 28/15; the staging array (A) and staging database (B) match no scope term
        expect(await counts(A)).toEqual([{ matching: 25, compliant: 13 }]);
        expect(await counts(B)).toEqual([{ matching: 3, compliant: 2 }]);
      });

      it('every other allowlisted view reads tables with no tenant column, so organization_id is NULL and a tenant filter shows none of it', async () => {
        expect(nullViews).toContain('public.v_unit_economics');
        for (const view of nullViews) {
          expect(await asBi(`SELECT 1 FROM ${view} WHERE organization_id IS NOT NULL`)).toEqual([]);
          for (const org of [A, B]) expect(await asBi(`SELECT 1 FROM ${view} WHERE organization_id = '${org}'`)).toEqual([]);
        }
      });

      it('a tenant view that returns NULL::uuid for organization_id fails the check', async () => {
        const cols = (await query(`SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS c FROM pg_attribute
          WHERE attrelid = 'v_incident_summary'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'organization_id'`))[0]['c'];
        await run(`ALTER VIEW v_incident_summary RENAME TO v_incident_summary_real;
          CREATE VIEW v_incident_summary AS SELECT ${cols}, NULL::uuid AS organization_id FROM v_incident_summary_real;
          GRANT SELECT ON v_incident_summary TO metabase_readonly`);
        try {
          expect(await tenantOrgViolations(['public.v_incident_summary'])).toEqual(['public.v_incident_summary']);
        } finally {
          await run('DROP VIEW v_incident_summary; ALTER VIEW v_incident_summary_real RENAME TO v_incident_summary');
        }
        expect(await tenantOrgViolations(tenantViews)).toEqual([]);
      });
    });

    it('the rollback restores every pre-052 shape without widening or narrowing any privilege, and 052 then upgrades them again', async () => {
      await run(`INSERT INTO cmdb.schema_migrations (migration_name) VALUES ('052_bi_views_organization_id.sql')`);
      // privileges beyond metabase_readonly's SELECT: PUBLIC, a grant-option write grant, and a column-level grant
      await run(`CREATE ROLE bi_writer; CREATE ROLE bi_columns;
        GRANT INSERT, UPDATE, DELETE ON v_cost_by_tower TO bi_writer WITH GRANT OPTION;
        GRANT SELECT ON v_incident_summary TO PUBLIC;
        GRANT SELECT (priority, status) ON v_incident_trends TO bi_columns`);
      const snapshotViews = allowlist.filter(v => v !== baselineView);
      const before = await aclSnapshot(snapshotViews);
      expect(before).toEqual(expect.arrayContaining([
        { rel: 'v_cost_by_tower', grantee: 'bi_writer', privilege: 'UPDATE', grantable: true, col: '' },
        { rel: 'v_incident_summary', grantee: 'PUBLIC', privilege: 'SELECT', grantable: false, col: '' },
        { rel: 'v_incident_trends', grantee: 'bi_columns', privilege: 'SELECT', grantable: false, col: 'priority' },
        { rel: 'v_incident_trends', grantee: 'metabase_readonly', privilege: 'SELECT', grantable: false, col: '' },
      ]));

      await run(down052);
      expect(await query(`SELECT 1 FROM cmdb.schema_migrations WHERE migration_name LIKE '052%'`)).toEqual([]);
      const restored: string[] = [];
      for (const view of allowlist) {
        const cols = await columns(view);
        if (cols.length > 0 && !cols.some(c => c.attname === 'organization_id')) restored.push(view);
      }
      // every view but v_baseline_drift_detection (its pre-052 definition cannot be created: dropped instead)
      expect(restored).toEqual(snapshotViews);
      expect(await columns(baselineView)).toEqual([]);
      expect(await aclSnapshot(snapshotViews)).toEqual(before);
      await asBi('SELECT * FROM v_top_cost_drivers_bi LIMIT 1');
      await expect(asBi('SELECT * FROM v_top_cost_drivers')).rejects.toThrow(/permission denied/);
      for (const view of barrierViews) expect(await reloptions(view)).toEqual(['security_barrier=true']);

      await run(up052);
      for (const file of viewFiles) await run(read(file)); // recreates v_baseline_drift_detection
      expect(await withoutOrganizationId()).toEqual([]);
      expect(await tenantOrgViolations(tenantViews)).toEqual([]);
      expect(await aclSnapshot(snapshotViews)).toEqual(before);
    }, 120000);
  });
});
