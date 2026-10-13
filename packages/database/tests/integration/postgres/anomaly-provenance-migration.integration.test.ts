// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Exercise the exact 026 SQL on a disposable shadow table; never touch live anomalies. */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getPostgresClient } from '../../../src/postgres/client';

const pg = getPostgresClient();
const migration = readFileSync(resolve(__dirname, '../../../src/postgres/migrations/026_anomaly_provenance.sql'), 'utf8');
const rollback = readFileSync(resolve(__dirname, '../../../src/postgres/migrations/rollback/026_anomaly_provenance.down.sql'), 'utf8');
const schema = 'anomaly_migration_probe';

it('bounds lock waiting and adds provenance without building an index under the table lock', async () => {
  await pg.query(`CREATE SCHEMA ${schema}`);
  const holder = await pg.getClient();
  try {
    await pg.query(`CREATE TABLE ${schema}.anomalies AS
      SELECT n::bigint AS id, 'ci-' || n AS ci_id, now() AS detected_at
      FROM generate_series(1, 20000) AS n`);
    await holder.query('BEGIN');
    await holder.query(`SELECT count(*) FROM ${schema}.anomalies`);
    const started = Date.now();
    await expect(pg.transaction(async client => {
      await client.query(`SET LOCAL search_path = ${schema}, public`);
      await client.query(migration);
    })).rejects.toMatchObject({ code: '55P03' });
    expect(Date.now() - started).toBeLessThan(8000);
    await holder.query('ROLLBACK');
    await pg.transaction(async client => {
      await client.query(`SET LOCAL search_path = ${schema}, public`);
      await client.query(migration);
    });
    const columns = await pg.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'anomalies' AND column_name IN ('organization_id', 'ci_incarnation_id')
      ORDER BY column_name`, [schema]);
    expect(columns.rows.map(row => row.column_name)).toEqual(['ci_incarnation_id', 'organization_id']);
    const indexes = await pg.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1', [schema]);
    expect(indexes.rows).toEqual([]);
    expect((await pg.query(`SELECT count(*) AS n FROM ${schema}.anomalies`)).rows[0].n).toBe('20000');
    await pg.transaction(async client => {
      await client.query(`SET LOCAL search_path = ${schema}, public`);
      await client.query(rollback);
    });
    expect((await pg.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='anomalies'
        AND column_name IN ('organization_id', 'ci_incarnation_id')`, [schema])).rows).toEqual([]);
    expect((await pg.query(`SELECT count(*) AS n FROM ${schema}.anomalies`)).rows[0].n).toBe('20000');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pg.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}, 30000);
