-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-2039: identity-window grant-portfolio-import-scope / revoke-portfolio-import-scope now append one
-- auth_credential_events row per change (event portfolio_import_scope_granted / portfolio_import_scope_revoked),
-- so the history survives a later grant or revoke (the :User node properties keep only the latest pair).
-- This widens auth_credential_events_event_check by exactly those two values. No data change: no row is read,
-- written or rewritten, and the append-only row triggers do not fire on an ALTER. No trigger, grant, column or
-- other constraint changes; the new events carry NULL ref_event_id, target_epoch, reason and revoked_api_keys,
-- which the other 020 constraints already require. The table comment is rewritten to list every event kind the
-- table now holds (a catalog-only change). Idempotent on re-run.
-- Manual rollback: rollback/055_auth_credential_events_scope_events.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

ALTER TABLE public.auth_credential_events
  DROP CONSTRAINT IF EXISTS auth_credential_events_event_check,
  ADD CONSTRAINT auth_credential_events_event_check CHECK (event IN (
    'default_marker_set_scan', 'default_marker_set_login',
    'password_rotation_intent', 'password_rotated_operator', 'password_rotation_not_applied',
    'portfolio_import_scope_granted', 'portfolio_import_scope_revoked'));

COMMENT ON TABLE public.auth_credential_events IS
  'HP1-S6 append-only credential lifecycle audit. Holds: default-password marker transitions (default_marker_set_scan, default_marker_set_login); operator password rotations (password_rotation_intent, then one outcome, password_rotated_operator or password_rotation_not_applied, derived from the Neo4j decision node); and, from HAP-2039, identity-window grants and revokes of the portfolio:import scope (portfolio_import_scope_granted, portfolio_import_scope_revoked).';
