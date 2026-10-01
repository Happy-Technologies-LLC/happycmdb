-- 010_business_service_views_org_functions.sql
--
-- Org-parameterized access to the two views 009 scoped by organization_id
-- (founder decision FD-6 = b). The views carry no row-level security, so
-- 009's GRANT SELECT ... TO PUBLIC let every database role read every
-- organization's rows.
--
--   cmdb.fn_business_service_health(p_org uuid)
--   cmdb.fn_tbm_tower_summary(p_org uuid)
--     return the view rows WHERE organization_id = p_org and raise on a NULL
--     p_org. p_org is the caller token's _organizationId claim, the same claim
--     the business-service routes filter by.
--   REVOKE SELECT ... FROM PUBLIC on both views.
--
-- Role model. The migration role owns the views and the functions, and is
-- the role the API connects as (POSTGRES_USER). As owner it keeps SELECT on
-- the views and EXECUTE on the functions. This migration grants no other
-- role. EXECUTE is revoked from PUBLIC as well: the functions are SECURITY
-- INVOKER, so a caller also needs SELECT on the view.
-- A future non-owner reader needs GRANT EXECUTE on the function AND
-- GRANT SELECT on the view. SELECT on the view still lets that role read
-- every organization directly: with no RLS, tenant isolation remains the
-- reader's job (call the function with the token's organization id).
--
-- Limits. This is not a tenant-isolation boundary for database roles:
--   - The views' base tables keep 001's PUBLIC grants (SELECT and INSERT on
--     dim_business_services, ci_business_service_mappings,
--     fact_business_service_incidents and fact_business_service_changes;
--     also UPDATE/DELETE on the first two), so any role can recompute both
--     views for every organization and write rows that feed them.
--   - Only the PUBLIC entry is revoked. Grants made outside migrations
--     survive, e.g. metabase_readonly from
--     infrastructure/database/metabase-init.sql (GRANT SELECT ON ALL
--     TABLES/VIEWS IN SCHEMA public, ALTER DEFAULT PRIVILEGES). Superusers
--     and pg_read_all_data members are unaffected.
--   Check after deploy: SELECT relname, relacl FROM pg_class
--   WHERE relname IN ('v_business_service_health', 'v_tbm_tower_summary');
--
-- The views live in schema public: 009 creates them unqualified, and the
-- connecting role has no schema of its own name. If they are elsewhere, the
-- RETURNS SETOF type does not resolve and this migration fails.
--
-- RETURNS SETOF <view> makes each function depend on its view's row type, so
-- neither view can be dropped while 010 is applied. Re-running 009 or running
-- rollback/009 fails until rollback/010 has run; 009 can therefore not
-- silently restore the PUBLIC grant.
--
-- Re-runnable. Rollback (manual): rollback/010_business_service_views_org_functions.down.sql.
-- It must run BEFORE rollback/009_...

CREATE OR REPLACE FUNCTION cmdb.fn_business_service_health(p_org uuid)
RETURNS SETOF public.v_business_service_health
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_org IS NULL THEN
        RAISE EXCEPTION 'fn_business_service_health: organization id must not be NULL'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    RETURN QUERY
        SELECT v.*
          FROM public.v_business_service_health v
         WHERE v.organization_id = p_org
         ORDER BY v.service_id;
END;
$$;

CREATE OR REPLACE FUNCTION cmdb.fn_tbm_tower_summary(p_org uuid)
RETURNS SETOF public.v_tbm_tower_summary
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF p_org IS NULL THEN
        RAISE EXCEPTION 'fn_tbm_tower_summary: organization id must not be NULL'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    RETURN QUERY
        SELECT v.*
          FROM public.v_tbm_tower_summary v
         WHERE v.organization_id = p_org
         ORDER BY v.service_count DESC, v.tbm_tower;
END;
$$;

REVOKE SELECT ON public.v_business_service_health FROM PUBLIC;
REVOKE SELECT ON public.v_tbm_tower_summary FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION cmdb.fn_business_service_health(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cmdb.fn_tbm_tower_summary(uuid) FROM PUBLIC;

COMMENT ON VIEW public.v_business_service_health IS
    'Business service health per organization. No PUBLIC SELECT on this view (base tables keep their 001 grants); readers must use cmdb.fn_business_service_health(organization_id)';
COMMENT ON VIEW public.v_tbm_tower_summary IS
    'Summary statistics by organization and TBM capability tower. No PUBLIC SELECT on this view (base tables keep their 001 grants); readers must use cmdb.fn_tbm_tower_summary(organization_id)';
COMMENT ON FUNCTION cmdb.fn_business_service_health(uuid) IS
    'Rows of v_business_service_health for one organization (the caller token''s _organizationId); raises on NULL';
COMMENT ON FUNCTION cmdb.fn_tbm_tower_summary(uuid) IS
    'Rows of v_tbm_tower_summary for one organization (the caller token''s _organizationId); raises on NULL';
