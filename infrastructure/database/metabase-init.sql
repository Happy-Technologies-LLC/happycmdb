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

-- Grant usage on public schema
GRANT USAGE ON SCHEMA public TO metabase_readonly;
GRANT USAGE ON SCHEMA cmdb TO metabase_readonly;

-- Grant SELECT on all existing tables in public schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO metabase_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA cmdb TO metabase_readonly;

-- Grant SELECT on all existing views
GRANT SELECT ON ALL VIEWS IN SCHEMA public TO metabase_readonly;
GRANT SELECT ON ALL VIEWS IN SCHEMA cmdb TO metabase_readonly;

-- Grant SELECT on all future tables (default privileges)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO metabase_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA cmdb GRANT SELECT ON TABLES TO metabase_readonly;

-- Grant SELECT on all sequences (needed for some queries)
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO metabase_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA cmdb TO metabase_readonly;

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
