-- Rollback for 011_ci_organization_scope.sql. MANUAL ONLY.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- When: BEFORE deploying an API/ETL image older than 011. Those images insert
-- cmdb.dim_ci rows without organization_id, and every insert would fail with
-- 23502 (not_null_violation) while the column exists. Between running this
-- and replacing the image, the 011-aware API returns 500 on
-- /api/v1/business-services/:id/costs, on mapping CIs into a service and on
-- TBM cost trends (column missing), and the 011-aware ETL fails its dim_ci
-- inserts: it fails closed, it does not leak.
--
-- Loses data: every CI's organization assignment is dropped. Re-applying 011
-- later puts ALL cmdb.dim_ci rows back in the internal organization.
--
-- Independent of the 008-010 rollbacks (no view or function depends on
-- cmdb.dim_ci.organization_id).
--
-- Run: psql -v ON_ERROR_STOP=1 -f 011_ci_organization_scope.down.sql

BEGIN;

DROP INDEX IF EXISTS cmdb.idx_dim_ci_organization;

ALTER TABLE cmdb.dim_ci DROP COLUMN IF EXISTS organization_id;

-- Lets the migrator apply 011 again on the next run.
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '011_ci_organization_scope.sql';

COMMIT;
