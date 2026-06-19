-- ============================================
-- HappyCMDB v3.0 - Business Service Mapping (BSM) Views for Metabase
-- ============================================
-- Optimized views for business impact analysis, revenue at risk, and compliance
-- ============================================

-- ----------------------------------------
-- v_criticality_distribution
-- Distribution of CIs by business criticality
-- ----------------------------------------
CREATE OR REPLACE VIEW v_criticality_distribution AS
SELECT
    ci.bsm_attributes->>'business_criticality' AS bsm_business_criticality,
    ci.ci_type,
    ci.environment,
    COUNT(*) AS ci_count,
    -- Cost metrics
    SUM(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS total_monthly_cost,
    AVG(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS avg_monthly_cost,
    -- Revenue supported
    SUM(COALESCE((ci.bsm_attributes->>'revenue_supported')::DECIMAL, 0)) AS total_revenue_supported,
    -- Impact score
    AVG(COALESCE((ci.bsm_attributes->>'impact_score')::DECIMAL, 0)) AS avg_impact_score,
    -- Customer facing ratio
    ROUND(
        100.0 * SUM(CASE WHEN (ci.bsm_attributes->>'customer_facing')::BOOLEAN = TRUE THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
        2
    ) AS pct_customer_facing
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
GROUP BY
    ci.bsm_attributes->>'business_criticality',
    ci.ci_type,
    ci.environment
ORDER BY
    CASE ci.bsm_attributes->>'business_criticality'
        WHEN 'tier_1' THEN 1
        WHEN 'tier_2' THEN 2
        WHEN 'tier_3' THEN 3
        WHEN 'tier_4' THEN 4
        ELSE 5
    END,
    ci_count DESC;

COMMENT ON VIEW v_criticality_distribution IS 'Distribution of CIs by business criticality tier with cost and impact metrics';

-- ----------------------------------------
-- v_revenue_at_risk
-- Revenue at risk from open incidents
-- ----------------------------------------
CREATE OR REPLACE VIEW v_revenue_at_risk AS
SELECT
    bs.id AS business_service_id,
    bs.name AS business_service,
    bs.bsm_attributes->>'business_criticality' AS business_criticality,
    bs.operational_status,
    -- Revenue metrics
    COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) AS annual_revenue,
    COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) AS customer_count,
    -- Open incidents
    COUNT(i.id) AS open_incidents,
    -- Revenue at risk
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_at_risk,
    SUM(COALESCE((i.business_impact->>'estimated_cost_of_downtime')::DECIMAL, 0)) AS total_downtime_cost,
    SUM(COALESCE((i.business_impact->>'estimated_user_impact')::INTEGER, 0)) AS total_users_impacted,
    -- Calculate percentage of annual revenue at risk
    ROUND(
        100.0 * SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) /
        NULLIF(COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0), 0),
        2
    ) AS pct_revenue_at_risk,
    -- Incident details
    MAX(i.priority) AS highest_priority,
    MAX(i.reported_at) AS latest_incident_at
FROM business_services bs
LEFT JOIN itil_incidents i ON i.affected_business_service_id = bs.id
    AND i.status IN ('new', 'assigned', 'in_progress', 'pending')
WHERE COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) > 0
GROUP BY
    bs.id,
    bs.name,
    bs.bsm_attributes->>'business_criticality',
    bs.operational_status,
    bs.bsm_attributes->>'annual_revenue_supported',
    bs.bsm_attributes->>'customer_count'
HAVING COUNT(i.id) > 0
ORDER BY total_revenue_at_risk DESC;

COMMENT ON VIEW v_revenue_at_risk IS 'Revenue at risk analysis from open incidents affecting business services';

-- ----------------------------------------
-- v_compliance_summary
-- Compliance status summary by framework
-- ----------------------------------------
CREATE OR REPLACE VIEW v_compliance_summary AS
SELECT
    compliance_framework,
    COUNT(DISTINCT bs.id) AS service_count,
    -- Compliance status
    SUM(CASE WHEN bs.bsm_attributes->>'compliance_status' = 'compliant' THEN 1 ELSE 0 END) AS compliant_services,
    SUM(CASE WHEN bs.bsm_attributes->>'compliance_status' = 'non_compliant' THEN 1 ELSE 0 END) AS non_compliant_services,
    SUM(CASE WHEN bs.bsm_attributes->>'compliance_status' = 'in_review' THEN 1 ELSE 0 END) AS in_review_services,
    -- Compliance rate
    ROUND(
        100.0 * SUM(CASE WHEN bs.bsm_attributes->>'compliance_status' = 'compliant' THEN 1 ELSE 0 END) /
        NULLIF(COUNT(*), 0),
        2
    ) AS compliance_rate,
    -- Financial metrics
    SUM(COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0)) AS total_monthly_cost,
    SUM(COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0)) AS total_revenue_supported,
    -- Criticality
    SUM(CASE WHEN bs.bsm_attributes->>'business_criticality' IN ('tier_1', 'tier_2') THEN 1 ELSE 0 END) AS critical_services
FROM business_services bs
CROSS JOIN LATERAL jsonb_array_elements_text(bs.bsm_attributes->'compliance_requirements') AS compliance_framework
GROUP BY compliance_framework
ORDER BY compliance_rate ASC, service_count DESC;

COMMENT ON VIEW v_compliance_summary IS 'Compliance status summary by regulatory framework';

-- ----------------------------------------
-- v_sox_pci_inventory
-- SOX and PCI scope inventory
-- ----------------------------------------
CREATE OR REPLACE VIEW v_sox_pci_inventory AS
SELECT
    bs.id AS business_service_id,
    bs.name AS business_service_name,
    bs.operational_status,
    -- Compliance scope flags
    COALESCE((bs.bsm_attributes->>'sox_scope')::BOOLEAN, FALSE) AS sox_scope,
    COALESCE((bs.bsm_attributes->>'pci_scope')::BOOLEAN, FALSE) AS pci_scope,
    bs.bsm_attributes->>'data_sensitivity' AS data_sensitivity,
    -- Business context
    bs.bsm_attributes->>'business_criticality' AS business_criticality,
    COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) AS annual_revenue_supported,
    -- Technical details
    bs.technical_owner,
    bs.platform_team,
    COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) AS monthly_cost,
    -- Audit status
    (
        SELECT COUNT(*)
        FROM service_dependencies sd
        JOIN cmdb.dim_ci ci ON sd.target_id::TEXT = ci.ci_id
            AND sd.target_type = 'configuration_item'
            AND ci.is_current = TRUE
        WHERE sd.source_id = bs.id
          AND sd.source_type = 'business_service'
          AND ci.itil_attributes->>'audit_status' = 'compliant'
    ) AS compliant_ci_count,
    (
        SELECT COUNT(*)
        FROM service_dependencies sd
        JOIN cmdb.dim_ci ci ON sd.target_id::TEXT = ci.ci_id
            AND sd.target_type = 'configuration_item'
            AND ci.is_current = TRUE
        WHERE sd.source_id = bs.id
          AND sd.source_type = 'business_service'
    ) AS total_ci_count,
    -- Last validation
    bs.last_validated
FROM business_services bs
WHERE (bs.bsm_attributes->>'sox_scope')::BOOLEAN = TRUE
   OR (bs.bsm_attributes->>'pci_scope')::BOOLEAN = TRUE
ORDER BY
    COALESCE((bs.bsm_attributes->>'sox_scope')::BOOLEAN, FALSE) DESC,
    COALESCE((bs.bsm_attributes->>'pci_scope')::BOOLEAN, FALSE) DESC,
    annual_revenue_supported DESC;

COMMENT ON VIEW v_sox_pci_inventory IS 'SOX and PCI in-scope business services with compliance metrics';

-- ----------------------------------------
-- v_disaster_recovery_tiers
-- Disaster recovery tier analysis
-- ----------------------------------------
CREATE OR REPLACE VIEW v_disaster_recovery_tiers AS
SELECT
    bs.bsm_attributes->>'disaster_recovery_tier' AS dr_tier,
    bs.bsm_attributes->>'business_criticality' AS business_criticality,
    COUNT(*) AS service_count,
    -- RTO/RPO metrics
    AVG(COALESCE((bs.bsm_attributes->>'recovery_time_objective')::INTEGER, 0)) AS avg_rto_minutes,
    AVG(COALESCE((bs.bsm_attributes->>'recovery_point_objective')::INTEGER, 0)) AS avg_rpo_minutes,
    MIN(COALESCE((bs.bsm_attributes->>'recovery_time_objective')::INTEGER, 0)) AS min_rto_minutes,
    MAX(COALESCE((bs.bsm_attributes->>'recovery_time_objective')::INTEGER, 0)) AS max_rto_minutes,
    -- Financial metrics
    SUM(COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0)) AS total_monthly_cost,
    SUM(COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0)) AS total_revenue_supported,
    -- Customer impact
    SUM(COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0)) AS total_customers,
    SUM(COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0)) AS total_daily_transactions
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
GROUP BY
    bs.bsm_attributes->>'disaster_recovery_tier',
    bs.bsm_attributes->>'business_criticality'
ORDER BY
    CASE bs.bsm_attributes->>'disaster_recovery_tier'
        WHEN '1' THEN 1
        WHEN '2' THEN 2
        WHEN '3' THEN 3
        WHEN '4' THEN 4
        ELSE 5
    END;

COMMENT ON VIEW v_disaster_recovery_tiers IS 'Disaster recovery tier analysis with RTO/RPO metrics';

-- ----------------------------------------
-- v_business_capability_health
-- Business capability health scorecard
-- ----------------------------------------
CREATE OR REPLACE VIEW v_business_capability_health AS
SELECT
    bc.id AS capability_id,
    bc.name AS capability_name,
    bc.capability_attributes->>'capability_type' AS capability_type,
    bc.capability_attributes->>'strategic_importance' AS strategic_importance,
    bc.capability_attributes->>'maturity_level' AS maturity_level,
    bc.capability_attributes->>'lifecycle_stage' AS lifecycle_stage,
    -- Financial metrics
    COALESCE((bc.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) AS monthly_cost,
    COALESCE((bc.tbm_attributes->>'budget_annual')::DECIMAL, 0) AS annual_budget,
    COALESCE((bc.tbm_attributes->>'variance_percentage')::DECIMAL, 0) AS budget_variance_pct,
    -- Value metrics
    COALESCE((bc.value_attributes->'revenue_impact'->>'annual_revenue_supported')::DECIMAL, 0) AS annual_revenue_supported,
    COALESCE((bc.value_attributes->>'user_count')::INTEGER, 0) AS user_count,
    COALESCE((bc.value_attributes->>'customer_facing')::BOOLEAN, FALSE) AS customer_facing,
    -- Supporting services count
    (
        SELECT COUNT(DISTINCT bs.id)
        FROM business_services bs
        JOIN service_dependencies sd ON sd.source_id = bs.id
            AND sd.source_type = 'business_service'
            AND sd.target_id = bc.id
            AND sd.target_type = 'business_capability'
            AND sd.dependency_type = 'ENABLED_BY'
        WHERE bs.operational_status IN ('operational', 'degraded')
    ) AS supporting_service_count,
    -- Incident impact (last 30 days)
    (
        SELECT COUNT(i.id)
        FROM business_services bs
        JOIN service_dependencies sd ON sd.source_id = bs.id
            AND sd.source_type = 'business_service'
            AND sd.target_id = bc.id
            AND sd.target_type = 'business_capability'
        JOIN itil_incidents i ON i.affected_business_service_id = bs.id
        WHERE i.reported_at >= NOW() - INTERVAL '30 days'
    ) AS incidents_30d,
    -- Ownership
    bc.capability_attributes->>'capability_owner' AS capability_owner,
    bc.tbm_attributes->>'business_unit' AS business_unit
FROM business_capabilities bc
ORDER BY strategic_importance, monthly_cost DESC;

COMMENT ON VIEW v_business_capability_health IS 'Business capability health scorecard with financial and operational metrics';

-- ----------------------------------------
-- v_service_dependency_map
-- Service dependency relationships for impact analysis
-- ----------------------------------------
CREATE OR REPLACE VIEW v_service_dependency_map AS
SELECT
    sd.id AS dependency_id,
    sd.source_type,
    CASE
        WHEN sd.source_type = 'business_service' THEN (SELECT name FROM business_services WHERE id = sd.source_id)
        WHEN sd.source_type = 'application_service' THEN (SELECT name FROM application_services WHERE id = sd.source_id)
        WHEN sd.source_type = 'business_capability' THEN (SELECT name FROM business_capabilities WHERE id = sd.source_id)
        ELSE sd.source_id::TEXT
    END AS source_name,
    sd.target_type,
    CASE
        WHEN sd.target_type = 'business_service' THEN (SELECT name FROM business_services WHERE id = sd.target_id)
        WHEN sd.target_type = 'application_service' THEN (SELECT name FROM application_services WHERE id = sd.target_id)
        WHEN sd.target_type = 'business_capability' THEN (SELECT name FROM business_capabilities WHERE id = sd.target_id)
        WHEN sd.target_type = 'configuration_item' THEN (SELECT ci_name FROM cmdb.dim_ci WHERE ci_id = sd.target_id::TEXT AND is_current = TRUE LIMIT 1)
        ELSE sd.target_id::TEXT
    END AS target_name,
    sd.dependency_type,
    sd.dependency_strength,
    sd.is_critical,
    -- Add business context for impact analysis
    CASE
        WHEN sd.source_type = 'business_service' THEN
            (SELECT bsm_attributes->>'business_criticality' FROM business_services WHERE id = sd.source_id)
        ELSE NULL
    END AS source_criticality,
    CASE
        WHEN sd.target_type = 'business_service' THEN
            (SELECT bsm_attributes->>'business_criticality' FROM business_services WHERE id = sd.target_id)
        ELSE NULL
    END AS target_criticality,
    sd.discovered_at,
    sd.last_verified_at
FROM service_dependencies sd
ORDER BY sd.is_critical DESC, sd.dependency_strength DESC;

COMMENT ON VIEW v_service_dependency_map IS 'Service dependency relationship map for impact analysis';

-- ----------------------------------------
-- v_customer_impact_analysis
-- Customer-facing services with impact metrics
-- ----------------------------------------
CREATE OR REPLACE VIEW v_customer_impact_analysis AS
SELECT
    bs.id AS business_service_id,
    bs.name AS business_service_name,
    bs.operational_status,
    -- Customer metrics
    COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) AS customer_count,
    COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0) AS daily_transactions,
    COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) AS annual_revenue,
    -- Service quality
    COALESCE((bs.itil_attributes->>'availability_30d')::DECIMAL, 100.0) AS availability_30d,
    COALESCE((bs.itil_attributes->>'incident_count_30d')::INTEGER, 0) AS incident_count_30d,
    -- Calculate customer impact score (0-100)
    ROUND(
        (
            -- Availability weight (40%)
            (COALESCE((bs.itil_attributes->>'availability_30d')::DECIMAL, 100.0) * 0.4) +
            -- Incident impact weight (30%, inverted)
            (GREATEST(0, 100 - COALESCE((bs.itil_attributes->>'incident_count_30d')::INTEGER, 0) * 20) * 0.3) +
            -- Revenue/customer ratio weight (30%)
            (LEAST(100, COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) / NULLIF(COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0), 0) / 1000) * 0.3)
        ),
        2
    ) AS customer_impact_score,
    -- Cost per customer
    CASE WHEN COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) > 0
        THEN ROUND(COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) / (bs.bsm_attributes->>'customer_count')::INTEGER, 2)
        ELSE 0
    END AS cost_per_customer,
    -- Business criticality
    bs.bsm_attributes->>'business_criticality' AS business_criticality,
    bs.technical_owner
FROM business_services bs
WHERE COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) > 0
ORDER BY customer_impact_score ASC, customer_count DESC;

COMMENT ON VIEW v_customer_impact_analysis IS 'Customer-facing services with impact scores and cost per customer';

-- Grant SELECT permissions to metabase_readonly
GRANT SELECT ON v_criticality_distribution TO metabase_readonly;
GRANT SELECT ON v_revenue_at_risk TO metabase_readonly;
GRANT SELECT ON v_compliance_summary TO metabase_readonly;
GRANT SELECT ON v_sox_pci_inventory TO metabase_readonly;
GRANT SELECT ON v_disaster_recovery_tiers TO metabase_readonly;
GRANT SELECT ON v_business_capability_health TO metabase_readonly;
GRANT SELECT ON v_service_dependency_map TO metabase_readonly;
GRANT SELECT ON v_customer_impact_analysis TO metabase_readonly;
