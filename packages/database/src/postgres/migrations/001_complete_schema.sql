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
-- Extended for v3.0 with ITIL, TBM, and BSM attributes
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
    -- v3.0: ITIL Service Configuration Management attributes
    itil_attributes JSONB DEFAULT '{
        "ci_class": "hardware",
        "lifecycle_stage": "operate",
        "configuration_status": "active",
        "version": "1.0.0",
        "audit_status": "unknown"
    }'::jsonb,
    -- v3.0: TBM Cost Allocation attributes
    tbm_attributes JSONB DEFAULT '{
        "resource_tower": "compute",
        "cost_pool": "hardware",
        "monthly_cost": 0,
        "cost_allocation_method": "usage_based"
    }'::jsonb,
    -- v3.0: Business Service Mapping attributes
    bsm_attributes JSONB DEFAULT '{
        "business_criticality": "tier_4",
        "supports_business_services": [],
        "customer_facing": false,
        "compliance_scope": [],
        "data_classification": "internal"
    }'::jsonb,
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
-- v3.0: Indexes for ITIL, TBM, and BSM attributes
CREATE INDEX IF NOT EXISTS idx_dim_ci_itil_attributes ON cmdb.dim_ci USING GIN(itil_attributes);
CREATE INDEX IF NOT EXISTS idx_dim_ci_tbm_attributes ON cmdb.dim_ci USING GIN(tbm_attributes);
CREATE INDEX IF NOT EXISTS idx_dim_ci_bsm_attributes ON cmdb.dim_ci USING GIN(bsm_attributes);

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
-- SECTION 1B: v3.0 UNIFIED DATA MODEL ENTITIES
-- ============================================
-- This section implements the v3.0 unified ITIL + TBM + BSM entities:
-- - Business Services (BSM + ITIL Service)
-- - Application Services (TBM IT Solution + ITIL Application CI)
-- - Business Capabilities (TBM Business Layer)
-- - ITIL-specific operational tables
-- - TBM-specific cost management tables
-- - Service dependency relationships
-- ============================================

-- ----------------------------------------
-- business_services: Business Service Catalog
-- Unified view of business services with ITIL, TBM, and BSM attributes
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS business_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- ITIL Service Management attributes
    itil_attributes JSONB NOT NULL DEFAULT '{
        "service_owner": "",
        "service_type": "internal",
        "service_hours": {"availability": "24x7", "timezone": "UTC"},
        "sla_targets": {"availability_percentage": 99.9, "response_time_ms": 1000},
        "support_level": "l2",
        "incident_count_30d": 0,
        "change_count_30d": 0,
        "availability_30d": 100.0
    }'::jsonb,

    -- TBM Cost Transparency attributes
    tbm_attributes JSONB NOT NULL DEFAULT '{
        "total_monthly_cost": 0,
        "cost_per_user": 0,
        "cost_per_transaction": 0,
        "cost_breakdown_by_tower": {},
        "cost_trend": "stable"
    }'::jsonb,

    -- Business Service Mapping attributes
    bsm_attributes JSONB NOT NULL DEFAULT '{
        "business_criticality": "tier_3",
        "capabilities_enabled": [],
        "value_streams": [],
        "business_impact_score": 0,
        "risk_rating": "medium",
        "annual_revenue_supported": 0,
        "customer_count": 0,
        "transaction_volume_daily": 0,
        "compliance_requirements": [],
        "data_sensitivity": "internal",
        "sox_scope": false,
        "pci_scope": false,
        "recovery_time_objective": 240,
        "recovery_point_objective": 60,
        "disaster_recovery_tier": 3
    }'::jsonb,

    -- Technical ownership
    technical_owner VARCHAR(255),
    platform_team VARCHAR(255),

    -- Operational state
    operational_status VARCHAR(50) NOT NULL DEFAULT 'operational',
    last_incident TIMESTAMPTZ,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    updated_by VARCHAR(255),
    last_validated TIMESTAMPTZ,

    CONSTRAINT business_services_name_check CHECK (name IS NOT NULL AND name <> ''),
    CONSTRAINT business_services_operational_status_check CHECK (
        operational_status IN ('operational', 'degraded', 'outage', 'maintenance')
    )
);

CREATE INDEX idx_business_services_name ON business_services(name);
CREATE INDEX idx_business_services_operational_status ON business_services(operational_status);
CREATE INDEX idx_business_services_technical_owner ON business_services(technical_owner);
CREATE INDEX idx_business_services_created_at ON business_services(created_at DESC);
CREATE INDEX idx_business_services_itil_attributes ON business_services USING GIN(itil_attributes);
CREATE INDEX idx_business_services_tbm_attributes ON business_services USING GIN(tbm_attributes);
CREATE INDEX idx_business_services_bsm_attributes ON business_services USING GIN(bsm_attributes);
CREATE UNIQUE INDEX idx_business_services_unique_name ON business_services(name);

COMMENT ON TABLE business_services IS 'v3.0 Unified business service catalog with ITIL, TBM, and BSM perspectives';

-- ----------------------------------------
-- application_services: Application Service Inventory
-- Maps to TBM IT Solution + ITIL Application CI
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS application_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- TBM IT Solution attributes
    tbm_attributes JSONB NOT NULL DEFAULT '{
        "solution_type": "application",
        "it_tower_alignment": "",
        "total_monthly_cost": 0,
        "cost_breakdown": {
            "infrastructure": 0,
            "licenses": 0,
            "labor": 0,
            "support": 0
        }
    }'::jsonb,

    -- ITIL Service attributes
    itil_attributes JSONB NOT NULL DEFAULT '{
        "service_type": "technical_service",
        "service_owner": "",
        "lifecycle_stage": "operate",
        "release_version": "1.0.0",
        "change_schedule": ""
    }'::jsonb,

    -- Application portfolio management
    application_attributes JSONB NOT NULL DEFAULT '{
        "application_type": "web_application",
        "technology_stack": {
            "primary_language": "",
            "frameworks": [],
            "databases": [],
            "messaging": [],
            "caching": [],
            "monitoring": []
        },
        "deployment_model": "cloud_native",
        "architecture_pattern": "microservices",
        "product_owner": "",
        "development_team": "",
        "vendor_product": false,
        "vendor_name": null
    }'::jsonb,

    -- Quality & performance metrics
    quality_metrics JSONB NOT NULL DEFAULT '{
        "code_repository": "",
        "test_coverage_percentage": 0,
        "defect_density": 0,
        "availability_percentage": 0,
        "response_time_p95": 0
    }'::jsonb,

    -- Business alignment
    business_value_score INTEGER DEFAULT 0 CHECK (business_value_score >= 0 AND business_value_score <= 100),

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    updated_by VARCHAR(255),

    CONSTRAINT application_services_name_check CHECK (name IS NOT NULL AND name <> '')
);

CREATE INDEX idx_application_services_name ON application_services(name);
CREATE INDEX idx_application_services_business_value ON application_services(business_value_score DESC);
CREATE INDEX idx_application_services_created_at ON application_services(created_at DESC);
CREATE INDEX idx_application_services_tbm_attributes ON application_services USING GIN(tbm_attributes);
CREATE INDEX idx_application_services_itil_attributes ON application_services USING GIN(itil_attributes);
CREATE INDEX idx_application_services_app_attributes ON application_services USING GIN(application_attributes);
CREATE INDEX idx_application_services_quality_metrics ON application_services USING GIN(quality_metrics);
CREATE UNIQUE INDEX idx_application_services_unique_name ON application_services(name);

COMMENT ON TABLE application_services IS 'v3.0 Application service inventory with TBM IT Solution and ITIL Application CI mapping';

-- ----------------------------------------
-- business_capabilities: Business Capability Taxonomy
-- Maps to TBM Business Layer
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS business_capabilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- TBM Business Layer attributes
    tbm_attributes JSONB NOT NULL DEFAULT '{
        "business_unit": "",
        "total_monthly_cost": 0,
        "cost_per_employee": 0,
        "budget_annual": 0,
        "variance_percentage": 0
    }'::jsonb,

    -- Business context
    capability_attributes JSONB NOT NULL DEFAULT '{
        "capability_type": "supporting",
        "parent_capability_id": null,
        "strategic_importance": "medium",
        "maturity_level": "managed",
        "lifecycle_stage": "maintain",
        "capability_owner": ""
    }'::jsonb,

    -- Business value
    value_attributes JSONB NOT NULL DEFAULT '{
        "revenue_impact": {
            "direct_revenue": false,
            "annual_revenue_supported": 0,
            "customer_count_impacted": 0,
            "transaction_volume": 0
        },
        "customer_facing": false,
        "user_count": 0,
        "regulatory_requirements": [],
        "competitive_advantage": false
    }'::jsonb,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    updated_by VARCHAR(255),

    CONSTRAINT business_capabilities_name_check CHECK (name IS NOT NULL AND name <> '')
);

CREATE INDEX idx_business_capabilities_name ON business_capabilities(name);
CREATE INDEX idx_business_capabilities_created_at ON business_capabilities(created_at DESC);
CREATE INDEX idx_business_capabilities_tbm_attributes ON business_capabilities USING GIN(tbm_attributes);
CREATE INDEX idx_business_capabilities_capability_attributes ON business_capabilities USING GIN(capability_attributes);
CREATE INDEX idx_business_capabilities_value_attributes ON business_capabilities USING GIN(value_attributes);
CREATE UNIQUE INDEX idx_business_capabilities_unique_name ON business_capabilities(name);

COMMENT ON TABLE business_capabilities IS 'v3.0 Business capability taxonomy with TBM Business Layer support';

-- ----------------------------------------
-- service_dependencies: Service Relationship Mapping
-- Links business services to application services to infrastructure CIs
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS service_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Source entity (polymorphic)
    source_type VARCHAR(50) NOT NULL,
    source_id UUID NOT NULL,

    -- Target entity (polymorphic)
    target_type VARCHAR(50) NOT NULL,
    target_id UUID NOT NULL,

    -- Relationship metadata
    dependency_type VARCHAR(50) NOT NULL,
    dependency_strength DECIMAL(3, 2) DEFAULT 1.0 CHECK (dependency_strength >= 0 AND dependency_strength <= 1.0),
    is_critical BOOLEAN DEFAULT FALSE,

    -- Discovery metadata
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_verified_at TIMESTAMPTZ,
    discovered_by VARCHAR(255) NOT NULL DEFAULT 'system',

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT service_dependencies_source_type_check CHECK (
        source_type IN ('business_capability', 'business_service', 'application_service', 'configuration_item')
    ),
    CONSTRAINT service_dependencies_target_type_check CHECK (
        target_type IN ('business_capability', 'business_service', 'application_service', 'configuration_item')
    ),
    CONSTRAINT service_dependencies_dependency_type_check CHECK (
        dependency_type IN ('DELIVERS', 'ENABLED_BY', 'RUNS_ON', 'DEPENDS_ON', 'USES', 'SUPPORTS')
    ),
    CONSTRAINT service_dependencies_unique_dependency UNIQUE (source_type, source_id, target_type, target_id, dependency_type)
);

CREATE INDEX idx_service_dependencies_source ON service_dependencies(source_type, source_id);
CREATE INDEX idx_service_dependencies_target ON service_dependencies(target_type, target_id);
CREATE INDEX idx_service_dependencies_type ON service_dependencies(dependency_type);
CREATE INDEX idx_service_dependencies_critical ON service_dependencies(is_critical) WHERE is_critical = TRUE;
CREATE INDEX idx_service_dependencies_discovered_at ON service_dependencies(discovered_at DESC);

COMMENT ON TABLE service_dependencies IS 'v3.0 Service dependency relationships across business capabilities, business services, application services, and infrastructure CIs';

-- ----------------------------------------
-- itil_baselines: ITIL Configuration Baselines
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS itil_baselines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    baseline_type VARCHAR(50) NOT NULL,

    -- Baseline scope
    scope JSONB NOT NULL DEFAULT '{
        "ci_ids": [],
        "ci_types": [],
        "environment": null
    }'::jsonb,

    -- Baseline data
    baseline_data JSONB NOT NULL,

    -- Approval workflow
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    created_by VARCHAR(255) NOT NULL,
    approved_by VARCHAR(255),
    approved_at TIMESTAMPTZ,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT itil_baselines_name_check CHECK (name IS NOT NULL AND name <> ''),
    CONSTRAINT itil_baselines_type_check CHECK (
        baseline_type IN ('configuration', 'security', 'performance', 'compliance')
    ),
    CONSTRAINT itil_baselines_status_check CHECK (
        status IN ('draft', 'pending_approval', 'approved', 'rejected', 'deprecated')
    )
);

CREATE INDEX idx_itil_baselines_name ON itil_baselines(name);
CREATE INDEX idx_itil_baselines_type ON itil_baselines(baseline_type);
CREATE INDEX idx_itil_baselines_status ON itil_baselines(status);
CREATE INDEX idx_itil_baselines_created_at ON itil_baselines(created_at DESC);
CREATE INDEX idx_itil_baselines_approved ON itil_baselines(approved_at DESC) WHERE approved_at IS NOT NULL;
CREATE INDEX idx_itil_baselines_scope ON itil_baselines USING GIN(scope);
CREATE UNIQUE INDEX idx_itil_baselines_unique_name ON itil_baselines(name);

COMMENT ON TABLE itil_baselines IS 'v3.0 ITIL configuration baselines for compliance and drift detection';

-- ----------------------------------------
-- itil_incidents: ITIL Incident Management
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS itil_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,

    -- ITIL classification
    category VARCHAR(100),
    subcategory VARCHAR(100),
    impact VARCHAR(20) NOT NULL,
    urgency VARCHAR(20) NOT NULL,
    priority INTEGER NOT NULL CHECK (priority >= 1 AND priority <= 5),

    -- Affected entities
    affected_ci_id VARCHAR(255),
    affected_business_service_id UUID,
    affected_application_service_id UUID,

    -- Business impact (auto-calculated from BSM)
    business_impact JSONB DEFAULT '{
        "estimated_user_impact": 0,
        "estimated_revenue_impact": 0,
        "estimated_cost_of_downtime": 0,
        "affected_services": []
    }'::jsonb,

    -- Assignment
    assigned_to VARCHAR(255),
    assigned_group VARCHAR(255),

    -- Status tracking
    status VARCHAR(50) NOT NULL DEFAULT 'new',
    resolution TEXT,
    resolution_code VARCHAR(100),

    -- Timestamps
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,

    -- Metrics
    time_to_acknowledge_minutes INTEGER,
    time_to_resolve_minutes INTEGER,

    -- Reporter
    reported_by VARCHAR(255) NOT NULL,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT itil_incidents_impact_check CHECK (impact IN ('critical', 'high', 'medium', 'low')),
    CONSTRAINT itil_incidents_urgency_check CHECK (urgency IN ('critical', 'high', 'medium', 'low')),
    CONSTRAINT itil_incidents_status_check CHECK (
        status IN ('new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled')
    )
);

CREATE INDEX idx_itil_incidents_number ON itil_incidents(incident_number);
CREATE INDEX idx_itil_incidents_priority ON itil_incidents(priority);
CREATE INDEX idx_itil_incidents_status ON itil_incidents(status);
CREATE INDEX idx_itil_incidents_affected_ci ON itil_incidents(affected_ci_id);
CREATE INDEX idx_itil_incidents_affected_business_service ON itil_incidents(affected_business_service_id);
CREATE INDEX idx_itil_incidents_affected_app_service ON itil_incidents(affected_application_service_id);
CREATE INDEX idx_itil_incidents_assigned_to ON itil_incidents(assigned_to);
CREATE INDEX idx_itil_incidents_reported_at ON itil_incidents(reported_at DESC);
CREATE INDEX idx_itil_incidents_resolved_at ON itil_incidents(resolved_at DESC) WHERE resolved_at IS NOT NULL;
CREATE INDEX idx_itil_incidents_business_impact ON itil_incidents USING GIN(business_impact);

COMMENT ON TABLE itil_incidents IS 'v3.0 ITIL incident management with auto-calculated business impact from BSM';

-- ----------------------------------------
-- itil_changes: ITIL Change Management
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS itil_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    change_number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,

    -- ITIL classification
    change_type VARCHAR(50) NOT NULL,
    category VARCHAR(100),

    -- Risk assessment (auto-calculated)
    risk_assessment JSONB DEFAULT '{
        "overall_risk_score": 0,
        "risk_level": "medium",
        "requires_cab_approval": false
    }'::jsonb,

    -- Business impact analysis (from BSM)
    business_impact JSONB DEFAULT '{
        "critical_services_affected": [],
        "estimated_downtime_minutes": 0,
        "customer_impact": false,
        "revenue_at_risk": 0
    }'::jsonb,

    -- Financial impact (from TBM)
    financial_impact JSONB DEFAULT '{
        "implementation_cost": 0,
        "downtime_cost": 0,
        "total_cost": 0
    }'::jsonb,

    -- Affected entities
    affected_ci_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
    affected_business_service_ids UUID[] DEFAULT ARRAY[]::UUID[],
    affected_application_service_ids UUID[] DEFAULT ARRAY[]::UUID[],

    -- Implementation details
    implementation_plan TEXT,
    backout_plan TEXT,
    test_plan TEXT,

    -- Approval workflow
    approval_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    approved_by VARCHAR(255),
    approved_at TIMESTAMPTZ,

    -- Assignment
    assigned_to VARCHAR(255),
    assigned_group VARCHAR(255),

    -- Status tracking
    status VARCHAR(50) NOT NULL DEFAULT 'draft',

    -- Scheduling
    scheduled_start TIMESTAMPTZ,
    scheduled_end TIMESTAMPTZ,
    actual_start TIMESTAMPTZ,
    actual_end TIMESTAMPTZ,

    -- Outcome
    outcome VARCHAR(50),
    closure_notes TEXT,

    -- Requester
    requested_by VARCHAR(255) NOT NULL,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,

    CONSTRAINT itil_changes_type_check CHECK (
        change_type IN ('standard', 'normal', 'emergency', 'major')
    ),
    CONSTRAINT itil_changes_approval_status_check CHECK (
        approval_status IN ('pending', 'approved', 'rejected', 'cancelled')
    ),
    CONSTRAINT itil_changes_status_check CHECK (
        status IN ('draft', 'pending_approval', 'approved', 'scheduled', 'in_progress', 'implemented', 'closed', 'cancelled')
    ),
    CONSTRAINT itil_changes_outcome_check CHECK (
        outcome IS NULL OR outcome IN ('successful', 'successful_with_issues', 'failed', 'backed_out')
    )
);

CREATE INDEX idx_itil_changes_number ON itil_changes(change_number);
CREATE INDEX idx_itil_changes_type ON itil_changes(change_type);
CREATE INDEX idx_itil_changes_status ON itil_changes(status);
CREATE INDEX idx_itil_changes_approval_status ON itil_changes(approval_status);
CREATE INDEX idx_itil_changes_scheduled_start ON itil_changes(scheduled_start);
CREATE INDEX idx_itil_changes_assigned_to ON itil_changes(assigned_to);
CREATE INDEX idx_itil_changes_created_at ON itil_changes(created_at DESC);
CREATE INDEX idx_itil_changes_risk_assessment ON itil_changes USING GIN(risk_assessment);
CREATE INDEX idx_itil_changes_business_impact ON itil_changes USING GIN(business_impact);
CREATE INDEX idx_itil_changes_financial_impact ON itil_changes USING GIN(financial_impact);

COMMENT ON TABLE itil_changes IS 'v3.0 ITIL change management with unified risk and business impact assessment';

-- ----------------------------------------
-- tbm_cost_pools: TBM Cost Pool Definitions
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS tbm_cost_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    cost_pool_type VARCHAR(50) NOT NULL,

    -- Cost allocation rules
    allocation_rules JSONB NOT NULL DEFAULT '{
        "allocation_method": "usage_based",
        "allocation_drivers": [],
        "allocation_frequency": "monthly"
    }'::jsonb,

    -- GL mapping
    gl_account_codes TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- Budget tracking
    monthly_budget DECIMAL(15, 2) DEFAULT 0,
    annual_budget DECIMAL(15, 2) DEFAULT 0,

    -- Ownership
    cost_center VARCHAR(100),
    business_unit VARCHAR(255),
    owner VARCHAR(255),

    -- Status
    is_active BOOLEAN DEFAULT TRUE,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    updated_by VARCHAR(255),

    CONSTRAINT tbm_cost_pools_name_check CHECK (name IS NOT NULL AND name <> ''),
    CONSTRAINT tbm_cost_pools_type_check CHECK (
        cost_pool_type IN ('labor_internal', 'labor_external', 'hardware', 'software', 'cloud', 'outside_services', 'facilities', 'telecom')
    )
);

CREATE INDEX idx_tbm_cost_pools_name ON tbm_cost_pools(name);
CREATE INDEX idx_tbm_cost_pools_type ON tbm_cost_pools(cost_pool_type);
CREATE INDEX idx_tbm_cost_pools_cost_center ON tbm_cost_pools(cost_center);
CREATE INDEX idx_tbm_cost_pools_business_unit ON tbm_cost_pools(business_unit);
CREATE INDEX idx_tbm_cost_pools_active ON tbm_cost_pools(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_tbm_cost_pools_allocation_rules ON tbm_cost_pools USING GIN(allocation_rules);
CREATE UNIQUE INDEX idx_tbm_cost_pools_unique_name ON tbm_cost_pools(name);

COMMENT ON TABLE tbm_cost_pools IS 'v3.0 TBM cost pool definitions with allocation rules and GL mapping';

-- ----------------------------------------
-- tbm_depreciation_schedules: Asset Depreciation Tracking
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS tbm_depreciation_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ci_id VARCHAR(255) NOT NULL,
    ci_name VARCHAR(500),

    -- Purchase details
    purchase_date DATE NOT NULL,
    purchase_cost DECIMAL(15, 2) NOT NULL,

    -- Depreciation parameters
    useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
    residual_value DECIMAL(15, 2) DEFAULT 0,
    depreciation_method VARCHAR(50) NOT NULL,

    -- Calculated values
    monthly_depreciation DECIMAL(15, 2) NOT NULL,
    accumulated_depreciation DECIMAL(15, 2) DEFAULT 0,
    current_book_value DECIMAL(15, 2) NOT NULL,

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    fully_depreciated BOOLEAN DEFAULT FALSE,
    fully_depreciated_at DATE,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,

    CONSTRAINT tbm_depreciation_method_check CHECK (
        depreciation_method IN ('straight_line', 'declining_balance', 'double_declining_balance')
    ),
    CONSTRAINT tbm_depreciation_cost_check CHECK (purchase_cost > 0),
    CONSTRAINT tbm_depreciation_residual_check CHECK (residual_value >= 0 AND residual_value < purchase_cost)
);

CREATE INDEX idx_tbm_depreciation_ci_id ON tbm_depreciation_schedules(ci_id);
CREATE INDEX idx_tbm_depreciation_purchase_date ON tbm_depreciation_schedules(purchase_date);
CREATE INDEX idx_tbm_depreciation_active ON tbm_depreciation_schedules(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_tbm_depreciation_fully_depreciated ON tbm_depreciation_schedules(fully_depreciated);
CREATE UNIQUE INDEX idx_tbm_depreciation_unique_ci ON tbm_depreciation_schedules(ci_id);

COMMENT ON TABLE tbm_depreciation_schedules IS 'v3.0 TBM asset depreciation tracking with multiple depreciation methods';

-- ----------------------------------------
-- tbm_gl_mappings: General Ledger Account Mappings
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS tbm_gl_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Source entity (polymorphic)
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    entity_name VARCHAR(255),

    -- GL account details
    gl_account_code VARCHAR(50) NOT NULL,
    gl_account_name VARCHAR(255) NOT NULL,
    gl_cost_center VARCHAR(100),
    gl_business_unit VARCHAR(255),

    -- Mapping rules
    mapping_rules JSONB DEFAULT '{
        "allocation_percentage": 100,
        "allocation_driver": "direct",
        "notes": ""
    }'::jsonb,

    -- Effective dates
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE DEFAULT '9999-12-31',
    is_active BOOLEAN DEFAULT TRUE,

    -- Audit trail
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    updated_by VARCHAR(255),

    CONSTRAINT tbm_gl_mappings_entity_type_check CHECK (
        entity_type IN ('cost_pool', 'business_service', 'application_service', 'business_capability', 'configuration_item')
    ),
    CONSTRAINT tbm_gl_mappings_effective_dates_check CHECK (effective_from <= effective_to)
);

CREATE INDEX idx_tbm_gl_mappings_entity ON tbm_gl_mappings(entity_type, entity_id);
CREATE INDEX idx_tbm_gl_mappings_gl_account ON tbm_gl_mappings(gl_account_code);
CREATE INDEX idx_tbm_gl_mappings_cost_center ON tbm_gl_mappings(gl_cost_center);
CREATE INDEX idx_tbm_gl_mappings_business_unit ON tbm_gl_mappings(gl_business_unit);
CREATE INDEX idx_tbm_gl_mappings_active ON tbm_gl_mappings(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_tbm_gl_mappings_effective_dates ON tbm_gl_mappings(effective_from, effective_to);
CREATE INDEX idx_tbm_gl_mappings_rules ON tbm_gl_mappings USING GIN(mapping_rules);

COMMENT ON TABLE tbm_gl_mappings IS 'v3.0 TBM general ledger account mappings for cost allocation and financial reporting';

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
  last_job_id VARCHAR(255),
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
  ci_id VARCHAR(255) NOT NULL,
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
  ci_id VARCHAR(255) NOT NULL,
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

-- ============================================
-- v3.0 ANALYTICAL VIEWS
-- ============================================

-- Business service summaries
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
ORDER BY bs.created_at DESC;

COMMENT ON VIEW v_business_service_summary IS 'v3.0 Business service summary with key metrics from ITIL, TBM, and BSM';

-- Application service summaries
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
ORDER BY app.business_value_score DESC, app.created_at DESC;

COMMENT ON VIEW v_application_service_summary IS 'v3.0 Application service summary with TBM costs and ITIL lifecycle';

-- Business capability summaries
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
ORDER BY (bc.tbm_attributes->>'total_monthly_cost')::numeric DESC, bc.created_at DESC;

COMMENT ON VIEW v_business_capability_summary IS 'v3.0 Business capability summary with TBM cost allocation and value metrics';

-- Service dependency graph view
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
ORDER BY sd.is_critical DESC, sd.dependency_strength DESC;

COMMENT ON VIEW v_service_dependency_graph IS 'v3.0 Service dependency relationships with resolved entity names';

-- ITIL incident summary
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
ORDER BY i.priority, i.reported_at DESC;

COMMENT ON VIEW v_itil_incident_summary IS 'v3.0 ITIL incident summary with business impact metrics';

-- ITIL change summary
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
ORDER BY c.scheduled_start DESC, c.created_at DESC;

COMMENT ON VIEW v_itil_change_summary IS 'v3.0 ITIL change summary with risk assessment and business impact';

-- TBM cost pool summary
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
ORDER BY cp.annual_budget DESC, cp.created_at DESC;

COMMENT ON VIEW v_tbm_cost_pool_summary IS 'v3.0 TBM cost pool summary with budget tracking and GL mappings';

-- TBM depreciation tracking
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
ORDER BY ds.current_book_value DESC, ds.purchase_date DESC;

COMMENT ON VIEW v_tbm_depreciation_tracking IS 'v3.0 TBM depreciation tracking with calculated remaining life and percentages';

-- Unified service health dashboard
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
ORDER BY health_score DESC, service_name;

COMMENT ON VIEW v_unified_service_health IS 'v3.0 Unified service health dashboard combining ITIL, TBM, and BSM metrics';

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
-- BUSINESS SERVICES & TBM INTEGRATION
-- ============================================
-- Business Service Management (BSM) with TBM v5.0.1 capability towers foundation
-- These tables support service portfolio management aligned with Technology Business Management standards

-- Dimension table for business services
CREATE TABLE IF NOT EXISTS dim_business_services (
    service_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    service_classification VARCHAR(50) NOT NULL,  -- compute, storage, network, data, application, security, end_user, iot, blockchain, quantum, other_it
    tbm_tower VARCHAR(50) NOT NULL,  -- TBM v5.0.1 capability tower
    business_criticality VARCHAR(20) NOT NULL,  -- critical, high, medium, low
    operational_status VARCHAR(20) NOT NULL,  -- active, inactive, maintenance, decommissioned
    service_type VARCHAR(50),  -- infrastructure, platform, software, business
    owned_by VARCHAR(255),
    managed_by VARCHAR(255),
    support_group VARCHAR(255),
    service_level_requirement TEXT,
    category VARCHAR(100),
    tags TEXT[],  -- Array of tags
    related_ci_types TEXT[],  -- Array of CI types that support this service
    cost_allocation JSONB,  -- {chargeback_enabled: boolean, tbm_pool: string}
    metadata JSONB,  -- Additional flexible attributes
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_classification CHECK (service_classification IN (
        'compute', 'storage', 'network', 'data', 'application',
        'security', 'end_user', 'iot', 'blockchain', 'quantum', 'other_it'
    )),
    CONSTRAINT valid_criticality CHECK (business_criticality IN (
        'critical', 'high', 'medium', 'low'
    )),
    CONSTRAINT valid_status CHECK (operational_status IN (
        'active', 'inactive', 'maintenance', 'decommissioned'
    ))
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_business_services_classification ON dim_business_services(service_classification);
CREATE INDEX IF NOT EXISTS idx_business_services_tbm_tower ON dim_business_services(tbm_tower);
CREATE INDEX IF NOT EXISTS idx_business_services_criticality ON dim_business_services(business_criticality);
CREATE INDEX IF NOT EXISTS idx_business_services_status ON dim_business_services(operational_status);
CREATE INDEX IF NOT EXISTS idx_business_services_tags ON dim_business_services USING GIN(tags);

-- Service dependency relationships (many-to-many)
CREATE TABLE IF NOT EXISTS business_service_dependencies (
    id SERIAL PRIMARY KEY,
    service_id VARCHAR(50) NOT NULL REFERENCES dim_business_services(service_id) ON DELETE CASCADE,
    depends_on_service_id VARCHAR(50) NOT NULL REFERENCES dim_business_services(service_id) ON DELETE CASCADE,
    dependency_type VARCHAR(50) NOT NULL,  -- infrastructure, platform, application, business
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_id, depends_on_service_id),
    CONSTRAINT no_self_dependency CHECK (service_id != depends_on_service_id)
);

CREATE INDEX IF NOT EXISTS idx_service_deps_service ON business_service_dependencies(service_id);
CREATE INDEX IF NOT EXISTS idx_service_deps_depends_on ON business_service_dependencies(depends_on_service_id);

-- CI to Business Service mappings (many-to-many)
CREATE TABLE IF NOT EXISTS ci_business_service_mappings (
    id SERIAL PRIMARY KEY,
    ci_id VARCHAR(100) NOT NULL,  -- References Neo4j CI node ID
    service_id VARCHAR(50) NOT NULL REFERENCES dim_business_services(service_id) ON DELETE CASCADE,
    mapping_type VARCHAR(50) NOT NULL,  -- supports, hosts, depends_on, consumes
    confidence_score FLOAT DEFAULT 1.0,  -- Auto-discovered mappings may have < 1.0
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ci_id, service_id, mapping_type),
    CONSTRAINT valid_confidence CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0)
);

CREATE INDEX IF NOT EXISTS idx_ci_service_mapping_ci ON ci_business_service_mappings(ci_id);
CREATE INDEX IF NOT EXISTS idx_ci_service_mapping_service ON ci_business_service_mappings(service_id);

-- Fact table for business service incidents (aggregated from ITSM connectors)
CREATE TABLE IF NOT EXISTS fact_business_service_incidents (
    id SERIAL PRIMARY KEY,
    service_id VARCHAR(50) NOT NULL REFERENCES dim_business_services(service_id) ON DELETE CASCADE,
    incident_date DATE NOT NULL,
    incident_count INT DEFAULT 0,
    p1_count INT DEFAULT 0,
    p2_count INT DEFAULT 0,
    p3_count INT DEFAULT 0,
    p4_count INT DEFAULT 0,
    mttr_minutes FLOAT,  -- Mean time to resolve
    sla_breaches INT DEFAULT 0,
    total_downtime_minutes FLOAT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_id, incident_date)
);

-- Convert to TimescaleDB hypertable for time-series optimization
SELECT create_hypertable('fact_business_service_incidents', 'incident_date', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_bs_incidents_service ON fact_business_service_incidents(service_id, incident_date DESC);

-- Fact table for business service changes (aggregated from ITSM connectors)
CREATE TABLE IF NOT EXISTS fact_business_service_changes (
    id SERIAL PRIMARY KEY,
    service_id VARCHAR(50) NOT NULL REFERENCES dim_business_services(service_id) ON DELETE CASCADE,
    change_date DATE NOT NULL,
    change_count INT DEFAULT 0,
    emergency_count INT DEFAULT 0,
    standard_count INT DEFAULT 0,
    normal_count INT DEFAULT 0,
    successful_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    rolled_back_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_id, change_date)
);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('fact_business_service_changes', 'change_date', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_bs_changes_service ON fact_business_service_changes(service_id, change_date DESC);

-- View: Business Service Health Dashboard
CREATE OR REPLACE VIEW v_business_service_health AS
SELECT
    bs.service_id,
    bs.name,
    bs.service_classification,
    bs.tbm_tower,
    bs.business_criticality,
    bs.operational_status,
    COUNT(DISTINCT csm.ci_id) as supported_ci_count,
    COALESCE(SUM(inc.incident_count), 0)::INT as incidents_last_30d,
    COALESCE(SUM(inc.sla_breaches), 0)::INT as sla_breaches_last_30d,
    COALESCE(AVG(inc.mttr_minutes), 0)::FLOAT as avg_mttr_minutes,
    COALESCE(SUM(chg.change_count), 0)::INT as changes_last_30d,
    COALESCE(SUM(chg.failed_count), 0)::INT as failed_changes_last_30d,
    CASE
        WHEN COALESCE(SUM(inc.sla_breaches), 0) = 0
         AND COALESCE(SUM(chg.failed_count), 0) = 0
         AND bs.operational_status = 'active'
        THEN 'healthy'
        WHEN COALESCE(SUM(inc.sla_breaches), 0) > 5
          OR COALESCE(SUM(chg.failed_count), 0) > 3
        THEN 'critical'
        ELSE 'degraded'
    END as health_status
FROM dim_business_services bs
LEFT JOIN ci_business_service_mappings csm ON bs.service_id = csm.service_id
LEFT JOIN fact_business_service_incidents inc ON bs.service_id = inc.service_id
    AND inc.incident_date >= CURRENT_DATE - INTERVAL '30 days'
LEFT JOIN fact_business_service_changes chg ON bs.service_id = chg.service_id
    AND chg.change_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY bs.service_id, bs.name, bs.service_classification, bs.tbm_tower,
         bs.business_criticality, bs.operational_status;

-- View: TBM Tower Summary
CREATE OR REPLACE VIEW v_tbm_tower_summary AS
SELECT
    tbm_tower,
    COUNT(*) as service_count,
    COUNT(CASE WHEN operational_status = 'active' THEN 1 END) as active_services,
    COUNT(CASE WHEN business_criticality = 'critical' THEN 1 END) as critical_services,
    COUNT(CASE WHEN business_criticality = 'high' THEN 1 END) as high_criticality_services
FROM dim_business_services
GROUP BY tbm_tower
ORDER BY service_count DESC;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON dim_business_services TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON business_service_dependencies TO PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ci_business_service_mappings TO PUBLIC;
GRANT SELECT, INSERT ON fact_business_service_incidents TO PUBLIC;
GRANT SELECT, INSERT ON fact_business_service_changes TO PUBLIC;
GRANT SELECT ON v_business_service_health TO PUBLIC;
GRANT SELECT ON v_tbm_tower_summary TO PUBLIC;

-- Table comments
COMMENT ON TABLE dim_business_services IS 'Business service catalog aligned with TBM v5.0.1 capability towers';
COMMENT ON TABLE business_service_dependencies IS 'Service dependency graph for impact analysis';
COMMENT ON TABLE ci_business_service_mappings IS 'Maps CIs (from Neo4j) to business services for BSM';
COMMENT ON TABLE fact_business_service_incidents IS 'Daily aggregated incident metrics per business service';
COMMENT ON TABLE fact_business_service_changes IS 'Daily aggregated change metrics per business service';
COMMENT ON VIEW v_business_service_health IS 'Real-time business service health dashboard';
COMMENT ON VIEW v_tbm_tower_summary IS 'Summary statistics by TBM capability tower';

-- ============================================
-- END OF CONSOLIDATED SCHEMA MIGRATION
-- ============================================
