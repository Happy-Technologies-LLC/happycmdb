-- Rollback for 031_business_service_mapping_ownership.sql. MANUAL ONLY;
-- not authorized for any environment without a separate named instruction.
-- Restores 009's v_business_service_health text (supported_ci_count counts
-- every mapping again) and keeps 010's REVOKE. Same columns, so
-- cmdb.fn_business_service_health stays valid.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 031_business_service_mapping_ownership.down.sql

BEGIN;

CREATE OR REPLACE VIEW v_business_service_health AS
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

REVOKE SELECT ON public.v_business_service_health FROM PUBLIC;

DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '031_business_service_mapping_ownership.sql';

COMMIT;
