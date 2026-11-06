-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-1426 (PoR S5, brief §4, Suite Contracts v2 C1): the one-way import of HappyHive's catalog-as-portfolio.
--   source_system, source_id  import provenance on dim_business_services and service_offerings: both NULL (a record
--                             HappyCMDB created itself) or both set; UNIQUE per tenant where set.
--   portfolio_imports         one row per APPLIED import (a dry run persists nothing, plan ruling D5): the tenant, the
--                             source system, the mode, the file's sha256, the header row counts and the verified actor.
--   portfolio_import_map      source record -> HappyCMDB id, per tenant. Its PRIMARY KEY (organization_id,
--                             source_system, kind, source_id) is the import's idempotency key; the composite FK binds
--                             every row to an import of the same tenant.
-- Grants: SELECT, INSERT only (append-only: no UPDATE, DELETE or TRUNCATE) on the two new tables to the app logins that
-- exist: cmdb_user (the HAP-1422 non-owner login) and cmdb_app (HAP-1562 staging login, per-table grants). The existing
-- table grants on dim_business_services and service_offerings cover the new columns. As for 046/047, rollback/045
-- also un-records 048 so the migrator re-grants cmdb_app on the way back. No RLS (brief §2; HAP-1405).
--
-- V2/V3 initdb ships no 001 business-service table (as 043, 046): everything is skipped with a NOTICE. A wrong
-- relation kind aborts. Idempotent; the migrator records it in one transaction.
-- Manual rollback: rollback/048_portfolio_import.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hap1426$
DECLARE
  target text;
  app_login text;
BEGIN
  IF to_regclass('public.dim_business_services') IS NULL OR to_regclass('public.service_offerings') IS NULL THEN
    RAISE NOTICE 'HAP-1426 dim_business_services or service_offerings absent (V2/V3); no portfolio import DDL';
    RETURN;
  END IF;
  FOREACH target IN ARRAY ARRAY['dim_business_services', 'service_offerings'] LOOP
    IF (SELECT relkind FROM pg_class WHERE oid = format('public.%I', target)::regclass) NOT IN ('r', 'p') THEN
      RAISE EXCEPTION 'HAP-1426 wrong object: %', target;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS source_system VARCHAR(50),
      ADD COLUMN IF NOT EXISTS source_id VARCHAR(255)', target);
    IF (SELECT count(*) FROM pg_attribute
        WHERE attrelid = format('public.%I', target)::regclass AND NOT attisdropped
          AND ((attname = 'source_system' AND format_type(atttypid, atttypmod) = 'character varying(50)')
            OR (attname = 'source_id' AND format_type(atttypid, atttypmod) = 'character varying(255)'))) <> 2 THEN
      RAISE EXCEPTION 'HAP-1426 conflicting % provenance columns', target;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', target)::regclass
                   AND conname = target || '_source_provenance') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((source_system IS NULL) = (source_id IS NULL))',
        target, target || '_source_provenance');
    END IF;
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (organization_id, source_system, source_id)
      WHERE source_system IS NOT NULL', target || '_source_key', target);
  END LOOP;

  -- NULL (no such relation) is not <> 'r', so only a wrong existing object aborts.
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.portfolio_imports')) <> 'r'
     OR (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.portfolio_import_map')) <> 'r' THEN
    RAISE EXCEPTION 'HAP-1426 wrong object: portfolio_imports or portfolio_import_map';
  END IF;

  CREATE TABLE IF NOT EXISTS public.portfolio_imports (
    import_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    source_system VARCHAR(50) NOT NULL,
    mode VARCHAR(10) NOT NULL,
    file_sha256 CHAR(64) NOT NULL,
    row_counts JSONB NOT NULL,
    actor VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portfolio_imports_tenant_key UNIQUE (import_id, organization_id),
    CONSTRAINT valid_portfolio_import_source CHECK (source_system = 'happyhive'),
    CONSTRAINT valid_portfolio_import_mode CHECK (mode IN ('dry_run', 'apply')),
    CONSTRAINT valid_portfolio_import_sha256 CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT valid_portfolio_import_row_counts CHECK (jsonb_typeof(row_counts) = 'object'),
    CONSTRAINT valid_portfolio_import_actor CHECK (btrim(actor) <> '')
  );

  CREATE TABLE IF NOT EXISTS public.portfolio_import_map (
    organization_id UUID NOT NULL,
    source_system VARCHAR(50) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    source_id VARCHAR(255) NOT NULL,
    target_id VARCHAR(255) NOT NULL,
    import_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portfolio_import_map_pkey PRIMARY KEY (organization_id, source_system, kind, source_id),
    CONSTRAINT portfolio_import_map_import_fkey FOREIGN KEY (import_id, organization_id)
      REFERENCES public.portfolio_imports (import_id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT valid_portfolio_import_map_kind CHECK (kind IN ('service', 'ci', 'relationship', 'service_ci')),
    CONSTRAINT valid_portfolio_import_map_ids CHECK (btrim(source_id) <> '' AND btrim(target_id) <> '')
  );
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.portfolio_import_map'::regclass AND contype = 'f'
                 AND conname = 'portfolio_import_map_import_fkey'
                 AND confrelid = 'public.portfolio_imports'::regclass) THEN
    RAISE EXCEPTION 'HAP-1426 portfolio_import_map exists without the tenant-bound import FK';
  END IF;

  FOREACH app_login IN ARRAY ARRAY['cmdb_user', 'cmdb_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_login) THEN
      EXECUTE format('GRANT SELECT, INSERT ON public.portfolio_imports, public.portfolio_import_map TO %I', app_login);
    END IF;
  END LOOP;
END
$hap1426$;
