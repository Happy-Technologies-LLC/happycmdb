-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-835: 001 granted PUBLIC SELECT on public.recent_audit_activity. The view
-- runs with its owner's privileges, so 033's audit_log revoke did not close
-- it. Readers are now the owner plus explicitly granted roles. Re-grant only
-- the existing named readers: the BI role (032/metabase-init allowlist) and
-- the app role (which already reads audit_log through 033). Other named grants
-- are left untouched. Run as the view owner: a non-owner's REVOKE only warns,
-- so the PUBLIC postcondition below fails the migration instead. Idempotent;
-- the migrator records it in one transaction.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
BEGIN
  IF (SELECT c.relkind FROM pg_class c
      WHERE c.oid = to_regclass('public.recent_audit_activity')) IS DISTINCT FROM 'v' THEN
    RAISE EXCEPTION '039 wrong or missing view public.recent_audit_activity';
  END IF;
  REVOKE ALL ON public.recent_audit_activity FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a
             WHERE c.oid = 'public.recent_audit_activity'::regclass AND a.grantee = 0) THEN
    RAISE EXCEPTION '039 could not revoke PUBLIC on recent_audit_activity; run as the view owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    GRANT SELECT ON public.recent_audit_activity TO metabase_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    GRANT SELECT ON public.recent_audit_activity TO cmdb_user;
  END IF;
END
$acl$;
