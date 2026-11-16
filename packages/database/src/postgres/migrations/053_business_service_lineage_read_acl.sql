-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-2028: the impact reads, GET /business-services/:service_id/context among them, now state which in-scope CIs no
-- source has reported, from a ci_source_lineage row in the caller's organization. 001 created that table and no
-- migration granted a non-owner app login on it, so as the LOGIN role cmdb_user (HAP-1422 A1/N1) the context read
-- would answer "permission denied" (500). This grants cmdb_user SELECT on the two columns the read filters on
-- (organization_id, ci_id), not on source_name, source_id, confidence_score or the other columns; lineage writes are
-- unchanged. It is additive and idempotent. It does nothing where cmdb_user does not exist, and nothing where cmdb_user
-- owns the table. cmdb_app already holds SELECT on the table through 045.
-- Manual rollback: rollback/053_business_service_lineage_read_acl.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
BEGIN
  IF (SELECT c.relkind FROM pg_class c
      WHERE c.oid = to_regclass('public.ci_source_lineage')) IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION '053 wrong or missing table public.ci_source_lineage';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    GRANT SELECT (organization_id, ci_id) ON public.ci_source_lineage TO cmdb_user;
  END IF;
END
$acl$;
