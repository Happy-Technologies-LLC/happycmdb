-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 028: CI history and reconciliation provenance (HP1-S1, HAP-440/471)
-- Design v16 §2.1 ("012 — provenance"), numbered next-free at implementation.
-- ============================================================================
--
-- EXPAND ONLY. This file adds; it removes and restricts nothing that the
-- writers running today depend on:
--   - organization_id (nullable, no default, no backfill) on ci_change_history,
--     ci_source_lineage, ci_field_sources, reconciliation_conflicts, audit_log.
--     Legacy rows stay NULL and are never inferred from current CI ownership.
--   - correlation ids: history.correlation_id (unique), conflicts.correlation_id,
--     lineage/field last_correlation_id.
--   - org-scoped unique keys on lineage and field sources, created ALONGSIDE the
--     old global keys (the identity engine's ON CONFLICT targets stay valid);
--   - the reconciliation journal and per-org epoch tables (no PUBLIC access).
-- The contract half of v16 §2.1 (dropping the global keys, NOT VALID
-- organization CHECKs) ships with the writers that adopt the org keys.
--
-- Manual rollback: rollback/028_change_history_reconciliation_org_provenance.down.sql.

DO $hp1$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  IF to_regclass('public.ci_reconciliation_operations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.ci_reconciliation_operations') AND relkind = 'r') THEN
    RAISE EXCEPTION 'HP1 012 wrong object: ci_reconciliation_operations must be a table';
  END IF;
  IF to_regclass('public.ci_reconciliation_epochs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.ci_reconciliation_epochs') AND relkind = 'r') THEN
    RAISE EXCEPTION 'HP1 012 wrong object: ci_reconciliation_epochs must be a table';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'cmdb' AND table_name = 'dim_ci' AND column_name = 'organization_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'cmdb' AND table_name = 'dim_ci' AND column_name = 'org_backfilled') THEN
    RAISE EXCEPTION 'HP1 012 requires 011_ci_organization_scope';
  END IF;
END
$hp1$;

ALTER TABLE ci_change_history
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS correlation_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ci_change_history_correlation_key ON ci_change_history (correlation_id);

ALTER TABLE ci_source_lineage
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS last_correlation_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ci_source_lineage_org_key
  ON ci_source_lineage (organization_id, ci_id, source_name, source_id);

ALTER TABLE ci_field_sources
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS last_correlation_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS ci_field_sources_org_key
  ON ci_field_sources (organization_id, ci_id, field_name);

ALTER TABLE reconciliation_conflicts
  ADD COLUMN IF NOT EXISTS organization_id UUID,
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

-- CI audit trail (SEC11-01). audit_log is a Timescale hypertable on 001;
-- ADD COLUMN without a default is catalog-only. Pre-existing rows stay NULL.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Reconciliation journal: one row per journaled graph operation; its id is
-- the Neo4j fence op_id (Neo4j operator migration 004).
CREATE TABLE IF NOT EXISTS ci_reconciliation_operations (
  id               UUID PRIMARY KEY,
  group_id         UUID NOT NULL,
  organization_id  UUID NOT NULL,
  ci_id            VARCHAR(255) NOT NULL,
  origin           VARCHAR(16) NOT NULL CHECK (origin IN ('api', 'etl', 'discovery')),
  operation        VARCHAR(32) NOT NULL CHECK (operation IN
    ('create', 'update', 'hold', 'delete', 'resolve_conflict', 'direct_write', 'relationship_write', 'restore')),
  graph_effect     BOOLEAN NOT NULL,
  state            VARCHAR(16) NOT NULL CHECK (state IN ('pending', 'committed', 'aborted', 'failed')),
  actor            VARCHAR(255) NOT NULL,
  epoch            BIGINT NOT NULL,
  plan             JSONB,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  claim_token      UUID,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       VARCHAR(64),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ci_reconciliation_operations_inflight
  ON ci_reconciliation_operations (organization_id, ci_id) WHERE state IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS ci_reconciliation_operations_org_epoch
  ON ci_reconciliation_operations (organization_id, epoch);
CREATE INDEX IF NOT EXISTS ci_reconciliation_operations_recovery
  ON ci_reconciliation_operations (lease_expires_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS ci_reconciliation_operations_group
  ON ci_reconciliation_operations (group_id);

CREATE TABLE IF NOT EXISTS ci_reconciliation_epochs (
  organization_id UUID PRIMARY KEY,
  epoch           BIGINT NOT NULL
);

-- 001's cmdb-wide PUBLIC grant does not reach these public tables. Metabase
-- may already have installed a named default SELECT grant for their owner.
REVOKE ALL ON ci_reconciliation_operations, ci_reconciliation_epochs FROM PUBLIC;
DO $hp1$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    EXECUTE 'REVOKE ALL ON public.ci_reconciliation_operations, public.ci_reconciliation_epochs FROM metabase_readonly';
  END IF;
END
$hp1$;

COMMENT ON COLUMN ci_change_history.organization_id IS
  'HP1: verified tenant at write time; legacy NULL rows are hidden from tenants and never inferred from current CI ownership';
COMMENT ON TABLE ci_reconciliation_operations IS
  'HP1 reconciliation journal; id is the Neo4j :ReconciliationOp fence op_id';
