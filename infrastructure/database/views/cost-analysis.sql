-- ============================================
-- HappyCMDB v3.0 - Cost Analysis Views for Metabase
-- ============================================
-- Optimized views for TBM cost allocation, unit economics, and financial reporting
-- ============================================

-- ----------------------------------------
-- v_executive_cost_summary
-- High-level cost summary by business capability and service
-- ----------------------------------------
CREATE OR REPLACE VIEW v_executive_cost_summary AS
SELECT
    bc.name AS business_capability,
    bs.name AS business_service,
    bs.id AS business_service_id,
    -- Extract cost from TBM attributes
    COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) AS monthly_cost,
    COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) * 12 AS annual_cost,
    -- Extract business metrics from BSM attributes
    COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) AS annual_revenue_supported,
    COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) AS customer_count,
    COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0) AS daily_transaction_volume,
    -- Calculate unit economics
    CASE
        WHEN COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) > 0
        THEN COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) / (bs.bsm_attributes->>'customer_count')::INTEGER
        ELSE 0
    END AS cost_per_customer,
    CASE
        WHEN COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0) > 0
        THEN COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) / ((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER * 30)
        ELSE 0
    END AS cost_per_transaction,
    -- Extract business criticality
    bs.bsm_attributes->>'business_criticality' AS business_criticality,
    bs.operational_status,
    bs.technical_owner,
    bs.updated_at
FROM business_services bs
LEFT JOIN service_dependencies sd ON sd.source_id = bs.id AND sd.source_type = 'business_service' AND sd.dependency_type = 'ENABLED_BY'
LEFT JOIN business_capabilities bc ON bc.id = sd.target_id AND sd.target_type = 'business_capability'
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY annual_cost DESC;

COMMENT ON VIEW v_executive_cost_summary IS 'Executive cost summary by business capability and service with unit economics';

-- ----------------------------------------
-- v_cost_by_tower
-- TBM cost breakdown by resource tower and cost pool
-- ----------------------------------------
CREATE OR REPLACE VIEW v_cost_by_tower AS
SELECT
    ci.tbm_attributes->>'resource_tower' AS tbm_resource_tower,
    ci.tbm_attributes->>'cost_pool' AS tbm_cost_pool,
    ci.ci_type,
    ci.environment,
    COUNT(*) AS ci_count,
    SUM(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS total_monthly_cost,
    AVG(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS avg_monthly_cost,
    MIN(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS min_monthly_cost,
    MAX(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS max_monthly_cost,
    -- Calculate percentage of total cost
    ROUND(
        100.0 * SUM(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) /
        NULLIF((SELECT SUM(COALESCE((tbm_attributes->>'monthly_cost')::DECIMAL, 0)) FROM cmdb.dim_ci WHERE is_current = TRUE AND ci_status = 'active'), 0),
        2
    ) AS pct_of_total_cost
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
  AND COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) > 0
GROUP BY
    ci.tbm_attributes->>'resource_tower',
    ci.tbm_attributes->>'cost_pool',
    ci.ci_type,
    ci.environment
ORDER BY total_monthly_cost DESC;

COMMENT ON VIEW v_cost_by_tower IS 'TBM cost breakdown by resource tower and cost pool';

-- ----------------------------------------
-- v_cost_trends
-- Monthly cost trends over time from fact table
-- ----------------------------------------
CREATE OR REPLACE VIEW v_cost_trends AS
SELECT
    DATE_TRUNC('month', fc.changed_at) AS month,
    ci.tbm_attributes->>'resource_tower' AS tbm_resource_tower,
    ci.ci_type,
    ci.environment,
    SUM(COALESCE((fc.new_value)::DECIMAL, 0)) AS monthly_cost,
    COUNT(DISTINCT ci.ci_id) AS ci_count
FROM cmdb.fact_ci_changes fc
JOIN cmdb.dim_ci ci ON fc.ci_key = ci.ci_key
WHERE fc.field_name = 'monthly_cost'
  AND fc.changed_at >= NOW() - INTERVAL '12 months'
  AND ci.is_current = TRUE
GROUP BY
    DATE_TRUNC('month', fc.changed_at),
    ci.tbm_attributes->>'resource_tower',
    ci.ci_type,
    ci.environment
ORDER BY month DESC, monthly_cost DESC;

COMMENT ON VIEW v_cost_trends IS 'Monthly cost trends over time by tower and CI type';

-- ----------------------------------------
-- v_unit_economics
-- Unit economics by business service
-- ----------------------------------------
CREATE OR REPLACE VIEW v_unit_economics AS
SELECT
    bs.name AS business_service,
    bs.id AS business_service_id,
    bs.operational_status,
    -- Financial metrics
    COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) AS monthly_cost,
    COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) AS annual_revenue,
    -- Volume metrics
    COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) AS customer_count,
    COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0) AS daily_transaction_volume,
    COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0) * 30 AS monthly_transaction_volume,
    -- Unit economics calculations
    CASE WHEN COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0) > 0
        THEN COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) /
             (COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0) * 30)
        ELSE 0
    END AS cost_per_transaction,
    CASE WHEN COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) > 0
        THEN COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) /
             COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0)
        ELSE 0
    END AS cost_per_customer,
    -- Revenue efficiency
    CASE WHEN COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) > 0
        THEN (COALESCE((bs.bsm_attributes->>'annual_revenue_supported')::DECIMAL, 0) / 12) /
             COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0)
        ELSE 0
    END AS revenue_ratio,
    -- Cost breakdown
    bs.tbm_attributes->'cost_breakdown_by_tower' AS cost_breakdown,
    bs.tbm_attributes->>'cost_trend' AS cost_trend,
    -- Business context
    bs.bsm_attributes->>'business_criticality' AS business_criticality,
    bs.technical_owner,
    bs.updated_at
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY revenue_ratio DESC;

COMMENT ON VIEW v_unit_economics IS 'Unit economics by business service with cost per transaction and customer';

-- ----------------------------------------
-- v_cloud_vs_onprem_costs
-- Cloud vs on-premises cost comparison
-- ----------------------------------------
CREATE OR REPLACE VIEW v_cloud_vs_onprem_costs AS
SELECT
    ci.tbm_attributes->>'cost_pool' AS deployment_model,
    ci.environment,
    ci.ci_type,
    COUNT(*) AS ci_count,
    SUM(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS monthly_cost,
    SUM(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) * 12) AS annual_cost,
    AVG(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) AS avg_cost_per_ci,
    -- Calculate percentage of total
    ROUND(
        100.0 * SUM(COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) /
        NULLIF((SELECT SUM(COALESCE((tbm_attributes->>'monthly_cost')::DECIMAL, 0)) FROM cmdb.dim_ci WHERE is_current = TRUE), 0),
        2
    ) AS pct_of_total
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
  AND ci.tbm_attributes->>'cost_pool' IS NOT NULL
GROUP BY
    ci.tbm_attributes->>'cost_pool',
    ci.environment,
    ci.ci_type
ORDER BY monthly_cost DESC;

COMMENT ON VIEW v_cloud_vs_onprem_costs IS 'Cloud vs on-premises cost comparison';

-- ----------------------------------------
-- v_cost_allocation_summary
-- Cost allocation summary by cost center and business unit
-- ----------------------------------------
CREATE OR REPLACE VIEW v_cost_allocation_summary AS
SELECT
    cp.cost_center,
    cp.business_unit,
    cp.name AS cost_pool_name,
    cp.cost_pool_type,
    cp.monthly_budget,
    cp.annual_budget,
    -- Actual costs (would be calculated from actual CI allocations)
    COALESCE(SUM((ci.tbm_attributes->>'monthly_cost')::DECIMAL), 0) AS actual_monthly_cost,
    cp.monthly_budget - COALESCE(SUM((ci.tbm_attributes->>'monthly_cost')::DECIMAL), 0) AS monthly_variance,
    -- Calculate variance percentage
    CASE WHEN cp.monthly_budget > 0
        THEN ROUND(
            100.0 * (cp.monthly_budget - COALESCE(SUM((ci.tbm_attributes->>'monthly_cost')::DECIMAL), 0)) / cp.monthly_budget,
            2
        )
        ELSE 0
    END AS variance_pct,
    cp.owner AS cost_pool_owner,
    cp.is_active
FROM tbm_cost_pools cp
LEFT JOIN cmdb.dim_ci ci ON
    ci.tbm_attributes->>'cost_pool' = cp.name AND
    ci.is_current = TRUE AND
    ci.ci_status = 'active'
WHERE cp.is_active = TRUE
GROUP BY
    cp.id,
    cp.cost_center,
    cp.business_unit,
    cp.name,
    cp.cost_pool_type,
    cp.monthly_budget,
    cp.annual_budget,
    cp.owner,
    cp.is_active
ORDER BY actual_monthly_cost DESC;

COMMENT ON VIEW v_cost_allocation_summary IS 'Cost allocation summary with budget variance by cost center';

-- ----------------------------------------
-- v_depreciation_summary
-- Asset depreciation summary
-- ----------------------------------------
CREATE OR REPLACE VIEW v_depreciation_summary AS
SELECT
    ds.ci_id,
    ds.ci_name,
    ci.ci_type,
    ci.environment,
    ds.purchase_date,
    ds.purchase_cost,
    ds.useful_life_months,
    ds.depreciation_method,
    ds.monthly_depreciation,
    ds.accumulated_depreciation,
    ds.current_book_value,
    -- Calculate remaining life
    ds.useful_life_months - EXTRACT(MONTH FROM AGE(CURRENT_DATE, ds.purchase_date))::INTEGER AS remaining_months,
    -- Calculate depreciation percentage
    ROUND(100.0 * ds.accumulated_depreciation / NULLIF(ds.purchase_cost, 0), 2) AS depreciation_pct,
    ds.fully_depreciated,
    ds.fully_depreciated_at,
    ds.is_active
FROM tbm_depreciation_schedules ds
LEFT JOIN cmdb.dim_ci ci ON ds.ci_id = ci.ci_id AND ci.is_current = TRUE
WHERE ds.is_active = TRUE
ORDER BY ds.current_book_value DESC;

COMMENT ON VIEW v_depreciation_summary IS 'Asset depreciation summary with remaining life and book value';

-- ----------------------------------------
-- v_top_cost_drivers
-- Top 20 cost drivers across all CIs
-- ----------------------------------------
CREATE OR REPLACE VIEW v_top_cost_drivers AS
SELECT
    ci.ci_id,
    ci.ci_name,
    ci.ci_type,
    ci.environment,
    ci.tbm_attributes->>'resource_tower' AS tbm_resource_tower,
    ci.tbm_attributes->>'cost_pool' AS tbm_cost_pool,
    COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) AS monthly_cost,
    COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) * 12 AS annual_cost,
    ci.bsm_attributes->>'business_criticality' AS business_criticality,
    ci.metadata,
    ci.updated_at
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
  AND COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) > 0
ORDER BY monthly_cost DESC
LIMIT 20;

COMMENT ON VIEW v_top_cost_drivers IS 'Top 20 configuration items by monthly cost';

-- Grant SELECT permissions to metabase_readonly
GRANT SELECT ON v_executive_cost_summary TO metabase_readonly;
GRANT SELECT ON v_cost_by_tower TO metabase_readonly;
GRANT SELECT ON v_cost_trends TO metabase_readonly;
GRANT SELECT ON v_unit_economics TO metabase_readonly;
GRANT SELECT ON v_cloud_vs_onprem_costs TO metabase_readonly;
GRANT SELECT ON v_cost_allocation_summary TO metabase_readonly;
GRANT SELECT ON v_depreciation_summary TO metabase_readonly;
GRANT SELECT ON v_top_cost_drivers TO metabase_readonly;
