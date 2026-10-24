// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** Isolated hosted real-PG acceptance: creates cluster roles, so it has its own job. */
import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { PostgresClient } from '../../../packages/database/src/postgres/client';
import { runMigrations } from '../../../packages/database/src/postgres/migrator';

const root = join(__dirname, '../../..');
const migrations = join(root, 'packages/database/src/postgres/migrations');
const file = (path: string) => readFileSync(join(root, path), 'utf8');
const biSql = file('infrastructure/database/metabase-init.sql');
const bi = biSql.slice(biSql.indexOf('-- Only audited reporting views'),
  biSql.indexOf('-- Create Helper Functions for Metabase'));
const nonowner = 'hap835_nonowner';
const readers = ['metabase_readonly', 'cmdb_user'];
const databases = ['hap835_migrated', 'hap835_persisted', 'hap835_init'];
// Disposable-container LOGIN password; never a deployed credential.
const password = randomUUID();
const entity = 'hap835-audited-ci';
let db: Pool;

/** A real LOGIN connection as the role, not SET ROLE from the owner. */
async function asLogin(database: string, role: string, sql: string, params: unknown[] = []) {
  const pool = new Pool({
    host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
    database, user: role, password, max: 1,
  });
  try {
    return (await pool.query(sql, params)).rows;
  } finally {
    await pool.end();
  }
}
const viewRows = (database: string, role: string) => asLogin(database, role,
  `SELECT entity_id, actor, change_count FROM public.recent_audit_activity
    WHERE entity_id = $1`, [entity]);
const seeded = [{ entity_id: entity, actor: 'hap835-auditor', change_count: 1 }];

async function scratch(database: string) {
  await db.query(`CREATE DATABASE ${database}`);
  await db.query(`GRANT CONNECT ON DATABASE ${database} TO ${nonowner}, ${readers.join(', ')}`);
  return new PostgresClient({
    _host: process.env['POSTGRES_HOST'] || 'localhost',
    _port: Number(process.env['POSTGRES_PORT']),
    _database: database,
    _user: process.env['POSTGRES_USER'] || 'test',
    _password: process.env['POSTGRES_PASSWORD'] || '',
  });
}
async function seed(client: PostgresClient) {
  await client.query(`INSERT INTO audit_log
    (entity_type, entity_id, action, actor, actor_type, changes)
    VALUES ('CI', $1, 'UPDATE', 'hap835-auditor', 'user', '[{"field":"owner"}]')`, [entity]);
}
/** The view itself refuses a CONNECT-only nonowner; named readers get its rows. */
async function expectClosed(client: PostgresClient, database: string) {
  const { rows } = await client.query(`SELECT
      has_database_privilege($1, current_database(), 'CONNECT') AS connect,
      has_schema_privilege($1, 'public', 'USAGE') AS usage,
      has_table_privilege($1, 'public.audit_log', 'SELECT') AS audit_log`, [nonowner]);
  expect(rows).toEqual([{ connect: true, usage: true, audit_log: false }]);
  await expect(viewRows(database, nonowner)).rejects.toMatchObject({
    code: '42501', message: 'permission denied for view recent_audit_activity',
  });
  for (const reader of readers) expect(await viewRows(database, reader)).toEqual(seeded);
}

if (process.env['HAP835_ACCEPTANCE'] !== '1') {
  it.skip('HAP-835 runs in its isolated hosted real-store job', () => {});
} else {
  beforeAll(async () => {
    db = new Pool({
      host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
      database: process.env['POSTGRES_DB'], user: process.env['POSTGRES_USER'],
      password: process.env['POSTGRES_PASSWORD'],
    });
    for (const role of [nonowner, ...readers]) {
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    }
  });
  afterAll(async () => {
    if (!db) return;
    for (const database of databases) await db.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await db.query(`DROP OWNED BY ${nonowner}, ${readers.join(', ')}`);
    await db.query(`DROP ROLE ${nonowner}, ${readers.join(', ')}`);
    await db.end();
  });

  it('migrator-built database: a CONNECT-only LOGIN role is denied the view; named readers read it', async () => {
    const client = await scratch('hap835_migrated');
    try {
      await runMigrations(client, migrations);
      await seed(client);
      await expectClosed(client, 'hap835_migrated');
      await client.query(bi);
      await expectClosed(client, 'hap835_migrated');
    } finally {
      await client.close();
    }
  }, 180000);

  it('persisted 038 database: 039 applies once, keeps PUBLIC-only readers, and reruns safely', async () => {
    const client = await scratch('hap835_persisted');
    const legacy = mkdtempSync(join(tmpdir(), 'hap835-'));
    try {
      for (const name of readdirSync(migrations).filter((f) => f.endsWith('.sql') && f < '039')) {
        copyFileSync(join(migrations, name), join(legacy, name));
      }
      await runMigrations(client, legacy);
      await seed(client);
      // Before 039: readers needed no grant, so even a CONNECT-only role read rows.
      await client.query(`REVOKE ALL ON recent_audit_activity FROM ${readers.join(', ')}`);
      expect(await viewRows('hap835_persisted', nonowner)).toEqual(seeded);
      const ledger = `SELECT migration_name, checksum, applied_at FROM cmdb.schema_migrations
        ORDER BY migration_name`;
      const before = (await client.query(ledger)).rows;

      await runMigrations(client, migrations);
      const after = (await client.query(ledger)).rows;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.map((row) => row.migration_name)).toEqual(
        readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort());
      await expectClosed(client, 'hap835_persisted');

      await runMigrations(client, migrations);
      expect((await client.query(ledger)).rows).toEqual(after);
      await client.query(`BEGIN;
        ${file('packages/database/src/postgres/migrations/039_recent_audit_activity_acl.sql')}
        COMMIT;`);
      await expectClosed(client, 'hap835_persisted');
    } finally {
      rmSync(legacy, { recursive: true, force: true });
      await client.close();
    }
  }, 180000);

  it('fresh initializer: never PUBLIC-readable, before or after 039 and BI provisioning', async () => {
    const client = await scratch('hap835_init');
    try {
      await client.query(file('infrastructure/scripts/init-postgres.sql'));
      await seed(client);
      await expectClosed(client, 'hap835_init');
      await client.query(`BEGIN;
        ${file('packages/database/src/postgres/migrations/039_recent_audit_activity_acl.sql')}
        COMMIT;`);
      await expectClosed(client, 'hap835_init');
      await client.query(bi);
      await expectClosed(client, 'hap835_init');
    } finally {
      await client.close();
    }
  }, 180000);
}
