-- Rollback for 055_auth_credential_events_scope_events.sql. MANUAL ONLY; not authorized for any environment
-- without a separate named instruction.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts and scripts/db-migrate.sh only
-- read *.sql directly inside migrations/, never this rollback/ subdirectory.
--
-- Run only AFTER reverting to an API image older than HAP-2039: a newer image's grant/revoke of the
-- portfolio:import scope would write a portfolio_import_scope_* row, which the narrow CHECK restored here
-- rejects (the Neo4j change would then be applied without its audit row, exit code 3).
--
-- Aborts, changing nothing, while any portfolio_import_scope_* row exists: the audit must never be deleted or
-- silently orphaned (the append-only trigger forbids deleting rows anyway), and re-adding the narrow CHECK
-- would fail on them. The file also removes the 055 ledger row, so the migrator re-applies 055 on a later
-- redeploy.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 055_auth_credential_events_scope_events.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.auth_credential_events WHERE event LIKE 'portfolio_import_scope_%') THEN
    RAISE EXCEPTION '055 down refused: auth_credential_events holds portfolio_import_scope_* rows';
  END IF;
END;
$$;

ALTER TABLE public.auth_credential_events
  DROP CONSTRAINT IF EXISTS auth_credential_events_event_check,
  ADD CONSTRAINT auth_credential_events_event_check CHECK (event IN (
    'default_marker_set_scan', 'default_marker_set_login',
    'password_rotation_intent', 'password_rotated_operator', 'password_rotation_not_applied'));
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '055_auth_credential_events_scope_events.sql';

COMMIT;
