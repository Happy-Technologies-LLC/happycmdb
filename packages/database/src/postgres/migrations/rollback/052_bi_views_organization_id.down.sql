-- Rollback for 052_bi_views_organization_id.sql. MANUAL ONLY; not authorized for any environment without a separate
-- named instruction. Not run by the migrator (it reads only *.sql directly inside migrations/).
--
-- Effect: each of the 37 BI views is dropped and recreated in its pre-052 shape (no organization_id column and, for
-- v_top_cost_drivers_bi, a single global LIMIT 20). A view cannot lose a column through CREATE OR REPLACE, hence the
-- drop. Its SELECT grants (metabase_readonly and every other reader), reloptions and comment are carried over. A Metabase
-- card or data sandbox that references organization_id breaks until 052 is applied again. Loses no data.
-- v_baseline_drift_detection is only dropped: its pre-052 definition (jsonb cast to text[]) could never be created.
-- A view that does not exist is skipped. Afterwards use the pre-052 versions of the three BI view files, or a
-- later run of the current ones fails with "cannot drop columns from view".
--
-- Run: psql -v ON_ERROR_STOP=1 -f 052_bi_views_organization_id.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

-- public.recent_audit_activity
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.recent_audit_activity') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.recent_audit_activity');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.recent_audit_activity') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.recent_audit_activity';
  EXECUTE $q$
CREATE OR REPLACE VIEW recent_audit_activity AS
SELECT
  id, entity_type, entity_id, action, actor, actor_type, timestamp,
  jsonb_array_length(changes) as change_count
FROM audit_log
WHERE timestamp >= NOW() - INTERVAL '30 days'
ORDER BY timestamp DESC
$q$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.recent_audit_activity TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.recent_audit_activity', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- cmdb.v_ci_discovery_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('cmdb.v_ci_discovery_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('cmdb.v_ci_discovery_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('cmdb.v_ci_discovery_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW cmdb.v_ci_discovery_summary';
  EXECUTE $q$
CREATE OR REPLACE VIEW cmdb.v_ci_discovery_summary AS
SELECT
    c.ci_id, c.ci_name, c.ci_type, f.discovery_provider,
    COUNT(*) AS discovery_count,
    MAX(f.discovered_at) AS last_discovered_at,
    AVG(f.confidence_score) AS avg_confidence_score,
    AVG(f.discovery_duration_ms) AS avg_discovery_duration_ms
FROM cmdb.dim_ci c
INNER JOIN cmdb.fact_discovery f ON c.ci_key = f.ci_key
WHERE c.is_current = TRUE
GROUP BY c.ci_id, c.ci_name, c.ci_type, f.discovery_provider
$q$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON cmdb.v_ci_discovery_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'cmdb.v_ci_discovery_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_business_service_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_business_service_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_business_service_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_business_service_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_business_service_summary';
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
   WHERE ii.affected_business_service_id = bs.id AND ii.status NOT IN ('closed', 'cancelled')) AS open_incident_count
FROM business_services bs
ORDER BY bs.created_at DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_business_service_summary IS 'v3.0 Business service summary with key metrics from ITIL, TBM, and BSM'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_business_service_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_business_service_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_application_service_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_application_service_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_application_service_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_application_service_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_application_service_summary';
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
     AND sd.source_type = 'business_service') AS business_service_count
FROM application_services app
ORDER BY app.business_value_score DESC, app.created_at DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_application_service_summary IS 'v3.0 Application service summary with TBM costs and ITIL lifecycle'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_application_service_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_application_service_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_business_capability_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_business_capability_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_business_capability_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_business_capability_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_business_capability_summary';
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
   WHERE sd.source_type = 'business_capability' AND sd.source_id = bc.id) AS business_service_count
FROM business_capabilities bc
ORDER BY (bc.tbm_attributes->>'total_monthly_cost')::numeric DESC, bc.created_at DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_business_capability_summary IS 'v3.0 Business capability summary with TBM cost allocation and value metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_business_capability_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_business_capability_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_service_dependency_graph
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_service_dependency_graph') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_service_dependency_graph');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_service_dependency_graph') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_service_dependency_graph';
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
  END AS target_name
FROM service_dependencies sd
ORDER BY sd.is_critical DESC, sd.dependency_strength DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_service_dependency_graph IS 'v3.0 Service dependency relationships with resolved entity names'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_service_dependency_graph TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_service_dependency_graph', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_itil_incident_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_itil_incident_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_itil_incident_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_itil_incident_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_itil_incident_summary';
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
  (SELECT name FROM application_services WHERE id = i.affected_application_service_id) AS application_service_name
FROM itil_incidents i
ORDER BY i.priority, i.reported_at DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_itil_incident_summary IS 'v3.0 ITIL incident summary with business impact metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_itil_incident_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_itil_incident_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_itil_change_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_itil_change_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_itil_change_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_itil_change_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_itil_change_summary';
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
  array_length(c.affected_application_service_ids, 1) AS affected_application_service_count
FROM itil_changes c
ORDER BY c.scheduled_start DESC, c.created_at DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_itil_change_summary IS 'v3.0 ITIL change summary with risk assessment and business impact'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_itil_change_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_itil_change_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_tbm_cost_pool_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_tbm_cost_pool_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_tbm_cost_pool_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_tbm_cost_pool_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_tbm_cost_pool_summary';
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
  (SELECT COUNT(*) FROM tbm_gl_mappings WHERE entity_type = 'cost_pool' AND entity_id = cp.id AND is_active = TRUE) AS active_gl_mapping_count
FROM tbm_cost_pools cp
ORDER BY cp.annual_budget DESC, cp.created_at DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_tbm_cost_pool_summary IS 'v3.0 TBM cost pool summary with budget tracking and GL mappings'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_tbm_cost_pool_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_tbm_cost_pool_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_tbm_depreciation_tracking
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_tbm_depreciation_tracking') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_tbm_depreciation_tracking');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_tbm_depreciation_tracking') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_tbm_depreciation_tracking';
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
  END AS depreciation_percentage
FROM tbm_depreciation_schedules ds
ORDER BY ds.current_book_value DESC, ds.purchase_date DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_tbm_depreciation_tracking IS 'v3.0 TBM depreciation tracking with calculated remaining life and percentages'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_tbm_depreciation_tracking TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_tbm_depreciation_tracking', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_unified_service_health
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_unified_service_health') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_unified_service_health');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_unified_service_health') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_unified_service_health';
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
  )::numeric, 2) AS health_score
FROM business_services bs
WHERE bs.operational_status NOT IN ('outage', 'maintenance')
ORDER BY health_score DESC, service_name
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_unified_service_health IS 'v3.0 Unified service health dashboard combining ITIL, TBM, and BSM metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_unified_service_health TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_unified_service_health', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_criticality_distribution
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_criticality_distribution') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_criticality_distribution');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_criticality_distribution') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_criticality_distribution';
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
    ci_count DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_criticality_distribution IS 'Distribution of CIs by business criticality tier with cost and impact metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_criticality_distribution TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_criticality_distribution', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_revenue_at_risk
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_revenue_at_risk') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_revenue_at_risk');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_revenue_at_risk') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_revenue_at_risk';
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
ORDER BY total_revenue_at_risk DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_revenue_at_risk IS 'Revenue at risk analysis from open incidents affecting business services'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_revenue_at_risk TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_revenue_at_risk', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_compliance_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_compliance_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_compliance_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_compliance_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_compliance_summary';
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
    SUM(CASE WHEN bs.bsm_attributes->>'business_criticality' IN ('tier_1', 'tier_2') THEN 1 ELSE 0 END) AS critical_services
FROM business_services bs
CROSS JOIN LATERAL jsonb_array_elements_text(bs.bsm_attributes->'compliance_requirements') AS compliance_framework
GROUP BY compliance_framework
ORDER BY compliance_rate ASC, service_count DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_compliance_summary IS 'Compliance status summary by regulatory framework'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_compliance_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_compliance_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_sox_pci_inventory
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_sox_pci_inventory') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_sox_pci_inventory');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_sox_pci_inventory') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_sox_pci_inventory';
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
    bs.last_validated
FROM business_services bs
WHERE (bs.bsm_attributes->>'sox_scope')::BOOLEAN = TRUE
   OR (bs.bsm_attributes->>'pci_scope')::BOOLEAN = TRUE
ORDER BY
    COALESCE((bs.bsm_attributes->>'sox_scope')::BOOLEAN, FALSE) DESC,
    COALESCE((bs.bsm_attributes->>'pci_scope')::BOOLEAN, FALSE) DESC,
    annual_revenue_supported DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_sox_pci_inventory IS 'SOX and PCI in-scope business services with compliance metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_sox_pci_inventory TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_sox_pci_inventory', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_disaster_recovery_tiers
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_disaster_recovery_tiers') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_disaster_recovery_tiers');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_disaster_recovery_tiers') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_disaster_recovery_tiers';
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
    END
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_disaster_recovery_tiers IS 'Disaster recovery tier analysis with RTO/RPO metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_disaster_recovery_tiers TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_disaster_recovery_tiers', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_business_capability_health
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_business_capability_health') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_business_capability_health');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_business_capability_health') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_business_capability_health';
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
    bc.tbm_attributes->>'business_unit' AS business_unit
FROM business_capabilities bc
ORDER BY strategic_importance, monthly_cost DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_business_capability_health IS 'Business capability health scorecard with financial and operational metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_business_capability_health TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_business_capability_health', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_service_dependency_map
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_service_dependency_map') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_service_dependency_map');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_service_dependency_map') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_service_dependency_map';
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
    sd.last_verified_at
FROM service_dependencies sd
ORDER BY sd.is_critical DESC, sd.dependency_strength DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_service_dependency_map IS 'Service dependency relationship map for impact analysis'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_service_dependency_map TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_service_dependency_map', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_customer_impact_analysis
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_customer_impact_analysis') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_customer_impact_analysis');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_customer_impact_analysis') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_customer_impact_analysis';
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
    bs.technical_owner
FROM business_services bs
WHERE COALESCE((bs.bsm_attributes->>'customer_count')::INTEGER, 0) > 0
ORDER BY customer_impact_score ASC, customer_count DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_customer_impact_analysis IS 'Customer-facing services with impact scores and cost per customer'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_customer_impact_analysis TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_customer_impact_analysis', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_executive_cost_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_executive_cost_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_executive_cost_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_executive_cost_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_executive_cost_summary';
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
    bs.updated_at
FROM business_services bs
LEFT JOIN service_dependencies sd ON sd.source_id = bs.id AND sd.source_type = 'business_service' AND sd.dependency_type = 'ENABLED_BY'
LEFT JOIN business_capabilities bc ON bc.id = sd.target_id AND sd.target_type = 'business_capability'
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY annual_cost DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_executive_cost_summary IS 'Executive cost summary by business capability and service with unit economics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_executive_cost_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_executive_cost_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cost_by_tower
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_cost_by_tower') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cost_by_tower');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_cost_by_tower') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_cost_by_tower';
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
ORDER BY total_monthly_cost DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_cost_by_tower IS 'TBM cost breakdown by resource tower and cost pool'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_cost_by_tower TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cost_by_tower', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cost_trends
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_cost_trends') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cost_trends');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_cost_trends') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_cost_trends';
  EXECUTE $q$
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
ORDER BY month DESC, monthly_cost DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_cost_trends IS 'Monthly cost trends over time by tower and CI type'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_cost_trends TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cost_trends', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_unit_economics
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_unit_economics') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_unit_economics');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_unit_economics') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_unit_economics';
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
    bs.updated_at
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY revenue_ratio DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_unit_economics IS 'Unit economics by business service with cost per transaction and customer'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_unit_economics TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_unit_economics', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cloud_vs_onprem_costs
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_cloud_vs_onprem_costs') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cloud_vs_onprem_costs');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_cloud_vs_onprem_costs') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_cloud_vs_onprem_costs';
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
ORDER BY monthly_cost DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_cloud_vs_onprem_costs IS 'Cloud vs on-premises cost comparison'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_cloud_vs_onprem_costs TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cloud_vs_onprem_costs', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_cost_allocation_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_cost_allocation_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_cost_allocation_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_cost_allocation_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_cost_allocation_summary';
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
ORDER BY actual_monthly_cost DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_cost_allocation_summary IS 'Cost allocation summary with budget variance by cost center'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_cost_allocation_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_cost_allocation_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_depreciation_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_depreciation_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_depreciation_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_depreciation_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_depreciation_summary';
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
    ds.is_active
FROM tbm_depreciation_schedules ds
LEFT JOIN cmdb.dim_ci ci ON ds.ci_id = ci.ci_id AND ci.is_current = TRUE
WHERE ds.is_active = TRUE
ORDER BY ds.current_book_value DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_depreciation_summary IS 'Asset depreciation summary with remaining life and book value'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_depreciation_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_depreciation_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_top_cost_drivers_bi
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_top_cost_drivers_bi') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_top_cost_drivers_bi');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_top_cost_drivers_bi') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_top_cost_drivers_bi';
  EXECUTE $q$
CREATE OR REPLACE VIEW v_top_cost_drivers_bi AS
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
    ci.updated_at
FROM cmdb.dim_ci ci
WHERE ci.is_current = TRUE
  AND ci.ci_status = 'active'
  AND COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) > 0
ORDER BY monthly_cost DESC
LIMIT 20
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_top_cost_drivers_bi IS 'Top 20 configuration items by monthly cost, without ci.metadata (BI-readable)'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_top_cost_drivers_bi TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_top_cost_drivers_bi', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_underutilized_resources
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_underutilized_resources') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_underutilized_resources');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_underutilized_resources') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_underutilized_resources';
  EXECUTE $q$
CREATE OR REPLACE VIEW v_underutilized_resources AS
SELECT
    u.ci_id,
    u.ci_name,
    u.ci_type,
    u.environment,
    u.monthly_cost,
    u.utilization_pct,
    u.monthly_cost * (1 - u.utilization_pct / 100) AS potential_savings
FROM (
    SELECT
        ci.ci_id,
        ci.ci_name,
        ci.ci_type,
        ci.environment,
        COALESCE((ci.tbm_attributes->>'monthly_cost')::DECIMAL, 0) AS monthly_cost,
        CASE WHEN ci.metadata->>'utilization_pct' ~ '^[0-9]+(\.[0-9]+)?$'
            THEN (ci.metadata->>'utilization_pct')::DECIMAL
        END AS utilization_pct
    FROM cmdb.dim_ci ci
    WHERE ci.is_current = TRUE
      AND ci.ci_status = 'active'
) u
WHERE u.utilization_pct < 50
  AND u.monthly_cost > 0
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_underutilized_resources IS 'Active CIs under 50% utilization with monthly cost and potential savings'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_underutilized_resources TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_underutilized_resources', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_incident_summary
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_incident_summary') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_incident_summary');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_incident_summary') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_incident_summary';
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
    MAX(i.reported_at) AS last_incident_date
FROM itil_incidents i
WHERE i.reported_at >= NOW() - INTERVAL '90 days'
GROUP BY
    i.priority,
    i.status,
    i.impact,
    i.urgency,
    i.category
ORDER BY i.priority, incident_count DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_incident_summary IS 'Incident summary by priority and status with business impact (90 days)'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_incident_summary TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_incident_summary', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_incident_trends
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_incident_trends') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_incident_trends');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_incident_trends') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_incident_trends';
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
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_impact
FROM itil_incidents i
WHERE i.reported_at >= NOW() - INTERVAL '12 months'
GROUP BY
    DATE_TRUNC('month', i.reported_at),
    i.priority,
    i.status,
    i.category
ORDER BY month DESC, incident_count DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_incident_trends IS 'Monthly incident trends by priority and category (12 months)'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_incident_trends TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_incident_trends', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_change_success_rates
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_change_success_rates') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_change_success_rates');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_change_success_rates') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_change_success_rates';
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
    SUM(COALESCE((c.financial_impact->>'total_cost')::DECIMAL, 0)) AS total_financial_impact
FROM itil_changes c
WHERE c.scheduled_start >= NOW() - INTERVAL '12 months'
  AND c.status = 'closed'
GROUP BY
    DATE_TRUNC('month', c.scheduled_start),
    c.change_type,
    c.category
ORDER BY month DESC, total_changes DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_change_success_rates IS 'Change success rates by type with risk and business impact (12 months)'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_change_success_rates TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_change_success_rates', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_change_calendar
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_change_calendar') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_change_calendar');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_change_calendar') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_change_calendar';
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
    c.created_at
FROM itil_changes c
WHERE c.scheduled_start >= CURRENT_DATE
  AND c.status IN ('approved', 'scheduled')
ORDER BY c.scheduled_start ASC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_change_calendar IS 'Upcoming scheduled changes with risk and impact assessment'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_change_calendar TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_change_calendar', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_configuration_accuracy
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_configuration_accuracy') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_configuration_accuracy');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_configuration_accuracy') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_configuration_accuracy';
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
ORDER BY ci_count DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_configuration_accuracy IS 'Configuration item accuracy and audit compliance by type and lifecycle'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_configuration_accuracy TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_configuration_accuracy', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_sla_compliance
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_sla_compliance') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_sla_compliance');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_sla_compliance') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_sla_compliance';
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
    ) AS avg_resolution_minutes_30d
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY sla_met ASC, actual_availability_30d ASC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_sla_compliance IS 'SLA compliance by business service with availability and incident metrics'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_sla_compliance TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_sla_compliance', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_service_health_scorecard
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_service_health_scorecard') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_service_health_scorecard');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_service_health_scorecard') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_service_health_scorecard';
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
    bs.updated_at
FROM business_services bs
WHERE bs.operational_status IN ('operational', 'degraded')
ORDER BY health_score ASC, business_criticality
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_service_health_scorecard IS 'Comprehensive service health scorecard with calculated health scores'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_service_health_scorecard TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_service_health_scorecard', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_mttr_mtbf_analysis
DO $v$
DECLARE
  opts text[];
  readers text[];
  r text;
BEGIN
  IF to_regclass('public.v_mttr_mtbf_analysis') IS NULL THEN
    RETURN;
  END IF;
  SELECT c.reloptions INTO opts FROM pg_class c WHERE c.oid = to_regclass('public.v_mttr_mtbf_analysis');
  SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END) INTO readers
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE c.oid = to_regclass('public.v_mttr_mtbf_analysis') AND a.privilege_type = 'SELECT' AND a.grantee <> c.relowner;
  EXECUTE 'DROP VIEW public.v_mttr_mtbf_analysis';
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
    SUM(COALESCE((i.business_impact->>'estimated_revenue_impact')::DECIMAL, 0)) AS total_revenue_impact
FROM business_services bs
LEFT JOIN itil_incidents i ON i.affected_business_service_id = bs.id
    AND i.reported_at >= NOW() - INTERVAL '90 days'
    AND i.status IN ('resolved', 'closed')
WHERE bs.operational_status IN ('operational', 'degraded')
GROUP BY bs.id, bs.name, bs.operational_status
HAVING COUNT(i.id) > 0
ORDER BY mttr_minutes DESC
$q$;
  EXECUTE $c$
COMMENT ON VIEW public.v_mttr_mtbf_analysis IS 'MTTR and MTBF analysis by business service (90 days)'
$c$;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.v_mttr_mtbf_analysis TO %s', r);
  END LOOP;
  IF opts IS NOT NULL THEN
    EXECUTE format('ALTER VIEW %s SET (%s)', 'public.v_mttr_mtbf_analysis', array_to_string(opts, ', '));
  END IF;
END
$v$;

-- public.v_baseline_drift_detection: the pre-052 definition casts jsonb to text[] and cannot be created, so there is nothing to restore.
DROP VIEW IF EXISTS public.v_baseline_drift_detection;

DELETE FROM cmdb.schema_migrations WHERE migration_name = '052_bi_views_organization_id.sql';
COMMIT;
