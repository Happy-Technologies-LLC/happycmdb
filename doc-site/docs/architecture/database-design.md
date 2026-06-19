# Database Design

## Overview

HappyCMDB uses a dual-database architecture:
- **Neo4j**: Primary graph database for CIs and relationships (source of truth)
- **PostgreSQL**: Data mart for analytics and reporting (dimensional model)

This design provides the flexibility of graph queries with the analytical power of SQL.

## Neo4j Graph Database

### Purpose
- Store all Configuration Items (CIs) as nodes
- Model relationships between CIs as edges
- Enable graph traversal queries (dependencies, impact analysis)
- Support full-text search across CIs

### Node Labels

**Base Label**: All CIs have the `CI` label

**Type-Specific Labels** (in addition to `CI`):
- `Server` - Physical and virtual servers
- `Application` - Applications and software
- `Service` - Services and microservices
- `Database` - Database instances
- `NetworkDevice` - Routers, switches, firewalls
- `Container` - Docker containers
- `Pod` - Kubernetes pods
- `CloudResource` - Generic cloud resources
- `LoadBalancer` - Load balancers
- `Storage` - Storage volumes and buckets

### Node Properties

**Common Properties** (all CIs):
```cypher
CREATE (ci:CI {
  id: String,                   // Unique identifier
  external_id: String,          // Provider-specific ID
  name: String,                 // Display name
  type: String,                 // CI type (server, application, etc.)
  status: String,               // active, inactive, maintenance, decommissioned
  environment: String,          // production, staging, development, test
  created_at: DateTime,         // When CI was discovered
  updated_at: DateTime,         // Last update timestamp
  discovered_at: DateTime,      // Last discovery timestamp
  discovered_by: String,        // Discovery provider (aws, azure, gcp, ssh, nmap)
  confidence_score: Float,      // Discovery confidence (0.0-1.0)
  tags: [String],              // User-defined tags
  attributes: JSON,            // Provider-specific attributes
  description: String          // Human-readable description
})
```

**Type-Specific Properties**:

**Server/VirtualMachine**:
```cypher
{
  hostname: String,
  ip_address: String,
  os: String,
  os_version: String,
  cpu_cores: Int,
  memory_gb: Int,
  disk_gb: Int,
  cloud_provider: String,
  region: String,
  availability_zone: String,
  instance_type: String
}
```

**Application**:
```cypher
{
  version: String,
  language: String,
  framework: String,
  repository_url: String,
  deployed_at: DateTime
}
```

**Database**:
```cypher
{
  engine: String,              // mysql, postgres, mongodb, etc.
  engine_version: String,
  port: Int,
  storage_gb: Int,
  multi_az: Boolean,
  backup_enabled: Boolean
}
```

### Relationship Types

**Dependency Relationships**:
- `DEPENDS_ON` - General dependency (application depends on database)
- `USES` - Service usage (application uses API)
- `CONNECTS_TO` - Network connection

**Hosting Relationships**:
- `HOSTS` - Physical/virtual hosting (server hosts application)
- `RUNS_ON` - Execution environment (container runs on server)
- `DEPLOYED_ON` - Deployment relationship

**Organizational Relationships**:
- `OWNED_BY` - Ownership (CI owned by team/user)
- `PART_OF` - Composition (server part of cluster)
- `MANAGED_BY` - Management responsibility

**Infrastructure Relationships**:
- `LOAD_BALANCES` - Load balancer to servers
- `BACKED_UP_BY` - Backup relationships
- `REPLICATED_TO` - Replication relationships

### Relationship Properties

```cypher
CREATE (from)-[r:DEPENDS_ON {
  created_at: DateTime,
  updated_at: DateTime,
  discovered_at: DateTime,
  confidence_score: Float,
  attributes: JSON,           // Relationship metadata
  weight: Float               // Dependency strength (0.0-1.0)
}]->(to)
```

### Indexes and Constraints

```cypher
// Unique constraints
CREATE CONSTRAINT ci_id_unique IF NOT EXISTS
FOR (ci:CI) REQUIRE ci.id IS UNIQUE;

CREATE CONSTRAINT ci_external_id_unique IF NOT EXISTS
FOR (ci:CI) REQUIRE ci.external_id IS UNIQUE;

// Indexes for performance
CREATE INDEX ci_type_index IF NOT EXISTS
FOR (ci:CI) ON (ci.type);

CREATE INDEX ci_name_index IF NOT EXISTS
FOR (ci:CI) ON (ci.name);

CREATE INDEX ci_status_index IF NOT EXISTS
FOR (ci:CI) ON (ci.status);

CREATE INDEX ci_environment_index IF NOT EXISTS
FOR (ci:CI) ON (ci.environment);

CREATE INDEX ci_discovered_at_index IF NOT EXISTS
FOR (ci:CI) ON (ci.discovered_at);

// Full-text search index
CREATE FULLTEXT INDEX ci_search IF NOT EXISTS
FOR (ci:CI) ON EACH [ci.name, ci.description, ci.tags];
```

### Common Queries

**Get CI with relationships**:
```cypher
MATCH (ci:CI {id: $ciId})-[r]-(related:CI)
RETURN ci, type(r) as relationshipType, related
```

**Get dependency tree (recursive)**:
```cypher
MATCH path = (ci:CI {id: $ciId})-[:DEPENDS_ON*1..5]->(dep:CI)
RETURN path
```

**Impact analysis (upstream dependencies)**:
```cypher
MATCH path = (ci:CI {id: $ciId})<-[:DEPENDS_ON*1..5]-(upstream:CI)
RETURN path
```

**Find orphaned CIs (no relationships)**:
```cypher
MATCH (ci:CI)
WHERE NOT (ci)-[]-()
RETURN ci
```

**Search CIs by name**:
```cypher
CALL db.index.fulltext.queryNodes('ci_search', $searchQuery)
YIELD node, score
RETURN node, score
ORDER BY score DESC
LIMIT 50
```

## PostgreSQL Data Mart

### Purpose
- Analytics and reporting queries
- Time-series data storage (TimescaleDB)
- Slowly Changing Dimension (SCD Type 2) for CI history
- Fact tables for events and metrics

### Schema Design

**Dimensional Model** (Star Schema):
- Dimension Tables: `dim_ci`, `dim_time`, `dim_environment`, `dim_ci_type`
- Fact Tables: `fact_discovery`, `fact_relationship`, `fact_ci_changes`

### Dimension Tables

**dim_ci** (SCD Type 2):
```sql
CREATE TABLE dim_ci (
  ci_key SERIAL PRIMARY KEY,
  ci_id VARCHAR(255) NOT NULL,
  external_id VARCHAR(255),
  ci_name VARCHAR(255) NOT NULL,
  ci_type VARCHAR(50) NOT NULL,
  ci_status VARCHAR(50) NOT NULL,
  environment VARCHAR(50),
  attributes JSONB,
  tags TEXT[],
  discovered_by VARCHAR(50),
  confidence_score DECIMAL(3,2),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dim_ci_id ON dim_ci(ci_id);
CREATE INDEX idx_dim_ci_current ON dim_ci(ci_id, is_current) WHERE is_current = TRUE;
CREATE INDEX idx_dim_ci_type ON dim_ci(ci_type);
CREATE INDEX idx_dim_ci_status ON dim_ci(ci_status);
CREATE INDEX idx_dim_ci_environment ON dim_ci(environment);
CREATE INDEX idx_dim_ci_effective FROM dim_ci(effective_from, effective_to);
```

**dim_time** (pre-populated):
```sql
CREATE TABLE dim_time (
  time_key SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  year INT NOT NULL,
  quarter INT NOT NULL,
  month INT NOT NULL,
  week INT NOT NULL,
  day INT NOT NULL,
  day_of_week INT NOT NULL,
  day_name VARCHAR(10) NOT NULL,
  is_weekend BOOLEAN NOT NULL,
  is_holiday BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_dim_time_date ON dim_time(date);
```

**dim_ci_type**:
```sql
CREATE TABLE dim_ci_type (
  ci_type_key SERIAL PRIMARY KEY,
  ci_type VARCHAR(50) NOT NULL UNIQUE,
  ci_category VARCHAR(50) NOT NULL,
  description TEXT
);
```

**dim_environment**:
```sql
CREATE TABLE dim_environment (
  environment_key SERIAL PRIMARY KEY,
  environment_name VARCHAR(50) NOT NULL UNIQUE,
  description TEXT
);
```

### Fact Tables

**fact_discovery** (discovery events):
```sql
CREATE TABLE fact_discovery (
  discovery_id SERIAL PRIMARY KEY,
  ci_key INT NOT NULL REFERENCES dim_ci(ci_key),
  time_key INT NOT NULL REFERENCES dim_time(time_key),
  discovery_provider VARCHAR(50) NOT NULL,
  discovery_method VARCHAR(50),
  discovered_at TIMESTAMPTZ NOT NULL,
  confidence_score DECIMAL(3,2),
  attributes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fact_discovery_ci ON fact_discovery(ci_key);
CREATE INDEX idx_fact_discovery_time ON fact_discovery(time_key);
CREATE INDEX idx_fact_discovery_provider ON fact_discovery(discovery_provider);
CREATE INDEX idx_fact_discovery_date ON fact_discovery(discovered_at);

-- TimescaleDB hypertable (optional)
SELECT create_hypertable('fact_discovery', 'discovered_at');
```

**fact_relationship** (CI relationships):
```sql
CREATE TABLE fact_relationship (
  relationship_id SERIAL PRIMARY KEY,
  from_ci_key INT NOT NULL REFERENCES dim_ci(ci_key),
  to_ci_key INT NOT NULL REFERENCES dim_ci(ci_key),
  relationship_type VARCHAR(50) NOT NULL,
  relationship_weight DECIMAL(3,2),
  discovered_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  attributes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fact_rel_from ON fact_relationship(from_ci_key);
CREATE INDEX idx_fact_rel_to ON fact_relationship(to_ci_key);
CREATE INDEX idx_fact_rel_type ON fact_relationship(relationship_type);
CREATE INDEX idx_fact_rel_active ON fact_relationship(is_active) WHERE is_active = TRUE;
```

**fact_ci_changes** (change tracking):
```sql
CREATE TABLE fact_ci_changes (
  change_id SERIAL PRIMARY KEY,
  ci_key INT NOT NULL REFERENCES dim_ci(ci_key),
  time_key INT NOT NULL REFERENCES dim_time(time_key),
  change_type VARCHAR(50) NOT NULL,  -- created, updated, deleted, status_changed
  field_name VARCHAR(100),
  old_value TEXT,
  new_value TEXT,
  changed_at TIMESTAMPTZ NOT NULL,
  changed_by VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fact_changes_ci ON fact_ci_changes(ci_key);
CREATE INDEX idx_fact_changes_time ON fact_ci_changes(time_key);
CREATE INDEX idx_fact_changes_type ON fact_ci_changes(change_type);
CREATE INDEX idx_fact_changes_date ON fact_ci_changes(changed_at);

-- TimescaleDB hypertable
SELECT create_hypertable('fact_ci_changes', 'changed_at');
```

### Common Analytics Queries

**CI count by type**:
```sql
SELECT ci_type, COUNT(*) as count
FROM dim_ci
WHERE is_current = TRUE
GROUP BY ci_type
ORDER BY count DESC;
```

**CI count by environment**:
```sql
SELECT environment, COUNT(*) as count
FROM dim_ci
WHERE is_current = TRUE
GROUP BY environment;
```

**Discovery timeline (last 30 days)**:
```sql
SELECT
  DATE(discovered_at) as date,
  COUNT(*) as discoveries,
  COUNT(DISTINCT ci_key) as unique_cis
FROM fact_discovery
WHERE discovered_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE(discovered_at)
ORDER BY date DESC;
```

**Top connected CIs**:
```sql
SELECT
  c.ci_id,
  c.ci_name,
  c.ci_type,
  COUNT(DISTINCT r1.relationship_id) + COUNT(DISTINCT r2.relationship_id) as connection_count
FROM dim_ci c
LEFT JOIN fact_relationship r1 ON c.ci_key = r1.from_ci_key
LEFT JOIN fact_relationship r2 ON c.ci_key = r2.to_ci_key
WHERE c.is_current = TRUE
GROUP BY c.ci_id, c.ci_name, c.ci_type
ORDER BY connection_count DESC
LIMIT 10;
```

**Recent changes (last 7 days)**:
```sql
SELECT
  c.ci_id,
  c.ci_name,
  ch.change_type,
  ch.field_name,
  ch.old_value,
  ch.new_value,
  ch.changed_at
FROM fact_ci_changes ch
JOIN dim_ci c ON ch.ci_key = c.ci_key
WHERE ch.changed_at >= NOW() - INTERVAL '7 days'
ORDER BY ch.changed_at DESC
LIMIT 100;
```

## Redis Data Structures

### Purpose
- Cache frequently accessed data
- Session storage
- BullMQ job queue backend

### Key Patterns

**CI Cache**:
```
Key: ci:{ci_id}
Type: String (JSON)
TTL: 300 seconds (5 minutes)
```

**Search Results Cache**:
```
Key: search:{hash_of_query}
Type: String (JSON array)
TTL: 300 seconds
```

**User Session**:
```
Key: session:{session_id}
Type: Hash
TTL: 3600 seconds (1 hour)
```

**BullMQ Queues**:
```
Key: bull:discovery:aws:*
Type: Various (List, Hash, Zset)
TTL: Managed by BullMQ
```

## Data Synchronization

### ETL Sync Process

1. **Extract**: Query Neo4j for CIs updated since last sync
2. **Transform**: Convert graph nodes to dimensional model
3. **Load**: Upsert to PostgreSQL with SCD Type 2 logic

**Incremental Sync** (every 5 minutes):
```sql
-- 1. Get last sync timestamp
SELECT MAX(updated_at) FROM dim_ci;

-- 2. Query Neo4j for CIs updated since last sync
-- 3. For each CI, check if exists in data mart
SELECT ci_key, effective_from
FROM dim_ci
WHERE ci_id = $1 AND is_current = TRUE;

-- 4. If exists and changed, close old version
UPDATE dim_ci
SET effective_to = NOW(), is_current = FALSE
WHERE ci_id = $1 AND is_current = TRUE;

-- 5. Insert new version
INSERT INTO dim_ci (ci_id, ci_name, ..., effective_from, is_current)
VALUES ($1, $2, ..., NOW(), TRUE);
```

## Backup Strategy

### Neo4j Backups
- **Full Backup**: Daily at 2 AM
- **Incremental Backup**: Hourly
- **Retention**: 90 days for production, 30 days for staging
- **Location**: S3 or equivalent cloud storage
- **Encryption**: AES-256 at rest

### PostgreSQL Backups
- **pg_dump**: Daily full backup
- **WAL Archiving**: Continuous archiving for point-in-time recovery
- **Retention**: 90 days for production
- **Location**: S3 or equivalent cloud storage

### Redis Backups
- **RDB Snapshots**: Every 6 hours
- **AOF**: Append-only file for durability
- **Retention**: 7 days

## Disaster Recovery

### Recovery Time Objective (RTO)
- **Target**: < 1 hour for full system recovery

### Recovery Point Objective (RPO)
- **Target**: < 15 minutes data loss maximum
- **Actual**: ~5 minutes with WAL archiving

### Recovery Procedures
1. Restore databases from latest backup
2. Apply incremental backups/WAL logs
3. Verify data integrity
4. Restart application services
5. Run smoke tests
6. Resume normal operations

## Next Steps

- [Job Scheduling Architecture](./job-scheduling)
- [Frontend Architecture](./frontend)
