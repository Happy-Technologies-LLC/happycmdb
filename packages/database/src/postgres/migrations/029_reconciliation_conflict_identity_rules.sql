-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 029: conflict identity, typed values, rule and authority scoping,
-- conflict lifecycle (HP1-S1, HAP-440; design v16 §2.2, "013")
-- ============================================================================
--
-- EXPAND ONLY; nothing today's writers rely on is removed:
--   - reconciliation_conflicts.ci_id becomes varchar(255), so CI ids of every
--     shape (ci_… and UUID text) can be stored; writers already pass strings;
--   - ci_field_sources.value_json: the typed field value;
--   - conflict evidence/lifecycle columns, pending/suppression keys, and
--     superseded status (the immutability trigger and detector requirement
--     are deferred to S4 alongside its writers);
--   - organization_id on reconciliation_rules and source_authority (NULL =
--     legacy, inert for tenants) with org-scoped unique keys ALONGSIDE the
--     existing global UNIQUE(name) / UNIQUE(source_name), which current writers
--     use (source_authority ON CONFLICT (source_name)). Dropping the global
--     keys is the contract half and ships with the writers that adopt the org keys.
--
-- Manual rollback: rollback/029_reconciliation_conflict_identity_rules.down.sql.

DO $hp1$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  IF to_regclass('public.ci_reconciliation_operations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'reconciliation_conflicts'
                      AND column_name = 'organization_id') THEN
    RAISE EXCEPTION 'HP1 013 requires 012_change_history_reconciliation_org_provenance';
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'reconciliation_conflicts' AND column_name = 'ci_id') = 'uuid' THEN
    ALTER TABLE reconciliation_conflicts ALTER COLUMN ci_id TYPE VARCHAR(255) USING ci_id::text;
  END IF;
END
$hp1$;

ALTER TABLE ci_field_sources ADD COLUMN IF NOT EXISTS value_json JSONB;

ALTER TABLE reconciliation_conflicts
  ADD COLUMN IF NOT EXISTS field_name                 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_name                VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_id                  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS incoming_json              JSONB,
  ADD COLUMN IF NOT EXISTS target_json                JSONB,
  ADD COLUMN IF NOT EXISTS target_source_name         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS content_hash               VARCHAR(64),
  ADD COLUMN IF NOT EXISTS target_field_correlation_id UUID,
  ADD COLUMN IF NOT EXISTS detected_by                VARCHAR(255),
  ADD COLUMN IF NOT EXISTS suppression_hash           VARCHAR(64),
  ADD COLUMN IF NOT EXISTS resolution_correlation_id  UUID,
  ADD COLUMN IF NOT EXISTS superseded_by              UUID;

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_conflicts_pending_key
  ON reconciliation_conflicts (organization_id, ci_id, field_name, source_name, source_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS reconciliation_conflicts_suppression
  ON reconciliation_conflicts (organization_id, ci_id, field_name, source_name, source_id, suppression_hash)
  WHERE status = 'resolved';

ALTER TABLE reconciliation_rules ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_rules_org_name_key
  ON reconciliation_rules (organization_id, name) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reconciliation_rules_org_enabled
  ON reconciliation_rules (organization_id, enabled, updated_at DESC, id DESC);

ALTER TABLE source_authority ADD COLUMN IF NOT EXISTS organization_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS source_authority_org_source_key
  ON source_authority (organization_id, source_name) WHERE organization_id IS NOT NULL;
