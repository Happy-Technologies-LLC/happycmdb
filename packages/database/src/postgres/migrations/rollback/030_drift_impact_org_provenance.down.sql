-- Rollback for 030_drift_impact_org_provenance.sql. MANUAL ONLY;
-- not authorized for any environment without a separate named instruction.
-- Run BEFORE rollback/029_... . Aborts, changing nothing, on any
-- organization-stamped drift or impact row.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 030_drift_impact_org_provenance.down.sql

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM baseline_snapshots WHERE organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM drift_detection_results WHERE organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM impact_analyses WHERE organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM ci_criticality_scores WHERE organization_id IS NOT NULL) THEN
    RAISE EXCEPTION '030 down refused: organization-stamped drift or impact rows exist';
  END IF;
END;
$$;

DROP INDEX IF EXISTS idx_baseline_snapshots_org_ci;
DROP INDEX IF EXISTS idx_drift_results_org_ci;
DROP INDEX IF EXISTS idx_impact_analyses_org_source_ci;
DROP INDEX IF EXISTS ci_criticality_scores_org_ci_key;
ALTER TABLE baseline_snapshots DROP COLUMN IF EXISTS organization_id;
ALTER TABLE drift_detection_results DROP COLUMN IF EXISTS organization_id;
ALTER TABLE impact_analyses DROP COLUMN IF EXISTS organization_id;
ALTER TABLE ci_criticality_scores DROP COLUMN IF EXISTS organization_id;

COMMIT;
