// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { logger } from '@cmdb/common';
import type { PoolClient } from 'pg';

/**
 * HAP-1575 item 1: the API flags (and, when asked, refuses) a PostgreSQL login that is a superuser, has BYPASSRLS,
 * runs under a session login that is one, or can SET ROLE to one.
 */

export interface DbRoleRow {
  current_user: string;
  session_user: string;
  /** rolsuper / rolbypassrls of current_user itself (neither attribute is inherited through membership). */
  rolsuper: boolean;
  rolbypassrls: boolean;
  /** session_user (the login before any SET ROLE) is a superuser or has BYPASSRLS. */
  session_user_privileged: boolean;
  /** current_user or session_user is a member of another superuser or BYPASSRLS role, so it can SET ROLE to it. */
  can_set_privileged_role: boolean;
}

export interface DbRolePool {
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>;
}

const PROBE_STATEMENT_TIMEOUT_MS = 5000;

/** Only the string `true` (case-insensitive, surrounding whitespace ignored) enables enforcement. */
export function requireNonSuperuser(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['REQUIRE_NON_SUPERUSER_DB'] ?? '').trim().toLowerCase() === 'true';
}

/**
 * A superuser ignores row level security and every grant check; a role with BYPASSRLS ignores RLS policies only
 * (grants still apply). Either is flagged, on the current role, on the session login, and through membership that
 * allows SET ROLE. Anything other than an explicit false counts as a violation.
 */
export function bypassesRowSecurity(
  row: Pick<DbRoleRow, 'rolsuper' | 'rolbypassrls' | 'session_user_privileged' | 'can_set_privileged_role'>,
): boolean {
  return row.rolsuper !== false || row.rolbypassrls !== false ||
    row.session_user_privileged !== false || row.can_set_privileged_role !== false;
}

/**
 * One row, or none when current_user has no pg_roles row (a probe failure). pg_has_role(..., 'MEMBER') is true for
 * direct and indirect membership whether or not the role inherits privileges, which is what SET ROLE needs.
 */
const PROBE_SQL =
  'SELECT current_user::text AS current_user, session_user::text AS session_user, ' +
  'COALESCE(bool_or(rolsuper) FILTER (WHERE rolname = current_user), false) AS rolsuper, ' +
  'COALESCE(bool_or(rolbypassrls) FILTER (WHERE rolname = current_user), false) AS rolbypassrls, ' +
  'COALESCE(bool_or(rolsuper OR rolbypassrls) FILTER (WHERE rolname = session_user), true) AS session_user_privileged, ' +
  'EXISTS (SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls) ' +
  'AND r.rolname NOT IN (current_user, session_user) ' +
  "AND (pg_has_role(current_user, r.oid, 'MEMBER') OR pg_has_role(session_user, r.oid, 'MEMBER'))) AS can_set_privileged_role " +
  'FROM pg_roles WHERE rolname IN (current_user, session_user) ' +
  'HAVING bool_or(rolname = current_user)';

/** One read-only statement as the API's own login. Rejects when the role row is missing. */
export async function probeDbRole(pool: DbRolePool): Promise<DbRoleRow> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = ${PROBE_STATEMENT_TIMEOUT_MS}`);
      const { rows } = await client.query(PROBE_SQL);
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

  const flags = {
    current_user: row.current_user,
    session_user: row.session_user,
    rolsuper: row.rolsuper,
    rolbypassrls: row.rolbypassrls,
    session_user_privileged: row.session_user_privileged,
    can_set_privileged_role: row.can_set_privileged_role,
  };
  if (!bypassesRowSecurity(row)) {
    logger.info('PostgreSQL login role is NOSUPERUSER and NOBYPASSRLS, and cannot SET ROLE to a role that is', flags);
    return;
  }
  const detail =
    `rolsuper=${row.rolsuper}, rolbypassrls=${row.rolbypassrls}, ` +
    `session_user_privileged=${row.session_user_privileged}, can_set_privileged_role=${row.can_set_privileged_role}`;
  if (enforce) {
    throw new Error(
      `REQUIRE_NON_SUPERUSER_DB=true: PostgreSQL login role "${row.current_user}" (session login "${row.session_user}"; ${detail}) ` +
      'is or can become a superuser (ignores row level security and grants) or a BYPASSRLS role (ignores row level security policies); ' +
      'refusing to start');
  }
  logger.error(
    'PostgreSQL login role is or can become a superuser (ignores row level security and grants) or a BYPASSRLS role ' +
    '(ignores row level security policies): the role itself, its session login, or a role it can SET ROLE to; ' +
    'use the NOSUPERUSER app login or set REQUIRE_NON_SUPERUSER_DB=true to refuse to start', flags);
}
