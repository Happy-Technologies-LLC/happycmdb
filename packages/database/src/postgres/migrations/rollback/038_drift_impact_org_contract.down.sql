-- Rollback for 038_drift_impact_org_contract.sql. MANUAL ONLY;
-- not authorized for any environment without a separate named instruction.
-- Drops only the three NOT VALID checks so pre-S4c (org-less) drift/impact
-- writers work again; every row, org-stamped or legacy, is kept.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 038_drift_impact_org_contract.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

ALTER TABLE baseline_snapshots DROP CONSTRAINT IF EXISTS baseline_snapshots_organization_required;
ALTER TABLE drift_detection_results DROP CONSTRAINT IF EXISTS drift_detection_results_organization_required;
ALTER TABLE impact_analyses DROP CONSTRAINT IF EXISTS impact_analyses_organization_required;

DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '038_drift_impact_org_contract.sql';

COMMIT;
