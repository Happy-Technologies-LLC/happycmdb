// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Disposable-database teardown for integration suites that run on TimescaleDB. */
import { Client, Pool } from 'pg';

const OBJECT_IN_USE = '55006';
const DROP_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function databaseExists(admin: Pool, database: string): Promise<boolean> {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  return rowCount === 1;
}

/**
 * Ask the TimescaleDB launcher to stop (and keep stopped) the scheduler of
 * `database`. A bare `DROP DATABASE ... WITH (FORCE)` signals sessions once and
 * then waits a fixed 5 s for them to leave, so a scheduler that is killed but
 * comes back (it connects as a background worker, ignoring datallowconn) fails
 * the drop. No-op when the database does not exist or has no TimescaleDB.
 */
export async function stopTimescaleBackgroundWorkers(admin: Pool, database: string): Promise<void> {
  if (!(await databaseExists(admin, database))) {
    return;
  }
  // pg-pool hides `password` from enumeration, so a spread of `options` would drop it.
  const { host, port, user, password } = admin.options;
  const client = new Client({ host, port, user, password, database });
  client.on('error', () => { /* a session killed during teardown is expected */ });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT
        (SELECT extname FROM pg_extension WHERE extname = 'timescaledb') AS installed,
        COALESCE(to_regprocedure('_timescaledb_functions.stop_background_workers()'),
                 to_regprocedure('_timescaledb_internal.stop_background_workers()'))::text AS stop`);
    const { installed, stop } = rows[0] as { installed: string | null; stop: string | null };
    if (installed && stop) {
      await client.query(`SELECT ${stop}`);
    }
  } finally {
    await client.end();
  }
}

interface SessionRow { pid: number; backend_type: string; application_name: string; state: string | null; backend_start: Date }

async function describeSessions(admin: Pool, database: string): Promise<string> {
  const { rows } = await admin.query<SessionRow>(
    `SELECT pid, backend_type, application_name, state, backend_start FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY backend_start`, [database]);
  return rows.length === 0 ? 'no remaining sessions'
    : rows.map(row => `pid ${row.pid} ${row.backend_type} "${row.application_name}" ${row.state} since ${row.backend_start.toISOString()}`).join('; ');
}

/**
 * Drop a disposable database whatever is still attached to it: stop its
 * TimescaleDB scheduler, then FORCE-drop, repeating the drop (which re-signals
 * every remaining session) only while Postgres reports the database in use.
 * Throws with the surviving sessions instead of leaving the caller to trip over
 * a downstream `DROP ROLE` failure.
 */
export async function dropDatabaseForce(admin: Pool, database: string): Promise<void> {
  if (!(await databaseExists(admin, database))) {
    return;
  }
  await stopTimescaleBackgroundWorkers(admin, database);
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== OBJECT_IN_USE) {
        throw error;
      }
      if (attempt === DROP_ATTEMPTS) {
        throw new Error(`DROP DATABASE ${database} still in use after ${attempt} attempts: ${(error as Error).message}; `
          + await describeSessions(admin, database));
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}
