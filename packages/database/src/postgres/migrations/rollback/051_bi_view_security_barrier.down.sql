-- Rollback for 051_bi_view_security_barrier.sql. MANUAL ONLY; not authorized for any environment without a separate
-- named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- Effect: the eight unbounded cost views lose security_barrier, so the planner may again push a BI-supplied predicate
-- below their WHERE (the leak 051 closed). The shape-guard grants and revokes 051 made are NOT undone: re-granting
-- a view 051 refused would re-open the metadata exposure. The TEMPORARY revoke from metabase_readonly is not undone
-- either: it removed no PUBLIC grant, and no BI feature uses temporary tables. Loses no data. Re-running
-- infrastructure/database/views/cost-analysis.sql restores security_barrier.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 051_bi_view_security_barrier.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'public.v_executive_cost_summary', 'public.v_cost_by_tower', 'public.v_cost_trends',
    'public.v_unit_economics', 'public.v_cloud_vs_onprem_costs', 'public.v_cost_allocation_summary',
    'public.v_depreciation_summary', 'public.v_underutilized_resources'
  ] LOOP
    IF to_regclass(name) IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass(name) AND c.relkind = 'v') THEN
      EXECUTE format('ALTER VIEW %s RESET (security_barrier)', name);
    END IF;
  END LOOP;
END
$acl$;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '051_bi_view_security_barrier.sql';
COMMIT;
