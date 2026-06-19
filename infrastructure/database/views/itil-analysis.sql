-- ============================================
-- HappyCMDB v3.0 - ITIL Service Management Views for Metabase
-- ============================================
-- Optimized views for incident management, change management, and configuration accuracy
-- ============================================

-- ----------------------------------------
-- v_incident_summary
-- Incident summary by priority and status
-- ----------------------------------------
CREATE OR REPLACE VIEW v_incident_summary AS
SELECT
    i.priority,
    i.status,
    i.impact,
    i.urgency,
    i.category,
    COUNT(*) AS incident_count,
    -- Time to resolve metrics
    AVG(i.time_to_acknowledge_minutes) AS avg_acknowledgment_minutes,
    AVG(i.time_to_resolve_minutes) AS avg_resolution_minutes,
    MIN(i.time_to_resolve_minutes) AS min_resolution_minutes,
    MAX(i.time_to_resolve_minutes) AS max_resolution_minutes,
    -- Business impact metrics
    SUM(COALESCE((i.business_impact->>'estimated_user_impact')::INTEGER, 0)) AS total_users_impacted,
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_impact,
    SUM(COALESCE((i.business_impact->>'estimated_cost_of_downtime')::DECIMAL, 0)) AS total_downtime_cost,
    -- Date range
    MIN(i.reported_at) AS first_incident_date,
    MAX(i.reported_at) AS last_incident_date
FROM itil_incidents i
WHERE i.reported_at >= NOW() - INTERVAL '90 days'
GROUP BY
    i.priority,
    i.status,
    i.impact,
    i.urgency,
    i.category
ORDER BY i.priority, incident_count DESC;

COMMENT ON VIEW v_incident_summary IS 'Incident summary by priority and status with business impact (90 days)';

-- ----------------------------------------
-- v_incident_trends
-- Monthly incident trends
-- ----------------------------------------
CREATE OR REPLACE VIEW v_incident_trends AS
SELECT
    DATE_TRUNC('month', i.reported_at) AS month,
    i.priority,
    i.status,
    i.category,
    COUNT(*) AS incident_count,
    COUNT(DISTINCT i.affected_business_service_id) AS affected_services_count,
    AVG(i.time_to_resolve_minutes) AS avg_resolution_minutes,
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_impact
FROM itil_incidents i
WHERE i.reported_at >= NOW() - INTERVAL '12 months'
GROUP BY
    DATE_TRUNC('month', i.reported_at),
    i.priority,
    i.status,
    i.category
ORDER BY month DESC, incident_count DESC;

COMMENT ON VIEW v_incident_trends IS 'Monthly incident trends by priority and category (12 months)';

-- ----------------------------------------
-- v_change_success_rates
-- Change success rates by type
-- ----------------------------------------
CREATE OR REPLACE VIEW v_change_success_rates AS
SELECT
    DATE_TRUNC('month', c.scheduled_start) AS month,
    c.change_type,
    c.category,
    COUNT(*) AS total_changes,
    -- Success/failure counts
    SUM(CASE WHEN c.outcome = 'successful' THEN 1 ELSE 0 END) AS successful_changes,
    SUM(CASE WHEN c.outcome = 'successful_with_issues' THEN 1 ELSE 0 END) AS successful_with_issues,
    SUM(CASE WHEN c.outcome = 'failed' THEN 1 ELSE 0 END) AS failed_changes,
    SUM(CASE WHEN c.outcome = 'backed_out' THEN 1 ELSE 0 END) AS rolled_back_changes,
    -- Success rate calculation
    ROUND(
        100.0 * SUM(CASE WHEN c.outcome = 'successful' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
        2
    ) AS success_rate,
    -- Risk assessment
    AVG(COALESCE((c.risk_assessment->>'overall_risk_score')::DECIMAL, 0)) AS avg_risk_score,
    -- Business impact
    SUM(COALESCE((c.business_impact->>'estimated_downtime_minutes')::INTEGER, 0)) AS total_downtime_minutes,
    SUM(COALESCE((c.financial_impact->>'total_cost')::DECIMAL, 0)) AS total_financial_impact
FROM itil_changes c
WHERE c.scheduled_start >= NOW() - INTERVAL '12 months'
  AND c.status = 'closed'
GROUP BY
    DATE_TRUNC('month', c.scheduled_start),
    c.change_type,
    c.category
ORDER BY month DESC, total_changes DESC;

COMMENT ON VIEW v_change_success_rates IS 'Change success rates by type with risk and business impact (12 months)';

-- ----------------------------------------
-- v_change_calendar
-- Upcoming scheduled changes
-- ----------------------------------------
CREATE OR REPLACE VIEW v_change_calendar AS
SELECT
    c.change_number,
    c.title,
    c.change_type,
    c.category,
    c.status,
    c.approval_status,
    c.scheduled_start,
    c.scheduled_end,
    EXTRACT(EPOCH FROM (c.scheduled_end - c.scheduled_start)) / 60 AS scheduled_duration_minutes,
    -- Risk and impact
    c.risk_assessment->>'risk_level' AS risk_level,
    c.risk_assessment->>'requires_cab_approval' AS requires_cab_approval,
    c.business_impact->>'customer_impact' AS customer_impact,
    COALESCE((c.business_impact->>'estimated_downtime_minutes')::INTEGER, 0) AS estimated_downtime_minutes,
    -- Affected entities
    ARRAY_LENGTH(c.affected_ci_ids, 1) AS affected_ci_count,
    ARRAY_LENGTH(c.affected_business_service_ids, 1) AS affected_service_count,
    -- Assignment
    c.assigned_to,
    c.assigned_group,
    c.requested_by,
    c.created_at
FROM itil_changes c
WHERE c.scheduled_start >= CURRENT_DATE
  AND c.status IN ('approved', 'scheduled')
ORDER BY c.scheduled_start ASC;

COMMENT ON VIEW v_change_calendar IS 'Upcoming scheduled changes with risk and impact assessment';

-- ----------------------------------------
-- v_configuration_accuracy
-- Configuration item accuracy and audit compliance
-- ----------------------------------------
CREATE OR REPLACE VIEW v_configuration_accuracy AS
SELECT
    ci.ci_type,
    ci.itil_attributes->>'ci_class' AS itil_ci_class,
    ci.itil_attributes->>'lifecycle_stage' AS itil_lifecycle_stage,
    ci.itil_attributes->>'audit_status' AS itil_audit_status,
    ci.environment,
    COUNT(*) AS ci_count,
    -- Audit compliance
    SUM(CASE WHEN ci.itil_attributes->>'audit_status' = 'compliant' THEN 1 ELSE 0 END) AS compliant_count,
    SUM(CASE WHEN ci.itil_attributes->>'audit_status' = 'non_compliant' THEN 1 ELSE 0 END) AS non_compliant_count,
    SUM(CASE WHEN ci.itil_attributes->>'audit_status' = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
    -- Compliance rate
    ROUND(
        100.0 * SUM(CASE WHEN ci.itil_attributes->>'audit_status' = 'compliant' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
        2
    ) AS compliance_rate,
    -- Last audit information
    MAX((ci.itil_attributes->>'last_audited')::TIMESTAMPTZ) AS last_audit_date,
    -- Average CI age
    AVG(EXTRACT(EPOCH FROM (NOW() - ci.created_at)) / 86400) AS avg_age_days
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
GROUP BY
    ci.ci_type,
    ci.itil_attributes->>'ci_class',
    ci.itil_attributes->>'lifecycle_stage',
    ci.itil_attributes->>'audit_status',
    ci.environment
ORDER BY ci_count DESC;

COMMENT ON VIEW v_configuration_accuracy IS 'Configuration item accuracy and audit compliance by type and lifecycle';

-- ----------------------------------------
-- v_sla_compliance
-- SLA compliance by business service
-- ----------------------------------------
CREATE OR REPLACE VIEW v_sla_compliance AS
SELECT
    bs.id AS business_service_id,
    bs.name AS business_service_name,
    bs.operational_status,
    -- SLA targets from ITIL attributes
    bs.itil_attributes->'sla_targets'->>'availability_percentage' AS sla_target_availability,
    bs.itil_attributes->'sla_targets'->>'response_time_ms' AS sla_target_response_time,
    -- Incident metrics
    COALESCE((bs.itil_attributes->>'incident_count_30d')::INTEGER, 0) AS incident_count_30d,
    COALESCE((bs.itil_attributes->>'availability_30d')::DECIMAL, 100.0) AS actual_availability_30d,
    -- Calculate SLA breach
    CASE
        WHEN COALESCE((bs.itil_attributes->>'availability_30d')::DECIMAL, 100.0) >=
             COALESCE((bs.itil_attributes->'sla_targets'->>'availability_percentage')::DECIMAL, 99.9)
        THEN TRUE
        ELSE FALSE
    END AS sla_met,
    -- Service support details
    bs.itil_attributes->>'service_owner' AS service_owner,
    bs.itil_attributes->>'support_level' AS support_level,
    bs.technical_owner,
    -- Related incidents (last 30 days)
    (
        SELECT COUNT(*)
        FROM itil_incidents i
        WHERE i.affected_business_service_id = bs.id
          AND i.reported_at >= NOW() - INTERVAL '30 days'
    ) AS recent_incident_count,
    (
        SELECT AVG(time_to_resolve_minutes)
        FROM itil_incidents i
        WHERE i.affected_business_service_id = bs.id
          AND i.reported_at >= NOW() - INTERVAL '30 days'
          AND i.resolved_at IS NOT NULL
    ) AS avg_resolution_minutes_30d
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY sla_met ASC, actual_availability_30d ASC;

COMMENT ON VIEW v_sla_compliance IS 'SLA compliance by business service with availability and incident metrics';

-- ----------------------------------------
-- v_service_health_scorecard
-- Comprehensive service health metrics
-- ----------------------------------------
CREATE OR REPLACE VIEW v_service_health_scorecard AS
SELECT
    bs.id AS business_service_id,
    bs.name AS business_service_name,
    bs.operational_status,
    -- ITIL metrics
    COALESCE((bs.itil_attributes->>'incident_count_30d')::INTEGER, 0) AS incident_count_30d,
    COALESCE((bs.itil_attributes->>'change_count_30d')::INTEGER, 0) AS change_count_30d,
    COALESCE((bs.itil_attributes->>'availability_30d')::DECIMAL, 100.0) AS availability_30d,
    -- Calculate health score (0-100)
    ROUND(
        (
            -- Availability component (50% weight)
            (COALESCE((bs.itil_attributes->>'availability_30d')::DECIMAL, 100.0) * 0.5) +
            -- Incident component (30% weight, inverted)
            (GREATEST(0, 100 - COALESCE((bs.itil_attributes->>'incident_count_30d')::INTEGER, 0) * 10) * 0.3) +
            -- Change success component (20% weight)
            (CASE WHEN COALESCE((bs.itil_attributes->>'change_count_30d')::INTEGER, 0) > 0
                THEN 80.0  -- Assume 80% success rate if changes exist
                ELSE 100.0
            END * 0.2)
        ),
        2
    ) AS health_score,
    -- Business context
    bs.bsm_attributes->>'business_criticality' AS business_criticality,
    COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) AS monthly_cost,
    -- Support details
    bs.technical_owner,
    bs.itil_attributes->>'service_owner' AS service_owner,
    bs.updated_at
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY health_score ASC, business_criticality;

COMMENT ON VIEW v_service_health_scorecard IS 'Comprehensive service health scorecard with calculated health scores';

-- ----------------------------------------
-- v_mttr_mtbf_analysis
-- Mean Time To Repair (MTTR) and Mean Time Between Failures (MTBF) analysis
-- ----------------------------------------
CREATE OR REPLACE VIEW v_mttr_mtbf_analysis AS
SELECT
    bs.id AS business_service_id,
    bs.name AS business_service_name,
    bs.operational_status,
    -- Incident counts
    COUNT(i.id) AS total_incidents_90d,
    COUNT(DISTINCT DATE(i.reported_at)) AS days_with_incidents,
    -- MTTR (Mean Time To Repair) in minutes
    AVG(i.time_to_resolve_minutes) AS mttr_minutes,
    ROUND(AVG(i.time_to_resolve_minutes) / 60.0, 2) AS mttr_hours,
    -- MTBF (Mean Time Between Failures) in hours
    CASE
        WHEN COUNT(i.id) > 1
        THEN ROUND(
            EXTRACT(EPOCH FROM (MAX(i.reported_at) - MIN(i.reported_at))) / 3600.0 / (COUNT(i.id) - 1),
            2
        )
        ELSE NULL
    END AS mtbf_hours,
    -- Reliability metrics
    ROUND(100.0 * (90 - COUNT(DISTINCT DATE(i.reported_at))) / 90.0, 2) AS availability_pct,
    -- Impact metrics
    SUM(COALESCE((i.business_impact->>'estimated_user_impact')::INTEGER, 0)) AS total_users_impacted,
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_impact
FROM business_services bs
LEFT JOIN itil_incidents i ON i.affected_business_service_id = bs.id
    AND i.reported_at >= NOW() - INTERVAL '90 days'
    AND i.status IN ('resolved', 'closed')
WHERE bs.operational_status IN ('operational', 'degraded')
GROUP BY bs.id, bs.name, bs.operational_status
HAVING COUNT(i.id) > 0
ORDER BY mttr_minutes DESC;

COMMENT ON VIEW v_mttr_mtbf_analysis IS 'MTTR and MTBF analysis by business service (90 days)';

-- ----------------------------------------
-- v_baseline_drift_detection
-- Configuration baseline drift detection
-- ----------------------------------------
CREATE OR REPLACE VIEW v_baseline_drift_detection AS
SELECT
    bl.name AS baseline_name,
    bl.baseline_type,
    bl.status AS baseline_status,
    bl.approved_at,
    -- Scope metrics
    COALESCE(ARRAY_LENGTH((bl.scope->'ci_ids')::TEXT[], 1), 0) AS scoped_ci_count,
    -- CIs matching scope
    (
        SELECT COUNT(*)
        FROM cmdb.dim_ci ci
        WHERE ci.is_current = TRUE
          AND (
              ci.ci_id = ANY((bl.scope->'ci_ids')::TEXT[])
              OR ci.ci_type = ANY((bl.scope->'ci_types')::TEXT[])
              OR (ci.environment = (bl.scope->>'environment') OR (bl.scope->>'environment') IS NULL)
          )
    ) AS matching_ci_count,
    -- Compliance status
    (
        SELECT COUNT(*)
        FROM cmdb.dim_ci ci
        WHERE ci.is_current = TRUE
          AND ci.itil_attributes->>'audit_status' = 'compliant'
          AND (
              ci.ci_id = ANY((bl.scope->'ci_ids')::TEXT[])
              OR ci.ci_type = ANY((bl.scope->'ci_types')::TEXT[])
              OR (ci.environment = (bl.scope->>'environment') OR (bl.scope->>'environment') IS NULL)
          )
    ) AS compliant_ci_count,
    -- Approval details
    bl.created_by,
    bl.approved_by,
    bl.created_at,
    bl.updated_at
FROM itil_baselines bl
WHERE bl.status = 'approved'
ORDER BY bl.approved_at DESC;

COMMENT ON VIEW v_baseline_drift_detection IS 'Configuration baseline drift detection with compliance metrics';

-- Grant SELECT permissions to metabase_readonly
GRANT SELECT ON v_incident_summary TO metabase_readonly;
GRANT SELECT ON v_incident_trends TO metabase_readonly;
GRANT SELECT ON v_change_success_rates TO metabase_readonly;
GRANT SELECT ON v_change_calendar TO metabase_readonly;
GRANT SELECT ON v_configuration_accuracy TO metabase_readonly;
GRANT SELECT ON v_sla_compliance TO metabase_readonly;
GRANT SELECT ON v_service_health_scorecard TO metabase_readonly;
GRANT SELECT ON v_mttr_mtbf_analysis TO metabase_readonly;
GRANT SELECT ON v_baseline_drift_detection TO metabase_readonly;
