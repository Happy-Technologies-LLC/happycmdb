-- MANUAL ONLY: psql -v ON_ERROR_STOP=1 -f 026_anomaly_provenance.down.sql
-- Revert the 026-aware image BEFORE running this file. Dropping these columns
-- destroys any future stamped provenance; preserve it before rollback if needed.
-- The migrator discovers only top-level forward files, never this rollback.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE anomalies DROP COLUMN IF EXISTS ci_incarnation_id;
ALTER TABLE anomalies DROP COLUMN IF EXISTS organization_id;
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '026_anomaly_provenance.sql';
COMMIT;
