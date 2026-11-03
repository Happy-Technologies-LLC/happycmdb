-- Rollback for 044_business_service_journal_read_acl.sql. MANUAL ONLY; not authorized for any environment without a
-- separate named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- Effect: an app login that does not own public.ci_reconciliation_operations again gets 500 on
-- GET /business-services/:service_id/cis, GET /business-services/:service_id/context and
-- POST /business-services/:service_id/cis. Loses no data.
--
-- Keeps: the owner's own privileges. Where cmdb_user owns the table (or is a member of its owner), nothing is revoked,
-- because 044 granted nothing there. A column SELECT granted by hand before 044 looks the same as 044's and is revoked
-- too. If cmdb_user still reads those columns afterwards (a table-level or PUBLIC grant 044 did not make), the script
-- aborts and changes nothing: remove that grant by hand first, or keep 044.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 044_business_service_journal_read_acl.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user')
     AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.ci_reconciliation_operations')
                 AND NOT pg_has_role('cmdb_user', c.relowner, 'MEMBER')) THEN
    REVOKE SELECT (organization_id, ci_id, state) ON public.ci_reconciliation_operations FROM cmdb_user;
    IF has_column_privilege('cmdb_user', 'public.ci_reconciliation_operations', 'state', 'SELECT') THEN
      RAISE EXCEPTION '044 rollback: cmdb_user still reads ci_reconciliation_operations through a grant 044 did not make';
    END IF;
  END IF;
END
$acl$;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '044_business_service_journal_read_acl.sql';
COMMIT;
