-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 037: HP1-S4b contract half for the merge, conflict and policy writers
-- cut over in the same release (design v16 §2.1 items 3-4, §2.2 items 3-5; HAP-443).
-- ============================================================================
--   - lineage/field sources: the global (ci_id, ...) keys are dropped; the 028 org
--     keys are the only arbiters, so a reused CI id never meets a former owner's rows.
--   - NOT VALID organization checks on lineage, field sources and conflicts; org-owned
--     conflicts need detected_by. Legacy NULL rows stay (inert).
--   - reconciliation_conflicts_immutable: only pending -> resolved|superseded lifecycle
--     columns change; an org-owned row is never deleted.
--   - rules UNIQUE(name) / authority UNIQUE(source_name) become legacy-only (NULL org).
-- Manual rollback: rollback/037_reconciliation_org_contract.down.sql.

DO $hp1$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  IF to_regclass('public.ci_field_sources_org_key') IS NULL OR to_regclass('public.ci_source_lineage_org_key') IS NULL
     OR to_regclass('public.reconciliation_conflicts_pending_key') IS NULL
     OR to_regclass('public.reconciliation_rules_org_name_key') IS NULL
     OR to_regclass('public.source_authority_org_source_key') IS NULL THEN
    RAISE EXCEPTION 'HP1 037 requires 028_change_history_reconciliation_org_provenance and 029_reconciliation_conflict_identity_rules';
  END IF;
  ALTER TABLE ci_source_lineage DROP CONSTRAINT IF EXISTS ci_source_lineage_ci_id_source_name_source_id_key;
  ALTER TABLE ci_field_sources DROP CONSTRAINT IF EXISTS ci_field_sources_ci_id_field_name_key;
  ALTER TABLE reconciliation_rules DROP CONSTRAINT IF EXISTS reconciliation_rules_name_key;
  ALTER TABLE source_authority DROP CONSTRAINT IF EXISTS source_authority_source_name_key;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_source_lineage_organization_required') THEN
    ALTER TABLE ci_source_lineage ADD CONSTRAINT ci_source_lineage_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ci_field_sources_organization_required') THEN
    ALTER TABLE ci_field_sources ADD CONSTRAINT ci_field_sources_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reconciliation_conflicts_organization_required') THEN
    ALTER TABLE reconciliation_conflicts ADD CONSTRAINT reconciliation_conflicts_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reconciliation_conflicts_detector_required') THEN
    ALTER TABLE reconciliation_conflicts ADD CONSTRAINT reconciliation_conflicts_detector_required
      CHECK (organization_id IS NULL OR detected_by IS NOT NULL) NOT VALID;
  END IF;
END
$hp1$;

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_rules_legacy_name_key
  ON reconciliation_rules (name) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS source_authority_legacy_source_key
  ON source_authority (source_name) WHERE organization_id IS NULL;

CREATE OR REPLACE FUNCTION reconciliation_conflicts_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  lifecycle CONSTANT text[] := ARRAY['status', 'resolved_at', 'resolved_by', 'resolution_action', 'resolution_data',
    'suppression_hash', 'resolution_correlation_id', 'superseded_by'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.organization_id IS NOT NULL THEN
      RAISE EXCEPTION 'reconciliation conflict evidence is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('resolved', 'superseded')
     OR to_jsonb(NEW) - lifecycle IS DISTINCT FROM to_jsonb(OLD) - lifecycle THEN
    RAISE EXCEPTION 'reconciliation conflict evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS reconciliation_conflicts_immutable ON reconciliation_conflicts;
CREATE TRIGGER reconciliation_conflicts_immutable BEFORE UPDATE OR DELETE ON reconciliation_conflicts
  FOR EACH ROW EXECUTE FUNCTION reconciliation_conflicts_immutable();
