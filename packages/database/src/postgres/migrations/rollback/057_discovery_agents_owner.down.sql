-- Rollback for 057_discovery_agents_owner.sql. MANUAL ONLY; not authorized for any environment without a separate
-- named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- When: AFTER replacing the API image with one older than the owner binding. An older image never names the column and
-- applies no owner predicate, so every agent-role credential again controls every agent of its organization.
-- Dropping the column discards who registered each agent; re-applying 057 then leaves every row ownerless, so agent-role
-- callers are locked out of all of them until an operator re-registers them. Copy the column first if that matters:
--   CREATE TABLE ... AS SELECT agent_id, owner_user_id FROM public.discovery_agents WHERE owner_user_id IS NOT NULL;
--
-- Run: psql -v ON_ERROR_STOP=1 -f 057_discovery_agents_owner.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE public.discovery_agents DROP COLUMN IF EXISTS owner_user_id;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '057_discovery_agents_owner.sql';
COMMIT;
