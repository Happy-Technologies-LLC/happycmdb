// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** Isolated hosted PG/Timescale acceptance; never run alongside role-sharing suites. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const root = join(__dirname, '../../..');
const file = (path: string) => readFileSync(join(root, path), 'utf8');
const up = process.env['HAP644_BASELINE'] === '1' ? '' :
  file('packages/database/src/postgres/migrations/033_public_business_service_audit_acl.sql');
const down = process.env['HAP644_BASELINE'] === '1' ? '' :
  file('packages/database/src/postgres/migrations/rollback/033_public_business_service_audit_acl.down.sql');
const init = file('infrastructure/scripts/init-postgres.sql');
const biSql = file('infrastructure/database/metabase-init.sql');
const bi = biSql.slice(biSql.indexOf('-- Only audited reporting views'),
  biSql.indexOf('-- Create Helper Functions for Metabase'));
const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const serviceTables = ['dim_business_services', 'business_service_dependencies',
  'ci_business_service_mappings', 'fact_business_service_incidents',
  'fact_business_service_changes', 'business_services'];
const poolFor = (database?: string) => new Pool({
  host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
  database: database || process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'],
  password: process.env['POSTGRES_PASSWORD'],
});
let db: Pool;

async function asRole(pool: Pool, role: string, sql: string, denied = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    if (denied) await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    else return (await client.query(sql)).rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
async function closed(pool: Pool, role: string, withServices: boolean) {
  for (const name of ['cmdb.dim_ci', 'cmdb.v_current_ci_inventory',
    'public.audit_log', 'public.v_ci_change_history_audit',
    ...(withServices ? serviceTables.map((table) => `public.${table}`) : [])]) {
    expect((await pool.query('SELECT has_table_privilege($1, $2, $3) AS allowed',
      [role, name, 'SELECT'])).rows[0].allowed).toBe(false);
    await asRole(pool, role, `SELECT * FROM ${name} LIMIT 1`, true);
  }
  if (withServices) {
    for (const name of serviceTables) {
      const key = name === 'business_services' ? 'name' :
        name === 'dim_business_services' ? 'service_id' : 'id';
      for (const [privilege, sql] of [
        ['INSERT', `INSERT INTO ${name} DEFAULT VALUES`],
        ['UPDATE', `UPDATE ${name} SET ${key} = ${key} WHERE false`],
        ['DELETE', `DELETE FROM ${name} WHERE false`],
      ]) {
        expect((await pool.query('SELECT has_table_privilege($1, $2, $3) AS allowed',
          [role, `public.${name}`, privilege])).rows[0].allowed).toBe(false);
        await asRole(pool, role, sql, true);
      }
    }
    await asRole(pool, role, 'SELECT * FROM public.v_business_service_health', true);
  }
}

if (process.env['HAP644_ACCEPTANCE'] !== '1') {
  it.skip('HAP-644 runs in its isolated hosted real-store job', () => {});
} else {
  beforeAll(async () => {
    db = poolFor();
    await db.query('CREATE ROLE hap644_nonowner LOGIN');
    await db.query('CREATE ROLE metabase_readonly LOGIN');
    await db.query('CREATE ROLE cmdb_user LOGIN');
    await db.query('GRANT USAGE ON SCHEMA public, cmdb TO hap644_nonowner, metabase_readonly, cmdb_user');
    await db.query(`SELECT has_database_privilege('hap644_nonowner', current_database(), 'CONNECT') AS allowed`)
      .then(({ rows }) => expect(rows[0].allowed).toBe(true));
  });
  afterAll(async () => {
    if (!db) return;
    await db.query('DROP OWNED BY hap644_nonowner, metabase_readonly, cmdb_user');
    await db.query('DROP ROLE hap644_nonowner, metabase_readonly, cmdb_user');
    await db.end();
  });
  if (process.env['HAP644_BASELINE'] === '1') {
    it('fails before 033: a connected nonowner must not read CI metadata', async () => {
      await asRole(db, 'hap644_nonowner', 'SELECT metadata FROM cmdb.dim_ci LIMIT 1', true);
    });
  } else {
    describe('HAP-644 ACL after 032', () => {
      it('upgrade, two-org BI reporting, owner app writes and audit inserts', async () => {
        await closed(db, 'hap644_nonowner', true);
        await db.query(`CREATE TABLE IF NOT EXISTS cmdb.schema_migrations
          (migration_name varchar(255) PRIMARY KEY, checksum varchar(64) NOT NULL)`);
        // The test loader runs SQL without a ledger; model the atomic migrator row.
        await db.query(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
          VALUES ('033_public_business_service_audit_acl.sql', 'disposable-proof')`);
        await db.query(down);
        expect((await db.query(`SELECT has_table_privilege('hap644_nonowner',
          'cmdb.dim_ci', 'SELECT') AS allowed`)).rows[0].allowed).toBe(true);
        await db.query('GRANT SELECT ON public.v_business_service_health TO metabase_readonly');
        await db.query(up);
        await db.query(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
          VALUES ('033_public_business_service_audit_acl.sql', 'disposable-proof')`);
        await db.query(bi); // BI initialization after the upgraded schema.
        await closed(db, 'hap644_nonowner', true);
        await closed(db, 'metabase_readonly', true);
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE cmdb_user');
          for (const [id, org] of [['hap644-a', orgA], ['hap644-b', orgB]]) {
            await client.query(`INSERT INTO dim_business_services
              (service_id, name, service_classification, tbm_tower,
               business_criticality, operational_status, organization_id)
              VALUES ($1, $1, 'application', 'applications', 'high', 'active', $2)`, [id, org]);
          }
          await client.query(`INSERT INTO ci_business_service_mappings
            (ci_id, service_id, mapping_type) VALUES ('hap644-ci', 'hap644-a', 'supports')`);
          await client.query(`INSERT INTO audit_log
            (entity_type, entity_id, action, actor, actor_type, changes, prev_hash, entry_hash)
            VALUES ('CI', 'hap644-a', 'CREATE', 'hap644', 'user', '[]', $1, $2)`,
            ['a'.repeat(64), 'b'.repeat(64)]);
          expect((await client.query(`SELECT prev_hash, entry_hash FROM audit_log
            WHERE entity_id = 'hap644-a'`)).rows[0]).toMatchObject({
            prev_hash: 'a'.repeat(64), entry_hash: 'b'.repeat(64),
          });
          expect((await client.query(`SELECT count(*)::int AS n FROM dim_business_services
            WHERE service_id LIKE 'hap644-%'`)).rows[0].n).toBe(2);
          await client.query('RESET ROLE');
          await client.query('SET LOCAL ROLE hap644_nonowner');
          for (const sql of [
            `SELECT * FROM dim_business_services WHERE service_id = 'hap644-b'`,
            `UPDATE dim_business_services SET name = 'tampered' WHERE service_id = 'hap644-b'`,
            `DELETE FROM dim_business_services WHERE service_id = 'hap644-b'`,
            `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
              VALUES ('hap644-ci', 'hap644-b', 'supports')`,
          ]) {
            await client.query('SAVEPOINT denied_probe');
            await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
            await client.query('ROLLBACK TO SAVEPOINT denied_probe');
          }
          await client.query('RESET ROLE');
          await client.query('SET LOCAL ROLE metabase_readonly');
          const a = await client.query('SELECT service_id FROM cmdb.fn_business_service_health($1)', [orgA]);
          const b = await client.query('SELECT service_id FROM cmdb.fn_business_service_health($1)', [orgB]);
          expect(a.rows.map((r) => r.service_id)).toEqual(['hap644-a']);
          expect(b.rows.map((r) => r.service_id)).toEqual(['hap644-b']);
          await expect(client.query('SELECT * FROM v_business_service_health')).rejects.toMatchObject({ code: '42501' });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
        await asRole(db, 'metabase_readonly', 'SELECT * FROM recent_audit_activity LIMIT 1');
        await asRole(db, 'metabase_readonly', 'SELECT * FROM cmdb.v_ci_discovery_summary LIMIT 1');
      }, 120000);

      it('fresh initializer, BI-before and BI-after converge; down guard and reapply preserve ledger', async () => {
        for (const [database, before] of [['hap644_before', true], ['hap644_after', false]] as const) {
          await db.query(`CREATE DATABASE ${database}`);
          const fresh = poolFor(database);
          try {
            await fresh.query('GRANT USAGE ON SCHEMA public TO hap644_nonowner, metabase_readonly, cmdb_user');
            await fresh.query(init);
            await closed(fresh, 'hap644_nonowner', false);
            if (before) {
              await fresh.query('GRANT SELECT ON ALL TABLES IN SCHEMA cmdb TO metabase_readonly');
              await fresh.query('GRANT SELECT ON audit_log TO metabase_readonly');
              await fresh.query(bi);
            }
            await fresh.query(up);
            if (!before) await fresh.query(bi);
            await closed(fresh, 'metabase_readonly', false);
            await asRole(fresh, 'metabase_readonly', 'SELECT * FROM recent_audit_activity LIMIT 1');
            await asRole(fresh, 'metabase_readonly', 'SELECT * FROM cmdb.v_ci_discovery_summary LIMIT 1');
            await fresh.query(`CREATE TABLE cmdb.schema_migrations
              (migration_name varchar(255) PRIMARY KEY, checksum varchar(64) NOT NULL)`);
            await fresh.query(`INSERT INTO cmdb.schema_migrations VALUES
              ('033_public_business_service_audit_acl.sql', 'disposable-proof')`);
            await fresh.query('ALTER TABLE audit_log RENAME TO hap644_wrong_kind');
            await expect(fresh.query(down)).rejects.toThrow('033 down wrong or missing');
            await fresh.query('ALTER TABLE hap644_wrong_kind RENAME TO audit_log');
            await fresh.query(down);
            expect((await fresh.query(`SELECT count(*)::int AS n FROM cmdb.schema_migrations
              WHERE migration_name = '033_public_business_service_audit_acl.sql'`)).rows[0].n).toBe(0);
            await fresh.query(up);
            await fresh.query(`INSERT INTO cmdb.schema_migrations VALUES
              ('033_public_business_service_audit_acl.sql', 'disposable-proof')`);
            await closed(fresh, 'hap644_nonowner', false);
          } finally {
            await fresh.end();
            await db.query(`DROP DATABASE ${database} WITH (FORCE)`);
          }
        }
      }, 180000);
    });
  }
}
