-- HAP-1562 (D42): provisions the Build01 staging API login cmdb_app. Run by the `app-login` Compose service (profile
-- migrate) as the owner login, before every migrator run. Idempotent: creates cmdb_app when missing, then re-asserts
-- its attributes and sets its password from APP_LOGIN_PASSWORD. The password is read from the environment with
-- \getenv, sent only inside a \gexec statement (never echoed), errors are terse (no statement text) and this session
-- does not log statements, so the value reaches neither output nor the server log.
-- When 045 is already applied, its grants are re-applied (idempotent), so a re-created cmdb_app is never left bare.
-- Rollback mode: when the API is configured to use the owner login (POSTGRES_APP_USER=<owner>), this does nothing.
\set ON_ERROR_STOP on
\set VERBOSITY terse
\set QUIET on
\getenv app_login APP_LOGIN
\getenv app_password APP_LOGIN_PASSWORD
\getenv owner_password PGPASSWORD
-- Superuser-only settings (the owner is the image's bootstrap superuser), first: later statements carry the passwords.
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

SELECT :'app_login' = current_user AS rollback_mode \gset
\if :rollback_mode
  \echo 'app-login: the API uses the owner login (rollback mode); nothing to provision'
  \quit
\endif
SELECT :'app_login' <> 'cmdb_app' AS wrong_login, length(:'app_password') < 32 AS weak_password,
  :'app_password' = :'owner_password' AS owner_password \gset
\if :wrong_login
  DO $$ BEGIN RAISE EXCEPTION 'app-login: POSTGRES_APP_USER must be cmdb_app, or the owner login to roll back'; END $$;
\endif
\if :weak_password
  DO $$ BEGIN RAISE EXCEPTION 'app-login: POSTGRES_APP_PASSWORD must be at least 32 characters'; END $$;
\endif
\if :owner_password
  DO $$ BEGIN RAISE EXCEPTION 'app-login: POSTGRES_APP_PASSWORD must differ from the owner password (restore it after a rollback)'; END $$;
\endif

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_app') AS creating \gset
\if :creating
  CREATE ROLE cmdb_app;
\endif
SELECT format('ALTER ROLE cmdb_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_password') \gexec

-- A member of another role could act as that role (and as a table owner): refuse instead of guessing which to drop.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'cmdb_app'::regrole) THEN
    RAISE EXCEPTION 'app-login: cmdb_app is a member of another role; revoke that membership first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = 'cmdb_app'::regrole)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = 'cmdb_app'::regrole) THEN
    RAISE EXCEPTION 'app-login: cmdb_app owns a relation or schema; reassign it to the owner login first';
  END IF;
END $$;

SELECT to_regclass('cmdb.schema_migrations') IS NOT NULL AS has_ledger \gset
\if :has_ledger
  SELECT EXISTS (SELECT 1 FROM cmdb.schema_migrations WHERE migration_name = '045_staging_app_login_acl.sql') AS has_045 \gset
  \if :has_045
    BEGIN;
    \ir 045_staging_app_login_acl.sql
    COMMIT;
  \endif
\endif
\echo 'app-login: cmdb_app is a NOSUPERUSER, NOCREATEDB, NOCREATEROLE login that owns nothing'
