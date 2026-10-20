// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** Isolated hosted real-PG acceptance; the database is disposable. */
import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const root = join(__dirname, '../../..');
const file = (path: string) => readFileSync(join(root, path), 'utf8');
const baseline = process.env['HAP668_BASELINE'] === '1';
const up = baseline ? '' : file('packages/database/src/postgres/migrations/034_history_sequence_discovery_acl.sql');
const down = baseline ? '' : file('packages/database/src/postgres/migrations/rollback/034_history_sequence_discovery_acl.down.sql');
const down033 = baseline ? '' : file('packages/database/src/postgres/migrations/rollback/033_public_business_service_audit_acl.down.sql');
const down032 = baseline ? '' : file('packages/database/src/postgres/migrations/rollback/032_secret_table_public_grants.down.sql');
const init = baseline ? '' : file('infrastructure/scripts/init-postgres.sql');
const reporting = baseline ? '' : file('infrastructure/database/metabase-init.sql');
const bi = reporting.slice(reporting.indexOf('-- Only audited reporting views'),
  reporting.indexOf('-- Create Helper Functions for Metabase'));
const sequences = [
  'dim_ci_ci_key_seq', 'dim_location_location_key_seq', 'dim_owner_owner_key_seq',
  'fact_discovery_discovery_key_seq', 'fact_ci_changes_change_key_seq',
  'fact_ci_relationships_relationship_key_seq',
];
const poolFor = (database?: string) => new Pool({
  host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
  database: database || process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'],
  password: process.env['POSTGRES_PASSWORD'],
});
let db: Pool;

async function asRole(pool: Pool, role: string, sql: string, denied = false, ownerPrelude?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ownerPrelude) await client.query(ownerPrelude);
    await client.query(`SET LOCAL ROLE ${role}`);
    if (denied) await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    else return (await client.query(sql)).rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
async function closed(pool: Pool) {
  for (const relation of ['public.ci_change_history', 'public.discovery_agents',
    'public.active_discovery_agents', 'public.agent_network_coverage']) {
    const privileges = relation === 'public.discovery_agents' ||
      relation === 'public.ci_change_history' ?
      ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : ['SELECT'];
    for (const privilege of privileges) {
      expect((await pool.query('SELECT has_table_privilege($1, $2, $3) AS allowed',
        ['hap668_nonowner', relation, privilege])).rows[0].allowed).toBe(false);
    }
    await asRole(pool, 'hap668_nonowner', `SELECT * FROM ${relation} LIMIT 1`, true);
  }
  for (const sql of [
    `INSERT INTO discovery_agents (agent_id, hostname) VALUES ('untrusted', 'host')`,
    `UPDATE discovery_agents SET hostname = 'untrusted' WHERE false`,
    `DELETE FROM discovery_agents WHERE false`,
  ]) await asRole(pool, 'hap668_nonowner', sql, true);
  for (const sql of [
    `INSERT INTO ci_change_history (ci_id, change_type, change_source)
      VALUES ('untrusted', 'updated', 'untrusted')`,
    `UPDATE ci_change_history SET change_source = 'untrusted' WHERE false`,
    `DELETE FROM ci_change_history WHERE false`,
  ]) await asRole(pool, 'hap668_nonowner', sql, true);
  for (const sequence of sequences) {
    expect((await pool.query('SELECT has_sequence_privilege($1, $2, $3) AS allowed',
      ['hap668_nonowner', `cmdb.${sequence}`, 'USAGE'])).rows[0].allowed).toBe(false);
    expect((await pool.query('SELECT has_sequence_privilege($1, $2, $3) AS allowed',
      ['hap668_nonowner', `cmdb.${sequence}`, 'SELECT'])).rows[0].allowed).toBe(false);
    expect((await pool.query('SELECT has_sequence_privilege($1, $2, $3) AS allowed',
      ['hap668_nonowner', `cmdb.${sequence}`, 'UPDATE'])).rows[0].allowed).toBe(false);
    await asRole(pool, 'hap668_nonowner', `SELECT nextval('cmdb.${sequence}')`, true);
    await asRole(pool, 'hap668_nonowner', `SELECT setval('cmdb.${sequence}', 1)`, true);
    await asRole(pool, 'hap668_nonowner', `SELECT currval('cmdb.${sequence}')`, true,
      `SELECT nextval('cmdb.${sequence}')`);
  }
  await asRole(pool, 'hap668_nonowner', 'SELECT previous_values, new_values, metadata FROM ci_change_history', true);
}
async function appAndBI(pool: Pool) {
  // HP1-S4a (036): the application writer always stamps the verified organization.
  await asRole(pool, 'cmdb_user', `INSERT INTO ci_change_history
    (ci_id, change_type, change_source, previous_values, new_values, metadata, organization_id)
    VALUES ('hap668-ci', 'updated', 'acceptance', '{"private":true}', '{"private":false}', '{"org":"a"}',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')`);
  await asRole(pool, 'cmdb_user', `INSERT INTO cmdb.dim_location
    (location_id, location_name, location_type) VALUES ('hap668-loc', 'test', 'datacenter')
    RETURNING location_key`);
  await asRole(pool, 'cmdb_user', `INSERT INTO discovery_agents (agent_id, hostname)
    VALUES ('hap668-agent', 'host') RETURNING id`);
  await asRole(pool, 'metabase_readonly', 'SELECT * FROM recent_audit_activity LIMIT 1');
  await asRole(pool, 'metabase_readonly', 'SELECT * FROM cmdb.v_ci_discovery_summary LIMIT 1');
  await asRole(pool, 'metabase_readonly', 'SELECT * FROM ci_change_history LIMIT 1', true);
  await asRole(pool, 'metabase_readonly', 'SELECT * FROM active_discovery_agents LIMIT 1', true);
}

if (process.env['HAP668_ACCEPTANCE'] !== '1') {
  it.skip('HAP-668 runs in its isolated hosted real-store job', () => {});
} else {
  beforeAll(async () => {
    db = poolFor();
    await db.query('CREATE ROLE hap668_nonowner LOGIN');
    await db.query('CREATE ROLE cmdb_user LOGIN');
    await db.query('CREATE ROLE metabase_readonly LOGIN');
    await db.query('GRANT USAGE ON SCHEMA public, cmdb TO hap668_nonowner, cmdb_user, metabase_readonly');
    expect((await db.query(`SELECT has_database_privilege('hap668_nonowner',
      current_database(), 'CONNECT') AS allowed`)).rows[0].allowed).toBe(true);
  });
  afterAll(async () => {
    if (!db) return;
    await db.query('DROP OWNED BY hap668_nonowner, cmdb_user, metabase_readonly');
    await db.query('DROP ROLE hap668_nonowner, cmdb_user, metabase_readonly');
    await db.end();
  });
  if (baseline) {
    it('fails before 034: raw history is accessible to a connected nonowner', async () => {
      await asRole(db, 'hap668_nonowner',
        'SELECT previous_values, new_values, metadata FROM ci_change_history LIMIT 1', true);
    });
  } else {
    it('upgrade from 033: deny nonowner, retain app writers and scoped BI', async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS cmdb.schema_migrations
        (migration_name varchar(255) PRIMARY KEY, checksum varchar(64) NOT NULL)`);
      await db.query(`INSERT INTO cmdb.schema_migrations VALUES
        ('032_secret_table_public_grants.sql', 'disposable-proof'),
        ('033_public_business_service_audit_acl.sql', 'disposable-proof'),
        ('034_history_sequence_discovery_acl.sql', 'disposable-proof')`);
      // The fixture loaded 034 before the roles existed. Its guarded down
      // recreates merged #80's PUBLIC ACLs without reopening 019's agents.
      await db.query(down);
      await asRole(db, 'hap668_nonowner',
        'SELECT previous_values, new_values, metadata FROM ci_change_history LIMIT 1');
      for (const sequence of sequences) {
        for (const privilege of ['USAGE', 'SELECT']) {
          expect((await db.query('SELECT has_sequence_privilege($1, $2, $3) AS allowed',
            ['hap668_nonowner', `cmdb.${sequence}`, privilege])).rows[0].allowed).toBe(true);
        }
        await asRole(db, 'hap668_nonowner', `SELECT nextval('cmdb.${sequence}')`);
        await asRole(db, 'hap668_nonowner', `SELECT currval('cmdb.${sequence}')`, false,
          `SELECT nextval('cmdb.${sequence}')`);
      }
      await asRole(db, 'hap668_nonowner', 'SELECT * FROM discovery_agents LIMIT 1', true);
      await db.query(up);
      await db.query(`INSERT INTO cmdb.schema_migrations VALUES
        ('034_history_sequence_discovery_acl.sql', 'disposable-proof')`);
      await closed(db);
      await expect(db.query(down032)).rejects.toThrow('032 down refused');
      await expect(db.query(down033)).rejects.toThrow('033 down refused');
      await db.query(`INSERT INTO cmdb.schema_migrations VALUES
        ('035_future_migration.sql', 'disposable-proof')`);
      await expect(db.query(down)).rejects.toThrow('034 down refused');
      await db.query(`DELETE FROM cmdb.schema_migrations WHERE migration_name = '035_future_migration.sql'`);
      await db.query(bi);
      await appAndBI(db);
      await db.query(down);
      await expect(db.query(down)).rejects.toThrow('034 down requires its migration ledger row');
      // 032 is still dependent on 033 even after 034 is removed.
      await expect(db.query(down032)).rejects.toThrow('032 down refused');
      await db.query(up);
      await db.query(`INSERT INTO cmdb.schema_migrations VALUES
        ('034_history_sequence_discovery_acl.sql', 'disposable-proof')`);
      await closed(db);
      await appAndBI(db);
    }, 120000);

    it('fresh initializer and BI order: raw paths closed, reporting and writers available', async () => {
      for (const [database, before] of [['hap668_before', true], ['hap668_after', false]] as const) {
        await db.query(`CREATE DATABASE ${database}`);
        const fresh = poolFor(database);
        try {
          await fresh.query('GRANT USAGE ON SCHEMA public TO hap668_nonowner, cmdb_user, metabase_readonly');
          await fresh.query(init);
          if (before) await fresh.query(bi);
          await closed(fresh);
          await fresh.query(up);
          if (before) {
            await expect(fresh.query(down)).rejects.toThrow('034 down requires its migration ledger row');
            await closed(fresh);
          }
          if (!before) await fresh.query(bi);
          await closed(fresh);
          await appAndBI(fresh);
          await fresh.query(`CREATE TABLE cmdb.schema_migrations
            (migration_name varchar(255) PRIMARY KEY, checksum varchar(64) NOT NULL)`);
          await fresh.query(`INSERT INTO cmdb.schema_migrations VALUES
            ('034_history_sequence_discovery_acl.sql', 'disposable-proof')`);
          await fresh.query(down);
          // On a fresh installer these were private BEFORE 034: rollback must
          // not create a PUBLIC exposure even briefly before reapplication.
          await closed(fresh);
          await appAndBI(fresh);
          await expect(fresh.query(down)).rejects.toThrow('034 down requires its migration ledger row');
          await fresh.query(up);
          await closed(fresh);
          if (before) {
            await fresh.query(`INSERT INTO cmdb.schema_migrations VALUES
              ('034_history_sequence_discovery_acl.sql', 'disposable-proof')`);
            await fresh.query('DROP TABLE cmdb.hap668_acl_prior');
            await expect(fresh.query(down)).rejects.toThrow('034 down requires its prior ACL snapshot');
            await closed(fresh);
          }
        } finally {
          await fresh.end();
          await db.query(`DROP DATABASE ${database} WITH (FORCE)`);
        }
      }
    }, 180000);
  }
}
