-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 038: HP1-S4c contract half for the drift/impact writers cut over in
-- the same release (design v16 §2.3, §6.5; HAP-443; S1 approval item 2).
-- ============================================================================
--   - baseline_snapshots, drift_detection_results, impact_analyses:
--     CHECK (organization_id IS NOT NULL) NOT VALID. The drift detector and the
--     impact engine now stamp the organization that owns the CI; an org-less
--     (pre-S4c) writer is refused with 23514.
--   - NOT VALID: legacy NULL-org rows stay as they are (no backfill) and the
--     org-filtered readers never return them. ci_criticality_scores got its check
--     in 036.
-- Manual rollback: rollback/038_drift_impact_org_contract.down.sql.

DO $hp1$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  IF to_regclass('public.idx_baseline_snapshots_org_ci') IS NULL
     OR to_regclass('public.idx_drift_results_org_ci') IS NULL
     OR to_regclass('public.idx_impact_analyses_org_source_ci') IS NULL THEN
    RAISE EXCEPTION 'HP1 038 requires 030_drift_impact_org_provenance';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baseline_snapshots_organization_required') THEN
    ALTER TABLE baseline_snapshots ADD CONSTRAINT baseline_snapshots_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drift_detection_results_organization_required') THEN
    ALTER TABLE drift_detection_results ADD CONSTRAINT drift_detection_results_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_analyses_organization_required') THEN
    ALTER TABLE impact_analyses ADD CONSTRAINT impact_analyses_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
END
$hp1$;
