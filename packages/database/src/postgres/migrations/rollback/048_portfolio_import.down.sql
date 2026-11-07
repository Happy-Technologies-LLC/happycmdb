-- Rollback for 048_portfolio_import.sql. MANUAL ONLY; not authorized for any environment without a separate named
-- instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- When: AFTER replacing the API image with one older than HAP-1426. A HAP-1426 image answers POST
-- /api/v1/portfolio/imports from these tables and fails closed (500) once they are gone; an older image never names
-- them or the provenance columns.
--
-- Loses data: the import history (portfolio_imports), the HappyHive -> HappyCMDB id map (portfolio_import_map) and
-- the source_system/source_id provenance of imported services and offerings. The imported services, offerings, CIs,
-- relationships, mappings and their audit_log rows stay. Re-applying 048 creates empty tables and NULL provenance, so a
-- later import no longer recognises those records by id (only by service name, as `match`).
--
-- Run: psql -v ON_ERROR_STOP=1 -f 048_portfolio_import.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DROP TABLE IF EXISTS portfolio_import_map;
DROP TABLE IF EXISTS portfolio_imports;
DROP INDEX IF EXISTS dim_business_services_source_key;
DROP INDEX IF EXISTS service_offerings_source_key;
ALTER TABLE IF EXISTS dim_business_services DROP CONSTRAINT IF EXISTS dim_business_services_source_provenance,
  DROP COLUMN IF EXISTS source_system, DROP COLUMN IF EXISTS source_id;
ALTER TABLE IF EXISTS service_offerings DROP CONSTRAINT IF EXISTS service_offerings_source_provenance,
  DROP COLUMN IF EXISTS source_system, DROP COLUMN IF EXISTS source_id;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '048_portfolio_import.sql';
COMMIT;
