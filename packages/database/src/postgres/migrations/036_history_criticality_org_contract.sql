-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 036: HP1-S4a contract half for the writers cut over in the same
-- release (design v16 §2.1 item 4 D-NULLHIST B, §2.3; HAP-443; S1 approval
-- item 2 "in the SAME PR as the writer changes that need them").
-- ============================================================================
--
--   - ci_change_history: CHECK (organization_id IS NOT NULL) NOT VALID. The only
--     history writer is now the journaled T2 (delete); the Kafka processor no
--     longer inserts history. Legacy NULL rows stay and stay hidden (H-2).
--   - ci_criticality_scores: PRIMARY KEY (ci_id) is replaced by the org key from
--     030 plus a legacy-only UNIQUE (ci_id) WHERE organization_id IS NULL, so a
--     reused CI id in another organization cannot collide with a former owner's
--     cached score. The impact engine now upserts on (organization_id, ci_id),
--     so new rows also get CHECK (organization_id IS NOT NULL) NOT VALID (v16 §2.3).
-- Lineage, field-source and conflict contract objects ship with the S4b merge
-- writer, which is the writer that needs them.
--
-- Manual rollback: rollback/036_history_criticality_org_contract.down.sql.

DO $hp1$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  IF to_regclass('public.ci_criticality_scores_org_ci_key') IS NULL
     OR to_regclass('public.ci_change_history_correlation_key') IS NULL THEN
    RAISE EXCEPTION 'HP1 036 requires 028_change_history_reconciliation_org_provenance and 030_drift_impact_org_provenance';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.ci_change_history'::regclass
                   AND conname = 'ci_change_history_organization_required') THEN
    ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.ci_criticality_scores'::regclass AND contype = 'p') THEN
    EXECUTE format('ALTER TABLE ci_criticality_scores DROP CONSTRAINT %I',
      (SELECT conname FROM pg_constraint
       WHERE conrelid = 'public.ci_criticality_scores'::regclass AND contype = 'p'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_criticality_scores_organization_required') THEN
    ALTER TABLE ci_criticality_scores ADD CONSTRAINT ci_criticality_scores_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
END
$hp1$;

CREATE UNIQUE INDEX IF NOT EXISTS ci_criticality_scores_legacy_ci_key
  ON ci_criticality_scores (ci_id) WHERE organization_id IS NULL;
