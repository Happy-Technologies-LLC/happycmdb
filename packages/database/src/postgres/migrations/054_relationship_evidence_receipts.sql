-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-2029 (evidence-qualified relationships, story 2): server-assigned, append-only receipts for relationship writes.
--   receipt identity     receipt_id, organization_id (NOT NULL: a legacy NULL-organization row cannot exist), created_at.
--   edge                 from_ci_id, to_ci_id, relationship_type plus both endpoints' CI incarnation ids at write time
--                        (the incarnation fence: a deleted or re-created CI never inherits an old receipt). No FKs: CIs
--                        live in Neo4j and rows outlive them (precedent 020).
--   claim                evidence_class (declared, static_observed, runtime_observed, inferred), polarity (supports on a
--                        create, contradicts on a delete), source_name/source_id/source_version, method and rationale_code
--                        (coded tokens only: no free text, no provider text, no secrets).
--   who and when         observed_at (T2 now()), observer, observer_type, correlation_id (the journal group_id, which is the
--                        metadata.correlation_id of the RELATIONSHIP_ADD/RELATIONSHIP_REMOVE audit rows).
-- Unique (organization_id, correlation_id, from_ci_id, to_ci_id, relationship_type): a replayed T2 writes no second row.
-- One index, per edge, newest first: the evidence read and the later currentness read.
-- Append-only twice: SELECT, INSERT only to the app logins that exist (cmdb_user, cmdb_app; per-table, as 048), and a
-- trigger that refuses UPDATE, DELETE and TRUNCATE with 55000 so an API that connects as the table owner is protected too.
-- As 046/047/048, rollback/045 also un-records 054 so the migrator re-grants cmdb_app on the way back. No RLS: tenancy is
-- the organization_id column and the org predicate of every query.
--
-- Idempotent; the migrator records it in one transaction. A wrong relation kind aborts.
-- Manual rollback: rollback/054_relationship_evidence_receipts.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hap2029$
DECLARE
  app_login text;
BEGIN
  -- NULL (no such relation) is not <> 'r', so only a wrong existing object aborts.
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.relationship_evidence_receipts')) <> 'r' THEN
    RAISE EXCEPTION 'HAP-2029 wrong object: relationship_evidence_receipts';
  END IF;

  CREATE TABLE IF NOT EXISTS public.relationship_evidence_receipts (
    receipt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    from_ci_id VARCHAR(255) NOT NULL,
    to_ci_id VARCHAR(255) NOT NULL,
    from_incarnation_id UUID NOT NULL,
    to_incarnation_id UUID NOT NULL,
    relationship_type VARCHAR(64) NOT NULL,
    evidence_class VARCHAR(20) NOT NULL,
    polarity VARCHAR(12) NOT NULL,
    source_name VARCHAR(100) NOT NULL,
    source_id VARCHAR(255),
    source_version VARCHAR(100),
    method VARCHAR(40) NOT NULL,
    rationale_code VARCHAR(40),
    observed_at TIMESTAMPTZ NOT NULL,
    observer VARCHAR(255) NOT NULL,
    observer_type VARCHAR(10) NOT NULL,
    correlation_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT relationship_evidence_receipts_correlation_key
      UNIQUE (organization_id, correlation_id, from_ci_id, to_ci_id, relationship_type),
    CONSTRAINT relationship_evidence_receipts_type_token CHECK (relationship_type ~ '^[A-Z][A-Z0-9_]*$'),
    CONSTRAINT relationship_evidence_receipts_class CHECK (evidence_class IN
      ('declared', 'static_observed', 'runtime_observed', 'inferred')),
    CONSTRAINT relationship_evidence_receipts_polarity CHECK (polarity IN ('supports', 'contradicts')),
    CONSTRAINT relationship_evidence_receipts_source CHECK (btrim(source_name) <> ''
      AND (source_id IS NULL OR btrim(source_id) <> '') AND (source_version IS NULL OR btrim(source_version) <> '')),
    CONSTRAINT relationship_evidence_receipts_method_token CHECK (method ~ '^[a-z][a-z0-9_]*$'
      AND (rationale_code IS NULL OR rationale_code ~ '^[a-z][a-z0-9_]*$')),
    CONSTRAINT relationship_evidence_receipts_observer CHECK (btrim(observer) <> '' AND observer_type IN ('user', 'system'))
  );
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.relationship_evidence_receipts'::regclass
                 AND conname = 'relationship_evidence_receipts_correlation_key' AND contype = 'u') THEN
    RAISE EXCEPTION 'HAP-2029 relationship_evidence_receipts exists without its replay key';
  END IF;

  CREATE INDEX IF NOT EXISTS idx_relationship_evidence_receipts_edge ON public.relationship_evidence_receipts
    (organization_id, from_ci_id, to_ci_id, relationship_type, observed_at DESC, receipt_id);

  CREATE OR REPLACE FUNCTION public.relationship_evidence_receipts_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'relationship_evidence_receipts is append-only' USING ERRCODE = '55000';
  END;
  $fn$;

  CREATE OR REPLACE TRIGGER relationship_evidence_receipts_no_update_delete
    BEFORE UPDATE OR DELETE ON public.relationship_evidence_receipts
    FOR EACH ROW EXECUTE FUNCTION public.relationship_evidence_receipts_append_only();
  CREATE OR REPLACE TRIGGER relationship_evidence_receipts_no_truncate
    BEFORE TRUNCATE ON public.relationship_evidence_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION public.relationship_evidence_receipts_append_only();

  REVOKE ALL ON public.relationship_evidence_receipts FROM PUBLIC;
  FOREACH app_login IN ARRAY ARRAY['cmdb_user', 'cmdb_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_login) THEN
      EXECUTE format('GRANT SELECT, INSERT ON public.relationship_evidence_receipts TO %I', app_login);
    END IF;
  END LOOP;
END
$hap2029$;
