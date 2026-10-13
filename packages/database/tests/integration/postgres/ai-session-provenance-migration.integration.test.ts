// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** Forward migrator, manual rollback, and reapply on the disposable integration DB. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getPostgresClient, PostgresClient } from '../../../src/postgres/client';
import { runMigrations } from '../../../src/postgres/migrator';

const admin = getPostgresClient();
const migration = readFileSync(resolve(__dirname, '../../../src/postgres/migrations/027_ai_session_provenance.sql'), 'utf8');
const rollback = readFileSync(resolve(__dirname, '../../../src/postgres/migrations/rollback/027_ai_session_provenance.down.sql'), 'utf8');
const database = 'ai_session_027_rollback_probe';

it('leaves historical rows unowned, bounds locks, and clears ledger for reapply', async () => {
  if (process.env.NODE_ENV !== 'test' || !process.env.POSTGRES_DB?.includes('test')) {
    throw new Error('027 rollback probe requires a disposable integration database');
  }
  const directory = mkdtempSync(join(tmpdir(), 'cmdb-027-'));
  writeFileSync(join(directory, '027_ai_session_provenance.sql'), migration);
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
    await scratch.query(`CREATE TABLE ai_discovery_sessions AS SELECT 'legacy'::text AS session_id`);
    await scratch.query(`CREATE TABLE ai_discovery_patterns AS SELECT 'legacy'::text AS pattern_id`);
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM ai_discovery_sessions');
    const started = Date.now();
    await expect(runMigrations(scratch, directory)).rejects.toMatchObject({ code: '55P03' });
    expect(Date.now() - started).toBeLessThan(8000);
    await holder.query('ROLLBACK');
    await runMigrations(scratch, directory);
    expect((await scratch.query('SELECT session_id, organization_id FROM ai_discovery_sessions')).rows)
      .toEqual([{ session_id: 'legacy', organization_id: null }]);
    expect((await scratch.query('SELECT pattern_id, organization_id FROM ai_discovery_patterns')).rows)
      .toEqual([{ pattern_id: 'legacy', organization_id: null }]);
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM ai_discovery_sessions');
    await manual.query("SET statement_timeout = '8s'");
    const rollbackStarted = Date.now();
    await expect(manual.query(rollback)).rejects.toMatchObject({ code: '55P03' });
    expect(Date.now() - rollbackStarted).toBeLessThan(7000);
    await manual.query('ROLLBACK');
    await holder.query('ROLLBACK');
    await manual.query(rollback);
    expect((await scratch.query('SELECT * FROM cmdb.schema_migrations')).rows).toEqual([]);
    expect((await scratch.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('ai_discovery_sessions', 'ai_discovery_patterns')
        AND column_name='organization_id'`)).rows).toEqual([]);
    await runMigrations(scratch, directory);
    expect((await scratch.query('SELECT session_id, organization_id FROM ai_discovery_sessions')).rows)
      .toEqual([{ session_id: 'legacy', organization_id: null }]);
    expect((await scratch.query('SELECT pattern_id, organization_id FROM ai_discovery_patterns')).rows)
      .toEqual([{ pattern_id: 'legacy', organization_id: null }]);
  } finally {
    await manual.query('ROLLBACK');
    await holder.query('ROLLBACK');
    manual.release();
    holder.release();
    await scratch.close();
    await admin.query(`DROP DATABASE ${database}`);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
