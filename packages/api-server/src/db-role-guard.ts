// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { logger } from '@cmdb/common';
import type { PoolClient } from 'pg';

/** HAP-1575 item 1: the API flags (and, when asked, refuses) a PostgreSQL login that ignores RLS and grants. */

export interface DbRoleRow {
  current_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

export interface DbRolePool {
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>;
}

const PROBE_STATEMENT_TIMEOUT_MS = 5000;

/** Only the string `true` (case-insensitive, surrounding whitespace ignored) enables enforcement. */
export function requireNonSuperuser(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['REQUIRE_NON_SUPERUSER_DB'] ?? '').trim().toLowerCase() === 'true';
}

/** A superuser always bypasses RLS; a plain role with BYPASSRLS does too. */
export function bypassesRowSecurity(row: Pick<DbRoleRow, 'rolsuper' | 'rolbypassrls'>): boolean {
  return row.rolsuper !== false || row.rolbypassrls !== false;
}

/** One read-only statement as the API's own login. Rejects when the role row is missing. */
export async function probeDbRole(pool: DbRolePool): Promise<DbRoleRow> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = ${PROBE_STATEMENT_TIMEOUT_MS}`);
      const { rows } = await client.query(
        'SELECT current_user::text AS current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      if (rows.length !== 1) {
        throw new Error('role row missing');
      }
      return rows[0] as DbRoleRow;
    } finally {
      // A failed ROLLBACK destroys the connection instead of pooling it mid-transaction.
      await client.query('ROLLBACK').catch((error: Error) => {
        broken = error;
      });
    }
  } finally {
    client.release(broken);
  }
}

/**
 * Run once at startup, before the server listens. Never logs the probe error's message (a connection error can
 * carry connection details): only its SQLSTATE/errno. Throws only when REQUIRE_NON_SUPERUSER_DB=true.
 */
export async function checkDbRole(pool: DbRolePool, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const enforce = requireNonSuperuser(env);
  let row: DbRoleRow;
  try {
    row = await probeDbRole(pool);
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    const reason = typeof code === 'string' ? code : 'unknown error';
    if (enforce) {
      throw new Error(`REQUIRE_NON_SUPERUSER_DB=true: the PostgreSQL login role probe failed (${reason}); refusing to start`);
    }
    logger.warn('PostgreSQL login role probe failed; continuing without the superuser/BYPASSRLS check', { reason });
    return;
  }

  const flags = { current_user: row.current_user, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls };
  if (!bypassesRowSecurity(row)) {
    logger.info('PostgreSQL login role is NOSUPERUSER and NOBYPASSRLS', flags);
    return;
  }
  if (enforce) {
    throw new Error(
      `REQUIRE_NON_SUPERUSER_DB=true: PostgreSQL login role "${row.current_user}" ` +
      `(rolsuper=${row.rolsuper}, rolbypassrls=${row.rolbypassrls}) ignores row level security and grants; refusing to start`);
  }
  logger.error(
    'PostgreSQL login role ignores row level security and grants (superuser or BYPASSRLS); ' +
    'use the NOSUPERUSER app login or set REQUIRE_NON_SUPERUSER_DB=true to refuse to start', flags);
}
