// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1422 (PoR S1): portfolio route tests run as the application login `cmdb_user`, a role that is not a superuser and
 * owns no table, so a missing grant or a missing `organization_id` predicate shows up the way it would in a deployment
 * that does not run as the owner. There is no RLS (brief R2): the grants and the predicates are the only boundary.
 *
 * `assertAppLogin` is the setup guard shared by the PGlite unit suites and the real-PostgreSQL integration suite. It
 * refuses (throws `AppLoginRefused`) a session that is or acts as a superuser, that can act as the owner of any
 * relation or of the `public`/`cmdb` schemas (direct ownership or membership in the owner role), that is a member of
 * pg_read_all_data or pg_write_all_data (which would hide a missing grant), or that has no portfolio schema to test against.
 *
 * PGlite is single-user: the backend is always authenticated as its bootstrap superuser. The PGlite suites therefore use
 * `SET SESSION AUTHORIZATION cmdb_user`, which makes both session_user and current_user `cmdb_user` for every
 * statement the routes send. Because the authenticated backend is still a superuser, a statement could switch back;
 * `assertAppStatement` refuses any route statement that changes the role, and only the harness switches
 * (`asTableOwner`, N1). The integration suite (tests/integration/database/hap1422-portfolio-app-login.integration.test.ts)
 * connects as a real LOGIN role, which has no way back.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

export const APP_LOGIN = 'cmdb_user';
/** PGlite only: a NOSUPERUSER role that runs the DDL, so N1 can prove the guard refuses a plain table owner too. */
export const TABLE_OWNER = 'cmdb_owner';

export class AppLoginRefused extends Error {
  constructor(readonly reasons: string[], readonly facts: AppLoginFacts) {
    super(`HAP-1422 test setup refused: the portfolio suite must run as a non-superuser app login that owns no table `
      + `(${reasons.join('; ')})`);
    this.name = 'AppLoginRefused';
  }
}

export interface AppLoginFacts {
  current_user: string;
  session_user: string;
  rolsuper: boolean;
  session_rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  has_portfolio: boolean;
  owned: string[];
  all_data_roles: string[];
}

type Rows = (sql: string) => Promise<unknown[]>;

const FACTS_SQL = `SELECT current_user::text AS current_user, session_user::text AS session_user,
    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
    (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS session_rolsuper,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls,
    (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS rolcreaterole,
    to_regclass('public.dim_business_services') IS NOT NULL AS has_portfolio,
    ARRAY(
      SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'cmdb') AND pg_has_role(current_user, c.relowner, 'MEMBER')
      UNION ALL
      SELECT format('schema %I', n.nspname) FROM pg_namespace n
        WHERE n.nspname IN ('public', 'cmdb') AND pg_has_role(current_user, n.nspowner, 'MEMBER')
      ORDER BY 1
    ) AS owned,
    ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname IN ('pg_read_all_data', 'pg_write_all_data')
      AND pg_has_role(current_user, oid, 'MEMBER') ORDER BY 1) AS all_data_roles`;

/** The A1/N1 setup guard: resolves with the observed facts, or rejects with every reason it refuses. */
export async function assertAppLogin(rows: Rows): Promise<AppLoginFacts> {
  const facts = (await rows(FACTS_SQL))[0] as AppLoginFacts;
  const reasons: string[] = [];
  if (facts.rolsuper !== false) reasons.push(`current_user ${facts.current_user} is a superuser`);
  if (facts.session_rolsuper !== false) reasons.push(`session_user ${facts.session_user} is a superuser`);
  if (facts.session_user !== facts.current_user) reasons.push('session_user differs from current_user (SET ROLE)');
  if (facts.rolbypassrls !== false) reasons.push(`${facts.current_user} bypasses RLS`);
  if (facts.rolcreaterole !== false) reasons.push(`${facts.current_user} has CREATEROLE (can join the owner role)`);
  if (facts.owned.length > 0) reasons.push(`${facts.current_user} can act as the owner of ${facts.owned.length} relations or schemas`);
  if (facts.all_data_roles.length > 0) reasons.push(`${facts.current_user} is a member of ${facts.all_data_roles.join(', ')}`);
  if (!facts.has_portfolio) reasons.push('public.dim_business_services is missing');
  if (reasons.length > 0) throw new AppLoginRefused(reasons, facts);
  return facts;
}

const MIGRATIONS = join(__dirname, '../../../../../../database/src/postgres/migrations');
export const migrationSql = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');

/** PGlite: create the owner and the app login, then run the DDL that follows as the owner (not the superuser). */
export const createLoginRolesSql = (database: string) => `
  CREATE ROLE ${TABLE_OWNER} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE ${APP_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  GRANT CREATE ON DATABASE "${database}" TO ${TABLE_OWNER};
  GRANT CREATE ON SCHEMA public TO ${TABLE_OWNER};
  SET ROLE ${TABLE_OWNER};`;

/**
 * PGlite: the cmdb_user privileges that the migrations grant on the tables the unit suites build, run as the owner.
 * They mirror 001:2494-2500 (cmdb PUBLIC usage/select), 033:84-105 and 034:73-79 for each table that exists. Those
 * migrations cannot run verbatim on the partial PGlite schema (033 requires the full FD-6 views and functions). The
 * integration suite runs the real migrator; 044 runs verbatim in both (journalReadAclSql).
 */
export const APP_GRANTS_SQL = `DO $grants$
DECLARE
  item record;
  sequence_name text;
BEGIN
  GRANT USAGE ON SCHEMA cmdb TO ${APP_LOGIN};
  GRANT SELECT ON ALL TABLES IN SCHEMA cmdb TO ${APP_LOGIN};
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA cmdb TO ${APP_LOGIN};
  FOR item IN SELECT * FROM (VALUES
    ('public.dim_business_services', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.business_service_dependencies', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ci_business_service_mappings', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.fact_business_service_incidents', 'SELECT, INSERT'),
    ('public.fact_business_service_changes', 'SELECT, INSERT'),
    ('public.audit_log', 'SELECT, INSERT'),
    ('public.discovery_agents', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.active_discovery_agents', 'SELECT'),
    ('public.agent_network_coverage', 'SELECT'),
    ('cmdb.dim_ci', 'SELECT, INSERT')
  ) AS grants(name, privileges) LOOP
    IF to_regclass(item.name) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON %s TO ${APP_LOGIN}', item.privileges, item.name);
      FOR sequence_name IN SELECT pg_get_serial_sequence(item.name, 'id') FROM pg_attribute
          WHERE attrelid = to_regclass(item.name) AND attname = 'id' AND NOT attisdropped LOOP
        IF sequence_name IS NOT NULL THEN
          EXECUTE format('GRANT USAGE ON SEQUENCE %s TO ${APP_LOGIN}', sequence_name);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$grants$;`;

/**
 * PGlite: 044 verbatim, for suites that build 028's journal tables (it refuses to run without them). Read on call, so
 * the guard above still loads on a base without 044 (the CI fail-before run).
 */
export const journalReadAclSql = () => `BEGIN;\n${migrationSql('044_business_service_journal_read_acl.sql')}\nCOMMIT;`;

/** PGlite: every later statement, from the routes or the test, runs as the app login. */
export const ENTER_APP_LOGIN_SQL = `RESET ROLE; SET SESSION AUTHORIZATION ${APP_LOGIN};`;
/** PGlite's bootstrap superuser, its authenticated backend user (RESET SESSION AUTHORIZATION does not return to it). */
export const PGLITE_SUPERUSER = 'postgres';

/**
 * PGlite: the authenticated backend is a superuser, so a statement could leave the app login with
 * SET SESSION AUTHORIZATION, SET ROLE, RESET, DISCARD ALL or set_config('role'|'session_authorization'). The routes
 * never send one; the PGlite suites' Postgres client refuses any such statement, and the tenant-isolation suite re-runs
 * assertAppLogin after each test. A real LOGIN (integration suite) cannot escape.
 */
const ROLE_CHANGE = /\b(?:SESSION\s+AUTHORIZATION|SET\s+(?:(?:LOCAL|SESSION)\s+)?"?ROLE|RESET\s+(?:"?ROLE|ALL)|DISCARD\s+ALL)\b|\bset_config\s*\(\s*'(?:role|session_authorization)'/i;
export function assertAppStatement(sql: string): void {
  if (ROLE_CHANGE.test(sql)) throw new Error('HAP-1422: a route statement tried to change the session role');
}

/** PGlite: run fixture work (TRUNCATE, seeding, migration replays) as the table owner, then return to the app login. */
export async function asTableOwner<T>(exec: (sql: string) => Promise<unknown>, work: () => Promise<T>): Promise<T> {
  await exec(`RESET ROLE; SET SESSION AUTHORIZATION ${TABLE_OWNER};`);
  try {
    return await work();
  } finally {
    await exec(ENTER_APP_LOGIN_SQL);
  }
}
