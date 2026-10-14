-- Rollback for 029_reconciliation_conflict_identity_rules.sql. MANUAL ONLY;
-- not authorized for any environment without a separate named instruction.
-- Run BEFORE rollback/028_...: 028's down drops reconciliation_conflicts.organization_id.
--
-- Aborts, changing nothing, on any superseded conflict (v16 M-9), any
-- organization-owned conflict, rule or source authority, any typed field
-- value, or any conflict ci_id that is not a UUID (it could not return to uuid).
--
-- Run: psql -v ON_ERROR_STOP=1 -f 029_reconciliation_conflict_identity_rules.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reconciliation_conflicts WHERE status = 'superseded') THEN
    RAISE EXCEPTION '029 down refused: superseded conflicts exist';
  END IF;
  IF EXISTS (SELECT 1 FROM reconciliation_conflicts WHERE
       organization_id IS NOT NULL OR field_name IS NOT NULL OR source_name IS NOT NULL
       OR source_id IS NOT NULL OR incoming_json IS NOT NULL OR target_json IS NOT NULL
       OR target_source_name IS NOT NULL OR content_hash IS NOT NULL
       OR target_field_correlation_id IS NOT NULL OR detected_by IS NOT NULL
       OR suppression_hash IS NOT NULL OR resolution_correlation_id IS NOT NULL
       OR superseded_by IS NOT NULL)
     OR EXISTS (SELECT 1 FROM reconciliation_rules WHERE organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM source_authority WHERE organization_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM ci_field_sources WHERE value_json IS NOT NULL) THEN
    RAISE EXCEPTION '029 down refused: organization-owned or typed rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM reconciliation_conflicts
             WHERE ci_id IS NOT NULL
               AND ci_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION '029 down refused: conflict ci_id values that are not UUIDs exist';
  END IF;
END;
$$;

DROP INDEX IF EXISTS reconciliation_conflicts_pending_key;
DROP INDEX IF EXISTS reconciliation_conflicts_suppression;
DROP INDEX IF EXISTS reconciliation_rules_org_name_key;
DROP INDEX IF EXISTS reconciliation_rules_org_enabled;
DROP INDEX IF EXISTS source_authority_org_source_key;
ALTER TABLE reconciliation_conflicts
  DROP COLUMN IF EXISTS field_name, DROP COLUMN IF EXISTS source_name, DROP COLUMN IF EXISTS source_id,
  DROP COLUMN IF EXISTS incoming_json, DROP COLUMN IF EXISTS target_json, DROP COLUMN IF EXISTS target_source_name,
  DROP COLUMN IF EXISTS content_hash, DROP COLUMN IF EXISTS target_field_correlation_id, DROP COLUMN IF EXISTS detected_by,
  DROP COLUMN IF EXISTS suppression_hash, DROP COLUMN IF EXISTS resolution_correlation_id, DROP COLUMN IF EXISTS superseded_by;
ALTER TABLE reconciliation_conflicts ALTER COLUMN ci_id TYPE UUID USING ci_id::uuid;
ALTER TABLE ci_field_sources DROP COLUMN IF EXISTS value_json;
ALTER TABLE reconciliation_rules DROP COLUMN IF EXISTS organization_id;
ALTER TABLE source_authority DROP COLUMN IF EXISTS organization_id;

DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '029_reconciliation_conflict_identity_rules.sql';

COMMIT;
