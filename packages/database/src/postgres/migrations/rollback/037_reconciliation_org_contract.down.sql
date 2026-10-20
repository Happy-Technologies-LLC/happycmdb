-- Rollback for 037_reconciliation_org_contract.sql. MANUAL ONLY;
-- not authorized for any environment without a separate named instruction.
-- Aborts, changing nothing, when two organizations hold rows that the restored
-- global keys could not hold.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 037_reconciliation_org_contract.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ci_source_lineage GROUP BY ci_id, source_name, source_id HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM ci_field_sources GROUP BY ci_id, field_name HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM reconciliation_rules GROUP BY name HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM source_authority GROUP BY source_name HAVING count(*) > 1) THEN
    RAISE EXCEPTION '037 down refused: organization-scoped rows share a former global key';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS reconciliation_conflicts_immutable ON reconciliation_conflicts;
DROP FUNCTION IF EXISTS reconciliation_conflicts_immutable();
ALTER TABLE reconciliation_conflicts DROP CONSTRAINT IF EXISTS reconciliation_conflicts_detector_required,
  DROP CONSTRAINT IF EXISTS reconciliation_conflicts_organization_required;
ALTER TABLE ci_field_sources DROP CONSTRAINT IF EXISTS ci_field_sources_organization_required,
  ADD CONSTRAINT ci_field_sources_ci_id_field_name_key UNIQUE (ci_id, field_name);
ALTER TABLE ci_source_lineage DROP CONSTRAINT IF EXISTS ci_source_lineage_organization_required,
  ADD CONSTRAINT ci_source_lineage_ci_id_source_name_source_id_key UNIQUE (ci_id, source_name, source_id);
DROP INDEX IF EXISTS reconciliation_rules_legacy_name_key, source_authority_legacy_source_key;
ALTER TABLE reconciliation_rules ADD CONSTRAINT reconciliation_rules_name_key UNIQUE (name);
ALTER TABLE source_authority ADD CONSTRAINT source_authority_source_name_key UNIQUE (source_name);

DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '037_reconciliation_org_contract.sql';

COMMIT;
