-- Copyright 2026 Happy Technologies LLC
-- SPDX-License-Identifier: Apache-2.0
-- HAP-1562 (D42): Build01 staging splits its database login. The migrator keeps the owner login (cmdb_user, which
-- owns every table); the API connects as cmdb_app, a NOSUPERUSER, NOCREATEDB, NOCREATEROLE login that owns nothing
-- (deploy/build01-staging-app-login.sql creates it before the migrator runs). This grants cmdb_app what the API
-- process issues at runtime, derived from its SQL: the reconciliation journal (ci_reconciliation_operations and
-- ci_reconciliation_epochs: T1, T2, the sweeper and read admission), its evidence tables and the CI-delete cascade,
-- reconciliation policy, ITIL, drift/impact/architecture/anomaly, connectors (startup registry upserts, runs and run
-- logs), settings, credentials, discovery, business services, TBM GL import, audit and auth events, and SELECT on the
-- cmdb tables the API reads. Operator-only relations get nothing: cmdb.schema_migrations, the discovery-definition
-- migration ledger and escrow (041), cmdb.tenant_fixture_marker. A relation a later migration adds for the API must
-- be granted to cmdb_app there as well.
-- Additive and idempotent. It does nothing where cmdb_app does not exist (dev, CI, owner-is-app deployments), and it
-- does not change cmdb_user's privileges.
-- Manual rollback: rollback/045_staging_app_login_acl.down.sql.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
DO $acl$
DECLARE
  item record;
  seq regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cmdb_app') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public, cmdb TO cmdb_app;
  FOR item IN SELECT * FROM (VALUES
    -- Reconciliation journal, read admission and journal evidence.
    ('public.ci_reconciliation_operations', 'SELECT, INSERT, UPDATE'),
    ('public.ci_reconciliation_epochs', 'SELECT, INSERT, UPDATE'),
    ('public.ci_field_sources', 'SELECT, INSERT, UPDATE'),
    ('public.ci_source_lineage', 'SELECT, INSERT, UPDATE'),
    ('public.reconciliation_conflicts', 'SELECT, INSERT, UPDATE'),
    ('public.source_authority', 'SELECT, INSERT, UPDATE'),
    ('public.reconciliation_rules', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ci_change_history', 'SELECT, INSERT'),
    ('public.audit_log', 'SELECT, INSERT'),
    -- Derived analyses (also purged by the journal's CI-delete cascade).
    ('public.drift_detection_results', 'SELECT, INSERT, DELETE'),
    ('public.impact_analyses', 'SELECT, INSERT, DELETE'),
    ('public.baseline_snapshots', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ci_criticality_scores', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.anomalies', 'SELECT, INSERT, UPDATE'),
    ('public.architecture_analyses', 'SELECT, INSERT, UPDATE'),
    ('public.ci_change_statistics', 'SELECT'),
    ('public.metrics_timeseries', 'SELECT'),
    -- Identity, settings and secrets (032 parity for the tables cmdb_user already had).
    ('public.auth_credential_events', 'INSERT'),
    ('public.api_keys', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.user_settings', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.discovery_provider_settings', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.system_config', 'SELECT'),
    ('public.credentials', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.credential_sets', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.credential_summaries', 'SELECT'),
    ('public.credential_set_summaries', 'SELECT'),
    -- Connectors (the registry upserts run at API startup) and discovery.
    ('public.connector_registry_cache', 'SELECT, INSERT, UPDATE'),
    ('public.installed_connectors', 'SELECT, INSERT, UPDATE'),
    ('public.connector_configurations', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.connector_run_history', 'SELECT, INSERT, UPDATE'),
    ('public.connector_run_log_entries', 'INSERT'),
    ('public.connector_resource_metrics', 'SELECT'),
    ('public.discovery_definitions', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.discovery_agents', 'SELECT, INSERT, UPDATE, DELETE'),
    -- Business services (033 parity).
    ('public.dim_business_services', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.business_service_dependencies', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ci_business_service_mappings', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.fact_business_service_incidents', 'SELECT, INSERT'),
    ('public.fact_business_service_changes', 'SELECT, INSERT'),
    -- ITIL, AI patterns, TBM.
    ('public.itil_incidents', 'SELECT, INSERT, UPDATE'),
    ('public.itil_changes', 'SELECT, INSERT, UPDATE'),
    ('public.itil_baselines', 'SELECT, INSERT, DELETE'),
    ('public.ai_discovery_patterns', 'SELECT, INSERT, UPDATE, DELETE'),
    ('public.ai_pattern_review_history', 'SELECT, INSERT'),
    ('public.ai_discovery_sessions', 'SELECT'),
    ('public.ai_pattern_usage', 'SELECT'),
    ('public.tbm_cost_pools', 'SELECT, UPDATE'),
    ('public.tbm_gl_mappings', 'SELECT, INSERT'),
    -- Data mart reads.
    ('cmdb.dim_ci', 'SELECT'),
    ('cmdb.fact_ci_relationships', 'SELECT'),
    ('cmdb.fact_discovery', 'SELECT')
  ) AS grants(name, privileges) LOOP
    IF to_regclass(item.name) IS NULL THEN
      RAISE EXCEPTION '045 missing relation %', item.name;
    END IF;
    EXECUTE format('GRANT %s ON %s TO cmdb_app', item.privileges, item.name);
    -- serial/identity defaults call nextval on the column's owned sequence.
    IF item.privileges LIKE '%INSERT%' THEN
      FOR seq IN SELECT d.objid::regclass FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
          WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
            AND d.refobjid = to_regclass(item.name) AND d.deptype IN ('a', 'i') LOOP
        EXECUTE format('GRANT USAGE ON SEQUENCE %s TO cmdb_app', seq);
      END LOOP;
    END IF;
  END LOOP;
END
$acl$;
