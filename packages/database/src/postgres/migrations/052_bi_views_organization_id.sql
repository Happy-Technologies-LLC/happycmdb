-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- cmdb#318 security review follow-up (cm-fu-bi-tenant-scope). Every view on the metabase_readonly allowlist
-- (metabase-init.sql) reads cmdb.dim_ci and other tables across ALL organizations and exposed no tenant column, so
-- Metabase could not row-filter by tenant. This migration appends `organization_id uuid` as the LAST column of each
-- of the 37 allowlisted views (CREATE OR REPLACE VIEW can append a column but not reorder one, so existing
-- columns, grants and comments are unchanged). The views stay SELECT-only, and the BI shape guard is untouched:
-- uuid is not json/jsonb and the column is not named metadata.
--
-- What organization_id means per view:
--   * Tenant-attributed (16 views): the value of the source row's organization_id (cmdb.dim_ci, itil_incidents,
--     itil_changes, itil_baselines, audit_log). Aggregate views gain it in GROUP BY, so each row is one tenant's;
--     the per-total subqueries of v_cost_by_tower / v_cloud_vs_onprem_costs and the CI counts of
--     v_baseline_drift_detection are scoped to the same tenant; v_top_cost_drivers_bi keeps the top 20 PER tenant
--     (a single global LIMIT 20 would leave a tenant filter fewer than 20 rows, usually none).
--     audit_log and the ITIL tables hold legacy rows with a NULL organization_id: those rows have no tenant.
--   * Not tenant-attributable (21 views): the sources (business_services, application_services,
--     business_capabilities, service_dependencies, tbm_cost_pools, tbm_depreciation_schedules) are the v3.0 legacy
--     tables and carry no organization_id, and cmdb.dim_ci.ci_id is not unique across organizations, so a join on it
--     cannot attribute a row. These views expose `NULL::uuid AS organization_id`: a row filter
--     `organization_id = <tenant>` matches nothing (fail closed). The column is attribution for staff, not an access
--     control: Metabase is an internal tool and tenant-facing BI is not supported. See infrastructure/metabase/README.md, Tenancy.
--
-- A view that does not exist is skipped (the BI view files are run by hand; setup-metabase.sh), so run the three
-- view files after this migration on a database that never had them; they carry the same definitions.
-- v_baseline_drift_detection could never be created from itil-analysis.sql (it cast jsonb to text[]); the view file
-- now builds the id and type lists with jsonb_array_elements_text, so the view appears when that file is run.
-- Reloptions (for example the security_barrier that 051 sets) are read before the redefinition and set
-- again afterwards, because CREATE OR REPLACE VIEW without WITH (...) resets them.
-- Run as the owner of the views. Additive, idempotent. Manual rollback: rollback/052_bi_views_organization_id.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

-- public.recent_audit_activity
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.recent_audit_activity') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.recent_audit_activity');
  EXECUTE $q$
CREATE OR REPLACE VIEW recent_audit_activity AS
SELECT
  id, entity_type, entity_id, action, actor, actor_type, timestamp,
  jsonb_array_length(changes) as change_count,
  organization_id
FROM audit_log
WHERE timestamp >= NOW() - INTERVAL '30 days'
ORDER BY timestamp DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.recent_audit_activity', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- cmdb.v_ci_discovery_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('cmdb.v_ci_discovery_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('cmdb.v_ci_discovery_summary');
  EXECUTE $q$
CREATE OR REPLACE VIEW cmdb.v_ci_discovery_summary AS
SELECT
    c.ci_id, c.ci_name, c.ci_type, f.discovery_provider,
    COUNT(*) AS discovery_count,
    MAX(f.discovered_at) AS last_discovered_at,
    AVG(f.confidence_score) AS avg_confidence_score,
    AVG(f.discovery_duration_ms) AS avg_discovery_duration_ms,
    c.organization_id
FROM cmdb.dim_ci c
INNER JOIN cmdb.fact_discovery f ON c.ci_key = f.ci_key
WHERE c.is_current = TRUE
GROUP BY c.ci_id, c.ci_name, c.ci_type, f.discovery_provider, c.organization_id
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'cmdb.v_ci_discovery_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_business_service_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_business_service_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_business_service_summary');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_business_service_summary AS
SELECT
  bs.id,
  bs.name,
  bs.description,
  bs.operational_status,
  bs.technical_owner,
  bs.platform_team,
  bs.itil_attributes->>'service_owner' AS service_owner,
  bs.itil_attributes->>'service_type' AS service_type,
  (bs.itil_attributes->>'availability_30d')::numeric AS availability_30d,
  (bs.itil_attributes->>'incident_count_30d')::integer AS incident_count_30d,
  (bs.tbm_attributes->>'total_monthly_cost')::numeric AS total_monthly_cost,
  bs.tbm_attributes->>'cost_trend' AS cost_trend,
  bs.bsm_attributes->>'business_criticality' AS business_criticality,
  (bs.bsm_attributes->>'business_impact_score')::integer AS business_impact_score,
  bs.bsm_attributes->>'risk_rating' AS risk_rating,
  (bs.bsm_attributes->>'annual_revenue_supported')::numeric AS annual_revenue_supported,
  bs.created_at,
  bs.last_validated,
  -- Count dependent services
  (SELECT COUNT(*) FROM service_dependencies sd
   WHERE sd.source_type = 'business_service' AND sd.source_id = bs.id) AS dependency_count,
  -- Count incidents
  (SELECT COUNT(*) FROM itil_incidents ii
   WHERE ii.affected_business_service_id = bs.id AND ii.status NOT IN ('closed', 'cancelled')) AS open_incident_count,
  NULL::uuid AS organization_id
FROM business_services bs
ORDER BY bs.created_at DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_business_service_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_application_service_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_application_service_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_application_service_summary');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_application_service_summary AS
SELECT
  app.id,
  app.name,
  app.description,
  app.tbm_attributes->>'solution_type' AS solution_type,
  (app.tbm_attributes->>'total_monthly_cost')::numeric AS total_monthly_cost,
  app.itil_attributes->>'service_type' AS service_type,
  app.itil_attributes->>'service_owner' AS service_owner,
  app.itil_attributes->>'lifecycle_stage' AS lifecycle_stage,
  app.itil_attributes->>'release_version' AS release_version,
  app.application_attributes->>'application_type' AS application_type,
  app.application_attributes->>'deployment_model' AS deployment_model,
  app.application_attributes->>'architecture_pattern' AS architecture_pattern,
  app.business_value_score,
  (app.quality_metrics->>'availability_percentage')::numeric AS availability_percentage,
  (app.quality_metrics->>'test_coverage_percentage')::numeric AS test_coverage_percentage,
  app.created_at,
  -- Count supporting infrastructure
  (SELECT COUNT(*) FROM service_dependencies sd
   WHERE sd.source_type = 'application_service' AND sd.source_id = app.id
     AND sd.target_type = 'configuration_item') AS infrastructure_count,
  -- Count supported business services
  (SELECT COUNT(*) FROM service_dependencies sd
   WHERE sd.target_type = 'application_service' AND sd.target_id = app.id
     AND sd.source_type = 'business_service') AS business_service_count,
  NULL::uuid AS organization_id
FROM application_services app
ORDER BY app.business_value_score DESC, app.created_at DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_application_service_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_business_capability_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_business_capability_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_business_capability_summary');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_business_capability_summary AS
SELECT
  bc.id,
  bc.name,
  bc.description,
  bc.tbm_attributes->>'business_unit' AS business_unit,
  (bc.tbm_attributes->>'total_monthly_cost')::numeric AS total_monthly_cost,
  (bc.tbm_attributes->>'cost_per_employee')::numeric AS cost_per_employee,
  (bc.tbm_attributes->>'budget_annual')::numeric AS budget_annual,
  (bc.tbm_attributes->>'variance_percentage')::numeric AS variance_percentage,
  bc.capability_attributes->>'capability_type' AS capability_type,
  bc.capability_attributes->>'strategic_importance' AS strategic_importance,
  bc.capability_attributes->>'maturity_level' AS maturity_level,
  bc.capability_attributes->>'lifecycle_stage' AS lifecycle_stage,
  bc.capability_attributes->>'capability_owner' AS capability_owner,
  (bc.value_attributes->'revenue_impact'->>'annual_revenue_supported')::numeric AS annual_revenue_supported,
  (bc.value_attributes->>'customer_facing')::boolean AS customer_facing,
  bc.created_at,
  -- Count supported business services
  (SELECT COUNT(*) FROM service_dependencies sd
   WHERE sd.source_type = 'business_capability' AND sd.source_id = bc.id) AS business_service_count,
  NULL::uuid AS organization_id
FROM business_capabilities bc
ORDER BY (bc.tbm_attributes->>'total_monthly_cost')::numeric DESC, bc.created_at DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_business_capability_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_service_dependency_graph
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_service_dependency_graph') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_service_dependency_graph');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_service_dependency_graph AS
SELECT
  sd.id,
  sd.source_type,
  sd.source_id,
  sd.target_type,
  sd.target_id,
  sd.dependency_type,
  sd.dependency_strength,
  sd.is_critical,
  sd.discovered_at,
  sd.last_verified_at,
  -- Source entity name (polymorphic lookup)
  CASE
    WHEN sd.source_type = 'business_capability' THEN (SELECT name FROM business_capabilities WHERE id = sd.source_id)
    WHEN sd.source_type = 'business_service' THEN (SELECT name FROM business_services WHERE id = sd.source_id)
    WHEN sd.source_type = 'application_service' THEN (SELECT name FROM application_services WHERE id = sd.source_id)
    ELSE NULL
  END AS source_name,
  -- Target entity name (polymorphic lookup)
  CASE
    WHEN sd.target_type = 'business_capability' THEN (SELECT name FROM business_capabilities WHERE id = sd.target_id)
    WHEN sd.target_type = 'business_service' THEN (SELECT name FROM business_services WHERE id = sd.target_id)
    WHEN sd.target_type = 'application_service' THEN (SELECT name FROM application_services WHERE id = sd.target_id)
    ELSE NULL
  END AS target_name,
  NULL::uuid AS organization_id
FROM service_dependencies sd
ORDER BY sd.is_critical DESC, sd.dependency_strength DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_service_dependency_graph', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_itil_incident_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_itil_incident_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_itil_incident_summary');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_itil_incident_summary AS
SELECT
  i.id,
  i.incident_number,
  i.title,
  i.category,
  i.impact,
  i.urgency,
  i.priority,
  i.status,
  i.affected_ci_id,
  i.affected_business_service_id,
  i.affected_application_service_id,
  (i.business_impact->>'estimated_user_impact')::integer AS estimated_user_impact,
  (i.business_impact->>'estimated_revenue_impact')::numeric AS estimated_revenue_impact,
  (i.business_impact->>'estimated_cost_of_downtime')::numeric AS estimated_cost_of_downtime,
  i.assigned_to,
  i.assigned_group,
  i.reported_at,
  i.acknowledged_at,
  i.resolved_at,
  i.time_to_acknowledge_minutes,
  i.time_to_resolve_minutes,
  i.reported_by,
  -- Business service name
  (SELECT name FROM business_services WHERE id = i.affected_business_service_id) AS business_service_name,
  -- Application service name
  (SELECT name FROM application_services WHERE id = i.affected_application_service_id) AS application_service_name,
  i.organization_id
FROM itil_incidents i
ORDER BY i.priority, i.reported_at DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_itil_incident_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_itil_change_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_itil_change_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_itil_change_summary');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_itil_change_summary AS
SELECT
  c.id,
  c.change_number,
  c.title,
  c.change_type,
  c.status,
  c.approval_status,
  (c.risk_assessment->>'risk_level') AS risk_level,
  (c.risk_assessment->>'overall_risk_score')::integer AS overall_risk_score,
  (c.risk_assessment->>'requires_cab_approval')::boolean AS requires_cab_approval,
  (c.business_impact->>'estimated_downtime_minutes')::integer AS estimated_downtime_minutes,
  (c.business_impact->>'customer_impact')::boolean AS customer_impact,
  (c.business_impact->>'revenue_at_risk')::numeric AS revenue_at_risk,
  (c.financial_impact->>'implementation_cost')::numeric AS implementation_cost,
  (c.financial_impact->>'total_cost')::numeric AS total_cost,
  c.assigned_to,
  c.assigned_group,
  c.scheduled_start,
  c.scheduled_end,
  c.outcome,
  c.requested_by,
  array_length(c.affected_ci_ids, 1) AS affected_ci_count,
  array_length(c.affected_business_service_ids, 1) AS affected_business_service_count,
  array_length(c.affected_application_service_ids, 1) AS affected_application_service_count,
  c.organization_id
FROM itil_changes c
ORDER BY c.scheduled_start DESC, c.created_at DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_itil_change_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_tbm_cost_pool_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_tbm_cost_pool_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_tbm_cost_pool_summary');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_tbm_cost_pool_summary AS
SELECT
  cp.id,
  cp.name,
  cp.description,
  cp.cost_pool_type,
  cp.monthly_budget,
  cp.annual_budget,
  cp.cost_center,
  cp.business_unit,
  cp.owner,
  cp.is_active,
  cp.allocation_rules->>'allocation_method' AS allocation_method,
  cp.allocation_rules->>'allocation_frequency' AS allocation_frequency,
  array_length(cp.gl_account_codes, 1) AS gl_account_count,
  cp.created_at,
  -- Count GL mappings
  (SELECT COUNT(*) FROM tbm_gl_mappings WHERE entity_type = 'cost_pool' AND entity_id = cp.id AND is_active = TRUE) AS active_gl_mapping_count,
  NULL::uuid AS organization_id
FROM tbm_cost_pools cp
ORDER BY cp.annual_budget DESC, cp.created_at DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_tbm_cost_pool_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_tbm_depreciation_tracking
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_tbm_depreciation_tracking') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_tbm_depreciation_tracking');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_tbm_depreciation_tracking AS
SELECT
  ds.id,
  ds.ci_id,
  ds.ci_name,
  ds.purchase_date,
  ds.purchase_cost,
  ds.useful_life_months,
  ds.residual_value,
  ds.depreciation_method,
  ds.monthly_depreciation,
  ds.accumulated_depreciation,
  ds.current_book_value,
  ds.is_active,
  ds.fully_depreciated,
  ds.fully_depreciated_at,
  -- Calculate remaining life
  CASE
    WHEN ds.fully_depreciated THEN 0
    ELSE GREATEST(0, ds.useful_life_months - EXTRACT(MONTH FROM AGE(CURRENT_DATE, ds.purchase_date))::integer)
  END AS remaining_life_months,
  -- Calculate depreciation percentage
  CASE
    WHEN ds.purchase_cost > 0 THEN ROUND((ds.accumulated_depreciation / ds.purchase_cost * 100)::numeric, 2)
    ELSE 0
  END AS depreciation_percentage,
  NULL::uuid AS organization_id
FROM tbm_depreciation_schedules ds
ORDER BY ds.current_book_value DESC, ds.purchase_date DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_tbm_depreciation_tracking', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_unified_service_health
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_unified_service_health') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_unified_service_health');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_unified_service_health AS
SELECT
  bs.id AS service_id,
  bs.name AS service_name,
  'business_service' AS service_type,
  -- ITIL metrics
  (bs.itil_attributes->>'availability_30d')::numeric AS availability_30d,
  (bs.itil_attributes->>'incident_count_30d')::integer AS incident_count_30d,
  -- TBM metrics
  (bs.tbm_attributes->>'total_monthly_cost')::numeric AS total_monthly_cost,
  bs.tbm_attributes->>'cost_trend' AS cost_trend,
  -- BSM metrics
  bs.bsm_attributes->>'business_criticality' AS business_criticality,
  (bs.bsm_attributes->>'business_impact_score')::integer AS business_impact_score,
  bs.bsm_attributes->>'risk_rating' AS risk_rating,
  -- Operational status
  bs.operational_status,
  bs.technical_owner,
  -- Calculated health score (simple weighted average)
  ROUND((
    COALESCE((bs.itil_attributes->>'availability_30d')::numeric, 0) * 0.4 +
    COALESCE((100 - LEAST((bs.itil_attributes->>'incident_count_30d')::integer, 100)), 0) * 0.3 +
    COALESCE((bs.bsm_attributes->>'business_impact_score')::integer, 0) * 0.3
  )::numeric, 2) AS health_score,
  NULL::uuid AS organization_id
FROM business_services bs
WHERE bs.operational_status NOT IN ('outage', 'maintenance')
ORDER BY health_score DESC, service_name
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_unified_service_health', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_criticality_distribution
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_criticality_distribution') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_criticality_distribution');
  EXECUTE $q$
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
    ) AS pct_customer_facing,
    ci.organization_id
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
GROUP BY
    ci.bsm_attributes->>'business_criticality',
    ci.ci_type,
    ci.environment,
    ci.organization_id
ORDER BY
    CASE ci.bsm_attributes->>'business_criticality'
        WHEN 'tier_1' THEN 1
        WHEN 'tier_2' THEN 2
        WHEN 'tier_3' THEN 3
        WHEN 'tier_4' THEN 4
        ELSE 5
    END,
    ci_count DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_criticality_distribution', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_revenue_at_risk
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_revenue_at_risk') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_revenue_at_risk');
  EXECUTE $q$
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
    MAX(i.reported_at) AS latest_incident_at,
    NULL::uuid AS organization_id
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
ORDER BY total_revenue_at_risk DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_revenue_at_risk', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_compliance_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_compliance_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_compliance_summary');
  EXECUTE $q$
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
    SUM(CASE WHEN bs.bsm_attributes->>'business_criticality' IN ('tier_1', 'tier_2') THEN 1 ELSE 0 END) AS critical_services,
    NULL::uuid AS organization_id
FROM business_services bs
CROSS JOIN LATERAL jsonb_array_elements_text(bs.bsm_attributes->'compliance_requirements') AS compliance_framework
GROUP BY compliance_framework
ORDER BY compliance_rate ASC, service_count DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_compliance_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_sox_pci_inventory
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_sox_pci_inventory') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_sox_pci_inventory');
  EXECUTE $q$
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
    bs.last_validated,
    NULL::uuid AS organization_id
FROM business_services bs
WHERE (bs.bsm_attributes->>'sox_scope')::BOOLEAN = TRUE
   OR (bs.bsm_attributes->>'pci_scope')::BOOLEAN = TRUE
ORDER BY
    COALESCE((bs.bsm_attributes->>'sox_scope')::BOOLEAN, FALSE) DESC,
    COALESCE((bs.bsm_attributes->>'pci_scope')::BOOLEAN, FALSE) DESC,
    annual_revenue_supported DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_sox_pci_inventory', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_disaster_recovery_tiers
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_disaster_recovery_tiers') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_disaster_recovery_tiers');
  EXECUTE $q$
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
    SUM(COALESCE((bs.bsm_attributes->>'transaction_volume_daily')::INTEGER, 0)) AS total_daily_transactions,
    NULL::uuid AS organization_id
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
    END
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_disaster_recovery_tiers', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_business_capability_health
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_business_capability_health') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_business_capability_health');
  EXECUTE $q$
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
    bc.tbm_attributes->>'business_unit' AS business_unit,
    NULL::uuid AS organization_id
FROM business_capabilities bc
ORDER BY strategic_importance, monthly_cost DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_business_capability_health', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_service_dependency_map
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_service_dependency_map') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_service_dependency_map');
  EXECUTE $q$
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
    sd.last_verified_at,
    NULL::uuid AS organization_id
FROM service_dependencies sd
ORDER BY sd.is_critical DESC, sd.dependency_strength DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_service_dependency_map', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_customer_impact_analysis
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_customer_impact_analysis') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_customer_impact_analysis');
  EXECUTE $q$
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
    bs.technical_owner,
    NULL::uuid AS organization_id
FROM business_services bs
WHERE COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) > 0
ORDER BY customer_impact_score ASC, customer_count DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_customer_impact_analysis', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_executive_cost_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_executive_cost_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_executive_cost_summary');
  EXECUTE $q$
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
    bs.updated_at,
    NULL::uuid AS organization_id
FROM business_services bs
LEFT JOIN service_dependencies sd ON sd.source_id = bs.id AND sd.source_type = 'business_service' AND sd.dependency_type = 'ENABLED_BY'
LEFT JOIN business_capabilities bc ON bc.id = sd.target_id AND sd.target_type = 'business_capability'
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY annual_cost DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_executive_cost_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cost_by_tower
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_cost_by_tower') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cost_by_tower');
  EXECUTE $q$
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
ORDER BY total_monthly_cost DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cost_by_tower', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cost_trends
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_cost_trends') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cost_trends');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_cost_trends AS
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
ORDER BY month DESC, monthly_cost DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cost_trends', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_unit_economics
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_unit_economics') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_unit_economics');
  EXECUTE $q$
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
    bs.updated_at,
    NULL::uuid AS organization_id
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY revenue_ratio DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_unit_economics', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cloud_vs_onprem_costs
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_cloud_vs_onprem_costs') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cloud_vs_onprem_costs');
  EXECUTE $q$
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
ORDER BY monthly_cost DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cloud_vs_onprem_costs', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cost_allocation_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_cost_allocation_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cost_allocation_summary');
  EXECUTE $q$
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
ORDER BY actual_monthly_cost DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cost_allocation_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_depreciation_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_depreciation_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_depreciation_summary');
  EXECUTE $q$
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
    ds.is_active,
    NULL::uuid AS organization_id
FROM tbm_depreciation_schedules ds
LEFT JOIN cmdb.dim_ci ci ON ds.ci_id = ci.ci_id AND ci.is_current = TRUE
WHERE ds.is_active = TRUE
ORDER BY ds.current_book_value DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_depreciation_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_top_cost_drivers_bi
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_top_cost_drivers_bi') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_top_cost_drivers_bi');
  EXECUTE $q$
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
        -- Top 20 per organization: filtering on organization_id must still leave up to 20 rows per tenant.
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
ORDER BY r.monthly_cost DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_top_cost_drivers_bi IS 'Top 20 configuration items per organization by monthly cost, without ci.metadata (BI-readable)'
$c$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_top_cost_drivers_bi', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_underutilized_resources
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_underutilized_resources') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_underutilized_resources');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_underutilized_resources AS
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
  AND u.monthly_cost > 0
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_underutilized_resources', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_incident_summary
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_incident_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_incident_summary');
  EXECUTE $q$
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
    MAX(i.reported_at) AS last_incident_date,
    i.organization_id
FROM itil_incidents i
WHERE i.reported_at >= NOW() - INTERVAL '90 days'
GROUP BY
    i.priority,
    i.status,
    i.impact,
    i.urgency,
    i.category,
    i.organization_id
ORDER BY i.priority, incident_count DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_incident_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_incident_trends
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_incident_trends') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_incident_trends');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_incident_trends AS
SELECT
    DATE_TRUNC('month', i.reported_at) AS month,
    i.priority,
    i.status,
    i.category,
    COUNT(*) AS incident_count,
    COUNT(DISTINCT i.affected_business_service_id) AS affected_services_count,
    AVG(i.time_to_resolve_minutes) AS avg_resolution_minutes,
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_impact,
    i.organization_id
FROM itil_incidents i
WHERE i.reported_at >= NOW() - INTERVAL '12 months'
GROUP BY
    DATE_TRUNC('month', i.reported_at),
    i.priority,
    i.status,
    i.category,
    i.organization_id
ORDER BY month DESC, incident_count DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_incident_trends', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_change_success_rates
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_change_success_rates') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_change_success_rates');
  EXECUTE $q$
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
    SUM(COALESCE((c.financial_impact->>'total_cost')::DECIMAL, 0)) AS total_financial_impact,
    c.organization_id
FROM itil_changes c
WHERE c.scheduled_start >= NOW() - INTERVAL '12 months'
  AND c.status = 'closed'
GROUP BY
    DATE_TRUNC('month', c.scheduled_start),
    c.change_type,
    c.category,
    c.organization_id
ORDER BY month DESC, total_changes DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_change_success_rates', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_change_calendar
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_change_calendar') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_change_calendar');
  EXECUTE $q$
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
    c.created_at,
    c.organization_id
FROM itil_changes c
WHERE c.scheduled_start >= CURRENT_DATE
  AND c.status IN ('approved', 'scheduled')
ORDER BY c.scheduled_start ASC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_change_calendar', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_configuration_accuracy
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_configuration_accuracy') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_configuration_accuracy');
  EXECUTE $q$
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
    AVG(EXTRACT(EPOCH FROM (NOW() - ci.created_at)) / 86400) AS avg_age_days,
    ci.organization_id
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
GROUP BY
    ci.ci_type,
    ci.itil_attributes->>'ci_class',
    ci.itil_attributes->>'lifecycle_stage',
    ci.itil_attributes->>'audit_status',
    ci.environment,
    ci.organization_id
ORDER BY ci_count DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_configuration_accuracy', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_sla_compliance
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_sla_compliance') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_sla_compliance');
  EXECUTE $q$
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
    ) AS avg_resolution_minutes_30d,
    NULL::uuid AS organization_id
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY sla_met ASC, actual_availability_30d ASC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_sla_compliance', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_service_health_scorecard
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_service_health_scorecard') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_service_health_scorecard');
  EXECUTE $q$
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
    bs.updated_at,
    NULL::uuid AS organization_id
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY health_score ASC, business_criticality
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_service_health_scorecard', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_mttr_mtbf_analysis
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_mttr_mtbf_analysis') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_mttr_mtbf_analysis');
  EXECUTE $q$
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
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_impact,
    NULL::uuid AS organization_id
FROM business_services bs
LEFT JOIN itil_incidents i ON i.affected_business_service_id = bs.id
    AND i.reported_at >= NOW() - INTERVAL '90 days'
    AND i.status IN ('resolved', 'closed')
WHERE bs.operational_status IN ('operational', 'degraded')
GROUP BY bs.id, bs.name, bs.operational_status
HAVING COUNT(i.id) > 0
ORDER BY mttr_minutes DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_mttr_mtbf_analysis', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_baseline_drift_detection
DO $v$
DECLARE
  opts text[];
BEGIN
  IF to_regclass('public.v_baseline_drift_detection') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_baseline_drift_detection');
  EXECUTE $q$
CREATE OR REPLACE VIEW v_baseline_drift_detection AS
SELECT
    bl.name AS baseline_name,
    bl.baseline_type,
    bl.status AS baseline_status,
    bl.approved_at,
    -- Scope metrics
    COALESCE(ARRAY_LENGTH(sc.ci_ids, 1), 0) AS scoped_ci_count,
    -- CIs matching scope
    (
        SELECT COUNT(*)
        FROM cmdb.dim_ci ci
        WHERE ci.is_current = TRUE
          AND ci.organization_id = bl.organization_id
          AND (
              ci.ci_id = ANY(sc.ci_ids)
              OR ci.ci_type = ANY(sc.ci_types)
              OR (ci.environment = (bl.scope->>'environment') OR (bl.scope->>'environment') IS NULL)
          )
    ) AS matching_ci_count,
    -- Compliance status
    (
        SELECT COUNT(*)
        FROM cmdb.dim_ci ci
        WHERE ci.is_current = TRUE
          AND ci.organization_id = bl.organization_id
          AND ci.itil_attributes->>'audit_status' = 'compliant'
          AND (
              ci.ci_id = ANY(sc.ci_ids)
              OR ci.ci_type = ANY(sc.ci_types)
              OR (ci.environment = (bl.scope->>'environment') OR (bl.scope->>'environment') IS NULL)
          )
    ) AS compliant_ci_count,
    -- Approval details
    bl.created_by,
    bl.approved_by,
    bl.created_at,
    bl.updated_at,
    bl.organization_id
FROM itil_baselines bl
-- jsonb cannot be cast to text[]: lift the scope's id and type lists out as arrays (a missing or non-array key is empty).
CROSS JOIN LATERAL (
    SELECT
        ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(bl.scope->'ci_ids') = 'array'
            THEN bl.scope->'ci_ids' ELSE '[]'::jsonb END)) AS ci_ids,
        ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(bl.scope->'ci_types') = 'array'
            THEN bl.scope->'ci_types' ELSE '[]'::jsonb END)) AS ci_types
) sc
WHERE bl.status = 'approved'
ORDER BY bl.approved_at DESC
$q$;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_baseline_drift_detection', array_to_string(opts, ', '));
  END IF;
END
$v$;
