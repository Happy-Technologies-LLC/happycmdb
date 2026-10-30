-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-774 S5b (design §3.4, D7, D13): the append-only ledger and the encrypted rollback escrow of the operator tool
-- migrate-legacy-discovery-definitions; the API never reads either. definition_id is a plain uuid (no FK), so the
-- history outlives its definition. Ledger UPDATE, DELETE and TRUNCATE raise. The escrow holds the original config as an
-- AES-256-GCM envelope until --finalize deletes it. REVOKE ALL FROM PUBLIC and no grant (not even cmdb_user): only the
-- owner, the migration role that runs this file, can read, write or delete them.
-- Manual rollback: rollback/041_discovery_definition_migration_ledger.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

CREATE TABLE IF NOT EXISTS discovery_definition_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL,
  definition_id UUID NOT NULL,
  organization_id UUID,
  action VARCHAR(16) NOT NULL CHECK (action IN ('planned_leave', 'converted', 'strip_equal', 'alias_rename',
    'benign_strip', 'retired', 'rolled_back', 'drifted')),
  reason VARCHAR(32),
  shape VARCHAR(8),
  prior_credential_id UUID,
  created_credential_id UUID,
  pre_updated_at TIMESTAMPTZ,
  post_updated_at TIMESTAMPTZ,
  key_skeleton_sha256 CHAR(64),
  actor TEXT NOT NULL DEFAULT ('operator:' || current_user),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, definition_id, action)
);
CREATE TABLE IF NOT EXISTS discovery_definition_migration_escrow (
  definition_id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL,
  envelope TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION discovery_definition_migrations_append_only() RETURNS trigger LANGUAGE plpgsql AS $hap774$
BEGIN
  RAISE EXCEPTION 'discovery_definition_migrations is append-only';
END
$hap774$;
CREATE OR REPLACE TRIGGER discovery_definition_migrations_append_only BEFORE UPDATE OR DELETE ON discovery_definition_migrations
  FOR EACH ROW EXECUTE FUNCTION discovery_definition_migrations_append_only();
CREATE OR REPLACE TRIGGER discovery_definition_migrations_no_truncate BEFORE TRUNCATE ON discovery_definition_migrations
  FOR EACH STATEMENT EXECUTE FUNCTION discovery_definition_migrations_append_only();

REVOKE ALL ON discovery_definition_migrations, discovery_definition_migration_escrow FROM PUBLIC;
REVOKE ALL ON FUNCTION discovery_definition_migrations_append_only() FROM PUBLIC;
