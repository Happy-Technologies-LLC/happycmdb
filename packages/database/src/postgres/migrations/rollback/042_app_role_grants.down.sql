-- Rollback for 042_app_role_grants.sql. MANUAL ONLY; not authorized for any environment without a separate named
-- instruction. Revokes from happycmdb_app exactly the relation privileges and sequence USAGE that 042 grants, then
-- deletes 042's ledger row. Nothing else changes: the ledger and escrow stay revoked (042 only revoked there), the
-- role itself, its CONNECT and schema USAGE (Phase B B3) and every other role's privileges are untouched. A privilege
-- that the role held on these objects before 042 through a direct grant is removed as well. Run as the object owner.
-- Idempotent. Role absent: a fixed WARNING, no REVOKE, and the ledger row is still deleted.
-- Run: psql -v ON_ERROR_STOP=1 -f 042_app_role_grants.down.sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  item record;
  kind "char";
  sequence_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happycmdb_app') THEN
    RAISE WARNING '042_app_role_grants.down: role happycmdb_app does not exist; no privileges revoked';
    RETURN;
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('public.ai_discovery_patterns', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ai_discovery_sessions', 'r', 'SELECT, INSERT'),
    ('public.ai_pattern_review_history', 'r', 'SELECT, INSERT'),
    ('public.ai_pattern_usage', 'r', 'SELECT, INSERT'),
    ('public.anomalies', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.api_keys', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.architecture_analyses', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.audit_log', 'r', 'SELECT, INSERT'),
    ('public.auth_credential_events', 'r', 'SELECT, INSERT'),
    ('public.baseline_snapshots', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.business_service_dependencies', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.business_services', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ci_business_service_mappings', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ci_change_alerts', 'r', 'SELECT, INSERT'),
    ('public.ci_change_history', 'r', 'SELECT, INSERT'),
    ('public.ci_change_statistics', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.ci_criticality_scores', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ci_field_sources', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.ci_reconciliation_epochs', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.ci_reconciliation_operations', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.ci_source_lineage', 'r', 'SELECT, INSERT, UPDATE'),
    ('cmdb.dim_ci', 'r', 'SELECT, INSERT, UPDATE'),
    ('cmdb.dim_location', 'r', 'SELECT, INSERT, UPDATE'),
    ('cmdb.dim_owner', 'r', 'SELECT, INSERT, UPDATE'),
    ('cmdb.fact_ci_changes', 'r', 'SELECT, INSERT'),
    ('cmdb.fact_ci_relationships', 'r', 'SELECT, INSERT, UPDATE'),
    ('cmdb.fact_discovery', 'r', 'SELECT, INSERT'),
    ('cmdb.v_ci_change_history', 'v', 'SELECT'),
    ('cmdb.v_ci_discovery_summary', 'v', 'SELECT'),
    ('cmdb.v_ci_relationships', 'v', 'SELECT'),
    ('cmdb.v_current_ci_inventory', 'v', 'SELECT'),
    ('public.connector_configurations', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.connector_registry_cache', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.connector_resource_metrics', 'r', 'SELECT'),
    ('public.connector_run_history', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.connector_run_log_entries', 'r', 'SELECT, INSERT'),
    ('public.credential_sets', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.credentials', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.credential_summaries', 'v', 'SELECT'),
    ('public.credential_set_summaries', 'v', 'SELECT'),
    ('public.active_api_keys', 'v', 'SELECT'),
    ('public.discovery_definitions_with_credentials', 'v', 'SELECT'),
    ('public.dim_business_services', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.discovery_agents', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.active_discovery_agents', 'v', 'SELECT'),
    ('public.agent_network_coverage', 'v', 'SELECT'),
    ('public.discovery_definitions', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.discovery_provider_settings', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.drift_detection_results', 'r', 'SELECT, INSERT, DELETE'),
    ('public.fact_business_service_changes', 'r', 'SELECT, INSERT'),
    ('public.fact_business_service_incidents', 'r', 'SELECT, INSERT'),
    ('public.impact_analyses', 'r', 'SELECT, INSERT, DELETE'),
    ('public.installed_connectors', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.itil_baselines', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.itil_changes', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.itil_incidents', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.metrics_aggregated', 'r', 'SELECT, INSERT'),
    ('public.metrics_timeseries', 'r', 'SELECT, INSERT'),
    ('public.oauth_states', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.reconciliation_conflicts', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.reconciliation_rules', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.source_authority', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.system_config', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.tbm_cost_pools', 'r', 'SELECT, INSERT, UPDATE'),
    ('public.tbm_gl_mappings', 'r', 'SELECT, INSERT'),
    ('public.user_settings', 'r', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.v_business_service_health', 'v', 'SELECT'),
    ('public.v_tbm_tower_summary', 'v', 'SELECT'),
    ('public.v_ci_change_history_audit', 'v', 'SELECT'),
    ('public.recent_audit_activity', 'v', 'SELECT')
  ) AS granted(name, expected, privileges) LOOP
    SELECT c.relkind INTO kind FROM pg_class c WHERE c.oid = to_regclass(item.name);
    IF kind IS DISTINCT FROM item.expected::"char" THEN
      RAISE EXCEPTION '042 down wrong or missing relation %', item.name;
    END IF;
    EXECUTE format('REVOKE %s ON %s FROM happycmdb_app', item.privileges, item.name);
    IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
               WHERE c.oid = to_regclass(item.name) AND a.grantee = 'happycmdb_app'::regrole
                 AND a.privilege_type = ANY (string_to_array(item.privileges, ', '))) THEN
      RAISE EXCEPTION '042 down could not revoke % from happycmdb_app; run as the object owner', item.name;
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES
    ('cmdb.dim_ci', 'ci_key'), ('cmdb.dim_location', 'location_key'), ('cmdb.dim_owner', 'owner_key'),
    ('cmdb.fact_discovery', 'discovery_key'), ('cmdb.fact_ci_changes', 'change_key'),
    ('cmdb.fact_ci_relationships', 'relationship_key'), ('public.business_service_dependencies', 'id'),
    ('public.ci_business_service_mappings', 'id'), ('public.fact_business_service_incidents', 'id'),
    ('public.fact_business_service_changes', 'id'), ('public.connector_run_log_entries', 'sequence')
  ) AS serial(name, column_name) LOOP
    sequence_name := pg_get_serial_sequence(item.name, item.column_name);
    IF sequence_name IS NULL THEN
      RAISE EXCEPTION '042 down missing serial sequence for %.%', item.name, item.column_name;
    END IF;
    EXECUTE format('REVOKE USAGE ON SEQUENCE %s FROM happycmdb_app', sequence_name);
    IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
               WHERE c.oid = sequence_name::regclass AND a.grantee = 'happycmdb_app'::regrole
                 AND a.privilege_type = 'USAGE') THEN
      RAISE EXCEPTION '042 down could not revoke USAGE on % from happycmdb_app; run as the sequence owner', sequence_name;
    END IF;
  END LOOP;
END
$acl$;
DELETE FROM cmdb.schema_migrations WHERE migration_name = '042_app_role_grants.sql';
COMMIT;
