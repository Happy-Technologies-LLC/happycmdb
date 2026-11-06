-- Rollback for 047_ai_sync_cursors.sql. MANUAL ONLY; not authorized for any environment without a separate named
-- instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- When: AFTER stopping every AI sync job (AAI S2+). No API path reads ai_sync_cursors in S1.
--
-- Loses data: every AI sync cursor. Re-applying 047 creates an empty table and the next sync starts from its source's
-- beginning (the sync writer is idempotent per natural key, so a replay updates CIs in place).
--
-- Run: psql -v ON_ERROR_STOP=1 -f 047_ai_sync_cursors.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DROP TABLE IF EXISTS public.ai_sync_cursors;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '047_ai_sync_cursors.sql';
COMMIT;
