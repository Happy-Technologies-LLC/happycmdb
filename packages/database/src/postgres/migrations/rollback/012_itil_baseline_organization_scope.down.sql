-- Rollback for 012_itil_baseline_organization_scope.sql. MANUAL ONLY.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- When: BEFORE deploying an API image older than 012. Between running this and
-- replacing the image, the 012-aware API answers 503 "ITIL records unavailable"
-- on /itil/baselines (its catalog check finds no organization_id column): it
-- fails closed, it does not leak.
--
-- Loses data: every baseline's organization assignment is dropped. Tenant
-- ownership is not recoverable afterwards: re-applying 012 leaves ALL baselines
-- with a NULL organization_id (inaccessible to the REST API until reassigned by
-- hand). Take a backup of (id, organization_id) first if the assignments matter.
--
-- Fails closed, whole transaction rolled back, while later objects that depend on
-- the column exist. Without this check DROP COLUMN would silently drop them:
--   - idx_itil_baselines_org_name (013): run
--     rollback/013_itil_baseline_org_name_unique.down.sql first.
--   - idx_itil_baselines_legacy_name or itil_baselines_organization_write_guard
--     (035): run rollback/035_itil_record_ownership.down.sql first.
--
-- Order (reverse of apply): rollback/035 (if 035 is applied), then
-- rollback/013_itil_baseline_org_name_unique.down.sql, then THIS file. Run the
-- 013 down first: it also restores the global unique name index, which is what a
-- pre-012 writer relies on. Nothing else references itil_baselines.organization_id.
--
-- Operator: stop or drain baseline writes (or take the API out of service) BEFORE
-- running the 013 down, run the 013 down and this file back-to-back, and replace
-- the API image right after. Reason: between the 013 down and this file, a running
-- 012/013-aware API still serves POST /itil/baselines (its 503 gate only checks
-- that organization_id exists). A name held by another organization or a NULL-owner
-- row then hits the restored global UNIQUE(name), which the API reports as 409
-- "Baseline name already exists": a cross-tenant name-existence oracle, the one
-- 013 closed.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 012_itil_baseline_organization_scope.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $hp503$
BEGIN
  IF to_regclass('public.idx_itil_baselines_legacy_name') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.itil_baselines'::regclass
                   AND conname = 'itil_baselines_organization_write_guard') THEN
    RAISE EXCEPTION '012 down refused: 035 objects still exist on itil_baselines. Run rollback/035_itil_record_ownership.down.sql, then rollback/013_itil_baseline_org_name_unique.down.sql, first.';
  END IF;
  IF to_regclass('public.idx_itil_baselines_org_name') IS NOT NULL THEN
    RAISE EXCEPTION '012 down refused: idx_itil_baselines_org_name (013) still exists. Run rollback/013_itil_baseline_org_name_unique.down.sql first.';
  END IF;
END
$hp503$;

DROP INDEX IF EXISTS idx_itil_baselines_organization_created;

ALTER TABLE itil_baselines DROP COLUMN IF EXISTS organization_id;

-- Lets the migrator apply 012 again on the next run.
DO $ledger$ BEGIN
  IF to_regclass('cmdb.schema_migrations') IS NOT NULL THEN
    DELETE FROM cmdb.schema_migrations WHERE migration_name = '012_itil_baseline_organization_scope.sql';
  END IF;
END $ledger$;

COMMIT;
