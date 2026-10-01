-- Rollback for 010_business_service_views_org_functions.sql. MANUAL ONLY.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- Drops cmdb.fn_business_service_health and cmdb.fn_tbm_tower_summary and
-- restores the view grants and comments exactly as 009 leaves them, including
-- GRANT SELECT ... TO PUBLIC: every database role can again read every
-- organization's rows from the views. View definitions are untouched (010
-- does not change them).
--
-- Order: run this BEFORE rollback/009_business_service_views_org_scope.down.sql.
-- While the functions exist, their RETURNS SETOF types depend on the views and
-- 009's DROP VIEW fails.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 010_business_service_views_org_functions.down.sql

BEGIN;

DROP FUNCTION IF EXISTS cmdb.fn_business_service_health(uuid);
DROP FUNCTION IF EXISTS cmdb.fn_tbm_tower_summary(uuid);

-- Grants and comments (009_business_service_views_org_scope.sql)
GRANT SELECT ON public.v_business_service_health TO PUBLIC;
GRANT SELECT ON public.v_tbm_tower_summary TO PUBLIC;

COMMENT ON VIEW public.v_business_service_health IS 'Business service health per organization (filter by organization_id)';
COMMENT ON VIEW public.v_tbm_tower_summary IS 'Summary statistics by organization and TBM capability tower (filter by organization_id)';

-- Lets the migrator apply 010 again on the next run.
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '010_business_service_views_org_functions.sql';

COMMIT;
