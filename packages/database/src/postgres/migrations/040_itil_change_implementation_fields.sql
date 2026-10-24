-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-922: REST PATCH /itil/changes/:id and GraphQL updateChange write, and the
-- GraphQL Change type reads, implemented_by and actual_duration. No earlier
-- migration created them, so every such update failed with 42703. Add both as
-- nullable columns; existing rows stay NULL. implemented_by matches the other
-- actor columns (VARCHAR(255)); actual_duration is positive whole minutes, as
-- in the API contract. V2/V3 have no ITIL tables, so nothing is created there
-- (as in 035). A wrong relation kind or a conflicting pre-existing column
-- aborts. Idempotent; the migrator records it in one transaction.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $hap922$
BEGIN
  IF to_regclass('public.itil_changes') IS NULL THEN
    RAISE NOTICE 'HAP-922 ITIL changes absent (V2/V3); no ITIL DDL';
    RETURN;
  END IF;
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.itil_changes'::regclass) NOT IN ('r', 'p') THEN
    RAISE EXCEPTION 'HAP-922 wrong object: itil_changes';
  END IF;
  ALTER TABLE public.itil_changes ADD COLUMN IF NOT EXISTS implemented_by VARCHAR(255);
  ALTER TABLE public.itil_changes ADD COLUMN IF NOT EXISTS actual_duration INTEGER;
  IF (SELECT count(*) FROM pg_attribute
      WHERE attrelid = 'public.itil_changes'::regclass AND NOT attisdropped AND NOT attnotnull
        AND ((attname = 'implemented_by' AND format_type(atttypid, atttypmod) = 'character varying(255)')
          OR (attname = 'actual_duration' AND format_type(atttypid, atttypmod) = 'integer'))) <> 2 THEN
    RAISE EXCEPTION 'HAP-922 conflicting itil_changes implementation columns';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.itil_changes'::regclass
                 AND conname = 'itil_changes_actual_duration_check') THEN
    ALTER TABLE public.itil_changes ADD CONSTRAINT itil_changes_actual_duration_check
      CHECK (actual_duration IS NULL OR actual_duration > 0);
  END IF;
END
$hap922$;
