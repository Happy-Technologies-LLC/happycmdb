// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * HAP-774 S5b C1: hosted disposable PG15/Timescale acceptance for 042_app_role_grants. It creates the cluster role
 * happycmdb_app (NOLOGIN, no password; queries run through SET ROLE from the bootstrap owner), so it runs only in its
 * own CI job. The app role is a non-owner: every query below is permission-checked exactly as the API's would be.
 */
import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const migrations = join(__dirname, '../../../packages/database/src/postgres/migrations');
// Absent on the pre-C1 base: the fail-before run then grants nothing, so every post-042 app query is denied.
const optional = (path: string) => existsSync(join(migrations, path)) ? readFileSync(join(migrations, path), 'utf8') : '';
const up = optional('042_app_role_grants.sql');
const down = optional('rollback/042_app_role_grants.down.sql');
const APP = 'happycmdb_app';

const S = ['SELECT'];
const SI = ['SELECT', 'INSERT'];
const SID = ['SELECT', 'INSERT', 'DELETE'];
const SIU = ['SELECT', 'INSERT', 'UPDATE'];
const SIUD = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
/** Role plan §3.2 (D12 a; no TRUNCATE, D8 b), keyed by regclass text. */
const PLAN_3_2: Record<string, string[]> = {
  ai_discovery_patterns: SIUD, ai_discovery_sessions: SI, ai_pattern_review_history: SI, ai_pattern_usage: SI,
  anomalies: SIU, api_keys: SIUD, architecture_analyses: SIU, audit_log: SI, auth_credential_events: SI,
  baseline_snapshots: SIUD, business_service_dependencies: SIUD, business_services: SIUD,
  ci_business_service_mappings: SIUD, ci_change_alerts: SI, ci_change_history: SI, ci_change_statistics: SIU,
  ci_criticality_scores: SIUD, ci_field_sources: SIU, ci_reconciliation_epochs: SIU, ci_reconciliation_operations: SIU,
  ci_source_lineage: SIU, 'cmdb.dim_ci': SIU, 'cmdb.dim_location': SIU, 'cmdb.dim_owner': SIU,
  'cmdb.fact_ci_changes': SI, 'cmdb.fact_ci_relationships': SIU, 'cmdb.fact_discovery': SI,
  'cmdb.v_ci_change_history': S, 'cmdb.v_ci_discovery_summary': S, 'cmdb.v_ci_relationships': S,
  'cmdb.v_current_ci_inventory': S, connector_configurations: SIUD, connector_registry_cache: SIUD,
  connector_resource_metrics: S, connector_run_history: SIU, connector_run_log_entries: SI, credential_sets: SIUD,
  credentials: SIUD, credential_summaries: S, credential_set_summaries: S, active_api_keys: S,
  discovery_definitions_with_credentials: S, dim_business_services: SIUD, discovery_agents: SIUD,
  active_discovery_agents: S, agent_network_coverage: S, discovery_definitions: SIUD, discovery_provider_settings: SIUD,
  drift_detection_results: SID, fact_business_service_changes: SI, fact_business_service_incidents: SI,
  impact_analyses: SID, installed_connectors: SIUD, itil_baselines: SIUD, itil_changes: SIU, itil_incidents: SIU,
  metrics_aggregated: SI, metrics_timeseries: SI, oauth_states: SIUD, reconciliation_conflicts: SIU,
  reconciliation_rules: SIUD, source_authority: SIU, system_config: SIUD, tbm_cost_pools: SIU, tbm_gl_mappings: SI,
  user_settings: SIUD, v_business_service_health: S, v_tbm_tower_summary: S, v_ci_change_history_audit: S,
  recent_audit_activity: S,
};
/** §3.2 sequences: USAGE on each serial the app inserts through. */
const SERIALS = [['cmdb.dim_ci', 'ci_key'], ['cmdb.dim_location', 'location_key'], ['cmdb.dim_owner', 'owner_key'],
  ['cmdb.fact_discovery', 'discovery_key'], ['cmdb.fact_ci_changes', 'change_key'],
  ['cmdb.fact_ci_relationships', 'relationship_key'], ['business_service_dependencies', 'id'],
  ['ci_business_service_mappings', 'id'], ['fact_business_service_incidents', 'id'],
  ['fact_business_service_changes', 'id'], ['connector_run_log_entries', 'sequence']];
const ESCROW = ['discovery_definition_migration_escrow', 'discovery_definition_migrations'];
const ETL_TRUNCATE = ['cmdb.fact_ci_relationships', 'cmdb.fact_ci_changes', 'cmdb.fact_discovery', 'cmdb.dim_ci'];

/** Representative app statements per area. WHERE false still runs the executor's permission check. */
const APP_QUERIES = [
  // API keys and credentials
  'SELECT id FROM api_keys LIMIT 1',
  'INSERT INTO credentials SELECT * FROM credentials WHERE false',
  'UPDATE credential_sets SET name = name WHERE false',
  'DELETE FROM api_keys WHERE false',
  'SELECT 1 FROM credential_summaries LIMIT 1',
  'SELECT 1 FROM auth_credential_events LIMIT 1',
  // Discovery definitions and agents
  'SELECT config FROM discovery_definitions WHERE false FOR UPDATE',
  'UPDATE discovery_definitions SET config = config WHERE false',
  'DELETE FROM discovery_definitions WHERE false',
  'INSERT INTO discovery_agents SELECT * FROM discovery_agents WHERE false',
  // cmdb dimensions and facts
  'SELECT 1 FROM cmdb.v_current_ci_inventory LIMIT 1',
  `INSERT INTO cmdb.dim_location (location_id, location_name, location_type)
    VALUES ('hap774-c1-loc', 'test', 'datacenter') RETURNING location_key`,
  'UPDATE cmdb.dim_ci SET ci_name = ci_name WHERE false',
  'INSERT INTO cmdb.fact_discovery SELECT * FROM cmdb.fact_discovery WHERE false',
  // Business services
  'SELECT 1 FROM v_business_service_health LIMIT 1',
  'INSERT INTO business_service_dependencies SELECT * FROM business_service_dependencies WHERE false',
  'UPDATE dim_business_services SET name = name WHERE false',
  'DELETE FROM ci_business_service_mappings WHERE false',
  // Run logs
  'SELECT 1 FROM connector_run_log_entries LIMIT 1',
  'INSERT INTO connector_run_log_entries SELECT * FROM connector_run_log_entries WHERE false',
  'UPDATE connector_run_history SET status = status WHERE false',
  // Audit and journal (real rows; the hypertable insert may create a chunk as the non-owner)
  `INSERT INTO audit_log (entity_type, entity_id, action, actor, actor_type, changes)
    VALUES ('CI', 'hap774-c1-ci', 'UPDATE', 'hap774-c1', 'user', '[]') RETURNING id`,
  `INSERT INTO ci_change_history (ci_id, change_type, change_source, organization_id)
    VALUES ('hap774-c1-ci', 'updated', 'acceptance', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') RETURNING id`,
  `UPDATE ci_reconciliation_operations SET attempts = attempts + 1 WHERE id IN
    (SELECT id FROM ci_reconciliation_operations WHERE false FOR UPDATE SKIP LOCKED)`,
  // Sequences
  `SELECT nextval(pg_get_serial_sequence('connector_run_log_entries', 'sequence'))`,
  `SELECT nextval(pg_get_serial_sequence('cmdb.dim_ci', 'ci_key'))`,
];

const RELATIONS = `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`;
const IN_SCOPE = `n.nspname IN ('public', 'cmdb')`;
/** Effective privileges (direct, PUBLIC or inherited) of the app role on every relation and sequence. */
const MATRIX = `SELECT c.oid::regclass::text || ':' || p.priv AS entry ${RELATIONS}
  CROSS JOIN LATERAL unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
    ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] END) p(priv)
  WHERE ${IN_SCOPE} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1::name, c.oid, p.priv)
      ELSE has_table_privilege($1::name, c.oid, p.priv) END`;
/** Direct ACL entries naming the app role. */
const DIRECT = `SELECT c.oid::regclass::text || ':' || a.privilege_type AS entry ${RELATIONS}
  CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE ${IN_SCOPE} AND a.grantee = $1::regrole`;
const ACLS = `SELECT c.oid::regclass::text AS relation, c.relacl::text AS acl ${RELATIONS} WHERE ${IN_SCOPE} ORDER BY 1`;

let db: Pool;
let before: string[] = [];
/** Sorted in JS so they compare with the JS-built expectations regardless of the database collation. */
const entries = async (sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows.map((row: { entry: string }) => row.entry).sort();
const acls = async () => (await db.query(ACLS)).rows;

/** One transaction as the non-owner app role; always rolled back. */
async function asApp(sql: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP}`);
    return (await client.query(sql)).rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
/** Applies a migration body in its own transaction and returns the WARNING texts it raised. */
async function apply(sql: string) {
  const client = await db.connect();
  const warnings: string[] = [];
  const onNotice = (notice: { severity?: string; message?: string }) => {
    if (notice.severity === 'WARNING') warnings.push(String(notice.message));
  };
  client.on('notice', onNotice);
  try {
    await client.query(`BEGIN;\n${sql}\nCOMMIT;`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.off('notice', onNotice);
    client.release();
  }
  return warnings;
}
async function expectedDirect() {
  const sequences = (await db.query(`SELECT pg_get_serial_sequence(t, c)::regclass::text || ':USAGE' AS entry
    FROM unnest($1::text[], $2::text[]) AS s(t, c)`, [SERIALS.map(([t]) => t), SERIALS.map(([, c]) => c)])).rows;
  return [...Object.entries(PLAN_3_2).flatMap(([relation, privileges]) => privileges.map((p) => `${relation}:${p}`)),
    ...sequences.map((row: { entry: string }) => row.entry)].sort();
}

if (process.env['HAP774_C1_ACCEPTANCE'] !== '1') {
  it.skip('HAP-774 C1 runs in its isolated hosted real-store job', () => {});
} else {
  beforeAll(async () => {
    db = new Pool({
      host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
      database: process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'],
      password: process.env['POSTGRES_PASSWORD'],
    });
    // Never adopt a pre-existing role: this disposable cluster must not have one yet.
    expect((await db.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1', [APP])).rows[0].n).toBe(0);
  });
  afterAll(async () => {
    if (!db) return;
    if ((await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP])).rowCount) {
      await db.query(`DROP OWNED BY ${APP}`);
      await db.query(`DROP ROLE ${APP}`);
    }
    await db.end();
  });

  it('role absent: 042 changes no ACL, warns with the fixed text and does not error', async () => {
    const acl = await acls();
    expect(await apply(up)).toEqual([
      '042_app_role_grants: role happycmdb_app does not exist; no privileges granted or revoked']);
    expect(await acls()).toEqual(acl);
  });

  it('before 042: the non-owner app role is denied every representative app query', async () => {
    // Phase B B3 gives the role CONNECT and schema USAGE only (SET ROLE needs no CONNECT).
    await db.query(`CREATE ROLE ${APP} NOLOGIN`);
    await db.query(`GRANT USAGE ON SCHEMA public, cmdb TO ${APP}`);
    before = await entries(MATRIX, [APP]);
    for (const sql of APP_QUERIES) await expect(asApp(sql)).rejects.toMatchObject({ code: '42501' });
  });

  it('after 042: every representative app query passes and the grants are exactly §3.2', async () => {
    expect(await apply(up)).toEqual([]);
    for (const sql of APP_QUERIES) await asApp(sql);
    expect(await entries(DIRECT, [APP])).toEqual(await expectedDirect());
    expect(await entries(MATRIX, [APP])).toEqual([...new Set([...before, ...await expectedDirect()])].sort());
  });

  it('after 042: escrow and ledger are denied even after a stale grant, and nothing is TRUNCATE-able (D8 b)', async () => {
    // A hand grant made before the apply (for example the old shared-role era) is removed by 042's §3.3 REVOKE.
    await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${ESCROW.join(', ')} TO ${APP}`);
    expect(await apply(up)).toEqual([]);
    for (const relation of ESCROW) {
      await expect(asApp(`SELECT 1 FROM ${relation} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
      await expect(asApp(`DELETE FROM ${relation} WHERE false`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(asApp('TRUNCATE cmdb.dim_ci')).rejects.toMatchObject({ code: '42501' });
    const leaked = (await entries(MATRIX, [APP])).filter((entry) =>
      ESCROW.some((relation) => entry.startsWith(`${relation}:`)) || entry.endsWith(':TRUNCATE'));
    expect(leaked).toEqual([]);
    for (const relation of ETL_TRUNCATE) {
      expect((await db.query('SELECT has_table_privilege($1, $2, $3) AS t', [APP, relation, 'TRUNCATE'])).rows[0].t)
        .toBe(false);
    }
  });

  it('rerunning 042 is idempotent', async () => {
    const acl = await acls();
    expect(await apply(up)).toEqual([]);
    expect(await acls()).toEqual(acl);
  });

  it('the .down restores exactly the pre-042 privilege matrix and removes the ledger row', async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS cmdb.schema_migrations (migration_name varchar(255) PRIMARY KEY,
      checksum varchar(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
      VALUES ('042_app_role_grants.sql', 'disposable-proof') ON CONFLICT DO NOTHING`);
    await db.query(down);
    expect(await entries(MATRIX, [APP])).toEqual(before);
    expect(await entries(DIRECT, [APP])).toEqual([]);
    expect((await db.query(`SELECT count(*)::int AS n FROM cmdb.schema_migrations
      WHERE migration_name = '042_app_role_grants.sql'`)).rows[0].n).toBe(0);
    for (const sql of APP_QUERIES) await expect(asApp(sql)).rejects.toMatchObject({ code: '42501' });
  });
}
