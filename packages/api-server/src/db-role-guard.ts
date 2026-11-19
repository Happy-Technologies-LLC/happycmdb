// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { logger } from '@cmdb/common';
import type { PoolClient } from 'pg';

/**
 * HAP-1575 item 1: the API flags (and, when asked, refuses) a PostgreSQL login that is a superuser, has BYPASSRLS,
 * runs under a session login that is one, can SET ROLE to one, or holds a capability that lets it escalate.
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
  /**
   * session_user differs from the authenticated login (system_user without its `method:` prefix): a superuser login
   * used SET SESSION AUTHORIZATION to look like another role. Always false below PostgreSQL 16 (no system_user) and
   * when system_user is NULL (no authenticated identity to compare); see the limitation in docs.
   */
  session_authorization_masked: boolean;
  /**
   * current_user or session_user is a member of pg_execute_server_program, pg_write_server_files,
   * pg_read_server_files or pg_write_all_data (those that exist on this server): it reads or writes outside RLS,
   * or runs programs on the database host.
   */
  dangerous_builtin_role_member: boolean;
  /** current_user has CREATEROLE on PostgreSQL 15 or older, where it can grant itself any role. Always false on 16+. */
  createrole_escalation: boolean;
}

export interface DbRolePool {
  connect(): Promise<Pick<PoolClient, 'query' | 'release'>>;
}

const PROBE_STATEMENT_TIMEOUT_MS = 5000;

/** system_user (the authenticated login) exists from this server_version_num on. */
const SYSTEM_USER_MIN_VERSION = 160000;

/** Only the string `true` (case-insensitive, surrounding whitespace ignored) enables enforcement. */
export function requireNonSuperuser(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['REQUIRE_NON_SUPERUSER_DB'] ?? '').trim().toLowerCase() === 'true';
}

type GuardFlags = Pick<DbRoleRow,
  'rolsuper' | 'rolbypassrls' | 'session_user_privileged' | 'can_set_privileged_role' |
  'session_authorization_masked' | 'dangerous_builtin_role_member' | 'createrole_escalation'>;

/** Every flag of the row, in the order the log and refusal text list them. */
const FLAG_NAMES: ReadonlyArray<keyof GuardFlags> = [
  'rolsuper', 'rolbypassrls', 'session_user_privileged', 'can_set_privileged_role',
  'session_authorization_masked', 'dangerous_builtin_role_member', 'createrole_escalation',
];

/**
 * A superuser ignores row level security and every grant check; a role with BYPASSRLS ignores RLS policies only
 * (grants still apply). Either is flagged, on the current role, on the session login, and through membership that
 * allows SET ROLE. A masked session login, membership of a dangerous built-in role, and CREATEROLE below
 * PostgreSQL 16 are flagged too. Anything other than an explicit false counts as a violation.
 */
export function bypassesRowSecurity(row: GuardFlags): boolean {
  return FLAG_NAMES.some(name => row[name] !== false);
}

/**
 * The statement is built from the server version (read first with SHOW server_version_num, a read-only command):
 * a bare `system_user` token is a syntax error on PostgreSQL 15 and older, so it is only emitted from 16 on, and no
 * single statement text parses on both. Each version still runs exactly one probe SELECT.
 *
 * One row, or none when current_user has no pg_roles row (a probe failure).
 * - pg_has_role(..., 'MEMBER') is true for direct and indirect membership whether or not the role inherits
 *   privileges. A NOINHERIT membership still allows SET ROLE, so it is flagged on purpose, not as a conservative
 *   guess.
 * - session_authorization_masked (16+): session_user follows SET SESSION AUTHORIZATION, system_user does not.
 *   Methods that map the identity (peer, cert, gss, ...) can report an identity that differs from the role name;
 *   that is flagged too (fail closed). A NULL system_user (trust) cannot be compared and reports false. Below 16
 *   the masking cannot be detected: an explicit false, a documented limitation, not an all clear.
 * - createrole_escalation (below 16): CREATEROLE lets a role grant itself any role. On 16+ CREATEROLE alone only
 *   grants roles the creator holds with ADMIN OPTION, so it is not flagged there.
 * - The four built-in roles are looked up by name in pg_roles, so a server that lacks one (pg_write_all_data is 14+)
 *   simply does not match it.
 */
export function probeSql(serverVersionNum: number): string {
  const hasSystemUser = serverVersionNum >= SYSTEM_USER_MIN_VERSION;
  const masked = hasSystemUser
    ? "system_user IS NOT NULL AND substr(system_user, strpos(system_user, ':') + 1) <> session_user::text"
    : 'false';
  const createrole = hasSystemUser
    ? 'false'
    : "COALESCE(bool_or(rolcreaterole) FILTER (WHERE rolname = current_user), true)";
  return (
    'SELECT current_user::text AS current_user, session_user::text AS session_user, ' +
    'COALESCE(bool_or(rolsuper) FILTER (WHERE rolname = current_user), false) AS rolsuper, ' +
    'COALESCE(bool_or(rolbypassrls) FILTER (WHERE rolname = current_user), false) AS rolbypassrls, ' +
    'COALESCE(bool_or(rolsuper OR rolbypassrls) FILTER (WHERE rolname = session_user), true) AS session_user_privileged, ' +
    'EXISTS (SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls) ' +
    'AND r.rolname NOT IN (current_user, session_user) ' +
    "AND (pg_has_role(current_user, r.oid, 'MEMBER') OR pg_has_role(session_user, r.oid, 'MEMBER'))) AS can_set_privileged_role, " +
    `(${masked}) AS session_authorization_masked, ` +
    "EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('pg_execute_server_program', 'pg_write_server_files', " +
    "'pg_read_server_files', 'pg_write_all_data') " +
    "AND (pg_has_role(current_user, r.oid, 'MEMBER') OR pg_has_role(session_user, r.oid, 'MEMBER'))) AS dangerous_builtin_role_member, " +
    `${createrole} AS createrole_escalation ` +
    'FROM pg_roles WHERE rolname IN (current_user, session_user) ' +
    'HAVING bool_or(rolname = current_user)'
  );
}

/** Reads server_version_num; rejects on anything that is not a plain positive integer. */
async function serverVersionNum(client: Pick<PoolClient, 'query'>): Promise<number> {
  const { rows } = await client.query('SHOW server_version_num');
  const raw = (rows[0] as { server_version_num?: unknown } | undefined)?.server_version_num;
  const version = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(version)) {
    throw new Error('server version unreadable');
  }
  return version;
}

/** A read-only version read and one read-only probe SELECT as the API's own login. Rejects when the role row is missing. */
export async function probeDbRole(pool: DbRolePool): Promise<DbRoleRow> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = ${PROBE_STATEMENT_TIMEOUT_MS}`);
      const { rows } = await client.query(probeSql(await serverVersionNum(client)));
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
    session_authorization_masked: row.session_authorization_masked,
    dangerous_builtin_role_member: row.dangerous_builtin_role_member,
    createrole_escalation: row.createrole_escalation,
  };
  if (!bypassesRowSecurity(row)) {
    logger.info(
      'PostgreSQL login role is NOSUPERUSER and NOBYPASSRLS, cannot SET ROLE to a role that is, and holds no escalation-capable membership or CREATEROLE', flags);
    return;
  }
  const detail = FLAG_NAMES.map(name => `${name}=${row[name]}`).join(', ');
  const reasons =
    'a superuser (ignores row level security and grants), a BYPASSRLS role (ignores row level security policies), ' +
    'a session login that is one (session_user_privileged), a role it can SET ROLE to that is one (can_set_privileged_role), ' +
    'a session login masked by SET SESSION AUTHORIZATION (session_authorization_masked), ' +
    'a member of pg_execute_server_program, pg_write_server_files, pg_read_server_files or pg_write_all_data (dangerous_builtin_role_member), ' +
    'or a CREATEROLE role on PostgreSQL 15 or older, which can grant itself any role (createrole_escalation)';
  if (enforce) {
    throw new Error(
      `REQUIRE_NON_SUPERUSER_DB=true: PostgreSQL login role "${row.current_user}" (session login "${row.session_user}"; ${detail}) ` +
      `is or can become one of: ${reasons}; refusing to start`);
  }
  logger.error(
    `PostgreSQL login role is or can become one of: ${reasons}; ` +
    'use the NOSUPERUSER app login or set REQUIRE_NON_SUPERUSER_DB=true to refuse to start', flags);
}
