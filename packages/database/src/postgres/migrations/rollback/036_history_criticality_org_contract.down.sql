-- Rollback for 036_history_criticality_org_contract.sql. MANUAL ONLY;
-- not authorized for any environment without a separate named instruction.
-- Aborts, changing nothing, when two organizations hold a score for one CI id
-- (the restored PRIMARY KEY (ci_id) could not hold them).
--
-- Run: psql -v ON_ERROR_STOP=1 -f 036_history_criticality_org_contract.down.sql

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DO $$
BEGIN
  IF EXISTS (SELECT ci_id FROM ci_criticality_scores GROUP BY ci_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '036 down refused: a CI id has scores in more than one organization';
  END IF;
END;
$$;

DROP INDEX IF EXISTS ci_criticality_scores_legacy_ci_key;
ALTER TABLE ci_criticality_scores ADD PRIMARY KEY (ci_id);
ALTER TABLE ci_change_history DROP CONSTRAINT IF EXISTS ci_change_history_organization_required;

DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '036_history_criticality_org_contract.sql';

COMMIT;
