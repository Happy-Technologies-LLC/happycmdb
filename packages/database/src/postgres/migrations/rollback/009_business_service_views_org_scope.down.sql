-- Rollback for 009_business_service_views_org_scope.sql. MANUAL ONLY.
--
-- Not run by any migration runner: packages/database/src/postgres/migrator.ts
-- and scripts/db-migrate.sh only read *.sql directly inside migrations/, never
-- this rollback/ subdirectory.
--
-- Restores v_business_service_health and v_tbm_tower_summary exactly as
-- 001_complete_schema.sql defines them (definitions, GRANT, COMMENT). Those
-- have no organization_id column and count every tenant's services together,
-- so any org-filtered reader errors on the missing column: it fails closed.
--
-- Order: run this BEFORE rollback/008_business_service_organization_scope.down.sql.
-- While the 009 views exist, 008's DROP COLUMN organization_id fails on the
-- view dependency.
--
-- Run: psql -v ON_ERROR_STOP=1 -f 009_business_service_views_org_scope.down.sql

BEGIN;

DROP VIEW IF EXISTS v_business_service_health;
DROP VIEW IF EXISTS v_tbm_tower_summary;

-- View: Business Service Health Dashboard (001_complete_schema.sql)
CREATE VIEW v_business_service_health AS
SELECT
    bs.service_id,
    bs.name,
    bs.service_classification,
    bs.tbm_tower,
    bs.business_criticality,
    bs.operational_status,
    COUNT(DISTINCT csm.ci_id) as supported_ci_count,
    COALESCE(SUM(inc.incident_count), 0)::INT as incidents_last_30d,
    COALESCE(SUM(inc.sla_breaches), 0)::INT as sla_breaches_last_30d,
    COALESCE(AVG(inc.mttr_minutes), 0)::FLOAT as avg_mttr_minutes,
    COALESCE(SUM(chg.change_count), 0)::INT as changes_last_30d,
    COALESCE(SUM(chg.failed_count), 0)::INT as failed_changes_last_30d,
    CASE
        WHEN COALESCE(SUM(inc.sla_breaches), 0) = 0
         AND COALESCE(SUM(chg.failed_count), 0) = 0
         AND bs.operational_status = 'active'
        THEN 'healthy'
        WHEN COALESCE(SUM(inc.sla_breaches), 0) > 5
          OR COALESCE(SUM(chg.failed_count), 0) > 3
        THEN 'critical'
        ELSE 'degraded'
    END as health_status
FROM dim_business_services bs
LEFT JOIN ci_business_service_mappings csm ON bs.service_id = csm.service_id
LEFT JOIN fact_business_service_incidents inc ON bs.service_id = inc.service_id
    AND inc.incident_date >= CURRENT_DATE - INTERVAL '30 days'
LEFT JOIN fact_business_service_changes chg ON bs.service_id = chg.service_id
    AND chg.change_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY bs.service_id, bs.name, bs.service_classification, bs.tbm_tower,
         bs.business_criticality, bs.operational_status;

-- View: TBM Tower Summary (001_complete_schema.sql)
CREATE VIEW v_tbm_tower_summary AS
SELECT
    tbm_tower,
    COUNT(*) as service_count,
    COUNT(CASE WHEN operational_status = 'active' THEN 1 END) as active_services,
    COUNT(CASE WHEN business_criticality = 'critical' THEN 1 END) as critical_services,
    COUNT(CASE WHEN business_criticality = 'high' THEN 1 END) as high_criticality_services
FROM dim_business_services
GROUP BY tbm_tower
ORDER BY service_count DESC;

GRANT SELECT ON v_business_service_health TO PUBLIC;
GRANT SELECT ON v_tbm_tower_summary TO PUBLIC;

COMMENT ON VIEW v_business_service_health IS 'Real-time business service health dashboard';
COMMENT ON VIEW v_tbm_tower_summary IS 'Summary statistics by TBM capability tower';

-- Lets the migrator apply 009 again on the next run.
DELETE FROM cmdb.schema_migrations
 WHERE migration_name = '009_business_service_views_org_scope.sql';

COMMIT;
