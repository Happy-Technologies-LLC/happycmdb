-- 004_run_logs_and_pattern_review.sql
--
-- Two schema gaps that were blocking matrix rows, closed together as one
-- additive, forward-only migration (no existing table/column is altered
-- destructively and no already-shipped migration is touched).
--
-- ------------------------------------------------------------------------
-- 1. connector_run_log_entries (F-258)
-- ------------------------------------------------------------------------
-- GET /api/v1/connectors/:name/runs/:runId/logs
-- (packages/integration-hub/src/api/connectors.routes.ts) promises
-- timestamp-ordered log lines for a connector run, but
-- connector_run_history (001_complete_schema.sql) stores exactly one
-- summary row per run (status/error_message/errors), not a log stream.
-- Add a dedicated per-line log table keyed on connector_run_history.id so
-- the endpoint has somewhere real to read from.
--
-- ------------------------------------------------------------------------
-- 2. ai_pattern_review_history (F-209)
-- ------------------------------------------------------------------------
-- PatternWorkflow.submitForReview/approvePattern/rejectPattern/
-- deactivatePattern (packages/ai-discovery/src/pattern-workflow.ts) accept
-- comment/reason parameters that were previously only logged, never
-- persisted -- ai_discovery_patterns has no column to hold them. A single
-- pattern can be commented on at more than one transition (submitted with
-- a note, later rejected with a different note, later deactivated with a
-- third), so a one-row-per-pattern column would only ever retain the last
-- comment and would silently overwrite earlier ones. A small append-only
-- history table -- one row per workflow transition, the same per-event
-- shape as ai_pattern_usage's per-execution rows in
-- packages/ai-discovery/schema.sql -- records every comment/reason
-- against the actor and transition it belongs to.
--
-- Placement: 003_z_ai_discovery_schema.sql establishes the AI discovery
-- parent tables in the canonical numbered migration chain. This migration
-- adds the append-only review history that depends on that base schema.
-- packages/ai-discovery/schema.sql remains a non-destructive legacy/dev
-- bootstrap, but it is not a prerequisite for runMigrations().
-- ai_pattern_review_history references ai_discovery_patterns(pattern_id),
-- which the preceding numbered AI migration creates and tracks before 004.

-- ==========================================================================
-- connector_run_log_entries
-- ==========================================================================

CREATE TABLE IF NOT EXISTS connector_run_log_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  level VARCHAR(20) NOT NULL DEFAULT 'info'
    CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  -- Tie-breaker for lines sharing a timestamp: preserves emission order
  -- within a run without depending on timestamp precision.
  sequence BIGSERIAL,
  CONSTRAINT fk_run_log_entries_run
    FOREIGN KEY (run_id)
    REFERENCES connector_run_history(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_log_entries_run_timestamp
  ON connector_run_log_entries(run_id, "timestamp", sequence);

COMMENT ON TABLE connector_run_log_entries IS
  'Per-line, timestamp-ordered log stream for a single connector_run_history run (F-258)';

-- ==========================================================================
-- ai_pattern_review_history
-- ==========================================================================

CREATE TABLE IF NOT EXISTS ai_pattern_review_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id VARCHAR(255) NOT NULL,
  action VARCHAR(50) NOT NULL
    CHECK (action IN ('submit', 'approve', 'reject', 'activate', 'deactivate')),
  performed_by VARCHAR(255) NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pattern_review_history_pattern
    FOREIGN KEY (pattern_id)
    REFERENCES ai_discovery_patterns(pattern_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pattern_review_history_pattern
  ON ai_pattern_review_history(pattern_id, created_at);

COMMENT ON TABLE ai_pattern_review_history IS
  'Append-only comment/reason trail for pattern workflow transitions: submit/approve/reject/activate/deactivate (F-209)';
