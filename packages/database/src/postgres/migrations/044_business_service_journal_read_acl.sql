-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-1422 (PoR S1): three business-service routes read public.ci_reconciliation_operations to hide a CI whose
-- journal operation is pending or failed: GET /:service_id/cis and GET /:service_id/context in their SQL, and
-- POST /:service_id/cis through read-admission's assertNoCIGap and writeReferencedCIs. 028 created the table and
-- revoked PUBLIC, and no migration granted the app role. An app login that does not own the table therefore got
-- "permission denied" (500) on those routes, for its own services too. This grants the app role SELECT on the three
-- columns every reader filters on (organization_id, ci_id, state), not on the plan, actor, error or claim columns;
-- journal writes are unchanged. It is additive and idempotent. It does nothing where cmdb_user does not exist, and
-- nothing where cmdb_user owns the table.
-- Manual rollback: rollback/044_business_service_journal_read_acl.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
BEGIN
  IF (SELECT c.relkind FROM pg_class c
      WHERE c.oid = to_regclass('public.ci_reconciliation_operations')) IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION '044 wrong or missing table public.ci_reconciliation_operations';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    GRANT SELECT (organization_id, ci_id, state) ON public.ci_reconciliation_operations TO cmdb_user;
  END IF;
END
$acl$;
