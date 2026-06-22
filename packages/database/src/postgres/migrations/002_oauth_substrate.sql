-- Migration 002: OAuth substrate (connector-core).
--
-- Adds the two pieces the connector-core OAuth substrate needs on top of the
-- existing (already-encrypted) credentials table:
--
--   1. oauth_states: short-lived, single-use state for the authorization-code
--      redirect, so the authorize -> redirect -> callback round trip survives
--      across nodes. `data` holds the ephemeral PendingAuth (sourceId,
--      providerId, single-use code verifier), never a long-lived credential.
--
--   2. credentials.oauth_metadata: the per-credential encrypted OAuth token
--      bundle (access + refresh + expiry), keyed by credentials.id. Plaintext
--      tokens never land here; the column holds only the sealed bundle
--      ciphertext (envelope AES-GCM via CmdbSecretCipher) alongside its
--      provider id. Shape:
--        { "provider": "servicenow", "bundle_ciphertext": "...", "updated_at": "..." }

CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);

ALTER TABLE credentials ADD COLUMN IF NOT EXISTS oauth_metadata JSONB;
