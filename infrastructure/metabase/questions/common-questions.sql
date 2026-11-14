-- ============================================
-- HappyCMDB v3.0 - Metabase Pre-Configured Questions
-- ============================================
-- Common SQL queries for ad-hoc analysis and reporting
-- These can be imported into Metabase as saved questions
-- ============================================

-- ============================================
-- COST ANALYSIS QUESTIONS
-- ============================================

-- Question 1: What are our top 10 cost drivers?
-- Description: Identify the configuration items consuming the most budget
-- Collection: Cost Analysis
SELECT
    ci_name,
    ci_type,
    tbm_resource_tower,
    environment,
    monthly_cost,
    monthly_cost * 12 AS annual_cost,
    business_criticality
FROM v_top_cost_drivers_bi
ORDER BY monthly_cost DESC
LIMIT 10;

-- Question 2: Which resources are underutilized (<50% utilization)?
-- Description: Find opportunities for cost optimization through rightsizing
-- Collection: Cost Optimization
SELECT
    ci_name,
    ci_type,
    environment,
    monthly_cost,
    utilization_pct,
    potential_savings
FROM v_underutilized_resources
ORDER BY potential_savings DESC
LIMIT 20;

-- Question 3: What is our month-over-month cost trend?
-- Description: Track cost changes over the past 12 months
-- Collection: Cost Analysis
SELECT
    month,
    tbm_resource_tower,
    SUM(monthly_cost) AS total_monthly_cost,
    LAG(SUM(monthly_cost)) OVER (PARTITION BY tbm_resource_tower ORDER BY month) AS previous_month_cost,
    SUM(monthly_cost) - LAG(SUM(monthly_cost)) OVER (PARTITION BY tbm_resource_tower ORDER BY month) AS mom_change,
    ROUND(
        100.0 * (SUM(monthly_cost) - LAG(SUM(monthly_cost)) OVER (PARTITION BY tbm_resource_tower ORDER BY month)) /
        NULLIF(LAG(SUM(monthly_cost)) OVER (PARTITION BY tbm_resource_tower ORDER BY month), 0),
        2
    ) AS mom_change_pct
FROM v_cost_trends
WHERE month >= NOW() - INTERVAL '12 months'
GROUP BY month, tbm_resource_tower
ORDER BY month DESC, tbm_resource_tower;

-- Question 4: What is the cost per customer for each service?
-- Description: Calculate unit economics for customer-facing services
-- Collection: Unit Economics
SELECT
    business_service,
    customer_count,
    monthly_cost,
    cost_per_customer,
    business_criticality
FROM v_unit_economics
WHERE customer_count > 0
ORDER BY cost_per_customer DESC;

-- Question 5: Which cost centers are over budget?
-- Description: Identify cost centers exceeding their allocated budget
-- Collection: Budget Management
SELECT
    cost_center,
    business_unit,
    cost_pool_name,
    monthly_budget,
    actual_monthly_cost,
    monthly_variance,
    variance_pct
FROM v_cost_allocation_summary
WHERE monthly_variance < 0  -- Negative variance means over budget
ORDER BY ABS(variance_pct) DESC;

-- ============================================
-- INCIDENT MANAGEMENT QUESTIONS
-- ============================================

-- Question 6: Which business services have the most incidents?
-- Description: Identify services requiring attention based on incident frequency
-- (resolved or closed incidents, last 90 days)
-- Collection: Service Health
SELECT
    business_service_name AS business_service,
    operational_status,
    total_incidents_90d AS incident_count,
    total_revenue_impact,
    mttr_minutes AS avg_resolution_minutes
FROM v_mttr_mtbf_analysis
ORDER BY incident_count DESC
LIMIT 10;

-- Question 7: What is our incident resolution performance by priority?
-- Description: Measure incident response SLAs (resolved or closed, last 90 days).
-- Averages are incident-weighted across the view's groups; the view has no
-- per-incident rows, so the max replaces the former p95.
-- Collection: ITIL Metrics
SELECT
    priority,
    SUM(incident_count) AS total_incidents,
    ROUND(
        SUM(avg_acknowledgment_minutes * incident_count) /
            NULLIF(SUM(incident_count) FILTER (WHERE avg_acknowledgment_minutes IS NOT NULL), 0),
        2
    ) AS avg_acknowledgment_minutes,
    ROUND(
        SUM(avg_resolution_minutes * incident_count) /
            NULLIF(SUM(incident_count) FILTER (WHERE avg_resolution_minutes IS NOT NULL), 0),
        2
    ) AS avg_resolution_minutes,
    MAX(max_resolution_minutes) AS max_resolution_minutes,
    SUM(total_revenue_impact) AS total_revenue_impact
FROM v_incident_summary
WHERE status IN ('resolved', 'closed')
GROUP BY priority
ORDER BY priority;

-- Question 8: Which business services are missing their availability SLA?
-- Description: Services whose 30-day availability is below target. A per-incident
-- breach list needs raw itil_incidents rows, which the BI role cannot read.
-- Collection: SLA Management
SELECT
    business_service_name,
    operational_status,
    sla_target_availability,
    actual_availability_30d,
    incident_count_30d,
    recent_incident_count,
    avg_resolution_minutes_30d,
    technical_owner
FROM v_sla_compliance
WHERE sla_met = FALSE
ORDER BY actual_availability_30d ASC;

-- ============================================
-- CHANGE MANAGEMENT QUESTIONS
-- ============================================

-- Question 9: What is our change success rate?
-- Description: Track change management effectiveness (last 6 calendar months, monthly buckets)
-- Collection: Change Management
SELECT
    change_type,
    SUM(total_changes) AS total_changes,
    SUM(successful_changes) AS successful,
    SUM(failed_changes) AS failed,
    SUM(rolled_back_changes) AS rolled_back,
    ROUND(
        100.0 * SUM(successful_changes) / NULLIF(SUM(total_changes), 0),
        2
    ) AS success_rate
FROM v_change_success_rates
WHERE month >= DATE_TRUNC('month', NOW() - INTERVAL '6 months')
GROUP BY change_type
ORDER BY total_changes DESC;

-- Question 10: What changes are scheduled for this week?
-- Description: View upcoming change window
-- Collection: Change Management
SELECT
    change_number,
    title,
    change_type,
    scheduled_start,
    scheduled_end,
    EXTRACT(EPOCH FROM (scheduled_end - scheduled_start)) / 60 AS duration_minutes,
    risk_level,
    customer_impact,
    estimated_downtime_minutes,
    affected_service_count,
    assigned_to,
    status
FROM v_change_calendar
WHERE scheduled_start BETWEEN DATE_TRUNC('week', CURRENT_DATE)
                          AND DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
ORDER BY scheduled_start;

-- ============================================
-- COMPLIANCE & RISK QUESTIONS
-- ============================================

-- Question 11: Which services are in SOX or PCI scope?
-- Description: Audit compliance scope inventory
-- Collection: Compliance
SELECT
    business_service_name,
    sox_scope,
    pci_scope,
    data_sensitivity,
    business_criticality,
    annual_revenue_supported,
    technical_owner,
    compliant_ci_count,
    total_ci_count,
    ROUND(100.0 * compliant_ci_count / NULLIF(total_ci_count, 0), 2) AS ci_compliance_rate
FROM v_sox_pci_inventory
ORDER BY annual_revenue_supported DESC;

-- Question 12: What is our compliance status by framework?
-- Description: Overall compliance health across regulatory frameworks
-- Collection: Compliance
SELECT
    compliance_framework,
    service_count,
    compliant_services,
    non_compliant_services,
    in_review_services,
    compliance_rate,
    critical_services,
    total_monthly_cost,
    total_revenue_supported
FROM v_compliance_summary
ORDER BY compliance_rate ASC, service_count DESC;

-- ============================================
-- BUSINESS IMPACT QUESTIONS
-- ============================================

-- Question 13: What revenue is at risk right now?
-- Description: Calculate immediate revenue impact from open incidents
-- Collection: Business Impact
SELECT
    business_service,
    business_criticality,
    operational_status,
    open_incidents,
    annual_revenue,
    total_revenue_at_risk,
    pct_revenue_at_risk,
    total_users_impacted,
    highest_priority
FROM v_revenue_at_risk
ORDER BY total_revenue_at_risk DESC;

-- Question 14: Which services need immediate attention?
-- Description: Identify critical services with degraded health
-- Collection: Service Health
SELECT
    business_service_name,
    operational_status,
    health_score,
    business_criticality,
    availability_30d,
    incident_count_30d,
    monthly_cost,
    service_owner,
    technical_owner
FROM v_service_health_scorecard
WHERE business_criticality IN ('tier_1', 'tier_2')
  AND health_score < 70
ORDER BY health_score ASC;

-- Question 15: What are our disaster recovery tier allocations?
-- Description: Validate DR strategy alignment with business criticality
-- Collection: Risk Management
SELECT
    dr_tier,
    business_criticality,
    service_count,
    avg_rto_minutes,
    avg_rpo_minutes,
    total_revenue_supported,
    total_customers,
    total_daily_transactions
FROM v_disaster_recovery_tiers
ORDER BY dr_tier;

-- ============================================
-- USAGE NOTES
-- ============================================
-- To use these questions in Metabase:
-- 1. Navigate to the SQL question editor
-- 2. Copy and paste the desired query
-- 3. Save the question to the appropriate collection
-- 4. Optionally add to a dashboard
--
-- Parameter Support:
-- Many of these queries can be enhanced with Metabase parameters:
-- - Date ranges (e.g., {{date_range}})
-- - Environment filters (e.g., {{environment}})
-- - Business criticality (e.g., {{criticality}})
-- ============================================
