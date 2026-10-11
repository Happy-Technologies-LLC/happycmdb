-- Manual rollback for HAP-483. Review owner mappings before dropping assignments;
-- this file is not discovered by the migrator (only top-level *.sql are applied).
BEGIN;
DROP INDEX IF EXISTS idx_discovery_definitions_organization_id_id;
ALTER TABLE discovery_definitions DROP COLUMN IF EXISTS organization_id;
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '024_discovery_definition_organization_scope.sql';
COMMIT;
