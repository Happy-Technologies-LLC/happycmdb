-- Rollback loses any newly stamped provenance; coordinate image reversion first.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE anomalies DROP COLUMN IF EXISTS ci_incarnation_id;
ALTER TABLE anomalies DROP COLUMN IF EXISTS organization_id;
