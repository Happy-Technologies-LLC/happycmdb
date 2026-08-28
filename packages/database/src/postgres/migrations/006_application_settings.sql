-- 006_application_settings.sql
--
-- Backing store for the /api/v1/settings* endpoints routed by
-- GeneralSettings.tsx, NotificationSettings.tsx, and DiscoverySettings.tsx
-- (web-ui/src/components/settings/*), none of which previously had a real
-- handler (F-058, F-059).
--
-- Settings are scoped to the authenticated user (req.user._userId). Users
-- live in Neo4j, not Postgres, so user_id here is a plain VARCHAR(255) with
-- no foreign key -- the same pattern api_keys.user_id (001_complete_schema.sql)
-- already uses for the same reason.
--
-- ------------------------------------------------------------------------
-- user_settings
-- ------------------------------------------------------------------------
-- GeneralSettings and NotificationSettings both PUT a small, evolving set
-- of preference fields (language/timezone/dateFormat/defaultPage;
-- emailOnJobFailure/emailOnJobSuccess/emailOnDiscoveryCompletion/
-- inAppNotifications/emailDigestFrequency). Stored as JSONB rather than
-- fixed columns so the two frontend components can evolve their field sets
-- without another migration, while still surviving a reread as a single
-- row per user.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id VARCHAR(255) PRIMARY KEY,
  general_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  notification_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_settings_user_id_check CHECK (user_id IS NOT NULL AND user_id <> '')
);

COMMENT ON TABLE user_settings IS
  'Per-user application preferences saved by GeneralSettings.tsx (general_settings) and NotificationSettings.tsx (notification_settings) (F-058)';

-- ------------------------------------------------------------------------
-- discovery_provider_settings
-- ------------------------------------------------------------------------
-- DiscoverySettings.tsx PUTs one { credentials: {...} } payload per
-- provider (aws/azure/gcp/ssh) that mixes non-secret fields (region,
-- projectId, username, ...) with secret fields (secretAccessKey,
-- clientSecret, the pasted GCP service-account JSON, the SSH private key).
-- The API layer splits that payload before it ever reaches this table:
-- non-secret fields land in `config` as plain JSONB; secret fields are
-- serialized and passed through @cmdb/common's EncryptionService
-- (AES-256-GCM -- the same "unified" encryption primitive the `credentials`
-- table below already relies on) and stored only as the resulting
-- ciphertext envelope string in `encrypted_credentials`. No plaintext
-- secret material is ever written here.
CREATE TABLE IF NOT EXISTS discovery_provider_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_credentials TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_provider_settings_provider_check
    CHECK (provider IN ('aws', 'azure', 'gcp', 'ssh')),
  CONSTRAINT discovery_provider_settings_user_id_check
    CHECK (user_id IS NOT NULL AND user_id <> ''),
  CONSTRAINT discovery_provider_settings_user_provider_unique
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_discovery_provider_settings_user
  ON discovery_provider_settings(user_id);

COMMENT ON TABLE discovery_provider_settings IS
  'Per-user, per-provider discovery settings from DiscoverySettings.tsx. Non-secret fields live in config (plain JSONB); secrets are AES-256-GCM encrypted via @cmdb/common EncryptionService and stored only as ciphertext in encrypted_credentials (F-059)';
