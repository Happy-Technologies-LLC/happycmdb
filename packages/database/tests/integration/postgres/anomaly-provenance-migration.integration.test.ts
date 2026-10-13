// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Run the actual migrator and manual psql-style rollback on a disposable database. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getPostgresClient, PostgresClient } from '../../../src/postgres/client';
import { runMigrations } from '../../../src/postgres/migrator';

const admin = getPostgresClient();
const migration = readFileSync(resolve(__dirname, '../../../src/postgres/migrations/026_anomaly_provenance.sql'), 'utf8');
const rollback = readFileSync(resolve(__dirname, '../../../src/postgres/migrations/rollback/026_anomaly_provenance.down.sql'), 'utf8');
const database = 'anomaly_026_rollback_probe';

it('bounds migration and manual rollback locks, clearing the ledger so 026 can reapply', async () => {
  if (process.env.NODE_ENV !== 'test' || !process.env.POSTGRES_DB?.includes('test')) {
    throw new Error('026 rollback probe requires the disposable integration database');
  }
  const migrationsDir = mkdtempSync(join(tmpdir(), 'cmdb-026-'));
  writeFileSync(join(migrationsDir, '026_anomaly_provenance.sql'), migration);
  await admin.query(`CREATE DATABASE ${database}`);
  const scratch = new PostgresClient({
    _host: process.env.POSTGRES_HOST || 'localhost',
    _port: Number(process.env.POSTGRES_PORT) || 5432,
    _database: database,
    _user: process.env.POSTGRES_USER || 'test',
    _password: process.env.POSTGRES_PASSWORD || 'testpassword',
  });
  const holder = await scratch.getClient();
  const manual = await scratch.getClient();
  try {
    await scratch.query(`CREATE TABLE anomalies AS
      SELECT n::bigint AS id, 'ci-' || n AS ci_id, now() AS detected_at
      FROM generate_series(1, 20000) AS n`);
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM anomalies');
    const forwardStarted = Date.now();
    await expect(runMigrations(scratch, migrationsDir)).rejects.toMatchObject({ code: '55P03' });
    expect(Date.now() - forwardStarted).toBeLessThan(8000);
    await holder.query('ROLLBACK');
    await runMigrations(scratch, migrationsDir);
    expect((await scratch.query(`SELECT migration_name FROM cmdb.schema_migrations`)).rows)
      .toEqual([{ migration_name: '026_anomaly_provenance.sql' }]);

    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM anomalies');
    // Safety watchdog is longer than the rollback's own 3s lock timeout.
    // The 55P03 assertion proves the SET LOCAL inside the file took effect.
    await manual.query("SET statement_timeout = '8s'");
    const started = Date.now();
    await expect(manual.query(rollback)).rejects.toMatchObject({ code: '55P03' });
    expect(Date.now() - started).toBeLessThan(7000);
    await manual.query('ROLLBACK');
    expect((await scratch.query(`SELECT migration_name FROM cmdb.schema_migrations`)).rows)
      .toEqual([{ migration_name: '026_anomaly_provenance.sql' }]);

    await holder.query('ROLLBACK');
    await manual.query(rollback); // No wrapper transaction: mirrors psql -v ON_ERROR_STOP=1 -f.
    expect((await scratch.query(`SELECT migration_name FROM cmdb.schema_migrations`)).rows).toEqual([]);
    expect((await scratch.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='anomalies'
        AND column_name IN ('organization_id', 'ci_incarnation_id')`)).rows).toEqual([]);
    expect((await scratch.query('SELECT count(*) AS n FROM anomalies')).rows[0].n).toBe('20000');
    await runMigrations(scratch, migrationsDir);
    expect((await scratch.query(`SELECT migration_name FROM cmdb.schema_migrations`)).rows)
      .toEqual([{ migration_name: '026_anomaly_provenance.sql' }]);
    expect((await scratch.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='anomalies'
        AND column_name IN ('organization_id', 'ci_incarnation_id') ORDER BY column_name`)).rows
        .map(row => row.column_name)).toEqual(['ci_incarnation_id', 'organization_id']);
    expect((await scratch.query(`SELECT indexname FROM pg_indexes WHERE tablename='anomalies'`)).rows).toEqual([]);
  } finally {
    await manual.query('ROLLBACK');
    await holder.query('ROLLBACK');
    manual.release();
    holder.release();
    await scratch.close();
    await admin.query(`DROP DATABASE ${database}`);
    rmSync(migrationsDir, { recursive: true, force: true });
  }
}, 30000);
