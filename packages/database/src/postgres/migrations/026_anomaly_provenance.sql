-- HAP-495: old anomaly rows have no independently verified tenant or CI incarnation.
-- Do not backfill from CI IDs, timestamps, names, or the seeded organization.
ALTER TABLE anomalies ADD COLUMN organization_id UUID;
ALTER TABLE anomalies ADD COLUMN ci_incarnation_id UUID;
CREATE INDEX idx_anomalies_owned_current ON anomalies (organization_id, ci_id, ci_incarnation_id, detected_at DESC)
  WHERE organization_id IS NOT NULL AND ci_incarnation_id IS NOT NULL;
