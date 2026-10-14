// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * 020_auth_credential_events (HP1-S6): forward migrator, manual rollback and
 * reapply on a disposable database inside the integration server. Both the
 * forward file and the rollback bound their ACCESS EXCLUSIVE lock on
 * api_keys (no unbounded wait behind a long transaction), the rollback
 * refuses once the credential lifecycle has been used, and a completed
 * rollback removes its ledger row so the migrator re-applies 020.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getPostgresClient, PostgresClient } from '../../../src/postgres/client';
import { runMigrations } from '../../../src/postgres/migrator';

const MIGRATIONS = resolve(__dirname, '../../../src/postgres/migrations');
const admin = getPostgresClient();
const migration = readFileSync(join(MIGRATIONS, '020_auth_credential_events.sql'), 'utf8');
const rollback = readFileSync(join(MIGRATIONS, 'rollback/020_auth_credential_events.down.sql'), 'utf8');
const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
const apiKeysTable = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS api_keys ('),
  schema.indexOf(');', schema.indexOf('CREATE TABLE IF NOT EXISTS api_keys (')) + 2);
const database = 'auth_credential_events_020_rollback_probe';

afterAll(async () => {
  await admin.close();
});

it('bounds its api_keys lock, keeps legacy keys at generation 0, refuses a used rollback, and clears the ledger for reapply', async () => {
  if (process.env.NODE_ENV !== 'test' || !process.env.POSTGRES_DB?.includes('test')) {
    throw new Error('020 rollback probe requires a disposable integration database');
  }
  const directory = mkdtempSync(join(tmpdir(), 'cmdb-020-'));
  writeFileSync(join(directory, '020_auth_credential_events.sql'), migration);
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
  const ledger = async () => (await scratch.query('SELECT migration_name FROM cmdb.schema_migrations')).rows;
  const epochColumn = async () => (await scratch.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'credential_epoch'`)).rows;
  try {
    await scratch.query(apiKeysTable);
    await scratch.query(`INSERT INTO api_keys (user_id, key_hash, name, role) VALUES ('legacy', repeat('a', 64), 'legacy', 'viewer')`);

    // Forward: a session holding api_keys makes the migration fail fast instead of queueing.
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM api_keys');
    const started = Date.now();
    await expect(runMigrations(scratch, directory)).rejects.toMatchObject({ code: '55P03' });
    expect(Date.now() - started).toBeLessThan(8000);
    await holder.query('ROLLBACK');
    await runMigrations(scratch, directory);
    expect(await ledger()).toEqual([{ migration_name: '020_auth_credential_events.sql' }]);
    expect((await scratch.query('SELECT name, credential_epoch FROM api_keys')).rows)
      .toEqual([{ name: 'legacy', credential_epoch: 0 }]);

    // Rollback refuses, changing nothing, once an audit row exists.
    await scratch.query(`INSERT INTO auth_credential_events (user_id, event, actor) VALUES ('legacy', 'default_marker_set_scan', 'probe')`);
    await expect(manual.query(rollback)).rejects.toThrow('020 down refused: auth_credential_events has rows');
    await manual.query('ROLLBACK');
    expect(await ledger()).toEqual([{ migration_name: '020_auth_credential_events.sql' }]);
    expect(await epochColumn()).toEqual([{ column_name: 'credential_epoch' }]);
    await scratch.query('ALTER TABLE auth_credential_events DISABLE TRIGGER USER');
    await scratch.query('DELETE FROM auth_credential_events');
    await scratch.query('ALTER TABLE auth_credential_events ENABLE TRIGGER USER');

    // Rollback is bounded by its own lock timeout too.
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM api_keys');
    await manual.query("SET statement_timeout = '8s'");
    const rollbackStarted = Date.now();
    await expect(manual.query(rollback)).rejects.toMatchObject({ code: '55P03' });
    expect(Date.now() - rollbackStarted).toBeLessThan(7000);
    await manual.query('ROLLBACK');
    await holder.query('ROLLBACK');

    // Completed rollback: objects and ledger row gone.
    await manual.query(rollback);
    expect(await ledger()).toEqual([]);
    expect(await epochColumn()).toEqual([]);
    expect((await scratch.query("SELECT to_regclass('public.auth_credential_events') AS t")).rows).toEqual([{ t: null }]);

    // Reapply: the migrator runs 020 again and the column is back at generation 0.
    await runMigrations(scratch, directory);
    expect(await ledger()).toEqual([{ migration_name: '020_auth_credential_events.sql' }]);
    expect((await scratch.query('SELECT name, credential_epoch FROM api_keys')).rows)
      .toEqual([{ name: 'legacy', credential_epoch: 0 }]);
    expect((await scratch.query("SELECT to_regclass('public.auth_credential_events') AS t")).rows)
      .toEqual([{ t: 'auth_credential_events' }]);
  } finally {
    await manual.query('ROLLBACK');
    await holder.query('ROLLBACK');
    manual.release();
    holder.release();
    await scratch.close();
    await admin.query(`DROP DATABASE ${database}`);
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
