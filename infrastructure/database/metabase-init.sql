-- ============================================
-- HappyCMDB v3.0 - Metabase Database Initialization
-- ============================================
-- This script creates the Metabase application database and users
-- Run this as PostgreSQL superuser before starting Metabase
-- ============================================

-- Create Metabase application database
CREATE DATABASE metabase
    WITH
    OWNER = postgres
    ENCODING = 'UTF8'
    LC_COLLATE = 'en_US.UTF-8'
    LC_CTYPE = 'en_US.UTF-8'
    TEMPLATE = template0;

-- Create Metabase database user (for Metabase's own tables)
CREATE USER metabase_user WITH ENCRYPTED PASSWORD 'metabase_password_change_me';
GRANT ALL PRIVILEGES ON DATABASE metabase TO metabase_user;

-- Grant schema permissions
\c metabase
GRANT ALL ON SCHEMA public TO metabase_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO metabase_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO metabase_user;

-- ============================================
-- Create Read-Only User for CMDB Data Mart
-- ============================================
-- This user is used by Metabase to query the CMDB data mart
-- It has SELECT-only permissions for security

\c cmdb

-- Create read-only user
CREATE USER metabase_readonly WITH ENCRYPTED PASSWORD 'readonly_password_change_me';

-- Grant connect to database
GRANT CONNECT ON DATABASE cmdb TO metabase_readonly;

-- Only audited reporting views get named BI grants. Remove grants left by an
-- older bootstrap (including the HP1 private journal) and its future-table
-- default; PUBLIC ACLs for unrelated reporting tables remain unchanged.
GRANT USAGE ON SCHEMA public TO metabase_readonly;
GRANT USAGE ON SCHEMA cmdb TO metabase_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM metabase_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA cmdb FROM metabase_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM metabase_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA cmdb REVOKE SELECT ON TABLES FROM metabase_readonly;

-- BI view scripts grant their own views after creation. This list also covers
-- already-created reporting views, without granting future tables or secrets.
DO $bi$
DECLARE
    name text;
    kind "char";
BEGIN
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
      'public.v_depreciation_summary',
      'public.v_incident_summary', 'public.v_incident_trends',
      'public.v_change_success_rates', 'public.v_change_calendar',
      'public.v_configuration_accuracy', 'public.v_sla_compliance',
      'public.v_service_health_scorecard', 'public.v_mttr_mtbf_analysis',
      'public.v_baseline_drift_detection'
    ] LOOP
        IF to_regclass(name) IS NOT NULL THEN
            SELECT c.relkind INTO kind FROM pg_class c WHERE c.oid = to_regclass(name);
            IF kind <> 'v' THEN
                RAISE EXCEPTION 'BI reporting object % is not a view', name;
            END IF;
            EXECUTE format('GRANT SELECT ON %s TO metabase_readonly', name);
        END IF;
    END LOOP;
END
$bi$;

-- ============================================
-- Create Helper Functions for Metabase
-- ============================================

-- Function to get current fiscal quarter
CREATE OR REPLACE FUNCTION get_fiscal_quarter(input_date DATE)
RETURNS INTEGER AS $$
DECLARE
    month_num INTEGER;
BEGIN
    month_num := EXTRACT(MONTH FROM input_date);
    RETURN CASE
        WHEN month_num IN (1, 2, 3) THEN 3
        WHEN month_num IN (4, 5, 6) THEN 4
        WHEN month_num IN (7, 8, 9) THEN 1
        ELSE 2
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get fiscal year (starts in July)
CREATE OR REPLACE FUNCTION get_fiscal_year(input_date DATE)
RETURNS INTEGER AS $$
BEGIN
    RETURN CASE
        WHEN EXTRACT(MONTH FROM input_date) >= 7 THEN EXTRACT(YEAR FROM input_date) + 1
        ELSE EXTRACT(YEAR FROM input_date)
    END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Grant execute permissions to metabase_readonly
GRANT EXECUTE ON FUNCTION get_fiscal_quarter(DATE) TO metabase_readonly;
GRANT EXECUTE ON FUNCTION get_fiscal_year(DATE) TO metabase_readonly;

-- ============================================
-- Verification Queries
-- ============================================

-- Verify metabase database exists
SELECT datname FROM pg_database WHERE datname = 'metabase';

-- Verify users exist
SELECT usename FROM pg_user WHERE usename IN ('metabase_user', 'metabase_readonly');

-- Verify permissions (run as metabase_readonly)
-- \c cmdb metabase_readonly
-- SELECT table_schema, table_name
-- FROM information_schema.table_privileges
-- WHERE grantee = 'metabase_readonly' AND privilege_type = 'SELECT'
-- ORDER BY table_schema, table_name;

COMMENT ON DATABASE metabase IS 'Metabase application database for HappyCMDB v3.0 BI';
