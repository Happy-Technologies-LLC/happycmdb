-- Rollback for 049_audit_entity_user.sql. MANUAL ONLY; not authorized for any environment without a separate named
-- instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- Keeps: the USER value of audit_entity_type. PostgreSQL cannot drop an enum value, and the audit_log rows written
-- with it are part of the hash chain, which must not lose rows. Only the ledger row is removed; re-applying 049 is a
-- no-op for the enum. An API build without HAP-1368 never writes USER rows.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 049_audit_entity_user.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
DELETE FROM cmdb.schema_migrations WHERE migration_name = '049_audit_entity_user.sql';
COMMIT;
