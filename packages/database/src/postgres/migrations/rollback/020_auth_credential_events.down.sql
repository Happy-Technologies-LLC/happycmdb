-- Rollback for 020_auth_credential_events.sql. MANUAL ONLY; not authorized for
-- any environment without a separate named instruction.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- Aborts, changing nothing, once the credential lifecycle has been used:
-- any auth_credential_events row, any api_keys.credential_epoch <> 0, any
-- audit_log row of a successful self-service password change, or no operator
-- attestation that every :User.credentialEpoch in Neo4j is still 0.
-- DROP TABLE would bypass the append-only trigger and destroy the audit, and
-- dropping the column would erase key generations.
--
-- Credential generations live in Neo4j. Since HAP-1285 a self-service password
-- change (PUT /auth/password) also advances :User.credentialEpoch, and it
-- writes no auth_credential_events row; its audit_log row (HAP-1368) is
-- best-effort and absent before HAP-1368 or for an actor without an
-- organization claim. A pre-HP1-S6 API build ignores the credential
-- generation, so after any advance it would accept the user's revoked API
-- keys (stored at an older generation) and pre-change tokens again. Reverting
-- the image is therefore the step that can do harm, so the checks come first.
-- Manual procedure, in this order:
--
--   1. With the 020-aware image STILL UP, read from Neo4j (read-only) the
--      number of users whose generation has advanced:
--
--        MATCH (u:User) WHERE coalesce(u.credentialEpoch, 0) <> 0 RETURN count(u)
--
--      and check that auth_credential_events has no rows and that audit_log
--      has no successful self-service password change (entity USER, metadata
--      operation password_change, outcome success). If the count is not 0 or
--      either table holds such rows, STOP: do not revert the image, and do
--      not run this file. This file's own guard would refuse, but only after
--      the old image was live and accepting revoked keys and tokens again.
--   2. Revert the 020-aware API image (so no generation can advance after the
--      attestation). If it was reverted after any revocation anyway (an
--      operator rotation or a self-service password change), the old build
--      ignores the credential generation: rotate the JWT signing secret in
--      the same deploy, or it accepts pre-revocation tokens again.
--   3. Re-read the same Neo4j count in the same window. Only when it is still
--      0, attest it in the psql session that runs this file:
--
--        PGOPTIONS='-c cmdb.rollback_020_max_credential_epoch=0' \
--          psql -v ON_ERROR_STOP=1 -f 020_auth_credential_events.down.sql
--
-- Unset, or any value but 0, refuses. A non-zero generation means the 020-aware
-- image must stay; there is no rollback of 020 that keeps revoked keys revoked.
-- The file also removes the 020 ledger row, so the migrator re-applies 020 on a
-- later redeploy.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $$
DECLARE
  self_service_change boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM auth_credential_events) THEN
    RAISE EXCEPTION '020 down refused: auth_credential_events has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM api_keys WHERE credential_epoch <> 0) THEN
    RAISE EXCEPTION '020 down refused: api_keys.credential_epoch is in use';
  END IF;
  -- HAP-1382 S-2: PostgreSQL evidence of a self-service generation advance (the HAP-1368 audit row, entity USER;
  -- without 049's USER value there is none). Dynamic: audit_log and the USER value need not exist here.
  IF to_regclass('public.audit_log') IS NOT NULL AND to_regtype('public.audit_entity_type') IS NOT NULL THEN
    EXECUTE $q$SELECT 'USER' = ANY (enum_range(NULL::public.audit_entity_type)::text[])$q$ INTO self_service_change;
    IF self_service_change THEN
      EXECUTE $q$SELECT EXISTS (SELECT 1 FROM public.audit_log
        WHERE entity_type = 'USER' AND metadata->>'operation' = 'password_change' AND metadata->>'outcome' = 'success')$q$
        INTO self_service_change;
    END IF;
    IF self_service_change THEN
      RAISE EXCEPTION '020 down refused: a self-service password change advanced a credential generation';
    END IF;
  END IF;
  -- HAP-1382 S-2: the generation itself lives in Neo4j; only the operator can read it.
  IF coalesce(current_setting('cmdb.rollback_020_max_credential_epoch', true), '') <> '0' THEN
    RAISE EXCEPTION '020 down refused: cmdb.rollback_020_max_credential_epoch is not attested as 0';
  END IF;
END;
$$;

ALTER TABLE api_keys DROP COLUMN IF EXISTS credential_epoch;
DROP TABLE IF EXISTS auth_credential_events;
DROP FUNCTION IF EXISTS auth_credential_events_append_only();
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '020_auth_credential_events.sql';

COMMIT;
