// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Real Timescale/Postgres and Neo4j acceptance for HP1-S1; global setup
 * applies 001–031 and fails hard on 028–031. No live database is contacted. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import neo4j, { Driver } from 'neo4j-driver';
import { Pool } from 'pg';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let db: Pool;
let graph: Driver;

beforeAll(() => {
  db = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
    database: process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
  graph = neo4j.driver(process.env['NEO4J_URI']!, neo4j.auth.basic(process.env['NEO4J_USERNAME']!, process.env['NEO4J_PASSWORD']!));
});
afterAll(async () => { await db?.end(); await graph?.close(); });

// A rollback makes each case independent even under the shared CI database.
async function transaction(run: (query: (sql: string, values?: unknown[]) => Promise<any>) => Promise<void>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await run((sql, values) => client.query(sql, values));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

if (process.env['HP1_S1_BASELINE'] === '1') {
  it('fails before S1: the legacy writer runs but no org-isolated journal key exists', async () => {
    await transaction(async q => {
      await q(`INSERT INTO ci_change_history (ci_id, change_type, change_source)
        VALUES ('hp1-baseline', 'updated', 'kafka')`);
      const { rows } = await q(`SELECT to_regclass('public.ci_reconciliation_operations') AS journal`);
      expect(rows[0].journal).toBeNull();
      const indexes = await q(`SELECT count(*)::int AS n FROM pg_indexes
        WHERE indexname IN ('ci_source_lineage_org_key', 'ci_field_sources_org_key')`);
      expect(indexes.rows[0].n).toBe(0);
    });
  });
} else {

describe('HP1-S1 expand contract on actual Timescale hypertables', () => {
  // HP1-S4a 036 and HP1-S4b 037 contract the org-less writers (asserted refused in hp1-s4a-journal and below).
  it('037: global lineage/field arbiters are gone, new evidence needs an organization and conflict evidence is immutable', async () => {
    const refused = (sql: string, values: unknown[], code: string) => transaction(async q => {
      await expect(q(sql, values)).rejects.toMatchObject({ code });
    });
    await refused(`INSERT INTO ci_field_sources (ci_id, field_name, source_name, organization_id) VALUES ($1, 'host', 's', $2)
      ON CONFLICT (ci_id, field_name) DO NOTHING`, [CI, A], '42P10');
    await refused(`INSERT INTO ci_source_lineage (ci_id, source_name, source_id) VALUES ($1, 's', 'i')`, [CI], '23514');
    await refused(`INSERT INTO reconciliation_conflicts (ci_id, conflict_type, source_data, organization_id)
      VALUES ($1, 'field', '{}', $2)`, [CI, A], '23514');
    await transaction(async q => {
      const { rows } = await q(`INSERT INTO reconciliation_conflicts (ci_id, conflict_type, source_data, organization_id, detected_by)
        VALUES ($1, 'field', '{}', $2, 's4b') RETURNING id`, [CI, A]);
      await expect(q(`UPDATE reconciliation_conflicts SET source_data = '{"forged":true}' WHERE id = $1`, [rows[0].id]))
        .rejects.toMatchObject({ code: '55000' });
    });
  });

  it('isolates journal keys by org; preserves global legacy keys while adding scoped evidence keys', async () => {
    await transaction(async q => {
      const insert = (id: string, org: string) => q(`INSERT INTO ci_reconciliation_operations
        (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state, actor, epoch, lease_expires_at)
        VALUES ($1, $1, $2, 'shared-ci', 'api', 'update', true, 'pending', 'actor', 1, now())`, [id, org]);
      await insert('aaaaaaaa-0000-4000-8000-000000000001', A);
      await insert('aaaaaaaa-0000-4000-8000-000000000002', B);
      await expect(insert('aaaaaaaa-0000-4000-8000-000000000003', A)).rejects.toMatchObject({ code: '23505' });
    });
    await transaction(async q => {
      const insert = (org: string) => q(`INSERT INTO reconciliation_conflicts
        (ci_id, conflict_type, source_data, organization_id, field_name, source_name, source_id, detected_by)
        VALUES ('ci_non_uuid', 'field', '{}', $1, 'host', 'hp1-source', 'instance', 's4b')`, [org]);
      await insert(A);
      await insert(B);
      await expect(insert(A)).rejects.toMatchObject({ code: '23505' });
    });
    const { rows } = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('ci_source_lineage_org_key', 'ci_field_sources_org_key', 'reconciliation_conflicts_pending_key') ORDER BY indexname`);
    expect(rows.map(row => row.indexname)).toEqual([
      'ci_field_sources_org_key', 'ci_source_lineage_org_key', 'reconciliation_conflicts_pending_key',
    ]);
    for (const table of ['ci_reconciliation_operations', 'ci_reconciliation_epochs']) {
      const { rows: acl } = await db.query(`SELECT count(*)::int AS grants FROM pg_class c,
        LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        WHERE c.oid = $1::regclass AND a.grantee = 0`, [table]);
      expect(acl[0].grants).toBe(0);
    }
  });

  it('counts only current non-backfilled service-owned CIs', async () => {
    await transaction(async q => {
      await q(`INSERT INTO dim_business_services
        (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id)
        VALUES ('hp1-s1-service', 'S1', 'application', 'application', 'high', 'active', $1)`, [A]);
      await q(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id, org_backfilled)
        VALUES ('hp1-s1-own', 'own', 'server', 'active', $1, false),
          ('hp1-s1-foreign', 'foreign', 'server', 'active', $2, false),
          ('hp1-s1-backfilled', 'backfilled', 'server', 'active', $1, true)`, [A, B]);
      await q(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES
        ('hp1-s1-own', 'hp1-s1-service', 'hosts'), ('hp1-s1-foreign', 'hp1-s1-service', 'hosts'),
        ('hp1-s1-backfilled', 'hp1-s1-service', 'hosts')`);
      const { rows } = await q(`SELECT supported_ci_count FROM v_business_service_health WHERE service_id = 'hp1-s1-service'`);
      expect(Number(rows[0].supported_ci_count)).toBe(1);
      const health = await q(`SELECT supported_ci_count FROM cmdb.fn_business_service_health($1)
        WHERE service_id = 'hp1-s1-service'`, [A]);
      expect(Number(health.rows[0].supported_ci_count)).toBe(1);
    });
  });

  it('fresh initdb matches migrated S1 columns and indexes and the S4a/S4b contract checks', async () => {
    const database = 'hp1_s1_v3_parity';
    await db.query(`CREATE DATABASE ${database}`);
    const fresh = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
      database, user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
    try {
      await fresh.query(readFileSync(join(__dirname, '../../../infrastructure/scripts/init-postgres.sql'), 'utf8'));
      const tableNames = ['ci_change_history', 'ci_source_lineage', 'ci_field_sources',
        'reconciliation_conflicts', 'reconciliation_rules', 'source_authority',
        'baseline_snapshots', 'drift_detection_results', 'impact_analyses',
        'ci_criticality_scores', 'audit_log', 'ci_reconciliation_operations', 'ci_reconciliation_epochs'];
      const columns = `SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public'
          AND table_name = ANY($1) AND column_name IN
            ('organization_id', 'correlation_id', 'last_correlation_id', 'value_json', 'ci_id',
             'incoming_json', 'detected_by', 'epoch')
          AND NOT (table_name IN ('ci_source_lineage', 'ci_field_sources') AND column_name = 'ci_id')
        ORDER BY 1, 2`;
      const indexes = `SELECT tablename, indexname, regexp_replace(indexdef, ' ON [^ ]+ ', ' ON table ', 'g') AS definition
        FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1)
          AND indexname IN ('ci_source_lineage_org_key', 'ci_field_sources_org_key',
            'reconciliation_conflicts_pending_key', 'ci_reconciliation_operations_inflight',
            'ci_criticality_scores_org_ci_key', 'ci_criticality_scores_legacy_ci_key') ORDER BY 1, 2`;
      // HP1-S4a 036, S4b 037 and S4c 038 (M-2): the same NOT VALID org checks and no criticality PRIMARY KEY.
      const checks = `SELECT conrelid::regclass::text AS tbl, conname, contype, convalidated FROM pg_constraint
        WHERE conrelid IN ('ci_change_history'::regclass, 'ci_criticality_scores'::regclass, 'ci_source_lineage'::regclass,
          'ci_field_sources'::regclass, 'reconciliation_conflicts'::regclass, 'baseline_snapshots'::regclass,
          'drift_detection_results'::regclass, 'impact_analyses'::regclass) AND (conname LIKE
          '%_required' OR (contype = 'p' AND conrelid = 'ci_criticality_scores'::regclass)) ORDER BY 1, 2`;
      expect((await fresh.query(columns, [tableNames])).rows).toEqual((await db.query(columns, [tableNames])).rows);
      expect((await fresh.query(indexes, [tableNames])).rows).toEqual((await db.query(indexes, [tableNames])).rows);
      const contract = (await fresh.query(checks)).rows;
      expect(contract).toEqual((await db.query(checks)).rows);
      expect(contract.map(row => [row.conname, row.convalidated])).toEqual([
        ['baseline_snapshots_organization_required', false],
        ['ci_change_history_organization_required', false], ['ci_criticality_scores_organization_required', false],
        ['ci_field_sources_organization_required', false], ['ci_source_lineage_organization_required', false],
        ['drift_detection_results_organization_required', false], ['impact_analyses_organization_required', false],
        ['reconciliation_conflicts_detector_required', false], ['reconciliation_conflicts_organization_required', false]]);

      // S4c old-then-new cutover on the initdb schema: the org-less (pre-S4c) drift/impact writers are refused;
      // the manual down restores them, and 038 then applies NOT VALID over their legacy rows (rerun: no change).
      const migrationDir = join(__dirname, '../../../packages/database/src/postgres/migrations');
      const oldWriters = [
        `INSERT INTO baseline_snapshots (id, ci_id, snapshot_type, snapshot_data, created_at, created_by)
          VALUES (gen_random_uuid(), 'hp1-s4c', 'configuration', '{}', now(), 'old')`,
        `INSERT INTO drift_detection_results (ci_id, has_drift, detected_at) VALUES ('hp1-s4c', false, now())`,
        `INSERT INTO impact_analyses (id, source_ci_id, change_type, risk_level, analyzed_at)
          VALUES (gen_random_uuid(), 'hp1-s4c', 'RESTART', 'low', now())`];
      for (const write of oldWriters) await expect(fresh.query(write)).rejects.toMatchObject({ code: '23514' });
      await fresh.query(`CREATE TABLE cmdb.schema_migrations (migration_name VARCHAR(255) PRIMARY KEY)`);
      await fresh.query(readFileSync(join(migrationDir, 'rollback/038_drift_impact_org_contract.down.sql'), 'utf8'));
      for (const write of oldWriters) await fresh.query(write);
      for (let run = 0; run < 2; run++) {
        await fresh.query(readFileSync(join(migrationDir, '038_drift_impact_org_contract.sql'), 'utf8'));
        expect((await fresh.query(checks)).rows).toEqual(contract);
      }
      for (const write of oldWriters) await expect(fresh.query(write)).rejects.toMatchObject({ code: '23514' });
      await fresh.query(`INSERT INTO drift_detection_results (ci_id, has_drift, detected_at, organization_id)
        VALUES ('hp1-s4c', false, now(), $1)`, [A]);
      expect((await fresh.query(`SELECT organization_id FROM drift_detection_results WHERE ci_id = 'hp1-s4c'
        ORDER BY organization_id NULLS FIRST`)).rows).toEqual([{ organization_id: null }, { organization_id: A }]);
      for (const table of ['ci_source_lineage', 'ci_field_sources']) {
        const fields = table === 'ci_source_lineage' ? '(ci_id, source_name, source_id)' :
          '(ci_id, field_name, source_name)';
        await expect(fresh.query(`INSERT INTO ${table} ${fields}
          VALUES ('ci_non_uuid', 'host', 'source')`)).rejects.toMatchObject({ code: '22P02' });
      }
      await fresh.query(`INSERT INTO reconciliation_conflicts (ci_id, conflict_type, source_data, status, organization_id,
        detected_by) VALUES ($1, 'field', '{}', 'superseded', $2, 's4b')`, [CI, A]);
      const down = readFileSync(join(__dirname,
        '../../../packages/database/src/postgres/migrations/rollback/029_reconciliation_conflict_identity_rules.down.sql'), 'utf8');
      await expect(fresh.query(down)).rejects.toThrow('029 down refused: superseded conflicts exist');
      await fresh.query('ROLLBACK');
      const { rows: stillTyped } = await fresh.query(`SELECT data_type FROM information_schema.columns
        WHERE table_name = 'reconciliation_conflicts' AND column_name = 'ci_id'`);
      expect(stillTyped[0].data_type).toBe('character varying');
    } finally {
      await fresh.end();
      await db.query(`DROP DATABASE ${database} WITH (FORCE)`);
    }
  });

  it('denies the named BI role in both setup orders, then removes ledger rows on down and reapplies', async () => {
    const migrationDir = join(__dirname, '../../../packages/database/src/postgres/migrations');
    const biInit = readFileSync(join(__dirname, '../../../infrastructure/database/metabase-init.sql'), 'utf8');
    const defaultGrant = 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO metabase_readonly;';
    const reportingGrants = biInit.slice(biInit.indexOf('-- Only audited reporting views'),
      biInit.indexOf('-- Create Helper Functions for Metabase'));
    const files = ['028_change_history_reconciliation_org_provenance',
      '029_reconciliation_conflict_identity_rules', '030_drift_impact_org_provenance',
      '031_business_service_mapping_ownership'];
    await db.query('CREATE ROLE metabase_readonly LOGIN');
    try {
      for (const [database, before] of [['hp1_s1_bi_before', true], ['hp1_s1_bi_after', false]] as const) {
        await db.query(`CREATE DATABASE ${database}`);
        const fresh = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
          database, user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
        try {
          await fresh.query('GRANT USAGE ON SCHEMA public TO metabase_readonly');
          if (before) await fresh.query(defaultGrant);
          await fresh.query(readFileSync(join(__dirname, '../../../infrastructure/scripts/init-postgres.sql'), 'utf8'));
          const assertPrivate = async () => {
            for (const table of ['ci_reconciliation_operations', 'ci_reconciliation_epochs']) {
              const { rows } = await fresh.query(`SELECT has_table_privilege('metabase_readonly', $1, 'SELECT') AS readable`,
                [`public.${table}`]);
              expect(rows[0].readable).toBe(false);
              const connection = await fresh.connect();
              try {
                await connection.query('BEGIN');
                await connection.query('SET LOCAL ROLE metabase_readonly');
                await expect(connection.query(`SELECT * FROM public.${table}`))
                  .rejects.toMatchObject({ code: '42501' });
              } finally {
                await connection.query('ROLLBACK');
                connection.release();
              }
            }
          };
          await assertPrivate();
          await fresh.query(reportingGrants);
          await assertPrivate(); // A later BI bootstrap must leave private tables denied.
          if (!before) continue;

          // V3 initdb contains the S1 columns, not the older business-service
          // tables/views: build those from their canonical 001 and 008–010 SQL.
          const baseSql = readFileSync(join(migrationDir, '001_complete_schema.sql'), 'utf8');
          await fresh.query(baseSql.slice(baseSql.indexOf('-- Dimension table for business services'),
            baseSql.indexOf('-- View: Business Service Health Dashboard')));
          for (const file of ['008_business_service_organization_scope',
            '009_business_service_views_org_scope', '010_business_service_views_org_functions',
            '031_business_service_mapping_ownership']) {
            await fresh.query(readFileSync(join(migrationDir, `${file}.sql`), 'utf8'));
          }

          await fresh.query(`CREATE TABLE cmdb.schema_migrations (
            migration_name VARCHAR(255) PRIMARY KEY, checksum VARCHAR(64) NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
          for (const file of files) {
            await fresh.query(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
              VALUES ($1, 'disposable-proof')`, [`${file}.sql`]);
          }
          await fresh.query(`INSERT INTO dim_business_services
            (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id)
            VALUES ('hp1-reapply-service', 'S1', 'application', 'application', 'high', 'active', $1)`, [A]);
          await fresh.query(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id, org_backfilled)
            VALUES ('hp1-reapply-own', 'own', 'server', 'active', $1, false),
              ('hp1-reapply-foreign', 'foreign', 'server', 'active', $2, false)`, [A, B]);
          await fresh.query(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
            VALUES ('hp1-reapply-own', 'hp1-reapply-service', 'hosts'),
              ('hp1-reapply-foreign', 'hp1-reapply-service', 'hosts')`);
          // Seeded inside the refused down's transaction: 037 keeps org-owned conflict evidence undeletable.
          await expect(fresh.query(`BEGIN; INSERT INTO reconciliation_conflicts (ci_id, conflict_type, source_data, status,
            organization_id, detected_by) VALUES ('${CI}', 'field', '{}', 'superseded', '${A}', 's4b');
            ${readFileSync(join(migrationDir, 'rollback', `${files[1]}.down.sql`), 'utf8')}`))
            .rejects.toThrow('029 down refused: superseded conflicts exist');
          await fresh.query('ROLLBACK');
          expect((await fresh.query(`SELECT count(*)::int AS applied FROM cmdb.schema_migrations
            WHERE migration_name = $1`, [`${files[1]}.sql`])).rows[0].applied).toBe(1);
          for (const file of [...files].reverse()) {
            await fresh.query(readFileSync(join(migrationDir, 'rollback', `${file}.down.sql`), 'utf8'));
          }
          expect((await fresh.query(`SELECT migration_name FROM cmdb.schema_migrations
            WHERE migration_name = ANY($1)`, [files.map(file => `${file}.sql`)])).rows).toEqual([]);
          expect((await fresh.query(`SELECT to_regclass('public.ci_reconciliation_operations') AS journal`))
            .rows[0].journal).toBeNull();
          expect(Number((await fresh.query(`SELECT supported_ci_count FROM v_business_service_health
            WHERE service_id = 'hp1-reapply-service'`)).rows[0].supported_ci_count)).toBe(2);
          for (const file of files) {
            await fresh.query(readFileSync(join(migrationDir, `${file}.sql`), 'utf8'));
            await fresh.query(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
              VALUES ($1, 'disposable-proof')`, [`${file}.sql`]);
          }
          expect((await fresh.query(`SELECT count(*)::int AS applied FROM cmdb.schema_migrations
            WHERE migration_name = ANY($1)`, [files.map(file => `${file}.sql`)])).rows[0].applied).toBe(4);
          expect((await fresh.query(`SELECT to_regclass('public.ci_reconciliation_operations') AS journal`))
            .rows[0].journal).not.toBeNull();
          expect(Number((await fresh.query(`SELECT supported_ci_count FROM v_business_service_health
            WHERE service_id = 'hp1-reapply-service'`)).rows[0].supported_ci_count)).toBe(1);
          await assertPrivate(); // A named default grant must also be stripped by 028 reapply.
        } finally {
          await fresh.end();
          await db.query(`DROP DATABASE ${database} WITH (FORCE)`);
        }
      }
    } finally {
      await db.query('DROP ROLE metabase_readonly');
    }
  });

  it('migrates existing V2 initdb into V3 parity and enforces guards and atomic rollback', async () => {
    const dir = join(__dirname, '../../../packages/database/src/postgres/migrations');
    const base = '11f026b00454444795db403bc0b75cb09af5ecd2';
    const v2Script = execFileSync('git', ['show', `${base}:infrastructure/scripts/init-postgres.sql`],
      { encoding: 'utf8' });
    const v3Script = readFileSync(join(__dirname, '../../../infrastructure/scripts/init-postgres.sql'), 'utf8');
    const files = ['028_change_history_reconciliation_org_provenance',
      '029_reconciliation_conflict_identity_rules', '030_drift_impact_org_provenance',
      '031_business_service_mapping_ownership'];
    const up = (n: number) => readFileSync(join(dir, `${files[n]}.sql`), 'utf8');
    const down = (n: number) => readFileSync(join(dir, 'rollback', `${files[n]}.down.sql`), 'utf8');
    const connection = (database: string) => new Pool({ host: process.env['POSTGRES_HOST'],
      port: Number(process.env['POSTGRES_PORT']), database,
      user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
    for (const name of ['hp1_s1_existing_v2', 'hp1_s1_fresh_v3']) await db.query(`CREATE DATABASE ${name}`);
    const existing = connection('hp1_s1_existing_v2');
    const fresh = connection('hp1_s1_fresh_v3');
    const client = await existing.connect();
    const q = (sql: string, values?: unknown[]) => client.query(sql, values);
    try {
      await q(v2Script);
      await fresh.query(v3Script);
      await q(`CREATE TABLE cmdb.schema_migrations (
        migration_name VARCHAR(255) PRIMARY KEY, checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await expect(q(up(0))).rejects.toThrow('HP1 012 requires 011_ci_organization_scope');
      await q(readFileSync(join(dir, '011_ci_organization_scope.sql'), 'utf8'));
      for (const [index, reason] of [[1, 'HP1 013 requires 012'], [2, 'HP1 014 requires 013'],
        [3, 'HP1 017 requires 014']] as const) {
        await expect(q(up(index))).rejects.toThrow(reason);
      }

      await q('BEGIN');
      await q('CREATE VIEW ci_reconciliation_operations AS SELECT 1 AS x');
      await expect(q(up(0))).rejects.toThrow('HP1 012 wrong object');
      await q('ROLLBACK');
      expect((await q(`SELECT to_regclass('public.ci_reconciliation_operations') AS journal`))
        .rows[0].journal).toBeNull();

      // The same V2 copy must not retain 028 after any later step aborts.
      await q('BEGIN');
      await q(up(0));
      await expect(q('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' });
      await q('ROLLBACK');
      expect((await q(`SELECT to_regclass('public.ci_reconciliation_operations') AS journal`))
        .rows[0].journal).toBeNull();
      expect((await q(`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ci_change_history' AND column_name = 'organization_id'`)).rows).toEqual([]);

      for (let i = 0; i < files.length; i++) {
        await q('BEGIN');
        await q(up(i));
        await q(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
          VALUES ($1, 'disposable-proof')`, [`${files[i]}.sql`]);
        await q('COMMIT');
      }
      expect((await q(`SELECT to_regclass('public.v_business_service_health') AS view`))
        .rows[0].view).toBeNull(); // 009/010 absent on V2; 031 records absence.
      await q('BEGIN');
      await q('CREATE TABLE v_business_service_health (x int)');
      await expect(q(up(3))).rejects.toThrow('HP1 017 wrong object');
      await q('ROLLBACK');

      const catalog = async (pool: Pool) => ({
        columns: (await pool.query(`SELECT table_name, column_name, data_type, is_nullable
          FROM information_schema.columns WHERE table_schema IN ('public', 'cmdb')
            AND table_name IN ('ci_change_history', 'ci_source_lineage', 'ci_field_sources',
              'reconciliation_conflicts', 'reconciliation_rules', 'source_authority',
              'baseline_snapshots', 'drift_detection_results', 'impact_analyses',
              'ci_criticality_scores', 'audit_log', 'ci_reconciliation_operations',
              'ci_reconciliation_epochs', 'dim_ci')
            AND column_name IN ('organization_id', 'org_backfilled', 'correlation_id',
              'last_correlation_id', 'value_json', 'ci_id', 'incoming_json', 'epoch')
          ORDER BY table_name, column_name`)).rows,
        indexes: (await pool.query(`SELECT tablename, indexname,
            regexp_replace(indexdef, ' ON [^ ]+ ', ' ON table ', 'g') AS definition
          FROM pg_indexes WHERE schemaname = 'public'
            AND indexname IN ('ci_change_history_correlation_key', 'ci_source_lineage_org_key',
              'ci_field_sources_org_key', 'reconciliation_conflicts_pending_key',
              'ci_reconciliation_operations_inflight', 'ci_criticality_scores_org_ci_key')
          ORDER BY tablename, indexname`)).rows,
        acl: (await pool.query(`SELECT relname, relacl::text AS acl FROM pg_class
          WHERE oid IN ('public.ci_reconciliation_operations'::regclass,
            'public.ci_reconciliation_epochs'::regclass) ORDER BY relname`)).rows,
      });
      const migrated = await catalog(existing);
      for (let i = 0; i < files.length; i++) {
        await q('BEGIN');
        await q(up(i));
        await q('COMMIT');
      }
      expect(await catalog(existing)).toEqual(migrated); // rerun makes no catalog/ACL difference
      expect(await catalog(fresh)).toEqual(migrated); // existing V2+011+028–031 = fresh V3

      await expect(q(down(0))).rejects.toThrow('028 down refused: 029 migration still recorded');
      await q('ROLLBACK');
      expect((await q(`SELECT count(*)::int AS applied FROM cmdb.schema_migrations`))
        .rows[0].applied).toBe(4);
      await q(down(3));
      await q(`INSERT INTO baseline_snapshots
        (id, ci_id, snapshot_type, snapshot_data, created_at, created_by, organization_id)
        VALUES ($1, 'hp1', 'manual', '{}', now(), 'test', $2)`, [CI, A]);
      await expect(q(down(2))).rejects.toThrow('030 down refused: organization-stamped');
      await q('ROLLBACK');
      expect((await q(`SELECT count(*)::int AS applied FROM cmdb.schema_migrations
        WHERE migration_name = $1`, [`${files[2]}.sql`])).rows[0].applied).toBe(1);
      await q('DELETE FROM baseline_snapshots WHERE id = $1', [CI]);
      await q(down(2));
      await q(down(1));
      await q(`INSERT INTO audit_log (actor, entity_type, entity_id, action, organization_id)
        VALUES ('test', 'CI', 'hp1-v2-audit', 'UPDATE', $1)`, [A]);
      await expect(q(down(0))).rejects.toThrow('028 down refused: organization provenance');
      await q('ROLLBACK');
      expect((await q(`SELECT count(*)::int AS applied FROM cmdb.schema_migrations
        WHERE migration_name = $1`, [`${files[0]}.sql`])).rows[0].applied).toBe(1);
      await q(`DELETE FROM audit_log WHERE entity_id = 'hp1-v2-audit'`);
      await q(`INSERT INTO ci_change_history (ci_id, change_type, change_source, organization_id)
        VALUES ('hp1-v2-history', 'updated', 'kafka', $1)`, [A]);
      await expect(q(down(0))).rejects.toThrow('028 down refused: organization provenance');
      await q('ROLLBACK');
      expect((await q(`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ci_change_history' AND column_name = 'organization_id'`)).rows)
        .toHaveLength(1);
      await q(`DELETE FROM ci_change_history WHERE ci_id = 'hp1-v2-history'`);
      await q(down(0));
      expect((await q(`SELECT count(*)::int AS applied FROM cmdb.schema_migrations`))
        .rows[0].applied).toBe(0);
    } finally {
      client.release();
      await existing.end();
      await fresh.end();
      for (const name of ['hp1_s1_existing_v2', 'hp1_s1_fresh_v3']) {
        await db.query(`DROP DATABASE ${name} WITH (FORCE)`);
      }
    }
  });

});

it('Neo4j 004 rejects a duplicate op_id across distinct tenants', async () => {
  const session = graph.session();
  const migration = readFileSync(join(__dirname, '../../../packages/database/src/neo4j/migrations/004_reconciliation_op_fence.cypher'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n').trim();
  try {
    await session.run(migration);
    await session.run(`CREATE (:ReconciliationOp {op_id:'hp1-s1-proof', organization_id:$org})`, { org: A });
    await expect(session.run(`CREATE (:ReconciliationOp {op_id:'hp1-s1-proof', organization_id:$org})`, { org: B }))
      .rejects.toThrow();
  } finally {
    await session.run(`MATCH (o:ReconciliationOp {op_id:'hp1-s1-proof'}) DELETE o`);
    await session.close();
  }
});
}
