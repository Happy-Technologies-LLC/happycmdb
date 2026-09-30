-- 009_business_service_views_org_scope.sql
--
-- Tenant scoping and correct aggregates for the two business-service views
-- created by 001_complete_schema.sql (follow-up to 008 and to the #26 health
-- fixes in business-service.controller.ts).
--
-- v_business_service_health
--   - exposes organization_id (from dim_business_services, see 008).
--   - aggregates mappings, incidents and changes in separate LATERAL
--     subqueries. 001 LEFT JOINed all three and grouped once, so every
--     incident/change sum was multiplied by (mapping rows x change days) and
--     vice versa.
--   - avg_mttr_minutes is weighted by incident_count over in-window rows with
--     a non-null mttr_minutes (a row's mttr_minutes is the mean over that
--     day's incidents), and is NULL when no such row exists. Same expression
--     as GET /api/v1/business-services/:id/health. 001 used AVG(mttr_minutes)
--     over joined rows, COALESCEd to 0.
-- v_tbm_tower_summary
--   - one row per (organization_id, tbm_tower); 001 counted all tenants'
--     services together.
--
-- Readers MUST filter by organization_id = the caller token's _organizationId
-- claim (the same claim the business-service routes use). The views carry no
-- row-level security; like dim_business_services itself they stay
-- GRANT SELECT TO PUBLIC, and tenant isolation is enforced by the reader.
--
-- DROP + CREATE (not CREATE OR REPLACE): a replaced view cannot insert a
-- column ahead of existing ones. Re-runnable. No CASCADE: if some other
-- object depends on these views, the migration fails instead of dropping it.
--
-- Rollback (manual): rollback/009_business_service_views_org_scope.down.sql.
-- It must run BEFORE rollback/008_...: while these views exist, 008's
-- DROP COLUMN organization_id fails on the view dependency.

DROP VIEW IF EXISTS v_business_service_health;
DROP VIEW IF EXISTS v_tbm_tower_summary;

CREATE VIEW v_business_service_health AS
SELECT
    bs.organization_id,
    bs.service_id,
    bs.name,
    bs.service_classification,
    bs.tbm_tower,
    bs.business_criticality,
    bs.operational_status,
    ci.supported_ci_count,
    inc.incidents_last_30d,
    inc.sla_breaches_last_30d,
    inc.avg_mttr_minutes,
    chg.changes_last_30d,
    chg.failed_changes_last_30d,
    CASE
        WHEN inc.sla_breaches_last_30d = 0
         AND chg.failed_changes_last_30d = 0
         AND bs.operational_status = 'active'
        THEN 'healthy'
        WHEN inc.sla_breaches_last_30d > 5
          OR chg.failed_changes_last_30d > 3
        THEN 'critical'
        ELSE 'degraded'
    END as health_status
FROM dim_business_services bs
CROSS JOIN LATERAL (
    SELECT COUNT(DISTINCT csm.ci_id) as supported_ci_count
    FROM ci_business_service_mappings csm
    WHERE csm.service_id = bs.service_id
) ci
CROSS JOIN LATERAL (
    SELECT
        COALESCE(SUM(f.incident_count), 0)::INT as incidents_last_30d,
        COALESCE(SUM(f.sla_breaches), 0)::INT as sla_breaches_last_30d,
        (SUM(f.mttr_minutes * f.incident_count)
          / NULLIF(SUM(f.incident_count) FILTER (WHERE f.mttr_minutes IS NOT NULL), 0))::FLOAT as avg_mttr_minutes
    FROM fact_business_service_incidents f
    WHERE f.service_id = bs.service_id
      AND f.incident_date >= CURRENT_DATE - INTERVAL '30 days'
) inc
CROSS JOIN LATERAL (
    SELECT
        COALESCE(SUM(f.change_count), 0)::INT as changes_last_30d,
        COALESCE(SUM(f.failed_count), 0)::INT as failed_changes_last_30d
    FROM fact_business_service_changes f
    WHERE f.service_id = bs.service_id
      AND f.change_date >= CURRENT_DATE - INTERVAL '30 days'
) chg;

CREATE VIEW v_tbm_tower_summary AS
SELECT
    organization_id,
    tbm_tower,
    COUNT(*) as service_count,
    COUNT(CASE WHEN operational_status = 'active' THEN 1 END) as active_services,
    COUNT(CASE WHEN business_criticality = 'critical' THEN 1 END) as critical_services,
    COUNT(CASE WHEN business_criticality = 'high' THEN 1 END) as high_criticality_services
FROM dim_business_services
GROUP BY organization_id, tbm_tower
ORDER BY organization_id, service_count DESC;

GRANT SELECT ON v_business_service_health TO PUBLIC;
GRANT SELECT ON v_tbm_tower_summary TO PUBLIC;

COMMENT ON VIEW v_business_service_health IS 'Business service health per organization (filter by organization_id)';
COMMENT ON VIEW v_tbm_tower_summary IS 'Summary statistics by organization and TBM capability tower (filter by organization_id)';
