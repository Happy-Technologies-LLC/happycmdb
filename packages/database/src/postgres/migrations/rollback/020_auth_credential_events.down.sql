-- Rollback for 020_auth_credential_events.sql. MANUAL ONLY; not authorized for
-- any environment without a separate named instruction.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- Aborts, changing nothing, once the credential lifecycle has been used:
-- any auth_credential_events row, or any api_keys.credential_epoch <> 0.
-- DROP TABLE would bypass the append-only trigger and destroy the audit, and
-- dropping the column would erase key generations. A pre-HP1-S6 API build
-- also ignores the credential generation, so redeploying one after any
-- operator rotation additionally requires rotating the JWT signing secret
-- in the same deploy (it would otherwise accept pre-rotation tokens again).
--
-- Run: psql -v ON_ERROR_STOP=1 -f 020_auth_credential_events.down.sql

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_credential_events) THEN
    RAISE EXCEPTION '020 down refused: auth_credential_events has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM api_keys WHERE credential_epoch <> 0) THEN
    RAISE EXCEPTION '020 down refused: api_keys.credential_epoch is in use';
  END IF;
END;
$$;

ALTER TABLE api_keys DROP COLUMN IF EXISTS credential_epoch;
DROP TABLE IF EXISTS auth_credential_events;
DROP FUNCTION IF EXISTS auth_credential_events_append_only();

COMMIT;
