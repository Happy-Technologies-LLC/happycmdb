-- Rollback for 013_itil_baseline_org_name_unique.sql. MANUAL ONLY.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- When: only to return itil_baselines to the global UNIQUE(name) of
-- 001_complete_schema.sql (idx_itil_baselines_unique_name), normally together
-- with rollback/012 and before deploying an API image older than 012/013.
--
-- Loses data: none. It drops idx_itil_baselines_org_name (organization_id, name)
-- and recreates the global unique index; no row is read-modified, deduplicated
-- or deleted. After this, two organizations can no longer hold a baseline with
-- the same name.
--
-- Fails closed, whole transaction rolled back, in two cases:
--   1. 035_itil_record_ownership.sql is still applied (idx_itil_baselines_legacy_name
--      or itil_baselines_organization_write_guard exists). Run
--      rollback/035_itil_record_ownership.down.sql FIRST.
--   2. Two or more baselines share a name (any organization, NULL-owner legacy
--      rows included): the global unique index cannot be built. The error gives
--      only the number of duplicated names. The operator must resolve them by
--      hand (rename or delete the extra baselines, after review) and run this
--      script again. This script never renames or deletes data itself.
--
-- Order (reverse of apply): rollback/035 (if 035 is applied), then THIS file,
-- then rollback/012_itil_baseline_organization_scope.down.sql. Nothing else
-- references itil_baselines.organization_id or its name indexes: 045 grants only
-- table privileges, and the baseline_snapshots tables of 025/030/038 are separate.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 013_itil_baseline_org_name_unique.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- SHARE blocks concurrent writes (reads continue) so the duplicate check below
-- stays true until the unique index is built.
LOCK TABLE itil_baselines IN SHARE MODE;

DO $hp503$
DECLARE duplicate_names bigint;
BEGIN
  IF to_regclass('public.idx_itil_baselines_legacy_name') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.itil_baselines'::regclass
                   AND conname = 'itil_baselines_organization_write_guard') THEN
    RAISE EXCEPTION '013 down refused: 035 objects still exist on itil_baselines. Run rollback/035_itil_record_ownership.down.sql first.';
  END IF;

  SELECT count(*) INTO duplicate_names
    FROM (SELECT 1 FROM itil_baselines GROUP BY name HAVING count(*) > 1) AS d;
  IF duplicate_names > 0 THEN
    RAISE EXCEPTION '013 down refused: % baseline name(s) are used by more than one baseline (across organizations or NULL-owner rows), so the global unique name index cannot be recreated. Nothing was changed. Resolve the duplicates by hand (rename or remove the extra baselines), then run this script again.', duplicate_names;
  END IF;
END
$hp503$;

CREATE UNIQUE INDEX idx_itil_baselines_unique_name ON itil_baselines(name);

DROP INDEX idx_itil_baselines_org_name;

-- Lets the migrator apply 013 again on the next run.
DO $ledger$ BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NOT NULL THEN
    DELETE FROM cmdb.schema_migrations WHERE migration_name = '013_itil_baseline_org_name_unique.sql';
  END IF;
END $ledger$;

COMMIT;
