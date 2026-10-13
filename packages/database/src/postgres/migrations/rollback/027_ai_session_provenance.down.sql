-- MANUAL ONLY: psql -v ON_ERROR_STOP=1 -f 027_ai_session_provenance.down.sql
-- Revert the 027-aware image BEFORE running this file. Preserve any future
-- stamped ownership first: dropping this column destroys that provenance.
-- The migrator only discovers top-level forward files.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE ai_discovery_patterns DROP COLUMN IF EXISTS organization_id;
ALTER TABLE ai_discovery_sessions DROP COLUMN IF EXISTS organization_id;
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '027_ai_session_provenance.sql';
COMMIT;
