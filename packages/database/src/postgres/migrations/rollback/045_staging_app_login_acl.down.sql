-- Rollback for 045_staging_app_login_acl.sql. MANUAL ONLY; not authorized for any environment without a separate
-- named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- Order (deploy/BUILD01-STAGING.md, "Rollback to cmdb_user"): switch the API back to the owner login FIRST. This
-- script refuses while any session is logged in as cmdb_app, because the API would lose every privilege it uses.
--
-- Effect: cmdb_app keeps its LOGIN but holds no privilege in the public or cmdb schemas beyond PUBLIC's. 045, 046
-- (service_offerings), 047 (ai_sync_cursors) and the staging app-login provisioning are the only grantors to cmdb_app,
-- so revoking everything reverses 045, 046 and 047's cmdb_app grants. All three are un-recorded so the migrator
-- re-grants on the way back (046 and 047 are idempotent and keep their tables and data).
-- Loses no data and does not touch cmdb_user. To remove the login too, afterwards: DROP OWNED BY cmdb_app; DROP ROLE
-- cmdb_app; (cluster-wide; run once per database that has cmdb_app grants, then drop the role).
--
-- Run as the owner login: psql -v ON_ERROR_STOP=1 -f 045_staging_app_login_acl.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $acl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_app') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = 'cmdb_app') THEN
    RAISE EXCEPTION '045 rollback: cmdb_app still has open sessions; switch the API to cmdb_user first';
  END IF;
  REVOKE ALL ON ALL TABLES IN SCHEMA public, cmdb FROM cmdb_app;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, cmdb FROM cmdb_app;
  REVOKE ALL ON SCHEMA public, cmdb FROM cmdb_app;
END
$acl$;
DELETE FROM cmdb.schema_migrations
  WHERE migration_name IN ('045_staging_app_login_acl.sql', '046_service_offerings.sql', '047_ai_sync_cursors.sql');
COMMIT;
