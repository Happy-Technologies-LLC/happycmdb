// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** HP1-S2 M-10 on the CI-owned PG15/Timescale containers. Never run against live DBs. */
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';

const migrations = join(__dirname, '../../../packages/database/src/postgres/migrations');
const up = readFileSync(join(migrations, '035_itil_record_ownership.sql'), 'utf8');
const down = readFileSync(join(migrations, 'rollback/035_itil_record_ownership.down.sql'), 'utf8');
const init = readFileSync(join(__dirname, '../../../infrastructure/scripts/init-postgres.sql'), 'utf8');
const settings = { host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
  user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] };
const db = new Pool({ ...settings, database: process.env['POSTGRES_DB'] });
const A = '11111111-1111-4111-8111-111111111111';
const I = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const databaseName = 'hp1_s2_v3_parity';
afterAll(async () => { await db.end(); });

it('V1 keeps legacy rows inert and globally unique numbers while enforcing owned writes', async () => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const table of ['itil_baselines', 'itil_incidents', 'itil_changes']) {
      const { rows: columns } = await client.query(`SELECT data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name = $1 AND column_name = 'organization_id'`, [table]);
      expect(columns).toEqual([{ data_type: 'uuid', is_nullable: 'YES', column_default: null }]);
      const { rows: guards } = await client.query(`SELECT convalidated, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
        [table, `${table}_organization_write_guard`]);
      expect(guards).toEqual([{ convalidated: false, definition: 'CHECK ((organization_id IS NOT NULL)) NOT VALID' }]);
    }
    const { rows: indexes } = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('idx_itil_baselines_org_name', 'idx_itil_baselines_legacy_name',
        'idx_itil_incidents_org_reported', 'idx_itil_incidents_org_affected', 'idx_itil_changes_org_created')
      ORDER BY indexname`);
    expect(indexes.map(row => row.indexname)).toEqual([
      'idx_itil_baselines_legacy_name', 'idx_itil_baselines_org_name',
      'idx_itil_changes_org_created', 'idx_itil_incidents_org_affected', 'idx_itil_incidents_org_reported',
    ]);
    const { rows: legacy } = await client.query(`SELECT organization_id FROM itil_incidents
      WHERE organization_id IS NULL LIMIT 1`);
    // A pre-cutover fixture written by 001 remains unowned, never attributed.
    if (legacy.length) expect(legacy[0].organization_id).toBeNull();
    await expect(client.query(`INSERT INTO itil_incidents(id, incident_number, title, impact,
      urgency, priority, reported_by) VALUES ($1, 'INC-s2-unowned', 'unowned', 'medium', 'medium', 3, 'actor')`, [I]))
      .rejects.toMatchObject({ code: '23514' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('fresh initdb records all three absent; V1-only cutover and down refuse owned rows', async () => {
  await db.query(`CREATE DATABASE ${databaseName}`);
  const fresh = new Pool({ ...settings, database: databaseName });
  try {
    await fresh.query(init);
    await fresh.query(up);
    const { rows: absent } = await fresh.query(`SELECT to_regclass('public.itil_baselines') AS baseline,
      to_regclass('public.itil_incidents') AS incident, to_regclass('public.itil_changes') AS change`);
    expect(absent).toEqual([{ baseline: null, incident: null, change: null }]);
    await fresh.query(down);
    await fresh.query(`CREATE TABLE itil_baselines(id uuid PRIMARY KEY, organization_id uuid,
      name text NOT NULL, created_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX idx_itil_baselines_org_name ON itil_baselines(organization_id, name)
        WHERE organization_id IS NOT NULL;`);
    await expect(fresh.query(up)).rejects.toThrow(/incomplete ITIL schema/);
    const { rows: partial } = await fresh.query(`SELECT to_regclass('public.itil_incidents') AS incident`);
    expect(partial).toEqual([{ incident: null }]);
    await fresh.query(`CREATE TABLE itil_incidents(id uuid PRIMARY KEY, incident_number text UNIQUE,
      reported_at timestamptz DEFAULT now(), affected_ci_id text);
      CREATE TABLE itil_changes(id uuid PRIMARY KEY, change_number text UNIQUE,
        created_at timestamptz DEFAULT now());`);
    await fresh.query(up);
    await fresh.query(`INSERT INTO itil_incidents(id, incident_number, organization_id)
      VALUES ($1, 'INC-s2-owned', $2)`, [I, A]);
    const rehearsal = await fresh.connect();
    try {
      await expect(rehearsal.query(down)).rejects.toThrow(/refuses owned ITIL records/);
    } finally {
      await rehearsal.query('ROLLBACK');
      rehearsal.release();
    }
    const { rows: retained } = await fresh.query(`SELECT organization_id FROM itil_incidents WHERE id = $1`, [I]);
    expect(retained[0].organization_id).toBe(A);
    await fresh.query('DELETE FROM itil_incidents WHERE id = $1', [I]);
    await fresh.query(down);
    const { rows: dropped } = await fresh.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('itil_incidents', 'itil_changes') AND column_name = 'organization_id'`);
    expect(dropped).toEqual([]);
  } finally {
    await fresh.end();
    await db.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  }
}, 120000);
