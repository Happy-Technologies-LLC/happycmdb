-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-1423 (PoR S2, Suite Contracts v2 C1, Vision Root v1 D15): dim_business_services becomes the record C1 reads.
--   lifecycle           planned|live|retiring|retired, stored and separate from operational_status (Q4 (a)).
--                       Backfill (story scenario 7): live when operational_status = 'active', else planned. New rows
--                       default to planned. This replaces HAP-1408's read-time derivation from operational_status.
--   owner_principal_id  identity-provider subject of one accountable human (F14, Q2 (a)); nullable here because
--                       existing rows have none. The API requires it when a write moves a service to live/retiring.
--   owner_group         optional owning group, next to owned_by (kept as the owner display name).
--   version             starts at 1; the API bumps it on every accepted update (If-Match concurrency).
-- audit_entity_type gains BUSINESS_SERVICE: portfolio writes append to the hash-chained audit_log (CR-4, F2).
--
-- V2/V3 initdb ships no 001 business-service table (as 031, 042): the table DDL is skipped with a NOTICE. A wrong
-- relation kind or a conflicting pre-existing column aborts. Idempotent; the migrator records it in one transaction.
-- Manual rollback: rollback/043_business_service_record_c1.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $hap1423$
BEGIN
  -- Enum values cannot be used in the transaction that adds them; nothing below writes audit_log.
  IF to_regtype('public.audit_entity_type') IS NOT NULL THEN
    ALTER TYPE public.audit_entity_type ADD VALUE IF NOT EXISTS 'BUSINESS_SERVICE';
  END IF;

  IF to_regclass('public.dim_business_services') IS NULL THEN
    RAISE NOTICE 'HAP-1423 dim_business_services absent (V2/V3); no business-service DDL';
    RETURN;
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.dim_business_services'::regclass) NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'HAP-1423 wrong object: dim_business_services';
  END IF;

  ALTER TABLE public.dim_business_services
    ADD COLUMN IF NOT EXISTS lifecycle VARCHAR(20),
    ADD COLUMN IF NOT EXISTS owner_principal_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS owner_group VARCHAR(255),
    ADD COLUMN IF NOT EXISTS version INTEGER;
  IF (SELECT count(*) FROM pg_attribute
      WHERE attrelid = 'public.dim_business_services'::regclass AND NOT attisdropped
        AND ((attname IN ('owner_principal_id', 'owner_group') AND format_type(atttypid, atttypmod) = 'character varying(255)')
          OR (attname = 'lifecycle' AND format_type(atttypid, atttypmod) = 'character varying(20)')
          OR (attname = 'version' AND format_type(atttypid, atttypmod) = 'integer'))) <> 4 THEN
    RAISE EXCEPTION 'HAP-1423 conflicting dim_business_services record columns';
  END IF;

  UPDATE public.dim_business_services
     SET lifecycle = CASE WHEN operational_status = 'active' THEN 'live' ELSE 'planned' END
   WHERE lifecycle IS NULL;
  UPDATE public.dim_business_services SET version = 1 WHERE version IS NULL;

  ALTER TABLE public.dim_business_services
    ALTER COLUMN lifecycle SET DEFAULT 'planned',
    ALTER COLUMN lifecycle SET NOT NULL,
    ALTER COLUMN version SET DEFAULT 1,
    ALTER COLUMN version SET NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dim_business_services'::regclass
                 AND conname = 'valid_lifecycle') THEN
    ALTER TABLE public.dim_business_services ADD CONSTRAINT valid_lifecycle
      CHECK (lifecycle IN ('planned', 'live', 'retiring', 'retired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dim_business_services'::regclass
                 AND conname = 'valid_version') THEN
    ALTER TABLE public.dim_business_services ADD CONSTRAINT valid_version CHECK (version >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.dim_business_services'::regclass
                 AND conname = 'valid_owner_principal_id') THEN
    ALTER TABLE public.dim_business_services ADD CONSTRAINT valid_owner_principal_id
      CHECK (owner_principal_id IS NULL OR btrim(owner_principal_id) <> '');
  END IF;
END
$hap1423$;
