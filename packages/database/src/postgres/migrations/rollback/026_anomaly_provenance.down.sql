DROP INDEX IF EXISTS idx_anomalies_owned_current;
ALTER TABLE anomalies DROP COLUMN IF EXISTS ci_incarnation_id;
ALTER TABLE anomalies DROP COLUMN IF EXISTS organization_id;
