-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0

-- HAP-630: 001 granted PUBLIC read/write on authentication and discovery
-- configuration. Revoke effective access through both PUBLIC and the legacy
-- named BI blanket grant. The table owner retains its ordinary privileges.
-- Run by the application schema owner; the migrator commits this and its ledger
-- row atomically. Manual rollback: rollback/032_secret_table_public_grants.down.sql.
DO $acl$
DECLARE
  default_acl record;
  name text;
  kind "char";
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '10s', true);
  FOREACH name IN ARRAY ARRAY[
    'api_keys', 'credentials', 'credential_sets', 'discovery_definitions',
    'connector_configurations', 'system_config', 'active_api_keys',
    'credential_summaries', 'credential_set_summaries',
    'discovery_definitions_with_credentials'
  ] LOOP
    SELECT c.relkind INTO kind FROM pg_class c
      WHERE c.oid = to_regclass(format('public.%I', name));
    IF kind IS DISTINCT FROM CASE WHEN name IN ('active_api_keys', 'credential_summaries',
        'credential_set_summaries', 'discovery_definitions_with_credentials')
      THEN 'v'::"char" ELSE 'r'::"char" END THEN
      RAISE EXCEPTION '032 expected public.% to be a table or view of the audited kind', name;
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', name);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys, public.credentials, public.credential_sets, public.discovery_definitions, public.connector_configurations, public.system_config TO cmdb_user';
    EXECUTE 'GRANT SELECT ON public.active_api_keys, public.credential_summaries, public.credential_set_summaries, public.discovery_definitions_with_credentials TO cmdb_user';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    -- Undo an earlier metabase-init.sql blanket grant, including private S1
    -- objects. PUBLIC on unrelated cmdb reporting tables is left untouched.
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM metabase_readonly;
    REVOKE ALL ON ALL TABLES IN SCHEMA cmdb FROM metabase_readonly;
    -- Default privileges belong to the role that ran the old bootstrap, not
    -- necessarily the migration's current role. Require authority to clear
    -- each actual blanket SELECT grant; otherwise abort the whole migration.
    FOR default_acl IN
      SELECT DISTINCT owner.rolname AS owner_name, ns.nspname AS schema_name
        FROM pg_default_acl d
        JOIN pg_roles owner ON owner.oid = d.defaclrole
        JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       WHERE d.defaclobjtype = 'r' AND ns.nspname IN ('public', 'cmdb')
         AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'metabase_readonly')
         AND a.privilege_type = 'SELECT'
    LOOP
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE SELECT ON TABLES FROM metabase_readonly',
        default_acl.owner_name, default_acl.schema_name);
    END LOOP;
    -- These reporting views have been audited against 001 and the three BI
    -- view files. BI views created later grant themselves SELECT explicitly.
    FOREACH name IN ARRAY ARRAY[
      'public.recent_audit_activity', 'public.v_business_service_summary',
      'public.v_application_service_summary', 'public.v_business_capability_summary',
      'public.v_service_dependency_graph', 'public.v_itil_incident_summary',
      'public.v_itil_change_summary', 'public.v_tbm_cost_pool_summary',
      'public.v_tbm_depreciation_tracking', 'public.v_unified_service_health',
      'public.v_business_service_health',
      'cmdb.v_ci_discovery_summary',
      'public.v_criticality_distribution', 'public.v_revenue_at_risk',
      'public.v_compliance_summary', 'public.v_sox_pci_inventory',
      'public.v_disaster_recovery_tiers', 'public.v_business_capability_health',
      'public.v_service_dependency_map', 'public.v_customer_impact_analysis',
      'public.v_executive_cost_summary', 'public.v_cost_by_tower',
      'public.v_cost_trends', 'public.v_unit_economics',
      'public.v_cloud_vs_onprem_costs', 'public.v_cost_allocation_summary',
      'public.v_depreciation_summary', 'public.v_top_cost_drivers',
      'public.v_incident_summary', 'public.v_incident_trends',
      'public.v_change_success_rates', 'public.v_change_calendar',
      'public.v_configuration_accuracy', 'public.v_sla_compliance',
      'public.v_service_health_scorecard', 'public.v_mttr_mtbf_analysis',
      'public.v_baseline_drift_detection'
    ] LOOP
      IF to_regclass(name) IS NOT NULL THEN
        SELECT c.relkind INTO kind FROM pg_class c WHERE c.oid = to_regclass(name);
        IF kind <> 'v' THEN
          RAISE EXCEPTION '032 reporting object % is not a view', name;
        END IF;
        EXECUTE format('GRANT SELECT ON %s TO metabase_readonly', name);
      END IF;
    END LOOP;
  END IF;
END
$acl$;
