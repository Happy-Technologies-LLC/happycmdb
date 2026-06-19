// ============================================
// Neo4j Schema for HappyCMDB v3.0
// ============================================
// This script creates all constraints, indexes, and full-text search
// capabilities for the CMDB graph database with v3.0 unified data model.
//
// v3.0 adds business entity support:
// - BusinessService: Business services and capabilities
// - ApplicationService: IT solutions/applications
// - BusinessCapability: Business capabilities
// - ValueStream: Customer journeys and value streams
//
// IMPORTANT: This script is idempotent - safe to run multiple times.
// All statements use "IF NOT EXISTS" to prevent errors on re-runs.

// ============================================
// CONSTRAINTS - Uniqueness and Data Integrity
// ============================================

// Unique constraint on CI.id (primary identifier)
CREATE CONSTRAINT ci_id_unique IF NOT EXISTS
FOR (c:CI)
REQUIRE c.id IS UNIQUE;

// Unique constraint on CI.external_id (source system identifier)
// Only enforced when external_id is not null
CREATE CONSTRAINT ci_external_id_unique IF NOT EXISTS
FOR (c:CI)
REQUIRE c.external_id IS UNIQUE;

// ============================================
// v3.0 BUSINESS ENTITY CONSTRAINTS
// ============================================

// Unique constraint on BusinessService.id
CREATE CONSTRAINT business_service_id_unique IF NOT EXISTS
FOR (bs:BusinessService)
REQUIRE bs.id IS UNIQUE;

// Unique constraint on ApplicationService.id
CREATE CONSTRAINT application_service_id_unique IF NOT EXISTS
FOR (as:ApplicationService)
REQUIRE as.id IS UNIQUE;

// Unique constraint on BusinessCapability.id
CREATE CONSTRAINT business_capability_id_unique IF NOT EXISTS
FOR (bc:BusinessCapability)
REQUIRE bc.id IS UNIQUE;

// Unique constraint on ValueStream.id
CREATE CONSTRAINT value_stream_id_unique IF NOT EXISTS
FOR (vs:ValueStream)
REQUIRE vs.id IS UNIQUE;

// ============================================
// INDEXES - Query Performance Optimization
// ============================================

// Index on CI.type for fast filtering by CI type
CREATE INDEX ci_type_idx IF NOT EXISTS
FOR (c:CI)
ON (c.type);

// Index on CI.status for filtering by operational status
CREATE INDEX ci_status_idx IF NOT EXISTS
FOR (c:CI)
ON (c.status);

// Index on CI.environment for filtering by deployment environment
CREATE INDEX ci_environment_idx IF NOT EXISTS
FOR (c:CI)
ON (c.environment);

// Index on CI.name for fast name-based lookups
CREATE INDEX ci_name_idx IF NOT EXISTS
FOR (c:CI)
ON (c.name);

// Index on CI.created_at for temporal queries
CREATE INDEX ci_created_at_idx IF NOT EXISTS
FOR (c:CI)
ON (c.created_at);

// Index on CI.updated_at for finding recently modified CIs
CREATE INDEX ci_updated_at_idx IF NOT EXISTS
FOR (c:CI)
ON (c.updated_at);

// Composite index on (type, status) for common query patterns
CREATE INDEX ci_type_status_idx IF NOT EXISTS
FOR (c:CI)
ON (c.type, c.status);

// Composite index on (environment, status) for env-specific queries
CREATE INDEX ci_env_status_idx IF NOT EXISTS
FOR (c:CI)
ON (c.environment, c.status);

// ============================================
// v3.0 BUSINESS ENTITY INDEXES
// ============================================

// BusinessService indexes
CREATE INDEX business_service_name_idx IF NOT EXISTS
FOR (bs:BusinessService)
ON (bs.name);

CREATE INDEX business_service_status_idx IF NOT EXISTS
FOR (bs:BusinessService)
ON (bs.operational_status);

CREATE INDEX business_service_created_idx IF NOT EXISTS
FOR (bs:BusinessService)
ON (bs.created_at);

CREATE INDEX business_service_updated_idx IF NOT EXISTS
FOR (bs:BusinessService)
ON (bs.updated_at);

// ApplicationService indexes
CREATE INDEX application_service_name_idx IF NOT EXISTS
FOR (as:ApplicationService)
ON (as.name);

CREATE INDEX application_service_type_idx IF NOT EXISTS
FOR (as:ApplicationService)
ON (as.application_type);

CREATE INDEX application_service_created_idx IF NOT EXISTS
FOR (as:ApplicationService)
ON (as.created_at);

CREATE INDEX application_service_updated_idx IF NOT EXISTS
FOR (as:ApplicationService)
ON (as.updated_at);

// BusinessCapability indexes
CREATE INDEX business_capability_name_idx IF NOT EXISTS
FOR (bc:BusinessCapability)
ON (bc.name);

CREATE INDEX business_capability_type_idx IF NOT EXISTS
FOR (bc:BusinessCapability)
ON (bc.capability_type);

CREATE INDEX business_capability_created_idx IF NOT EXISTS
FOR (bc:BusinessCapability)
ON (bc.created_at);

CREATE INDEX business_capability_updated_idx IF NOT EXISTS
FOR (bc:BusinessCapability)
ON (bc.updated_at);

// ValueStream indexes
CREATE INDEX value_stream_name_idx IF NOT EXISTS
FOR (vs:ValueStream)
ON (vs.name);

CREATE INDEX value_stream_created_idx IF NOT EXISTS
FOR (vs:ValueStream)
ON (vs.created_at);

CREATE INDEX value_stream_updated_idx IF NOT EXISTS
FOR (vs:ValueStream)
ON (vs.updated_at);

// ============================================
// FULL-TEXT SEARCH INDEXES
// ============================================

// Full-text search index on CI.name and metadata for search functionality
CREATE FULLTEXT INDEX ci_fulltext_idx IF NOT EXISTS
FOR (c:CI)
ON EACH [c.name];

// Full-text search on BusinessService names and descriptions
CREATE FULLTEXT INDEX business_service_fulltext_idx IF NOT EXISTS
FOR (bs:BusinessService)
ON EACH [bs.name, bs.description];

// Full-text search on ApplicationService names and descriptions
CREATE FULLTEXT INDEX application_service_fulltext_idx IF NOT EXISTS
FOR (as:ApplicationService)
ON EACH [as.name, as.description];

// Full-text search on BusinessCapability names and descriptions
CREATE FULLTEXT INDEX business_capability_fulltext_idx IF NOT EXISTS
FOR (bc:BusinessCapability)
ON EACH [bc.name, bc.description];

// Full-text search on ValueStream names and descriptions
CREATE FULLTEXT INDEX value_stream_fulltext_idx IF NOT EXISTS
FOR (vs:ValueStream)
ON EACH [vs.name, vs.description];

// ============================================
// RELATIONSHIP TYPE INDEXES (Neo4j 5.x)
// ============================================

// Index on DEPENDS_ON relationships for fast dependency traversal
CREATE INDEX depends_on_idx IF NOT EXISTS
FOR ()-[r:DEPENDS_ON]-()
ON (r.created_at);

// Index on HOSTS relationships
CREATE INDEX hosts_idx IF NOT EXISTS
FOR ()-[r:HOSTS]-()
ON (r.created_at);

// Index on CONNECTS_TO relationships for network topology queries
CREATE INDEX connects_to_idx IF NOT EXISTS
FOR ()-[r:CONNECTS_TO]-()
ON (r.created_at);

// ============================================
// v3.0 BUSINESS RELATIONSHIP INDEXES
// ============================================

// Index on ENABLES relationships (ApplicationService -> BusinessService)
CREATE INDEX enables_idx IF NOT EXISTS
FOR ()-[r:ENABLES]-()
ON (r.created_at);

// Index on DELIVERS relationships (BusinessService -> BusinessCapability)
CREATE INDEX delivers_idx IF NOT EXISTS
FOR ()-[r:DELIVERS]-()
ON (r.created_at);

// Index on CONTRIBUTES_TO relationships (BusinessCapability -> ValueStream)
CREATE INDEX contributes_to_idx IF NOT EXISTS
FOR ()-[r:CONTRIBUTES_TO]-()
ON (r.created_at);

// Index on RUNS_ON relationships (ApplicationService -> CI)
CREATE INDEX runs_on_idx IF NOT EXISTS
FOR ()-[r:RUNS_ON]-()
ON (r.created_at);

// Index on SUPPORTS relationships (CI -> BusinessService)
CREATE INDEX supports_idx IF NOT EXISTS
FOR ()-[r:SUPPORTS]-()
ON (r.created_at);

// Index on REQUIRES relationships (ValueStream -> BusinessCapability)
CREATE INDEX requires_idx IF NOT EXISTS
FOR ()-[r:REQUIRES]-()
ON (r.created_at);

// ============================================
// SPECIALIZED CI TYPE LABELS
// ============================================
// Note: These are not constraints, just documentation
// Each CI will have multiple labels: CI + specific type
//
// Supported labels:
// - :Server
// - :VirtualMachine
// - :Container
// - :Application
// - :Service
// - :Database
// - :NetworkDevice
// - :Storage
// - :LoadBalancer
// - :CloudResource

// ============================================
// RELATIONSHIP TYPES
// ============================================
// Note: This is documentation - Neo4j doesn't require relationship type declaration
//
// v2.0 CI Relationship Types:
// - DEPENDS_ON: CI depends on another CI
// - HOSTS: CI hosts another CI (e.g., server hosts application)
// - CONNECTS_TO: Network connection between CIs
// - USES: CI uses another CI (e.g., application uses database)
// - OWNED_BY: Ownership relationship
// - PART_OF: Component/composition relationship
// - LOCATED_IN: Physical or logical location
// - DEPLOYED_ON: Deployment relationship
// - BACKED_UP_BY: Backup relationship
//
// v3.0 Business Relationship Types:
// - ENABLES: ApplicationService enables BusinessService (IT → Business)
// - DELIVERS: BusinessService delivers BusinessCapability (Service → Capability)
// - CONTRIBUTES_TO: BusinessCapability contributes to ValueStream (Capability → Value)
// - RUNS_ON: ApplicationService runs on CI (Application → Infrastructure)
// - SUPPORTS: CI supports BusinessService (Infrastructure → Business)
// - REQUIRES: ValueStream requires BusinessCapability (Value → Capability)

// ============================================
// END OF SCHEMA DEFINITION
// ============================================
