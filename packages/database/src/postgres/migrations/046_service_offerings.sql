-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-1424 (PoR S3, Suite Contracts v2 C1): a service offering is a record under one business service.
--   service_offerings   offering_id ('so-' + UUID v4, API-assigned), the service it belongs to, the tenant, name,
--                       description, audience (internal|customer), lifecycle (the C1 vocabulary), service_level
--                       (a JSON object: availability_target, response_target_hours, support_hours) and version (If-Match).
--   tenant guard        FOREIGN KEY (service_id, organization_id) -> dim_business_services (service_id, organization_id):
--                       the database refuses an offering whose service belongs to another tenant, whatever the API does.
--                       The new UNIQUE (service_id, organization_id) on dim_business_services is its target (service_id
--                       alone is already the primary key, so no existing row can violate it). ON DELETE RESTRICT: a
--                       service with offerings cannot be deleted (the API answers 409: retire it).
-- audit_entity_type gains SERVICE_OFFERING: offering writes append to the hash-chained audit_log (C1, F2; no ledger).
-- Grants: SELECT, INSERT, UPDATE (no DELETE route) to the app logins that exist: cmdb_user (the HAP-1422 non-owner
-- login) and cmdb_app (HAP-1562 staging login; 045 grants it per table, with no default privileges).
--
-- V2/V3 initdb ships no 001 business-service table (as 043): the DDL is skipped with a NOTICE. A wrong relation kind,
-- or a pre-existing service_offerings without the composite tenant guard, aborts. Idempotent; the migrator records it
-- in one transaction. Manual rollback: rollback/046_service_offerings.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hap1424$
BEGIN
  -- Enum values cannot be used in the transaction that adds them; nothing below writes audit_log.
  IF to_regtype('public.audit_entity_type') IS NOT NULL THEN
    ALTER TYPE public.audit_entity_type ADD VALUE IF NOT EXISTS 'SERVICE_OFFERING';
  END IF;

  IF to_regclass('public.dim_business_services') IS NULL THEN
    RAISE NOTICE 'HAP-1424 dim_business_services absent (V2/V3); no service_offerings';
    RETURN;
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.dim_business_services'::regclass) NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'HAP-1424 wrong object: dim_business_services';
  END IF;
  -- NULL (no such relation) is not <> 'r', so only a wrong existing object aborts.
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.service_offerings')) <> 'r' THEN
    RAISE EXCEPTION 'HAP-1424 wrong object: service_offerings';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dim_business_services'::regclass
                 AND conname = 'dim_business_services_service_org_key') THEN
    ALTER TABLE public.dim_business_services
      ADD CONSTRAINT dim_business_services_service_org_key UNIQUE (service_id, organization_id);
  END IF;

  CREATE TABLE IF NOT EXISTS public.service_offerings (
    offering_id VARCHAR(50) PRIMARY KEY,
    organization_id UUID NOT NULL,
    service_id VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    audience VARCHAR(20) NOT NULL DEFAULT 'internal',
    lifecycle VARCHAR(20) NOT NULL DEFAULT 'planned',
    service_level JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT service_offerings_service_tenant_fkey FOREIGN KEY (service_id, organization_id)
      REFERENCES public.dim_business_services (service_id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT valid_offering_name CHECK (btrim(name) <> ''),
    CONSTRAINT valid_offering_audience CHECK (audience IN ('internal', 'customer')),
    CONSTRAINT valid_offering_lifecycle CHECK (lifecycle IN ('planned', 'live', 'retiring', 'retired')),
    CONSTRAINT valid_offering_service_level CHECK (jsonb_typeof(service_level) = 'object'),
    CONSTRAINT valid_offering_version CHECK (version >= 1)
  );
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.service_offerings'::regclass AND contype = 'f'
                 AND conname = 'service_offerings_service_tenant_fkey'
                 AND confrelid = 'public.dim_business_services'::regclass) THEN
    RAISE EXCEPTION 'HAP-1424 service_offerings exists without the composite tenant guard';
  END IF;
  -- The list read (WHERE service_id AND organization_id) and the RESTRICT check on a service delete.
  CREATE INDEX IF NOT EXISTS idx_service_offerings_service ON public.service_offerings (service_id, organization_id);

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    GRANT SELECT, INSERT, UPDATE ON public.service_offerings TO cmdb_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.service_offerings TO cmdb_app;
  END IF;
END
$hap1424$;
