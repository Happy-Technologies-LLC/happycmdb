-- Rollback for 028_change_history_reconciliation_org_provenance.sql. MANUAL ONLY;
-- not authorized for any environment without a separate named instruction.
-- Not run by the migrator (it reads only migrations/*.sql).
--
-- Aborts, changing nothing, once any organization provenance or journal data
-- exists: dropping it would erase tenant evidence.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 028_change_history_reconciliation_org_provenance.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cmdb.schema_migrations
             WHERE migration_name = '029_reconciliation_conflict_identity_rules.sql') THEN
    RAISE EXCEPTION '028 down refused: 029 migration still recorded';
  END IF;
  IF EXISTS (SELECT 1 FROM ci_change_history WHERE organization_id IS NOT NULL OR correlation_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM ci_source_lineage WHERE organization_id IS NOT NULL OR last_correlation_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM ci_field_sources WHERE organization_id IS NOT NULL OR last_correlation_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM reconciliation_conflicts WHERE organization_id IS NOT NULL OR correlation_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM audit_log WHERE organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM ci_reconciliation_operations)
     OR EXISTS (SELECT 1 FROM ci_reconciliation_epochs) THEN
    RAISE EXCEPTION '028 down refused: organization provenance or journal rows exist';
  END IF;
END;
$$;

DROP TABLE IF EXISTS ci_reconciliation_operations;
DROP TABLE IF EXISTS ci_reconciliation_epochs;
DROP INDEX IF EXISTS ci_change_history_correlation_key;
DROP INDEX IF EXISTS ci_source_lineage_org_key;
DROP INDEX IF EXISTS ci_field_sources_org_key;
ALTER TABLE ci_change_history DROP COLUMN IF EXISTS organization_id, DROP COLUMN IF EXISTS correlation_id;
ALTER TABLE ci_source_lineage DROP COLUMN IF EXISTS organization_id, DROP COLUMN IF EXISTS last_correlation_id;
ALTER TABLE ci_field_sources DROP COLUMN IF EXISTS organization_id, DROP COLUMN IF EXISTS last_correlation_id;
ALTER TABLE reconciliation_conflicts DROP COLUMN IF EXISTS organization_id, DROP COLUMN IF EXISTS correlation_id;
ALTER TABLE audit_log DROP COLUMN IF EXISTS organization_id;

-- Keep the migration runner in sync with the objects removed above.
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '028_change_history_reconciliation_org_provenance.sql';

COMMIT;
