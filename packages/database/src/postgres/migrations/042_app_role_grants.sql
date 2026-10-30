-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-774 S5b C1 (role plan §3.2, §3.3; D1 a, D8 b, D11 a, D12 a): grant the API's least-privilege role
-- happycmdb_app exactly the code-derived and signed-migration (032/033/034/039) privileges on 70 relations, plus
-- USAGE on the 11 serial sequences the app inserts through, resolved with pg_get_serial_sequence. Then explicitly
-- revoke everything on the S5b ledger and escrow from it. No TRUNCATE on anything (D8 b: the ETL full refresh runs
-- as an operator job). This file creates no role and sets no password: Phase B step B3 creates happycmdb_app with
-- CONNECT and schema USAGE. cmdb_user, metabase_readonly and PUBLIC are not touched.
--
-- Role absent (fresh, dev and CI databases): a no-op with a fixed WARNING. The migrator still records this file and
-- never re-runs a recorded file (checksum-pinned skip, migrator.ts:78-91). MERGE GATE: this file may reach a
-- database only after B3 has created happycmdb_app there; a skipped apply is visible in the readback below.
-- Role present: every object must exist with its audited kind, and every grant and the escrow lockdown are read
-- back before commit. A run by a role that cannot grant (GRANT then only warns) fails instead of recording an empty
-- apply. Run by the object owner (the migration owner). Idempotent; the migrator records it in one transaction.
-- Manual rollback: rollback/042_app_role_grants.down.sql.
--
-- Phase B readback (read-only). Expected: the 70 relations and 11 sequences listed below with exactly these
-- privileges; no ledger or escrow row; no TRUNCATE. (0 rows) means 042 was recorded before the role existed.
--   SELECT c.oid::regclass AS object, string_agg(p.priv, ',' ORDER BY p.ord) AS privileges
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'USAGE']) WITH ORDINALITY p(priv, ord)
--    WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
--      AND CASE WHEN c.relkind = 'S' THEN
--            CASE WHEN p.priv IN ('SELECT', 'UPDATE', 'USAGE') THEN has_sequence_privilege('happycmdb_app', c.oid, p.priv) ELSE false END
--          ELSE CASE WHEN p.priv <> 'USAGE' THEN has_table_privilege('happycmdb_app', c.oid, p.priv) ELSE false END END
--    GROUP BY c.oid ORDER BY c.oid::regclass::text;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $acl$
DECLARE
  item record;
  kind "char";
  privilege text;
  sequence_name text;
  relation text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'happycmdb_app') THEN
    RAISE WARNING '042_app_role_grants: role happycmdb_app does not exist; no privileges granted or revoked';
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
      RAISE EXCEPTION '042 wrong or missing relation %', item.name;
    END IF;
    EXECUTE format('GRANT %s ON %s TO happycmdb_app', item.privileges, item.name);
    FOREACH privilege IN ARRAY string_to_array(item.privileges, ', ') LOOP
      IF NOT has_table_privilege('happycmdb_app', item.name, privilege) THEN
        RAISE EXCEPTION '042 could not grant % on % to happycmdb_app; run as the object owner', privilege, item.name;
      END IF;
    END LOOP;
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
      RAISE EXCEPTION '042 missing serial sequence for %.%', item.name, item.column_name;
    END IF;
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO happycmdb_app', sequence_name);
    IF NOT has_sequence_privilege('happycmdb_app', sequence_name, 'USAGE') THEN
      RAISE EXCEPTION '042 could not grant USAGE on % to happycmdb_app; run as the sequence owner', sequence_name;
    END IF;
  END LOOP;
  -- §3.3: the S5b ledger and escrow stay owner-only; the app never reads either (041 header). Any remaining access
  -- (a PUBLIC or inherited grant that this REVOKE cannot remove) fails the migration.
  FOREACH relation IN ARRAY ARRAY[
    'public.discovery_definition_migration_escrow', 'public.discovery_definition_migrations'
  ] LOOP
    IF (SELECT c.relkind FROM pg_class c WHERE c.oid = to_regclass(relation)) IS DISTINCT FROM 'r' THEN
      RAISE EXCEPTION '042 wrong or missing relation %', relation;
    END IF;
    EXECUTE format('REVOKE ALL ON %s FROM happycmdb_app', relation);
    FOREACH privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('happycmdb_app', relation, privilege)
         OR (CASE WHEN privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
               THEN has_any_column_privilege('happycmdb_app', relation, privilege) ELSE false END) THEN
        RAISE EXCEPTION '042 happycmdb_app still holds % on %', privilege, relation;
      END IF;
    END LOOP;
  END LOOP;
END
$acl$;
