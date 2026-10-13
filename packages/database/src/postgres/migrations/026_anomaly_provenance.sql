-- HAP-495: old anomaly rows have no independently verified tenant or CI incarnation.
-- Do not backfill from CI IDs, timestamps, names, or the seeded organization.
-- Production migrator executes each file in one transaction. Wait no longer
-- than 3s for the metadata lock; do not hold it for an index scan or rewrite.
-- A future index must be a separate, operator-controlled concurrent migration.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE anomalies ADD COLUMN organization_id UUID;
ALTER TABLE anomalies ADD COLUMN ci_incarnation_id UUID;
