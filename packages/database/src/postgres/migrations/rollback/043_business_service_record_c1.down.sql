-- Rollback for 043_business_service_record_c1.sql. MANUAL ONLY; not authorized for any environment without a separate
-- named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- When: AFTER replacing the API image with one older than HAP-1423. A HAP-1423 image reads and writes these columns and
-- fails closed (500) once they are gone; a pre-HAP-1423 image never names them and works with or without them.
--
-- Loses data: every service's stored lifecycle, owner_principal_id, owner_group and version. Re-applying 043 backfills
-- lifecycle from operational_status again and restarts version at 1; owner principals must be set again.
--
-- Keeps: the BUSINESS_SERVICE value of audit_entity_type. PostgreSQL cannot drop an enum value, and the audit_log rows
-- written with it are part of the hash chain, which must not lose rows. Re-applying 043 is a no-op for the enum.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 043_business_service_record_c1.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE IF EXISTS dim_business_services
  DROP CONSTRAINT IF EXISTS valid_lifecycle,
  DROP CONSTRAINT IF EXISTS valid_version,
  DROP CONSTRAINT IF EXISTS valid_owner_principal_id,
  DROP COLUMN IF EXISTS lifecycle,
  DROP COLUMN IF EXISTS owner_principal_id,
  DROP COLUMN IF EXISTS owner_group,
  DROP COLUMN IF EXISTS version;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '043_business_service_record_c1.sql';
COMMIT;
