-- Rollback for 050_bi_cost_view_grants.sql. MANUAL ONLY; not authorized for any environment without a separate named
-- instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- Effect: metabase_readonly loses SELECT on public.v_top_cost_drivers_bi and public.v_underutilized_resources, so the
-- Metabase cards that read them answer "permission denied" until cost-analysis.sql (which grants them by shape) or
-- metabase-init.sql runs again. Loses no data.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 050_bi_cost_view_grants.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    FOREACH name IN ARRAY ARRAY['public.v_top_cost_drivers_bi', 'public.v_underutilized_resources'] LOOP
      IF to_regclass(name) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON %s FROM metabase_readonly', name);
      END IF;
    END LOOP;
  END IF;
END
$acl$;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '050_bi_cost_view_grants.sql';
COMMIT;
