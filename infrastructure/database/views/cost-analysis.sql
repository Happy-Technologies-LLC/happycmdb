-- ============================================
-- HappyCMDB v3.0 - Cost Analysis Views for Metabase
-- ============================================
-- Optimized views for TBM cost allocation, unit economics, and financial reporting
-- ============================================

-- ----------------------------------------
-- v_executive_cost_summary
-- High-level cost summary by business capability and service
-- ----------------------------------------
CREATE OR REPLACE VIEW v_executive_cost_summary WITH (security_barrier) AS
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
    bs.updated_at,
    NULL::uuid AS organization_id
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
CREATE OR REPLACE VIEW v_cost_by_tower WITH (security_barrier) AS
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
        NULLIF((SELECT SUM(COALESCE((t.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) FROM cmdb.dim_ci t
                WHERE t.is_current = TRUE AND t.ci_status = 'active' AND t.organization_id = ci.organization_id), 0),
        2
    ) AS pct_of_total_cost,
    ci.organization_id
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
  AND COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) > 0
GROUP BY
    ci.tbm_attributes->>'resource_tower',
    ci.tbm_attributes->>'cost_pool',
    ci.ci_type,
    ci.environment,
    ci.organization_id
ORDER BY total_monthly_cost DESC;

COMMENT ON VIEW v_cost_by_tower IS 'TBM cost breakdown by resource tower and cost pool';

-- ----------------------------------------
-- v_cost_trends
-- Monthly cost trends over time from fact table
-- ----------------------------------------
CREATE OR REPLACE VIEW v_cost_trends WITH (security_barrier) AS
SELECT
    DATE_TRUNC('month', fc.changed_at) AS month,
    ci.tbm_attributes->>'resource_tower' AS tbm_resource_tower,
    ci.ci_type,
    ci.environment,
    SUM(COALESCE((fc.new_value)::DECIMAL, 0)) AS monthly_cost,
    COUNT(DISTINCT ci.ci_id) AS ci_count,
    ci.organization_id
FROM cmdb.fact_ci_changes fc
JOIN cmdb.dim_ci ci ON fc.ci_key = ci.ci_key
WHERE fc.field_name = 'monthly_cost'
  AND fc.changed_at >= NOW() - INTERVAL '12 months'
  AND ci.is_current = TRUE
GROUP BY
    DATE_TRUNC('month', fc.changed_at),
    ci.tbm_attributes->>'resource_tower',
    ci.ci_type,
    ci.environment,
    ci.organization_id
ORDER BY month DESC, monthly_cost DESC;

COMMENT ON VIEW v_cost_trends IS 'Monthly cost trends over time by tower and CI type';

-- ----------------------------------------
-- v_unit_economics
-- Unit economics by business service
-- ----------------------------------------
CREATE OR REPLACE VIEW v_unit_economics WITH (security_barrier) AS
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
    bs.updated_at,
    NULL::uuid AS organization_id
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY revenue_ratio DESC;

COMMENT ON VIEW v_unit_economics IS 'Unit economics by business service with cost per transaction and customer';

-- ----------------------------------------
-- v_cloud_vs_onprem_costs
-- Cloud vs on-premises cost comparison
-- ----------------------------------------
CREATE OR REPLACE VIEW v_cloud_vs_onprem_costs WITH (security_barrier) AS
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
        NULLIF((SELECT SUM(COALESCE((t.tbm_attributes->>'monthly_cost')::DECIMAL, 0)) FROM cmdb.dim_ci t
                WHERE t.is_current = TRUE AND t.organization_id = ci.organization_id), 0),
        2
    ) AS pct_of_total,
    ci.organization_id
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
  AND ci.tbm_attributes->>'cost_pool' IS NOT NULL
GROUP BY
    ci.tbm_attributes->>'cost_pool',
    ci.environment,
    ci.ci_type,
    ci.organization_id
ORDER BY monthly_cost DESC;

COMMENT ON VIEW v_cloud_vs_onprem_costs IS 'Cloud vs on-premises cost comparison';

-- ----------------------------------------
-- v_cost_allocation_summary
-- Cost allocation summary by cost center and business unit
-- ----------------------------------------
CREATE OR REPLACE VIEW v_cost_allocation_summary WITH (security_barrier) AS
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
    cp.is_active,
    NULL::uuid AS organization_id
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
CREATE OR REPLACE VIEW v_depreciation_summary WITH (security_barrier) AS
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
    ds.is_active,
    NULL::uuid AS organization_id
FROM tbm_depreciation_schedules ds
LEFT JOIN cmdb.dim_ci ci ON ds.ci_id = ci.ci_id AND ci.is_current = TRUE
WHERE ds.is_active = TRUE
ORDER BY ds.current_book_value DESC;

COMMENT ON VIEW v_depreciation_summary IS 'Asset depreciation summary with remaining life and book value';

-- ----------------------------------------
-- v_top_cost_drivers
-- Top 20 cost drivers across all CIs
-- Carries ci.metadata (unbounded, secret-capable JSONB): NEVER granted to metabase_readonly and never on a BI
-- allowlist. BI reads v_top_cost_drivers_bi below. HAP-659.
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

COMMENT ON VIEW v_top_cost_drivers IS 'Top 20 configuration items by monthly cost (includes ci.metadata; not for BI)';

-- ----------------------------------------
-- v_top_cost_drivers_bi
-- HAP-659: the BI-readable top cost drivers: v_top_cost_drivers without ci.metadata. A new name, so no database
-- that ever held the metadata shape of v_top_cost_drivers has this view in that shape.
-- ----------------------------------------
CREATE OR REPLACE VIEW v_top_cost_drivers_bi WITH (security_barrier) AS
SELECT
    r.ci_id,
    r.ci_name,
    r.ci_type,
    r.environment,
    r.tbm_resource_tower,
    r.tbm_cost_pool,
    r.monthly_cost,
    r.annual_cost,
    r.business_criticality,
    r.updated_at,
    r.organization_id
FROM (
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
        ci.updated_at,
        ci.organization_id,
        -- Top 20 per organization: a row filter on organization_id (BI data sandboxing) must still leave 20 rows.
        row_number() OVER (
            PARTITION BY ci.organization_id
            ORDER BY COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) DESC
        ) AS cost_rank
    FROM cmdb.dim_ci ci
    WHERE ci.is_current = TRUE
      AND ci.ci_status = 'active'
      AND COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) > 0
) r
WHERE r.cost_rank <= 20
ORDER BY r.monthly_cost DESC;

COMMENT ON VIEW v_top_cost_drivers_bi IS 'Top 20 configuration items per organization by monthly cost, without ci.metadata (BI-readable)';

-- ----------------------------------------
-- v_underutilized_resources
-- HAP-659: rightsizing candidates (<50% utilization). Only the numeric
-- utilization_pct scalar is lifted out of ci.metadata; the JSONB itself is never
-- selected, and a non-numeric value yields NULL (row excluded) instead of a cast error.
-- The seven unbounded cost views above and this one are WITH (security_barrier): BI-supplied predicates cannot be
-- pushed below the view's WHERE. (CREATE OR REPLACE VIEW without the option would reset it.) Migration 051.
-- ----------------------------------------
CREATE OR REPLACE VIEW v_underutilized_resources WITH (security_barrier) AS
SELECT
    u.ci_id,
    u.ci_name,
    u.ci_type,
    u.environment,
    u.monthly_cost,
    u.utilization_pct,
    u.monthly_cost * (1 - u.utilization_pct / 100) AS potential_savings,
    u.organization_id
FROM (
    SELECT
        ci.ci_id,
        ci.ci_name,
        ci.ci_type,
        ci.environment,
        COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) AS monthly_cost,
        CASE WHEN ci.metadata->>'utilization_pct' ~ '^[0-9]+(\.[0-9]+)?$'
            THEN (ci.metadata->>'utilization_pct')::DECIMAL
        END AS utilization_pct,
        ci.organization_id
    FROM cmdb.dim_ci ci
    WHERE ci.is_current = TRUE
      AND ci.ci_status = 'active'
) u
WHERE u.utilization_pct < 50
  AND u.monthly_cost > 0;

COMMENT ON VIEW v_underutilized_resources IS 'Active CIs under 50% utilization with monthly cost and potential savings';

-- Grant SELECT permissions to metabase_readonly
GRANT SELECT ON v_executive_cost_summary TO metabase_readonly;
GRANT SELECT ON v_cost_by_tower TO metabase_readonly;
GRANT SELECT ON v_cost_trends TO metabase_readonly;
GRANT SELECT ON v_unit_economics TO metabase_readonly;
GRANT SELECT ON v_cloud_vs_onprem_costs TO metabase_readonly;
GRANT SELECT ON v_cost_allocation_summary TO metabase_readonly;
GRANT SELECT ON v_depreciation_summary TO metabase_readonly;
-- v_top_cost_drivers exposes unbounded ci.metadata; do not allow BI to read it.

-- HAP-659: the per-CI views BI may read are granted by SHAPE, not only by name. This file runs without
-- ON_ERROR_STOP (setup-metabase.sh, documented psql commands), so a failed CREATE can leave a view of this name in
-- an older shape. A view gets no grant, and loses one, when it is not a view, is not owned by the migration role
-- (the owner of cmdb.dim_ci), has a column named metadata, or carries json/jsonb in any column, including through a
-- domain, array or composite type. Migration 051 applies the same rule after a restore.
DO $bi$
DECLARE
    name text;
    rel regclass;
    expected_owner oid := (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass('cmdb.dim_ci'));
    unsafe boolean;
BEGIN
    FOREACH name IN ARRAY ARRAY['v_top_cost_drivers_bi', 'v_underutilized_resources'] LOOP
        rel := to_regclass(name);
        CONTINUE WHEN rel IS NULL;
        SELECT NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = rel AND c.relkind = 'v'
                           AND c.relowner IS NOT DISTINCT FROM expected_owner)
            OR EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
                         AND lower(a.attname) = 'metadata')
            OR EXISTS (
              WITH RECURSIVE ty(oid) AS (
                SELECT a.atttypid FROM pg_attribute a
                WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
                UNION
                SELECT n.oid
                FROM ty
                  JOIN pg_type t ON t.oid = ty.oid
                  CROSS JOIN LATERAL (
                    SELECT t.typbasetype WHERE t.typtype = 'd'
                    UNION ALL
                    SELECT t.typelem WHERE t.typcategory = 'A'
                    UNION ALL
                    SELECT f.atttypid FROM pg_attribute f
                    WHERE t.typtype = 'c' AND f.attrelid = t.typrelid AND f.attnum > 0 AND NOT f.attisdropped
                  ) n(oid)
              )
              SELECT 1 FROM ty WHERE ty.oid IN ('json'::regtype, 'jsonb'::regtype))
          INTO unsafe;
        IF unsafe THEN
            RAISE WARNING 'HAP-659: % is not a view owned by the owner of cmdb.dim_ci, or carries json/jsonb or a metadata column; not granting it to metabase_readonly', rel;
            EXECUTE format('REVOKE ALL ON %s FROM metabase_readonly', rel);
        ELSE
            EXECUTE format('GRANT SELECT ON %s TO metabase_readonly', rel);
        END IF;
    END LOOP;
END
$bi$;
