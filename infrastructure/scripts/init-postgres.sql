-- ============================================
-- HappyCMDB - Complete Database Schema
-- Consolidated Migration: 001_complete_schema.sql
-- ============================================
-- This migration creates the complete PostgreSQL schema for HappyCMDB.
-- It consolidates all tables, indexes, views, and functions into a single
-- clean migration file.
--
-- Database Design:
-- - CMDB Data Mart: Dimensional model with TimescaleDB for time-series data
-- - Audit & Security: API keys, audit logs
-- - Discovery System: Definitions, agents, credentials, field mappings
-- - Connector Framework: Installed connectors, configurations, runs
-- - Transformation Engine: Rules, lookups, executions
-- - Identity Resolution: Reconciliation, source tracking
-- - Event Tracking: Change history, alerts, metrics
-- - AI/ML Engines: Anomalies, impact analysis, drift detection
-- ============================================

-- ============================================
-- EXTENSIONS
-- ============================================

-- Enable TimescaleDB for time-series data (optional but recommended)
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- SCHEMAS
-- ============================================

-- Create dedicated schema for CMDB data mart
CREATE SCHEMA IF NOT EXISTS cmdb;

-- ============================================
-- ENUM TYPES
-- ============================================

-- Audit log enums
CREATE TYPE audit_action AS ENUM (
  'CREATE',
  'UPDATE',
  'DELETE',
  'RELATIONSHIP_ADD',
  'RELATIONSHIP_REMOVE',
  'DISCOVERY_UPDATE'
);

CREATE TYPE audit_entity_type AS ENUM (
  'CI',
  'RELATIONSHIP'
);

CREATE TYPE audit_actor_type AS ENUM (
  'user',
  'system',
  'discovery'
);

-- ============================================
-- SECTION 1: CMDB DATA MART (Dimensional Model)
-- ============================================

-- ----------------------------------------
-- dim_time: Time Dimension (Pre-populated)
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS cmdb.dim_time (
    date_key INTEGER PRIMARY KEY,
    full_date DATE NOT NULL UNIQUE,
    year INTEGER NOT NULL,
    quarter INTEGER NOT NULL,
    month INTEGER NOT NULL,
    month_name VARCHAR(20) NOT NULL,
    week INTEGER NOT NULL,
    day_of_month INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    day_name VARCHAR(20) NOT NULL,
    is_weekend BOOLEAN NOT NULL,
    is_holiday BOOLEAN DEFAULT FALSE,
    fiscal_year INTEGER,
    fiscal_quarter INTEGER,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dim_time_full_date ON cmdb.dim_time(full_date);
CREATE INDEX IF NOT EXISTS idx_dim_time_year_month ON cmdb.dim_time(year, month);
CREATE INDEX IF NOT EXISTS idx_dim_time_fiscal ON cmdb.dim_time(fiscal_year, fiscal_quarter);

-- ----------------------------------------
-- dim_ci: Configuration Item Dimension (SCD Type 2)
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS cmdb.dim_ci (
    ci_key SERIAL PRIMARY KEY,
    ci_id VARCHAR(100) NOT NULL,
    ci_name VARCHAR(500) NOT NULL,
    ci_type VARCHAR(50) NOT NULL,
    ci_status VARCHAR(50) NOT NULL,
    environment VARCHAR(50),
    external_id VARCHAR(200),
    metadata JSONB,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    effective_to TIMESTAMPTZ DEFAULT '9999-12-31'::TIMESTAMPTZ,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dim_ci_id_current ON cmdb.dim_ci(ci_id) WHERE is_current = TRUE;
CREATE INDEX IF NOT EXISTS idx_dim_ci_type ON cmdb.dim_ci(ci_type);
CREATE INDEX IF NOT EXISTS idx_dim_ci_status ON cmdb.dim_ci(ci_status);
CREATE INDEX IF NOT EXISTS idx_dim_ci_environment ON cmdb.dim_ci(environment);
CREATE INDEX IF NOT EXISTS idx_dim_ci_external_id ON cmdb.dim_ci(external_id);
CREATE INDEX IF NOT EXISTS idx_dim_ci_effective_dates ON cmdb.dim_ci(effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_dim_ci_metadata ON cmdb.dim_ci USING GIN(metadata);

-- ----------------------------------------
-- dim_location: Location Dimension
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS cmdb.dim_location (
    location_key SERIAL PRIMARY KEY,
    location_id VARCHAR(100) NOT NULL UNIQUE,
    location_name VARCHAR(200) NOT NULL,
    location_type VARCHAR(50) NOT NULL,
    cloud_provider VARCHAR(50),
    region VARCHAR(100),
    country VARCHAR(100),
    city VARCHAR(100),
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dim_location_type ON cmdb.dim_location(location_type);
CREATE INDEX IF NOT EXISTS idx_dim_location_cloud ON cmdb.dim_location(cloud_provider);
CREATE INDEX IF NOT EXISTS idx_dim_location_region ON cmdb.dim_location(region);
CREATE INDEX IF NOT EXISTS idx_dim_location_coords ON cmdb.dim_location(latitude, longitude);

-- ----------------------------------------
-- dim_owner: Owner Dimension
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS cmdb.dim_owner (
    owner_key SERIAL PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL UNIQUE,
    owner_name VARCHAR(200) NOT NULL,
    owner_type VARCHAR(50) NOT NULL,
    email VARCHAR(200),
    department VARCHAR(200),
    cost_center VARCHAR(100),
    manager_id VARCHAR(100),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dim_owner_type ON cmdb.dim_owner(owner_type);
CREATE INDEX IF NOT EXISTS idx_dim_owner_department ON cmdb.dim_owner(department);
CREATE INDEX IF NOT EXISTS idx_dim_owner_cost_center ON cmdb.dim_owner(cost_center);

-- ----------------------------------------
-- fact_discovery: Discovery Events (TimescaleDB Hypertable)
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS cmdb.fact_discovery (
    discovery_key BIGSERIAL,
    ci_key INTEGER NOT NULL,
    location_key INTEGER,
    date_key INTEGER NOT NULL,
    discovered_at TIMESTAMPTZ NOT NULL,
    discovery_job_id VARCHAR(100) NOT NULL,
    discovery_provider VARCHAR(50) NOT NULL,
    discovery_method VARCHAR(50) NOT NULL,
    confidence_score DECIMAL(3, 2),
    discovery_duration_ms INTEGER,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_fact_discovery PRIMARY KEY (discovery_key, discovered_at)
);

-- Convert to TimescaleDB hypertable (partitioned by time)
SELECT create_hypertable(
    'cmdb.fact_discovery',
    'discovered_at',
    if_not_exists => TRUE,
    chunk_time_interval => INTERVAL '7 days'
);

CREATE INDEX IF NOT EXISTS idx_fact_discovery_ci ON cmdb.fact_discovery(ci_key);
CREATE INDEX IF NOT EXISTS idx_fact_discovery_location ON cmdb.fact_discovery(location_key);
CREATE INDEX IF NOT EXISTS idx_fact_discovery_date ON cmdb.fact_discovery(date_key);
CREATE INDEX IF NOT EXISTS idx_fact_discovery_job ON cmdb.fact_discovery(discovery_job_id);
CREATE INDEX IF NOT EXISTS idx_fact_discovery_provider ON cmdb.fact_discovery(discovery_provider);
CREATE INDEX IF NOT EXISTS idx_fact_discovery_time ON cmdb.fact_discovery(discovered_at DESC);

-- ----------------------------------------
-- fact_ci_changes: Change Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS cmdb.fact_ci_changes (
    change_key BIGSERIAL PRIMARY KEY,
    ci_key INTEGER NOT NULL,
    date_key INTEGER NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL,
    change_type VARCHAR(50) NOT NULL,
    field_name VARCHAR(100),
    old_value TEXT,
    new_value TEXT,
    changed_by VARCHAR(200),
    change_source VARCHAR(50) DEFAULT 'discovery',
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fact_changes_ci ON cmdb.fact_ci_changes(ci_key);
CREATE INDEX IF NOT EXISTS idx_fact_changes_date ON cmdb.fact_ci_changes(date_key);
CREATE INDEX IF NOT EXISTS idx_fact_changes_time ON cmdb.fact_ci_changes(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_changes_type ON cmdb.fact_ci_changes(change_type);
CREATE INDEX IF NOT EXISTS idx_fact_changes_source ON cmdb.fact_ci_changes(change_source);

-- ----------------------------------------
-- fact_ci_relationships: Relationship Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS cmdb.fact_ci_relationships (
    relationship_key BIGSERIAL PRIMARY KEY,
    from_ci_key INTEGER NOT NULL,
    to_ci_key INTEGER NOT NULL,
    date_key INTEGER NOT NULL,
    relationship_type VARCHAR(50) NOT NULL,
    relationship_strength DECIMAL(3, 2),
    discovered_at TIMESTAMPTZ NOT NULL,
    last_verified_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    properties JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_active_relationship UNIQUE (from_ci_key, to_ci_key, relationship_type, is_active)
);

CREATE INDEX IF NOT EXISTS idx_fact_rel_from ON cmdb.fact_ci_relationships(from_ci_key);
CREATE INDEX IF NOT EXISTS idx_fact_rel_to ON cmdb.fact_ci_relationships(to_ci_key);
CREATE INDEX IF NOT EXISTS idx_fact_rel_type ON cmdb.fact_ci_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_fact_rel_active ON cmdb.fact_ci_relationships(is_active);
CREATE INDEX IF NOT EXISTS idx_fact_rel_discovered ON cmdb.fact_ci_relationships(discovered_at DESC);

-- Foreign key constraints for CMDB data mart
ALTER TABLE cmdb.fact_discovery
    ADD CONSTRAINT fk_discovery_ci FOREIGN KEY (ci_key) REFERENCES cmdb.dim_ci(ci_key),
    ADD CONSTRAINT fk_discovery_location FOREIGN KEY (location_key) REFERENCES cmdb.dim_location(location_key),
    ADD CONSTRAINT fk_discovery_date FOREIGN KEY (date_key) REFERENCES cmdb.dim_time(date_key);

ALTER TABLE cmdb.fact_ci_changes
    ADD CONSTRAINT fk_changes_ci FOREIGN KEY (ci_key) REFERENCES cmdb.dim_ci(ci_key),
    ADD CONSTRAINT fk_changes_date FOREIGN KEY (date_key) REFERENCES cmdb.dim_time(date_key);

ALTER TABLE cmdb.fact_ci_relationships
    ADD CONSTRAINT fk_rel_from_ci FOREIGN KEY (from_ci_key) REFERENCES cmdb.dim_ci(ci_key),
    ADD CONSTRAINT fk_rel_to_ci FOREIGN KEY (to_ci_key) REFERENCES cmdb.dim_ci(ci_key),
    ADD CONSTRAINT fk_rel_date FOREIGN KEY (date_key) REFERENCES cmdb.dim_time(date_key);

-- ============================================
-- SECTION 2: AUDIT & SECURITY
-- ============================================

-- ----------------------------------------
-- audit_log: Comprehensive Audit Trail
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID DEFAULT gen_random_uuid(),
  entity_type audit_entity_type NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  action audit_action NOT NULL,
  actor VARCHAR(255) NOT NULL,
  actor_type audit_actor_type NOT NULL DEFAULT 'system',
  changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address INET,
  user_agent TEXT,
  PRIMARY KEY (id, timestamp),
  CONSTRAINT audit_log_entity_id_idx CHECK (entity_id IS NOT NULL AND entity_id <> '')
);

CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_actor ON audit_log(actor);
CREATE INDEX idx_audit_log_composite ON audit_log(entity_id, timestamp DESC);

-- Create hypertable for audit_log
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
  ) THEN
    PERFORM create_hypertable('audit_log', 'timestamp', if_not_exists => TRUE);
    PERFORM add_retention_policy('audit_log', INTERVAL '2 years', if_not_exists => TRUE);
  END IF;
END $$;

-- ----------------------------------------
-- api_keys: API Authentication
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  CONSTRAINT api_keys_user_id_check CHECK (user_id IS NOT NULL AND user_id <> ''),
  CONSTRAINT api_keys_name_check CHECK (name IS NOT NULL AND name <> ''),
  CONSTRAINT api_keys_role_check CHECK (role IN ('admin', 'operator', 'viewer', 'agent'))
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_enabled ON api_keys(enabled) WHERE enabled = TRUE;
CREATE INDEX idx_api_keys_expires_at ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_api_keys_created_at ON api_keys(created_at DESC);

-- ============================================
-- SECTION 3: UNIFIED CREDENTIAL SYSTEM
-- ============================================

-- ----------------------------------------
-- credentials: Unified Credential Storage
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS credentials (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  protocol VARCHAR(50) NOT NULL,
  scope VARCHAR(50) NOT NULL,
  credentials JSONB NOT NULL,
  affinity JSONB DEFAULT '{}'::jsonb,
  last_validated_at TIMESTAMPTZ,
  validation_status VARCHAR(20),
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credentials_name_check CHECK (name IS NOT NULL AND name <> ''),
  CONSTRAINT credentials_protocol_check CHECK (
    protocol IN ('oauth2', 'api_key', 'basic', 'bearer', 'aws_iam', 'azure_sp',
                 'gcp_sa', 'ssh_key', 'ssh_password', 'certificate', 'kerberos',
                 'snmp_v2c', 'snmp_v3', 'winrm')
  ),
  CONSTRAINT credentials_scope_check CHECK (
    scope IN ('cloud_provider', 'ssh', 'api', 'network', 'database', 'container', 'universal')
  ),
  CONSTRAINT credentials_validation_status_check CHECK (
    validation_status IS NULL OR validation_status IN ('valid', 'invalid', 'expired', 'unknown')
  ),
  CONSTRAINT credentials_created_by_check CHECK (created_by IS NOT NULL AND created_by <> '')
);

CREATE INDEX idx_credentials_name ON credentials(name);
CREATE INDEX idx_credentials_protocol ON credentials(protocol);
CREATE INDEX idx_credentials_scope ON credentials(scope);
CREATE INDEX idx_credentials_created_by ON credentials(created_by);
CREATE INDEX idx_credentials_created_at ON credentials(created_at DESC);
CREATE INDEX idx_credentials_affinity ON credentials USING GIN(affinity);
CREATE INDEX idx_credentials_tags ON credentials USING GIN(tags);
CREATE INDEX idx_credentials_validation_status ON credentials(validation_status)
  WHERE validation_status IS NOT NULL;
CREATE UNIQUE INDEX idx_credentials_unique_name ON credentials(name, created_by);

-- ----------------------------------------
-- credential_sets: Credential Groups
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS credential_sets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  credential_ids UUID[] NOT NULL,
  strategy VARCHAR(50) NOT NULL DEFAULT 'sequential',
  stop_on_success BOOLEAN DEFAULT TRUE,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credential_sets_name_check CHECK (name IS NOT NULL AND name <> ''),
  CONSTRAINT credential_sets_strategy_check CHECK (
    strategy IN ('sequential', 'parallel', 'adaptive')
  ),
  CONSTRAINT credential_sets_created_by_check CHECK (created_by IS NOT NULL AND created_by <> ''),
  CONSTRAINT credential_sets_credential_ids_check CHECK (array_length(credential_ids, 1) > 0)
);

CREATE INDEX idx_credential_sets_name ON credential_sets(name);
CREATE INDEX idx_credential_sets_created_by ON credential_sets(created_by);
CREATE INDEX idx_credential_sets_created_at ON credential_sets(created_at DESC);
CREATE INDEX idx_credential_sets_credential_ids ON credential_sets USING GIN(credential_ids);
CREATE INDEX idx_credential_sets_tags ON credential_sets USING GIN(tags);
CREATE UNIQUE INDEX idx_credential_sets_unique_name ON credential_sets(name, created_by);

-- ============================================
-- SECTION 4: DISCOVERY SYSTEM
-- ============================================

-- ----------------------------------------
-- discovery_agents: Agent Registration
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS discovery_agents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id VARCHAR(255) NOT NULL UNIQUE,
  hostname VARCHAR(255) NOT NULL,
  provider_capabilities TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reachable_networks CIDR[] NOT NULL DEFAULT ARRAY[]::CIDR[],
  version VARCHAR(50),
  platform VARCHAR(50),
  arch VARCHAR(50),
  api_endpoint VARCHAR(500),
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_job_at TIMESTAMPTZ,
  total_jobs_completed INTEGER NOT NULL DEFAULT 0,
  total_jobs_failed INTEGER NOT NULL DEFAULT 0,
  total_cis_discovered INTEGER NOT NULL DEFAULT 0,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_agents_status_check CHECK (
    status IN ('active', 'inactive', 'offline', 'disabled')
  )
);

CREATE INDEX idx_discovery_agents_agent_id ON discovery_agents(agent_id);
CREATE INDEX idx_discovery_agents_status ON discovery_agents(status) WHERE status = 'active';
CREATE INDEX idx_discovery_agents_hostname ON discovery_agents(hostname);
CREATE INDEX idx_discovery_agents_last_heartbeat ON discovery_agents(last_heartbeat_at DESC);
CREATE INDEX idx_discovery_agents_capabilities ON discovery_agents USING GIN(provider_capabilities);
CREATE INDEX idx_discovery_agents_tags ON discovery_agents USING GIN(tags);

-- ----------------------------------------
-- discovery_definitions: Discovery Configurations
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS discovery_definitions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  provider VARCHAR(50) NOT NULL,
  method VARCHAR(50) NOT NULL DEFAULT 'agentless',
  credential_id UUID,
  credential_set_id UUID,
  agent_id VARCHAR(255),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  last_run_status VARCHAR(50),
  last_job_id UUID,
  field_mappings JSONB DEFAULT NULL,
  CONSTRAINT discovery_definitions_name_check CHECK (name IS NOT NULL AND name <> ''),
  CONSTRAINT discovery_definitions_provider_check CHECK (
    provider IN ('nmap', 'ssh', 'active-directory', 'snmp')
  ),
  CONSTRAINT discovery_definitions_method_check CHECK (
    method IN ('agentless', 'agent')
  ),
  CONSTRAINT discovery_definitions_created_by_check CHECK (created_by IS NOT NULL AND created_by <> ''),
  CONSTRAINT discovery_definitions_last_run_status_check CHECK (
    last_run_status IS NULL OR last_run_status IN ('pending', 'running', 'completed', 'failed')
  ),
  CONSTRAINT check_credential_xor_set CHECK (
    (credential_id IS NOT NULL AND credential_set_id IS NULL) OR
    (credential_id IS NULL AND credential_set_id IS NOT NULL) OR
    (credential_id IS NULL AND credential_set_id IS NULL)
  )
);

CREATE INDEX idx_discovery_definitions_name ON discovery_definitions(name);
CREATE INDEX idx_discovery_definitions_provider ON discovery_definitions(provider);
CREATE INDEX idx_discovery_definitions_credential_id ON discovery_definitions(credential_id);
CREATE INDEX idx_discovery_definitions_credential_set_id ON discovery_definitions(credential_set_id)
  WHERE credential_set_id IS NOT NULL;
CREATE INDEX idx_discovery_definitions_agent_id ON discovery_definitions(agent_id)
  WHERE agent_id IS NOT NULL;
CREATE INDEX idx_discovery_definitions_is_active ON discovery_definitions(is_active)
  WHERE is_active = TRUE;
CREATE INDEX idx_discovery_definitions_created_by ON discovery_definitions(created_by);
CREATE INDEX idx_discovery_definitions_created_at ON discovery_definitions(created_at DESC);
CREATE INDEX idx_discovery_definitions_last_run_at ON discovery_definitions(last_run_at DESC NULLS LAST);
CREATE INDEX idx_discovery_definitions_tags ON discovery_definitions USING GIN(tags);
CREATE INDEX idx_discovery_definitions_field_mappings ON discovery_definitions USING GIN(field_mappings);
CREATE INDEX idx_discovery_definitions_scheduled ON discovery_definitions(schedule, is_active)
  WHERE schedule IS NOT NULL AND is_active = TRUE;
CREATE UNIQUE INDEX idx_discovery_definitions_unique_name ON discovery_definitions(name, created_by);

-- Add foreign key constraints
ALTER TABLE discovery_definitions
  ADD CONSTRAINT fk_discovery_definitions_credential
    FOREIGN KEY (credential_id)
    REFERENCES credentials(id)
    ON DELETE RESTRICT;

ALTER TABLE discovery_definitions
  ADD CONSTRAINT fk_discovery_definitions_credential_set
    FOREIGN KEY (credential_set_id)
    REFERENCES credential_sets(id)
    ON DELETE RESTRICT;

-- ============================================
-- SECTION 5: CONNECTOR FRAMEWORK
-- ============================================

-- ----------------------------------------
-- installed_connectors: Connector Registry
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS installed_connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type VARCHAR(100) UNIQUE NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN ('discovery', 'connector')),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  installed_version VARCHAR(20) NOT NULL,
  latest_available_version VARCHAR(20),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  installed_by VARCHAR(255),
  enabled BOOLEAN DEFAULT TRUE,
  verified BOOLEAN DEFAULT FALSE,
  install_path TEXT NOT NULL,
  metadata JSONB NOT NULL,
  capabilities JSONB DEFAULT '{
    "extraction": false,
    "relationships": false,
    "incremental": false,
    "bidirectional": false
  }'::jsonb,
  resources JSONB DEFAULT '[]'::jsonb,
  configuration_schema JSONB DEFAULT '{}'::jsonb,
  total_runs INTEGER DEFAULT 0,
  successful_runs INTEGER DEFAULT 0,
  failed_runs INTEGER DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_run_status VARCHAR(50),
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_installed_connectors_category ON installed_connectors(category);
CREATE INDEX idx_installed_connectors_enabled ON installed_connectors(enabled);
CREATE INDEX idx_installed_connectors_type ON installed_connectors(connector_type);
CREATE INDEX idx_installed_connectors_tags ON installed_connectors USING GIN(tags);

-- ----------------------------------------
-- connector_configurations: Connector Instances
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS connector_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  connector_type VARCHAR(100) NOT NULL,
  credential_id UUID,
  enabled BOOLEAN DEFAULT TRUE,
  schedule VARCHAR(100),
  schedule_enabled BOOLEAN DEFAULT FALSE,
  connection JSONB NOT NULL,
  options JSONB DEFAULT '{}',
  enabled_resources TEXT[],
  resource_configs JSONB DEFAULT '{}',
  max_retries INTEGER DEFAULT 3,
  retry_delay_seconds INTEGER DEFAULT 300,
  continue_on_error BOOLEAN DEFAULT FALSE,
  notification_channels TEXT[] DEFAULT '{}',
  notification_on_success BOOLEAN DEFAULT FALSE,
  notification_on_failure BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),
  updated_by VARCHAR(255),
  CONSTRAINT fk_connector_type
    FOREIGN KEY (connector_type)
    REFERENCES installed_connectors(connector_type)
    ON DELETE CASCADE
);

CREATE INDEX idx_connector_configs_type ON connector_configurations(connector_type);
CREATE INDEX idx_connector_configs_enabled ON connector_configurations(enabled);
CREATE INDEX idx_connector_configs_schedule_enabled ON connector_configurations(schedule_enabled);
CREATE INDEX idx_connector_configs_credential_id ON connector_configurations(credential_id)
  WHERE credential_id IS NOT NULL;
CREATE UNIQUE INDEX idx_connector_configs_name ON connector_configurations(name);

-- Add credential foreign key
ALTER TABLE connector_configurations
  ADD CONSTRAINT fk_connector_configurations_credential
    FOREIGN KEY (credential_id)
    REFERENCES credentials(id)
    ON DELETE RESTRICT;

-- ----------------------------------------
-- connector_run_history: Connector Execution Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS connector_run_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL,
  connector_type VARCHAR(100) NOT NULL,
  config_name VARCHAR(255) NOT NULL,
  resource_id VARCHAR(100),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  status VARCHAR(50) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  records_extracted INTEGER DEFAULT 0,
  records_transformed INTEGER DEFAULT 0,
  records_loaded INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  duration_ms INTEGER,
  errors JSONB DEFAULT '[]',
  error_message TEXT,
  triggered_by VARCHAR(50),
  triggered_by_user VARCHAR(255),
  job_id VARCHAR(255),
  CONSTRAINT fk_connector_config
    FOREIGN KEY (config_id)
    REFERENCES connector_configurations(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_run_history_config ON connector_run_history(config_id);
CREATE INDEX idx_run_history_connector_type ON connector_run_history(connector_type);
CREATE INDEX idx_run_history_resource ON connector_run_history(resource_id);
CREATE INDEX idx_run_history_status ON connector_run_history(status);
CREATE INDEX idx_run_history_started_at ON connector_run_history(started_at DESC);

-- ----------------------------------------
-- connector_registry_cache: Remote Catalog Cache
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS connector_registry_cache (
  connector_type VARCHAR(100) PRIMARY KEY,
  category VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  verified BOOLEAN DEFAULT FALSE,
  latest_version VARCHAR(20) NOT NULL,
  versions JSONB NOT NULL,
  author VARCHAR(255),
  homepage VARCHAR(500),
  repository VARCHAR(500),
  license VARCHAR(50),
  downloads INTEGER DEFAULT 0,
  rating DECIMAL(3, 2) DEFAULT 0.0,
  tags TEXT[] DEFAULT '{}',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cache_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_registry_cache_category ON connector_registry_cache(category);
CREATE INDEX idx_registry_cache_verified ON connector_registry_cache(verified);
CREATE INDEX idx_registry_cache_tags ON connector_registry_cache USING GIN(tags);

-- ----------------------------------------
-- connector_resource_metrics: Resource Performance
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS connector_resource_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id UUID NOT NULL,
  connector_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  avg_extraction_time_ms INTEGER,
  avg_transformation_time_ms INTEGER,
  avg_load_time_ms INTEGER,
  total_records_extracted INTEGER DEFAULT 0,
  total_records_loaded INTEGER DEFAULT 0,
  total_records_failed INTEGER DEFAULT 0,
  success_rate DECIMAL(5, 2) DEFAULT 0.0,
  CONSTRAINT fk_resource_metrics_config
    FOREIGN KEY (config_id)
    REFERENCES connector_configurations(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_resource_metrics_config ON connector_resource_metrics(config_id);
CREATE INDEX idx_resource_metrics_resource ON connector_resource_metrics(resource_id);
CREATE INDEX idx_resource_metrics_measured_at ON connector_resource_metrics(measured_at DESC);

-- ----------------------------------------
-- connector_dependencies: Dependency Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS connector_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type VARCHAR(100) NOT NULL,
  dependency_name VARCHAR(255) NOT NULL,
  dependency_version VARCHAR(50) NOT NULL,
  dependency_type VARCHAR(50) NOT NULL CHECK (dependency_type IN ('npm', 'system', 'connector')),
  installed BOOLEAN DEFAULT FALSE,
  installed_version VARCHAR(50),
  CONSTRAINT fk_dep_connector
    FOREIGN KEY (connector_type)
    REFERENCES installed_connectors(connector_type)
    ON DELETE CASCADE,
  CONSTRAINT unique_dependency UNIQUE (connector_type, dependency_name)
);

CREATE INDEX idx_dependencies_connector ON connector_dependencies(connector_type);
CREATE INDEX idx_dependencies_installed ON connector_dependencies(installed);

-- ============================================
-- SECTION 6: TRANSFORMATION ENGINE
-- ============================================

-- ----------------------------------------
-- transformation_rules: Data Mapping Rules
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS transformation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  version VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by VARCHAR(255),
  field_mappings JSONB NOT NULL,
  conditions JSONB,
  validations JSONB,
  UNIQUE(connector_type, name, version)
);

CREATE INDEX idx_transformation_rules_connector ON transformation_rules(connector_type);
CREATE INDEX idx_transformation_rules_enabled ON transformation_rules(enabled);

-- ----------------------------------------
-- transformation_lookup_tables: Lookup Data
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS transformation_lookup_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  data JSONB NOT NULL
);

-- ----------------------------------------
-- transformation_executions: Execution History
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS transformation_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES transformation_rules(id) ON DELETE CASCADE,
  connector_run_id VARCHAR(255),
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  records_processed INTEGER DEFAULT 0,
  records_succeeded INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  execution_time_ms INTEGER,
  errors JSONB
);

CREATE INDEX idx_transformation_executions_rule ON transformation_executions(rule_id);
CREATE INDEX idx_transformation_executions_time ON transformation_executions(executed_at DESC);

-- ============================================
-- SECTION 7: IDENTITY RESOLUTION
-- ============================================

-- ----------------------------------------
-- reconciliation_rules: Identity Matching Rules
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  identification_rules JSONB NOT NULL,
  merge_strategies JSONB NOT NULL,
  conditions JSONB
);

-- ----------------------------------------
-- source_authority: Source Priority Rankings
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS source_authority (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name VARCHAR(255) UNIQUE NOT NULL,
  authority_score INTEGER NOT NULL CHECK (authority_score >= 1 AND authority_score <= 10),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_source_authority_score ON source_authority(authority_score DESC);

-- ----------------------------------------
-- ci_source_lineage: Multi-source CI Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS ci_source_lineage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id UUID NOT NULL,
  source_name VARCHAR(255) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  confidence_score INTEGER CHECK (confidence_score >= 0 AND confidence_score <= 100),
  UNIQUE(ci_id, source_name, source_id)
);

CREATE INDEX idx_ci_source_lineage_ci ON ci_source_lineage(ci_id);
CREATE INDEX idx_ci_source_lineage_source ON ci_source_lineage(source_name);

-- ----------------------------------------
-- ci_field_sources: Field-level Source Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS ci_field_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id UUID NOT NULL,
  field_name VARCHAR(255) NOT NULL,
  field_value TEXT,
  source_name VARCHAR(255) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ci_id, field_name)
);

CREATE INDEX idx_ci_field_sources_ci ON ci_field_sources(ci_id);

-- ----------------------------------------
-- reconciliation_conflicts: Manual Review Queue
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id UUID,
  conflict_type VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(255),
  resolution_action VARCHAR(50),
  status VARCHAR(50) DEFAULT 'pending',
  source_data JSONB NOT NULL,
  target_data JSONB,
  conflicting_fields JSONB,
  resolution_data JSONB
);

CREATE INDEX idx_reconciliation_conflicts_status ON reconciliation_conflicts(status);
CREATE INDEX idx_reconciliation_conflicts_created_at ON reconciliation_conflicts(created_at DESC);
CREATE INDEX idx_reconciliation_conflicts_ci_id ON reconciliation_conflicts(ci_id);

-- ----------------------------------------
-- reconciliation_history: Merge History
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id UUID NOT NULL,
  reconciliation_type VARCHAR(50) NOT NULL,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  confidence_score INTEGER CHECK (confidence_score >= 0 AND confidence_score <= 100),
  source_ci_ids JSONB,
  changes JSONB
);

CREATE INDEX idx_reconciliation_history_ci ON reconciliation_history(ci_id);
CREATE INDEX idx_reconciliation_history_executed_at ON reconciliation_history(executed_at DESC);

-- ============================================
-- SECTION 8: EVENT TRACKING & METRICS
-- ============================================

-- ----------------------------------------
-- ci_change_history: Detailed Change Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS ci_change_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id VARCHAR(255) NOT NULL,
  change_type VARCHAR(50) NOT NULL,
  changed_by VARCHAR(255) DEFAULT 'system',
  change_source VARCHAR(255) NOT NULL,
  changed_fields TEXT[],
  previous_values JSONB,
  new_values JSONB,
  metadata JSONB,
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ci_change_history_ci_id ON ci_change_history(ci_id);
CREATE INDEX idx_ci_change_history_changed_at ON ci_change_history(changed_at DESC);
CREATE INDEX idx_ci_change_history_change_type ON ci_change_history(change_type);

-- ----------------------------------------
-- ci_change_statistics: Aggregated Change Stats
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS ci_change_statistics (
  ci_id VARCHAR(255) PRIMARY KEY,
  last_change_type VARCHAR(50),
  last_change_at TIMESTAMPTZ,
  total_changes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ci_change_statistics_last_change_at ON ci_change_statistics(last_change_at DESC);

-- ----------------------------------------
-- ci_change_alerts: Significant Change Alerts
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS ci_change_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id VARCHAR(255) NOT NULL,
  ci_name VARCHAR(500),
  alert_type VARCHAR(50) NOT NULL,
  changed_fields TEXT[],
  previous_values JSONB,
  new_values JSONB,
  source VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  acknowledged_by VARCHAR(255),
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ci_change_alerts_ci_id ON ci_change_alerts(ci_id);
CREATE INDEX idx_ci_change_alerts_status ON ci_change_alerts(status);
CREATE INDEX idx_ci_change_alerts_created_at ON ci_change_alerts(created_at DESC);

-- ----------------------------------------
-- metrics_timeseries: Real-time Metrics (TimescaleDB)
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS metrics_timeseries (
  timestamp TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  metric_name VARCHAR(255) NOT NULL,
  value NUMERIC NOT NULL,
  tags JSONB
);

SELECT create_hypertable('metrics_timeseries', 'timestamp', if_not_exists => TRUE);

CREATE INDEX idx_metrics_timeseries_metric_name ON metrics_timeseries(metric_name);
CREATE INDEX idx_metrics_timeseries_tags ON metrics_timeseries USING GIN(tags);

-- ----------------------------------------
-- metrics_aggregated: Pre-aggregated Metrics
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS metrics_aggregated (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "window" VARCHAR(20) NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  metric_name VARCHAR(255) NOT NULL,
  count INTEGER,
  total NUMERIC,
  average NUMERIC,
  min NUMERIC,
  max NUMERIC,
  tags JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_metrics_aggregated_window ON metrics_aggregated("window", window_start DESC);
CREATE INDEX idx_metrics_aggregated_metric_name ON metrics_aggregated(metric_name);
CREATE INDEX idx_metrics_aggregated_tags ON metrics_aggregated USING GIN(tags);

-- ----------------------------------------
-- event_processing_status: Kafka Consumer Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS event_processing_status (
  consumer_group VARCHAR(255) NOT NULL,
  topic VARCHAR(255) NOT NULL,
  partition INTEGER NOT NULL,
  "offset" BIGINT NOT NULL,
  last_processed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (consumer_group, topic, partition)
);

CREATE INDEX idx_event_processing_status_group ON event_processing_status(consumer_group);

-- ----------------------------------------
-- event_dlq: Dead Letter Queue
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS event_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_topic VARCHAR(255) NOT NULL,
  original_event_type VARCHAR(100) NOT NULL,
  original_event_id VARCHAR(255),
  event_data JSONB NOT NULL,
  error_message TEXT,
  error_stack TEXT,
  failed_at TIMESTAMPTZ DEFAULT NOW(),
  retry_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'failed',
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_event_dlq_status ON event_dlq(status);
CREATE INDEX idx_event_dlq_failed_at ON event_dlq(failed_at DESC);
CREATE INDEX idx_event_dlq_original_topic ON event_dlq(original_topic);

-- ============================================
-- SECTION 9: AI/ML ENGINES
-- ============================================

-- ----------------------------------------
-- anomalies: Detected Anomalies
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS anomalies (
  id UUID PRIMARY KEY,
  ci_id VARCHAR(255) NOT NULL,
  ci_name VARCHAR(500),
  anomaly_type VARCHAR(100) NOT NULL,
  severity VARCHAR(50) NOT NULL,
  confidence_score INTEGER CHECK (confidence_score >= 0 AND confidence_score <= 100),
  detected_at TIMESTAMPTZ NOT NULL,
  description TEXT,
  metrics JSONB,
  context JSONB,
  status VARCHAR(50) DEFAULT 'detected',
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_anomalies_ci_id ON anomalies(ci_id);
CREATE INDEX idx_anomalies_detected_at ON anomalies(detected_at DESC);
CREATE INDEX idx_anomalies_severity ON anomalies(severity);
CREATE INDEX idx_anomalies_status ON anomalies(status);
CREATE INDEX idx_anomalies_type ON anomalies(anomaly_type);

-- ----------------------------------------
-- impact_analyses: Change Impact Analysis
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS impact_analyses (
  id UUID PRIMARY KEY,
  source_ci_id VARCHAR(255) NOT NULL,
  source_ci_name VARCHAR(500),
  change_type VARCHAR(100) NOT NULL,
  impact_score INTEGER CHECK (impact_score >= 0 AND impact_score <= 100),
  blast_radius INTEGER DEFAULT 0,
  critical_path JSONB,
  risk_level VARCHAR(50) NOT NULL,
  analyzed_at TIMESTAMPTZ NOT NULL,
  estimated_downtime_minutes INTEGER,
  affected_cis JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_impact_analyses_source_ci ON impact_analyses(source_ci_id);
CREATE INDEX idx_impact_analyses_analyzed_at ON impact_analyses(analyzed_at DESC);
CREATE INDEX idx_impact_analyses_risk_level ON impact_analyses(risk_level);
CREATE INDEX idx_impact_analyses_impact_score ON impact_analyses(impact_score DESC);

-- ----------------------------------------
-- ci_criticality_scores: Criticality Ranking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS ci_criticality_scores (
  ci_id VARCHAR(255) PRIMARY KEY,
  ci_name VARCHAR(500),
  criticality_score INTEGER CHECK (criticality_score >= 0 AND criticality_score <= 100),
  factors JSONB NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_criticality_scores_score ON ci_criticality_scores(criticality_score DESC);
CREATE INDEX idx_criticality_scores_calculated_at ON ci_criticality_scores(calculated_at DESC);

-- ----------------------------------------
-- baseline_snapshots: Configuration Baselines
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS baseline_snapshots (
  id UUID PRIMARY KEY,
  ci_id VARCHAR(255) NOT NULL,
  snapshot_type VARCHAR(50) NOT NULL,
  snapshot_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  is_approved BOOLEAN DEFAULT FALSE,
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ
);

CREATE INDEX idx_baseline_snapshots_ci_id ON baseline_snapshots(ci_id);
CREATE INDEX idx_baseline_snapshots_type ON baseline_snapshots(snapshot_type);
CREATE INDEX idx_baseline_snapshots_approved ON baseline_snapshots(is_approved);
CREATE INDEX idx_baseline_snapshots_created_at ON baseline_snapshots(created_at DESC);

-- ----------------------------------------
-- drift_detection_results: Configuration Drift
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS drift_detection_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id VARCHAR(255) NOT NULL,
  ci_name VARCHAR(500),
  has_drift BOOLEAN NOT NULL,
  drift_score INTEGER CHECK (drift_score >= 0 AND drift_score <= 100),
  drifted_fields JSONB,
  baseline_snapshot_id UUID REFERENCES baseline_snapshots(id),
  detected_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_drift_results_ci_id ON drift_detection_results(ci_id);
CREATE INDEX idx_drift_results_detected_at ON drift_detection_results(detected_at DESC);
CREATE INDEX idx_drift_results_has_drift ON drift_detection_results(has_drift);
CREATE INDEX idx_drift_results_drift_score ON drift_detection_results(drift_score DESC);

-- ----------------------------------------
-- system_config: System Configuration
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS system_config (
  config_key VARCHAR(255) PRIMARY KEY,
  config_value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by VARCHAR(255)
);

-- ----------------------------------------
-- ml_model_training_history: Model Training Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS ml_model_training_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_type VARCHAR(100) NOT NULL,
  model_version VARCHAR(50) NOT NULL,
  training_started_at TIMESTAMPTZ NOT NULL,
  training_completed_at TIMESTAMPTZ,
  training_duration_minutes INTEGER,
  training_dataset_size INTEGER,
  accuracy_score NUMERIC(5,4),
  precision_score NUMERIC(5,4),
  recall_score NUMERIC(5,4),
  f1_score NUMERIC(5,4),
  hyperparameters JSONB,
  status VARCHAR(50) DEFAULT 'training',
  deployed_at TIMESTAMPTZ,
  created_by VARCHAR(255)
);

CREATE INDEX idx_ml_training_model_type ON ml_model_training_history(model_type);
CREATE INDEX idx_ml_training_status ON ml_model_training_history(status);
CREATE INDEX idx_ml_training_started_at ON ml_model_training_history(training_started_at DESC);

-- ============================================
-- UTILITY FUNCTIONS
-- ============================================

-- Function to get or create date key from timestamp
CREATE OR REPLACE FUNCTION cmdb.get_date_key(ts TIMESTAMPTZ)
RETURNS INTEGER AS $$
DECLARE
    target_date DATE;
    result_key INTEGER;
BEGIN
    target_date := ts::DATE;
    SELECT date_key INTO result_key
    FROM cmdb.dim_time
    WHERE full_date = target_date;
    IF NOT FOUND THEN
        INSERT INTO cmdb.dim_time (
            date_key, full_date, year, quarter, month, month_name,
            week, day_of_month, day_of_week, day_name, is_weekend,
            fiscal_year, fiscal_quarter
        )
        VALUES (
            TO_CHAR(target_date, 'YYYYMMDD')::INTEGER,
            target_date,
            EXTRACT(YEAR FROM target_date)::INTEGER,
            EXTRACT(QUARTER FROM target_date)::INTEGER,
            EXTRACT(MONTH FROM target_date)::INTEGER,
            TO_CHAR(target_date, 'Month'),
            EXTRACT(WEEK FROM target_date)::INTEGER,
            EXTRACT(DAY FROM target_date)::INTEGER,
            EXTRACT(DOW FROM target_date)::INTEGER,
            TO_CHAR(target_date, 'Day'),
            EXTRACT(DOW FROM target_date) IN (0, 6),
            EXTRACT(YEAR FROM target_date)::INTEGER,
            EXTRACT(QUARTER FROM target_date)::INTEGER
        )
        RETURNING date_key INTO result_key;
    END IF;
    RETURN result_key;
END;
$$ LANGUAGE plpgsql;

-- Function to log CI changes automatically
CREATE OR REPLACE FUNCTION log_ci_change()
RETURNS TRIGGER AS $$
DECLARE
  changes_array JSONB := '[]'::jsonb;
  change_record JSONB;
  col_name TEXT;
  old_val TEXT;
  new_val TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR col_name IN
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = TG_TABLE_NAME
      AND column_name NOT IN ('id', 'created_at', 'updated_at')
    LOOP
      EXECUTE format('SELECT ($1).%I::TEXT, ($2).%I::TEXT', col_name, col_name)
        INTO old_val, new_val
        USING OLD, NEW;
      IF old_val IS DISTINCT FROM new_val THEN
        change_record := jsonb_build_object(
          'field', col_name,
          'old_value', old_val,
          'new_value', new_val
        );
        changes_array := changes_array || change_record;
      END IF;
    END LOOP;
  END IF;
  INSERT INTO audit_log (
    entity_type, entity_id, action, actor, actor_type, changes
  ) VALUES (
    'CI'::audit_entity_type,
    COALESCE(NEW.id, OLD.id),
    CASE
      WHEN TG_OP = 'INSERT' THEN 'CREATE'::audit_action
      WHEN TG_OP = 'UPDATE' THEN 'UPDATE'::audit_action
      WHEN TG_OP = 'DELETE' THEN 'DELETE'::audit_action
    END,
    current_user,
    'system'::audit_actor_type,
    changes_array
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- UPDATE TRIGGERS
-- ============================================

-- Credentials updated_at trigger
CREATE OR REPLACE FUNCTION update_credentials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_credentials_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW
  EXECUTE FUNCTION update_credentials_updated_at();

CREATE TRIGGER trigger_update_credential_sets_updated_at
  BEFORE UPDATE ON credential_sets
  FOR EACH ROW
  EXECUTE FUNCTION update_credentials_updated_at();

-- Discovery agents updated_at trigger
CREATE OR REPLACE FUNCTION update_discovery_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_discovery_agents_updated_at
  BEFORE UPDATE ON discovery_agents
  FOR EACH ROW
  EXECUTE FUNCTION update_discovery_agents_updated_at();

-- Discovery definitions updated_at trigger
CREATE OR REPLACE FUNCTION update_discovery_definitions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_discovery_definitions_updated_at
  BEFORE UPDATE ON discovery_definitions
  FOR EACH ROW
  EXECUTE FUNCTION update_discovery_definitions_updated_at();

-- Connector updated_at triggers
CREATE OR REPLACE FUNCTION update_installed_connectors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_installed_connectors_updated_at
BEFORE UPDATE ON installed_connectors
FOR EACH ROW
EXECUTE FUNCTION update_installed_connectors_updated_at();

CREATE OR REPLACE FUNCTION update_connector_configurations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_connector_configurations_updated_at
BEFORE UPDATE ON connector_configurations
FOR EACH ROW
EXECUTE FUNCTION update_connector_configurations_updated_at();

-- Transformation updated_at triggers
CREATE TRIGGER trigger_transformation_rules_updated_at
BEFORE UPDATE ON transformation_rules
FOR EACH ROW
EXECUTE FUNCTION update_connector_configurations_updated_at();

CREATE TRIGGER trigger_transformation_lookup_tables_updated_at
BEFORE UPDATE ON transformation_lookup_tables
FOR EACH ROW
EXECUTE FUNCTION update_connector_configurations_updated_at();

-- Reconciliation updated_at triggers
CREATE TRIGGER trigger_reconciliation_rules_updated_at
BEFORE UPDATE ON reconciliation_rules
FOR EACH ROW
EXECUTE FUNCTION update_connector_configurations_updated_at();

CREATE TRIGGER trigger_source_authority_updated_at
BEFORE UPDATE ON source_authority
FOR EACH ROW
EXECUTE FUNCTION update_connector_configurations_updated_at();

-- ============================================
-- ANALYTICAL VIEWS
-- ============================================

-- Current CI inventory
CREATE OR REPLACE VIEW cmdb.v_current_ci_inventory AS
SELECT
    ci_key, ci_id, ci_name, ci_type, ci_status, environment,
    external_id, metadata, effective_from, created_at, updated_at
FROM cmdb.dim_ci
WHERE is_current = TRUE;

-- CI discovery summary
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
GROUP BY c.ci_id, c.ci_name, c.ci_type, f.discovery_provider;

-- CI change history
CREATE OR REPLACE VIEW cmdb.v_ci_change_history AS
SELECT
    ch.change_key, c.ci_id, c.ci_name, c.ci_type, ch.change_type,
    ch.field_name, ch.old_value, ch.new_value, ch.changed_at,
    ch.changed_by, ch.change_source, t.full_date, t.year, t.month, t.quarter
FROM cmdb.fact_ci_changes ch
INNER JOIN cmdb.dim_ci c ON ch.ci_key = c.ci_key
INNER JOIN cmdb.dim_time t ON ch.date_key = t.date_key
WHERE c.is_current = TRUE
ORDER BY ch.changed_at DESC;

-- CI relationships
CREATE OR REPLACE VIEW cmdb.v_ci_relationships AS
SELECT
    r.relationship_key,
    from_ci.ci_id AS from_ci_id, from_ci.ci_name AS from_ci_name, from_ci.ci_type AS from_ci_type,
    r.relationship_type,
    to_ci.ci_id AS to_ci_id, to_ci.ci_name AS to_ci_name, to_ci.ci_type AS to_ci_type,
    r.relationship_strength, r.discovered_at, r.last_verified_at, r.properties
FROM cmdb.fact_ci_relationships r
INNER JOIN cmdb.dim_ci from_ci ON r.from_ci_key = from_ci.ci_key
INNER JOIN cmdb.dim_ci to_ci ON r.to_ci_key = to_ci.ci_key
WHERE r.is_active = TRUE
  AND from_ci.is_current = TRUE
  AND to_ci.is_current = TRUE;

-- Recent audit activity
CREATE OR REPLACE VIEW recent_audit_activity AS
SELECT
  id, entity_type, entity_id, action, actor, actor_type, timestamp,
  jsonb_array_length(changes) as change_count
FROM audit_log
WHERE timestamp >= NOW() - INTERVAL '30 days'
ORDER BY timestamp DESC;

-- CI change history from audit log (view with detailed field changes)
CREATE OR REPLACE VIEW v_ci_change_history_audit AS
SELECT
  al.id, al.entity_id as ci_id, al.action, al.actor, al.actor_type,
  al.changes, al.timestamp,
  c->>'field' as field_changed,
  c->>'old_value' as old_value,
  c->>'new_value' as new_value
FROM audit_log al
CROSS JOIN LATERAL jsonb_array_elements(al.changes) as c
WHERE al.entity_type = 'CI'
ORDER BY al.timestamp DESC;

-- Active API keys
CREATE OR REPLACE VIEW active_api_keys AS
SELECT
  id, user_id, name, role, created_at, expires_at, last_used_at
FROM api_keys
WHERE enabled = TRUE
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY created_at DESC;

-- Credential summaries
CREATE OR REPLACE VIEW credential_summaries AS
SELECT
  c.id, c.name, c.description, c.protocol, c.scope, c.affinity, c.tags,
  c.created_by, c.created_at, c.updated_at, c.last_validated_at, c.validation_status,
  (SELECT COUNT(*) FROM discovery_definitions dd WHERE dd.credential_id = c.id) AS usage_count,
  (SELECT COUNT(*) FROM connector_configurations cc WHERE cc.credential_id = c.id) AS connector_usage_count
FROM credentials c
ORDER BY c.created_at DESC;

-- Credential set summaries
CREATE OR REPLACE VIEW credential_set_summaries AS
SELECT
  cs.id, cs.name, cs.description, cs.strategy, cs.stop_on_success, cs.tags,
  cs.created_by, cs.created_at, cs.updated_at, cs.credential_ids,
  (SELECT COUNT(*) FROM discovery_definitions dd WHERE dd.credential_set_id = cs.id) AS usage_count,
  (SELECT json_agg(
    json_build_object(
      'id', c.id, 'name', c.name, 'protocol', c.protocol, 'scope', c.scope,
      'affinity', c.affinity, 'priority', COALESCE((c.affinity->>'priority')::int, 5)
    )
    ORDER BY array_position(cs.credential_ids, c.id)
  ) FROM credentials c WHERE c.id = ANY(cs.credential_ids)) AS credentials
FROM credential_sets cs
ORDER BY cs.created_at DESC;

-- Discovery definitions with credentials
CREATE OR REPLACE VIEW discovery_definitions_with_credentials AS
SELECT
  dd.id, dd.name, dd.description, dd.provider, dd.method,
  dd.credential_id, dd.credential_set_id, dd.config, dd.schedule,
  dd.is_active, dd.tags, dd.created_by, dd.last_run_at, dd.last_run_status,
  c.name AS credential_name, c.protocol AS credential_protocol, c.scope AS credential_scope,
  cs.name AS credential_set_name, cs.strategy AS credential_set_strategy,
  (SELECT COUNT(*) FROM unnest(cs.credential_ids) cid) AS credential_set_size
FROM discovery_definitions dd
LEFT JOIN credentials c ON dd.credential_id = c.id
LEFT JOIN credential_sets cs ON dd.credential_set_id = cs.id
ORDER BY dd.created_at DESC;

-- Active discovery agents
CREATE OR REPLACE VIEW active_discovery_agents AS
SELECT
  id, agent_id, hostname, provider_capabilities, reachable_networks,
  version, platform, arch, status, last_heartbeat_at, last_job_at,
  total_jobs_completed, total_jobs_failed, total_cis_discovered, tags, registered_at,
  CASE
    WHEN total_jobs_completed + total_jobs_failed > 0
    THEN ROUND((total_jobs_completed::numeric / (total_jobs_completed + total_jobs_failed)) * 100, 2)
    ELSE 0
  END AS success_rate,
  EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))::INTEGER AS seconds_since_heartbeat,
  (NOW() - last_heartbeat_at) > INTERVAL '5 minutes' AS is_stale
FROM discovery_agents
WHERE status = 'active'
ORDER BY last_heartbeat_at DESC;

-- Agent network coverage
CREATE OR REPLACE VIEW agent_network_coverage AS
SELECT
  agent_id, hostname, unnest(reachable_networks) AS network,
  status, last_heartbeat_at
FROM discovery_agents
WHERE status = 'active'
ORDER BY agent_id, network;

-- ============================================
-- INITIAL DATA POPULATION
-- ============================================

-- Pre-populate time dimension for 10 years (2020-2030)
INSERT INTO cmdb.dim_time (
    date_key, full_date, year, quarter, month, month_name,
    week, day_of_month, day_of_week, day_name, is_weekend,
    fiscal_year, fiscal_quarter
)
SELECT
    TO_CHAR(date_series, 'YYYYMMDD')::INTEGER,
    date_series::DATE,
    EXTRACT(YEAR FROM date_series)::INTEGER,
    EXTRACT(QUARTER FROM date_series)::INTEGER,
    EXTRACT(MONTH FROM date_series)::INTEGER,
    TO_CHAR(date_series, 'Month'),
    EXTRACT(WEEK FROM date_series)::INTEGER,
    EXTRACT(DAY FROM date_series)::INTEGER,
    EXTRACT(DOW FROM date_series)::INTEGER,
    TO_CHAR(date_series, 'Day'),
    EXTRACT(DOW FROM date_series) IN (0, 6),
    EXTRACT(YEAR FROM date_series)::INTEGER,
    EXTRACT(QUARTER FROM date_series)::INTEGER
FROM generate_series(
    '2020-01-01'::DATE,
    '2030-12-31'::DATE,
    '1 day'::INTERVAL
) AS date_series
ON CONFLICT (full_date) DO NOTHING;

-- Insert default anomaly detection config
INSERT INTO system_config (config_key, config_value, description)
VALUES (
  'anomaly_detection',
  '{"enabled": true, "sensitivity": "medium", "min_confidence_score": 70, "check_interval_minutes": 60, "lookback_days": 30, "notification_enabled": true}',
  'Anomaly detection engine configuration'
) ON CONFLICT (config_key) DO NOTHING;

-- ============================================
-- GRANTS AND PERMISSIONS
-- ============================================

-- Grant usage on schemas
GRANT USAGE ON SCHEMA cmdb TO PUBLIC;

-- Grant select on all tables in cmdb schema
GRANT SELECT ON ALL TABLES IN SCHEMA cmdb TO PUBLIC;

-- Grant usage on sequences
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cmdb TO PUBLIC;

-- Grant permissions on public schema tables
GRANT SELECT ON audit_log TO PUBLIC;
GRANT SELECT ON recent_audit_activity TO PUBLIC;
GRANT SELECT ON ci_change_history TO PUBLIC;
GRANT SELECT ON v_ci_change_history_audit TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO PUBLIC;
GRANT SELECT ON active_api_keys TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON credentials TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON credential_sets TO PUBLIC;
GRANT SELECT ON credential_summaries TO PUBLIC;
GRANT SELECT ON credential_set_summaries TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON discovery_agents TO PUBLIC;
GRANT SELECT ON active_discovery_agents TO PUBLIC;
GRANT SELECT ON agent_network_coverage TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON discovery_definitions TO PUBLIC;
GRANT SELECT ON discovery_definitions_with_credentials TO PUBLIC;

-- ============================================
-- TABLE COMMENTS
-- ============================================

COMMENT ON TABLE audit_log IS 'Comprehensive audit trail for all CI and relationship changes';
COMMENT ON TABLE api_keys IS 'API keys for authentication and authorization';
COMMENT ON TABLE credentials IS 'Unified credential system with protocol-based authentication';
COMMENT ON TABLE credential_sets IS 'Groups of credentials to try in order (for NMAP, SSH discovery, etc.)';
COMMENT ON TABLE discovery_agents IS 'Registered discovery agents with their capabilities and network reach';
COMMENT ON TABLE discovery_definitions IS 'Network-based discovery configurations for UNKNOWN infrastructure. For API-based import from KNOWN systems (AWS, Azure, GCP, Kubernetes, VMware, etc.), use the Connectors system instead.';
COMMENT ON TABLE installed_connectors IS 'Installed connectors registry with metadata and capabilities';
COMMENT ON TABLE connector_configurations IS 'User-configured connector instances';
COMMENT ON TABLE connector_run_history IS 'Execution history for all connector runs';
COMMENT ON TABLE transformation_rules IS 'Data transformation and mapping rules';
COMMENT ON TABLE reconciliation_rules IS 'Identity resolution and merge strategies';
COMMENT ON TABLE ci_change_history IS 'Tracks all changes to Configuration Items for audit and history';
COMMENT ON TABLE anomalies IS 'Detected anomalies in CI behavior and configuration';
COMMENT ON TABLE impact_analyses IS 'Change impact analysis results for risk assessment';
COMMENT ON TABLE baseline_snapshots IS 'Configuration baselines for drift detection';
COMMENT ON TABLE drift_detection_results IS 'Configuration drift detection results';

-- ============================================
-- END OF CONSOLIDATED SCHEMA MIGRATION
-- ============================================
