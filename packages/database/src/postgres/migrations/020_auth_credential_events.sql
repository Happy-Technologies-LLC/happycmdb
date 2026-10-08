-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- ============================================================================
-- Migration 020: credential-lifecycle audit and API-key credential generation
-- (HP1-S6, design v16 §1.1 / §2.6; founder ruling exchange/approvals/cmdb-hp1-slices.go)
-- ============================================================================
--
-- auth_credential_events: append-only record of default-password marker
-- transitions and operator password rotations. Each rotation writes one
-- `password_rotation_intent` row before it touches Neo4j, then exactly one
-- outcome row (`password_rotated_operator` or `password_rotation_not_applied`)
-- that references the intent. An outcome is only ever derived from the
-- per-event Neo4j :CredentialRotationDecision node the rotation script
-- observed; an intent without an outcome is PENDING. No age or timeout is a
-- reason, so the reason vocabulary is exactly the decision node's.
-- No password, hash, secret or IP is stored. No foreign keys: rows outlive
-- the user they describe.
--
-- api_keys.credential_epoch: the credential generation of the credential that
-- authorized the key's creation. A key is only valid while it equals the
-- owning user's current :User.credentialEpoch (absent = 0), which an operator
-- rotation increments. Existing keys get 0 = every user's initial generation,
-- so no key changes validity when this migration is applied.

CREATE TABLE IF NOT EXISTS auth_credential_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          VARCHAR(255) NOT NULL,
  event            VARCHAR(40)  NOT NULL,
  ref_event_id     UUID,
  target_epoch     INTEGER,
  revoked_api_keys INTEGER,
  reason           VARCHAR(32),
  actor            VARCHAR(255) NOT NULL,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_credential_events_user_id_check CHECK (user_id <> ''),
  CONSTRAINT auth_credential_events_actor_check CHECK (actor <> ''),
  CONSTRAINT auth_credential_events_event_check CHECK (event IN (
    'default_marker_set_scan', 'default_marker_set_login',
    'password_rotation_intent', 'password_rotated_operator', 'password_rotation_not_applied')),
  CONSTRAINT auth_credential_events_reason_check CHECK (reason IS NULL OR reason IN ('guard_failed', 'fenced')),
  CONSTRAINT auth_credential_events_outcome_ref_check CHECK (
    (event IN ('password_rotated_operator', 'password_rotation_not_applied')) = (ref_event_id IS NOT NULL)),
  CONSTRAINT auth_credential_events_intent_epoch_check CHECK (
    (event = 'password_rotation_intent') = (target_epoch IS NOT NULL)),
  CONSTRAINT auth_credential_events_not_applied_reason_check CHECK (
    (event = 'password_rotation_not_applied') = (reason IS NOT NULL)),
  CONSTRAINT auth_credential_events_revoked_keys_check CHECK (
    (event = 'password_rotated_operator') = (revoked_api_keys IS NOT NULL) AND (revoked_api_keys IS NULL OR revoked_api_keys >= 0))
);

-- At most one outcome per intent.
CREATE UNIQUE INDEX IF NOT EXISTS auth_credential_events_one_outcome
  ON auth_credential_events (ref_event_id) WHERE ref_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_credential_events_open_intents
  ON auth_credential_events (occurred_at) WHERE event = 'password_rotation_intent';

CREATE OR REPLACE FUNCTION auth_credential_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auth_credential_events is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE TRIGGER auth_credential_events_no_update_delete
  BEFORE UPDATE OR DELETE ON auth_credential_events
  FOR EACH ROW EXECUTE FUNCTION auth_credential_events_append_only();

CREATE OR REPLACE TRIGGER auth_credential_events_no_truncate
  BEFORE TRUNCATE ON auth_credential_events
  FOR EACH STATEMENT EXECUTE FUNCTION auth_credential_events_append_only();

REVOKE ALL ON auth_credential_events FROM PUBLIC;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS credential_epoch INTEGER NOT NULL DEFAULT 0;

COMMENT ON TABLE auth_credential_events IS
  'HP1-S6 append-only credential lifecycle audit: default-password marker transitions and operator rotations (intent, then one outcome derived from the Neo4j decision node).';
COMMENT ON COLUMN api_keys.credential_epoch IS
  'Credential generation of the credential that authorized this key; the key is valid only while it equals the owner''s :User.credentialEpoch.';
