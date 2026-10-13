-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- Legacy derived rows have NULL incarnation and are never attributed to a new
-- graph CI. Do not backfill from timestamps, ownership metadata or CI ID.
ALTER TABLE baseline_snapshots ADD COLUMN IF NOT EXISTS ci_incarnation_id UUID;
ALTER TABLE drift_detection_results ADD COLUMN IF NOT EXISTS ci_incarnation_id UUID;
ALTER TABLE impact_analyses ADD COLUMN IF NOT EXISTS ci_incarnation_id UUID;
ALTER TABLE ci_criticality_scores ADD COLUMN IF NOT EXISTS ci_incarnation_id UUID;
ALTER TABLE ci_change_history ADD COLUMN IF NOT EXISTS ci_incarnation_id UUID;

CREATE INDEX IF NOT EXISTS idx_baseline_ci_incarnation ON baseline_snapshots (ci_id, ci_incarnation_id);
CREATE INDEX IF NOT EXISTS idx_drift_ci_incarnation ON drift_detection_results (ci_id, ci_incarnation_id);
CREATE INDEX IF NOT EXISTS idx_impact_ci_incarnation ON impact_analyses (source_ci_id, ci_incarnation_id);
CREATE INDEX IF NOT EXISTS idx_criticality_ci_incarnation ON ci_criticality_scores (ci_id, ci_incarnation_id);
CREATE INDEX IF NOT EXISTS idx_history_ci_incarnation ON ci_change_history (ci_id, ci_incarnation_id);
