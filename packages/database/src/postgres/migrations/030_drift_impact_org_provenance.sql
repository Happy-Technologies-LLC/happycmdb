-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 030: drift and impact record provenance
-- (HP1-S1, HAP-440; design v16 §2.3, "014")
-- ============================================================================
--
-- EXPAND ONLY: organization_id (nullable, no default, no backfill) and
-- org-leading indexes on baseline_snapshots, drift_detection_results,
-- impact_analyses and ci_criticality_scores, plus an org-scoped unique key
-- on ci_criticality_scores ALONGSIDE its PRIMARY KEY (ci_id), which the
-- impact engine's ON CONFLICT (ci_id) upsert uses today. The NOT VALID
-- organization CHECKs and the primary-key swap are the contract half and ship
-- with the writers that stamp the organization.
--
-- Manual rollback: rollback/030_drift_impact_org_provenance.down.sql.

DO $hp1$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'ci_field_sources' AND column_name = 'value_json') THEN
    RAISE EXCEPTION 'HP1 014 requires 013_reconciliation_conflict_identity_rules';
  END IF;
END
$hp1$;

ALTER TABLE baseline_snapshots ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_org_ci
  ON baseline_snapshots (organization_id, ci_id, created_at DESC);

ALTER TABLE drift_detection_results ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE INDEX IF NOT EXISTS idx_drift_results_org_ci
  ON drift_detection_results (organization_id, ci_id, detected_at DESC);

ALTER TABLE impact_analyses ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE INDEX IF NOT EXISTS idx_impact_analyses_org_source_ci
  ON impact_analyses (organization_id, source_ci_id, analyzed_at DESC);

ALTER TABLE ci_criticality_scores ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ci_criticality_scores_org_ci_key
  ON ci_criticality_scores (organization_id, ci_id) WHERE organization_id IS NOT NULL;
