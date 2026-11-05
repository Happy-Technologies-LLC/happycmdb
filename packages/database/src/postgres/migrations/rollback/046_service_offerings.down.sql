-- Rollback for 046_service_offerings.sql. MANUAL ONLY; not authorized for any environment without a separate named
-- instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- When: AFTER replacing the API image with one older than HAP-1424. A HAP-1424 image reads service_offerings on every
-- service read and fails closed (500) once it is gone; a pre-HAP-1424 image never names it and works either way.
--
-- Loses data: every service offering. Re-applying 046 creates an empty table.
--
-- Keeps: the SERVICE_OFFERING value of audit_entity_type. PostgreSQL cannot drop an enum value, and the audit_log rows
-- written with it are part of the hash chain, which must not lose rows. Re-applying 046 is a no-op for the enum.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 046_service_offerings.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DROP TABLE IF EXISTS service_offerings;
ALTER TABLE IF EXISTS dim_business_services DROP CONSTRAINT IF EXISTS dim_business_services_service_org_key;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '046_service_offerings.sql';
COMMIT;
