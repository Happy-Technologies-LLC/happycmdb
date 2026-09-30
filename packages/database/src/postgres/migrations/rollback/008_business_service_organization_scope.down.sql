-- Rollback for 008_business_service_organization_scope.sql. MANUAL ONLY.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- When: BEFORE deploying an API image older than 008. Those images insert
-- business services without organization_id, and every create would fail
-- with 23502 (not_null_violation) while the column exists. Between running
-- this and replacing the image, the 008-aware API returns 500 on business
-- service routes (column missing): it fails closed, it does not leak.
--
-- Loses data: every service's organization assignment is dropped. Re-applying
-- 008 later puts ALL services back in the internal organization.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 008_business_service_organization_scope.down.sql

BEGIN;

DROP INDEX IF EXISTS idx_dim_business_services_organization;

ALTER TABLE dim_business_services DROP COLUMN IF EXISTS organization_id;

-- Lets the migrator apply 008 again on the next run.
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '008_business_service_organization_scope.sql';

COMMIT;
