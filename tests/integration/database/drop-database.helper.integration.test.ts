// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** HAP-810: teardown of Timescale databases that still have a scheduler and open sessions attached. */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Client, Pool } from 'pg';
import { dropDatabaseForce, stopTimescaleBackgroundWorkers } from './drop-database.helper';

const DB = 'hap810_drop_helper';
const ROLE = 'hap810_drop_helper_role';
let admin: Pool;

const connection = (database: string) => ({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']),
  database, user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function schedulerSessions(database: string): Promise<number> {
  const { rows } = await admin.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND backend_type ILIKE '%scheduler%'`, [database]);
  return rows[0].n;
}

async function eventually(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A disposable Timescale database whose scheduler is running and which has a role grant and an open session. */
async function createAttachedDatabase(): Promise<Client> {
  await admin.query(`CREATE DATABASE ${DB}`);
  const session = new Client(connection(DB));
  session.on('error', () => { /* terminated by teardown */ });
  await session.connect();
  await session.query('CREATE EXTENSION timescaledb');
  await session.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  await eventually(async () => (await schedulerSessions(DB)) === 1, 'the Timescale scheduler to attach');
  return session;
}

beforeAll(async () => {
  admin = new Pool(connection(process.env['POSTGRES_DB']!));
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE}`);
});
afterAll(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin?.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin?.end();
});

describe('dropDatabaseForce', () => {
  it('stops the scheduler for good, so nothing but the caller is attached afterwards', async () => {
    const session = await createAttachedDatabase();
    try {
      await stopTimescaleBackgroundWorkers(admin, DB);
      expect(await schedulerSessions(DB)).toBe(0);
      await sleep(1500); // a stopped scheduler must not be restarted behind the caller's back
      expect(await schedulerSessions(DB)).toBe(0);
    } finally {
      await dropDatabaseForce(admin, DB);
    }
  });

  it('drops a database with a live scheduler and an open session, after which the granted role can be dropped', async () => {
    const session = await createAttachedDatabase();
    await dropDatabaseForce(admin, DB);
    session.on('error', () => undefined);
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])).rowCount).toBe(0);
    await admin.query(`DROP ROLE ${ROLE}`); // fails with "cannot be dropped" while the database lingers
    await admin.query(`CREATE ROLE ${ROLE}`);
  });

  it('is a no-op for a database that is already gone', async () => {
    await expect(dropDatabaseForce(admin, 'hap810_never_created')).resolves.toBeUndefined();
  });

  it('gives up after a bounded number of attempts and names the blocker when the database stays in use', async () => {
    await admin.query(`CREATE DATABASE ${DB}`);
    const inside = new Client(connection(DB));
    inside.on('error', () => { /* terminated by the drop's FORCE */ });
    await inside.connect();
    const removeBlocker = async () => {
      const cleanup = new Client(connection(DB));
      await cleanup.connect();
      try { await cleanup.query('DROP SUBSCRIPTION IF EXISTS hap810_blocker'); } finally { await cleanup.end(); }
    };
    try {
      // A subscription is something FORCE cannot terminate: DROP DATABASE keeps reporting 55006.
      await inside.query(`CREATE SUBSCRIPTION hap810_blocker CONNECTION 'host=127.0.0.1 dbname=none' PUBLICATION p
        WITH (connect = false, enabled = false, create_slot = false, slot_name = NONE)`);
      const started = Date.now();
      await expect(dropDatabaseForce(admin, DB)).rejects.toThrow(
        /DROP DATABASE hap810_drop_helper still in use after 3 attempts: .*logical replication subscription/);
      expect(Date.now() - started).toBeLessThan(10000);
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])).rowCount).toBe(1);

      await removeBlocker();
      await dropDatabaseForce(admin, DB); // the blocker's removal is all that was needed
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])).rowCount).toBe(0);
    } finally {
      await inside.end().catch(() => undefined);
      // Never leave a subscription behind: it would make this database undroppable for every later run.
      await removeBlocker().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    }
  });
});
