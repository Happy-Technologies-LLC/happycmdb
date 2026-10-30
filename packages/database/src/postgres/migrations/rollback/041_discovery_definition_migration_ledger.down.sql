-- Rollback for 041_discovery_definition_migration_ledger.sql. MANUAL ONLY; not authorized for any environment
-- without a separate named instruction. Drops exactly what 041 creates (ledger and its triggers, escrow, trigger
-- function): the ledger history and any unfinalized escrow are lost, so back up first. Definitions and credentials stay.
-- Run: psql -v ON_ERROR_STOP=1 -f 041_discovery_definition_migration_ledger.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DROP TABLE IF EXISTS discovery_definition_migration_escrow;
DROP TABLE IF EXISTS discovery_definition_migrations;
DROP FUNCTION IF EXISTS discovery_definition_migrations_append_only();
DELETE FROM cmdb.schema_migrations WHERE migration_name = '041_discovery_definition_migration_ledger.sql';
COMMIT;
