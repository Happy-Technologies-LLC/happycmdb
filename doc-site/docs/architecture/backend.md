# Backend Architecture

## Overview

The HappyCMDB backend is built as a monorepo of TypeScript microservices, each with a specific responsibility. The architecture follows clean architecture principles with clear separation between layers.

## Monorepo Structure

```
packages/
├── common/              # Shared types and utilities
├── database/            # Database clients (Neo4j, PostgreSQL, Redis)
├── api-server/          # REST + GraphQL API servers
├── discovery-engine/    # Multi-cloud discovery workers
├── etl-processor/       # ETL jobs and data transformers
├── agent/              # Lightweight discovery agent
└── cli/                # Command-line interface
```

## Package Details

### @cmdb/common

**Purpose**: Shared TypeScript types, utilities, and business logic used across all packages.

**Key Components**:
- Type definitions for CIs, relationships, discovery jobs
- Logger configuration (Winston)
- Validators (Joi schemas)
- Queue configuration (BullMQ)
- Constants and enums

**Usage**:
```typescript
import { CI, logger, validators } from '@cmdb/common';
```

### @cmdb/database

**Purpose**: Database clients and connection management for all data stores.

**Databases Supported**:
- **Neo4j**: Graph database client with connection pooling
- **PostgreSQL**: Relational database client (node-postgres)
- **Redis**: Cache and queue backend (ioredis)

**Features**:
- Singleton pattern for global client access
- Connection pooling with configurable limits
- Health check methods
- Graceful shutdown support
- Transaction management

**Example Usage**:
```typescript
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';

const neo4jClient = getNeo4jClient();
const session = neo4jClient.getSession();

const ci = await neo4jClient.createCI({
  id: 'vm-123',
  name: 'web-server-01',
  type: 'virtual-machine',
  status: 'active'
});
```

### @cmdb/api-server

**Purpose**: Expose REST and GraphQL APIs for all CMDB operations.

**Architecture**:
```
api-server/src/
├── rest/
│   ├── routes/          # Route definitions
│   ├── controllers/     # Request handlers
│   ├── middleware/      # Auth, validation, error handling
│   └── index.ts         # Express app setup
├── graphql/
│   ├── schema/          # GraphQL type definitions
│   ├── resolvers/       # Query and mutation resolvers
│   └── index.ts         # Apollo Server setup
└── server.ts            # Main entry point
```

**Key Features**:
- RESTful API following `/api/v1/{resource}` pattern
- GraphQL endpoint at `/graphql`
- JWT authentication middleware
- Request validation with Joi
- Centralized error handling
- Rate limiting
- CORS configuration
- Swagger/OpenAPI documentation

**REST API Endpoints**:
- `GET /api/v1/cis` - List CIs with filtering
- `GET /api/v1/cis/:id` - Get CI by ID
- `POST /api/v1/cis` - Create new CI
- `PUT /api/v1/cis/:id` - Update CI
- `DELETE /api/v1/cis/:id` - Delete CI
- `GET /api/v1/cis/:id/relationships` - Get relationships
- `GET /api/v1/cis/:id/dependencies` - Get dependency tree
- `POST /api/v1/discovery/jobs` - Trigger discovery
- `GET /api/v1/discovery/jobs/:id` - Get job status

### @cmdb/discovery-engine

**Purpose**: Multi-cloud and on-premise infrastructure discovery with ServiceNow-style 3-tier architecture.

**Architecture**:
```
discovery-engine/src/
├── workers/
│   ├── aws-discovery.worker.ts      # AWS EC2, RDS, S3, etc.
│   ├── azure-discovery.worker.ts    # Azure VMs, SQL, Storage
│   ├── gcp-discovery.worker.ts      # GCP Compute, Storage
│   ├── ssh-discovery.worker.ts      # Linux/Unix servers
│   └── nmap-discovery.worker.ts     # Network device scanning
├── orchestrator/
│   └── discovery-orchestrator.ts    # Job coordination
├── schedulers/
│   └── discovery-scheduler.ts       # Cron-based scheduling
├── processors/
│   └── worker-manager.ts            # Worker lifecycle
├── credentials/
│   ├── credential-service.ts        # Credential CRUD operations
│   └── encryption-service.ts        # AES-256-GCM encryption
└── definitions/
    ├── definition-service.ts        # Definition CRUD operations
    └── definition-scheduler.ts      # Schedule management
```

**3-Tier Discovery Architecture**:

HappyCMDB implements a ServiceNow-style discovery architecture with three tiers:

1. **Credentials** - Encrypted authentication credentials stored in PostgreSQL
2. **Discovery Definitions** - Reusable discovery configurations with scheduling
3. **Discovery Jobs** - Individual execution instances

This architecture provides:
- **Security**: Credentials encrypted at rest with AES-256-GCM
- **Reusability**: Single definition used for multiple discovery runs
- **Audit Trail**: Complete history of all discovery operations
- **Scheduling**: Automated discovery with cron patterns
- **Consistency**: Standardized discovery configurations

**Discovery Providers**:

**AWS Discovery**:
- EC2 instances
- RDS databases
- S3 buckets
- ECS clusters
- Lambda functions
- Load balancers
- Security groups

**Azure Discovery**:
- Virtual machines
- SQL databases
- Storage accounts
- App services
- Network interfaces

**GCP Discovery**:
- Compute instances
- Cloud SQL
- Cloud Storage
- GKE clusters

**SSH Discovery**:
- System information
- Installed packages
- Running services
- Network connections

**Nmap Discovery**:
- Network devices
- Open ports
- Service versions
- OS detection

**Discovery Flow**:
1. Job queued in `discovery:{provider}` queue
2. Worker picks up job based on concurrency settings
3. Authenticate with cloud provider
4. Query resources by region/scope
5. Transform raw data to CI format
6. Create/update CIs and relationships in Neo4j
7. Track progress (0-100%)
8. Record job result in PostgreSQL

### @cmdb/etl-processor

**Purpose**: Synchronize Neo4j graph database to PostgreSQL data mart for analytics.

**Architecture**:
```
etl-processor/src/
├── jobs/
│   ├── neo4j-to-postgres.job.ts     # Main ETL sync
│   ├── reconciliation.job.ts        # Data consistency checks
│   └── change-detection.job.ts      # CI change tracking
├── transformers/
│   ├── ci-transformer.ts            # CI dimension transform
│   ├── relationship-transformer.ts  # Fact table transform
│   └── discovery-transformer.ts     # Discovery fact transform
├── schedulers/
│   └── etl-scheduler.ts             # Cron-based ETL scheduling
└── processors/
    └── worker-manager.ts            # ETL worker lifecycle
```

**ETL Job Types**:

**Incremental Sync** (every 5 minutes):
- Query CIs updated since last sync
- Transform to dimensional model
- Upsert to PostgreSQL (SCD Type 2)
- Update sync timestamp

**Full Refresh** (daily at 2 AM):
- Truncate all fact tables
- Extract all CIs from Neo4j
- Bulk load to PostgreSQL
- Rebuild indexes

**Change Detection** (every 10 minutes):
- Compare current vs previous CI state
- Record changes in `fact_ci_changes`
- Track field-level changes
- Trigger notifications

**Reconciliation** (hourly):
- Compare Neo4j vs PostgreSQL counts
- Identify missing or orphaned records
- Auto-fix or flag for manual review

### @cmdb/agent

**Purpose**: Lightweight agent for server-based discovery.

**Features**:
- Runs on target servers
- Collects system information
- Reports to API server
- Scheduled execution (cron)
- Minimal resource footprint

**Collectors**:
- System information (OS, CPU, memory)
- Installed packages
- Running services
- Network configuration
- Disk usage

### @cmdb/cli

**Purpose**: Command-line interface for operations and automation.

**Commands**:
```bash
# CI operations
cmdb ci list --type server --status active
cmdb ci get vm-123
cmdb ci create --from-file ci.json
cmdb ci delete vm-123

# Discovery operations
cmdb discovery scan --provider aws --region us-east-1
cmdb discovery status --job-id abc123
cmdb discovery schedule aws "0 */6 * * *"

# Job management
cmdb jobs list discovery:aws --status failed
cmdb jobs retry abc123
cmdb jobs stats

# ETL operations
cmdb datamart sync --wait
cmdb datamart validate
cmdb analytics summary
```

## API Design Patterns

### RESTful Conventions
- **GET**: Retrieve resources (idempotent)
- **POST**: Create new resources
- **PUT**: Update entire resources
- **PATCH**: Partial updates
- **DELETE**: Remove resources

### Response Format
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2025-10-04T12:00:00Z",
    "requestId": "req-abc123"
  }
}
```

### Error Format
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid CI type",
    "details": {
      "field": "type",
      "value": "invalid-type"
    }
  },
  "meta": {
    "timestamp": "2025-10-04T12:00:00Z",
    "requestId": "req-abc123"
  }
}
```

### GraphQL Schema
```graphql
type CI {
  id: ID!
  name: String!
  type: CIType!
  status: CIStatus!
  environment: String
  attributes: JSON
  createdAt: DateTime!
  updatedAt: DateTime!
  relationships: [Relationship!]!
}

type Query {
  getCIs(filter: CIFilterInput): [CI!]!
  getCI(id: ID!): CI
  getDependencies(id: ID!, depth: Int): [CI!]!
}

type Mutation {
  createCI(input: CreateCIInput!): CI!
  updateCI(id: ID!, input: UpdateCIInput!): CI!
  deleteCI(id: ID!): Boolean!
}
```

## Database Interaction Patterns

### Neo4j Queries
```typescript
// Create CI with relationships
async createCIWithRelationships(ci: CIInput, relationships: RelationshipInput[]) {
  const session = this.neo4jClient.getSession();
  try {
    const result = await session.writeTransaction(async (tx) => {
      // Create CI
      const ciResult = await tx.run(
        `CREATE (ci:CI:${ci.type} $props) RETURN ci`,
        { props: ci }
      );

      // Create relationships
      for (const rel of relationships) {
        await tx.run(
          `MATCH (from:CI {id: $fromId}), (to:CI {id: $toId})
           CREATE (from)-[r:${rel.type}]->(to)
           SET r = $props`,
          { fromId: ci.id, toId: rel.toId, props: rel.properties }
        );
      }

      return ciResult.records[0].get('ci');
    });

    return this.recordToCI(result);
  } finally {
    await session.close();
  }
}
```

### PostgreSQL Queries
```typescript
// Upsert CI to data mart (SCD Type 2)
async upsertCI(ci: CI) {
  const client = await this.pgPool.connect();
  try {
    await client.query('BEGIN');

    // Close current version
    await client.query(
      `UPDATE dim_ci
       SET effective_to = NOW(), is_current = FALSE
       WHERE ci_id = $1 AND is_current = TRUE`,
      [ci.id]
    );

    // Insert new version
    await client.query(
      `INSERT INTO dim_ci (ci_id, ci_name, ci_type, effective_from, is_current, ...)
       VALUES ($1, $2, $3, NOW(), TRUE, ...)`,
      [ci.id, ci.name, ci.type, ...]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

## Error Handling Strategy

### Error Categories
1. **Validation Errors**: Invalid input data
2. **Not Found Errors**: Resource doesn't exist
3. **Authentication Errors**: Invalid credentials
4. **Authorization Errors**: Insufficient permissions
5. **Database Errors**: Connection or query failures
6. **External API Errors**: Cloud provider API failures
7. **Internal Errors**: Unexpected application errors

### Error Handling Middleware
```typescript
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  const statusCode = err.statusCode || 500;
  const errorCode = err.code || 'INTERNAL_ERROR';

  res.status(statusCode).json({
    success: false,
    error: {
      code: errorCode,
      message: err.message,
      details: err.details || {},
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: req.id,
    },
  });
};
```

## Credential Encryption Service

### Overview

The credential encryption service provides secure storage for discovery credentials using industry-standard encryption.

### Encryption Algorithm

- **Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Key Size**: 256 bits (32 bytes)
- **IV Size**: 96 bits (12 bytes, randomly generated)
- **Authentication**: Built-in authentication tag (GCM mode)

### Implementation

```typescript
interface EncryptionService {
  encrypt(plaintext: string): EncryptedData;
  decrypt(encryptedData: EncryptedData): string;
}

interface EncryptedData {
  ciphertext: string;      // Base64-encoded encrypted data
  iv: string;              // Initialization vector (random per encryption)
  authTag: string;         // Authentication tag for integrity verification
  algorithm: 'aes-256-gcm';
}
```

### Key Management

The encryption key is stored in an environment variable:

```bash
ENCRYPTION_KEY=8f7a3b2c9d1e6f0a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1
```

**Key Generation**:
```bash
openssl rand -hex 32
```

**Security Best Practices**:
- Store key in secrets manager (AWS Secrets Manager, HashiCorp Vault)
- Use different keys for different environments
- Rotate keys periodically (requires re-encryption of all credentials)
- Never commit keys to version control

### Database Storage

Encrypted credentials are stored in PostgreSQL:

```sql
CREATE TABLE discovery_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  type VARCHAR(50) NOT NULL,  -- 'aws', 'azure', 'gcp', 'ssh', etc.
  encrypted_credentials JSONB NOT NULL,  -- Encrypted EncryptedData object
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP
);
```

### Encryption Flow

**Encryption (Create/Update Credential)**:
1. Receive credential data from API request
2. Serialize credential object to JSON string
3. Generate random 12-byte IV
4. Encrypt JSON with AES-256-GCM using key and IV
5. Store ciphertext, IV, and auth tag in database as JSONB

**Decryption (Use Credential)**:
1. Retrieve encrypted data from database
2. Extract ciphertext, IV, and auth tag
3. Decrypt using AES-256-GCM with key
4. Verify authentication tag (prevents tampering)
5. Parse JSON to credential object
6. Use credential for discovery operation

### Audit Trail

All credential access is logged:

```sql
CREATE TABLE credential_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID REFERENCES discovery_credentials(id),
  action VARCHAR(50) NOT NULL,  -- 'created', 'updated', 'deleted', 'accessed'
  performed_by VARCHAR(255) NOT NULL,
  performed_at TIMESTAMP DEFAULT NOW(),
  details JSONB
);
```

## Discovery Definition Data Model

### Overview

Discovery definitions are reusable configurations that define discovery scope, credentials, and scheduling.

### Database Schema

```sql
CREATE TABLE discovery_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  provider VARCHAR(50) NOT NULL,  -- 'aws', 'azure', 'gcp', 'ssh', 'nmap'
  credential_id UUID REFERENCES discovery_credentials(id) ON DELETE RESTRICT,
  config JSONB NOT NULL,          -- Provider-specific configuration
  schedule_enabled BOOLEAN DEFAULT false,
  schedule_cron_pattern VARCHAR(100),
  enabled BOOLEAN DEFAULT true,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP
);

CREATE INDEX idx_definitions_provider ON discovery_definitions(provider);
CREATE INDEX idx_definitions_credential ON discovery_definitions(credential_id);
CREATE INDEX idx_definitions_enabled ON discovery_definitions(enabled);
CREATE INDEX idx_definitions_schedule_enabled ON discovery_definitions(schedule_enabled);
```

### Job Association

Discovery jobs are linked to their definitions:

```sql
CREATE TABLE discovery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID REFERENCES discovery_definitions(id),
  queue_name VARCHAR(100) NOT NULL,
  bullmq_job_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,    -- 'queued', 'active', 'completed', 'failed'
  progress INTEGER DEFAULT 0,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  result JSONB,                    -- Discovery results
  error JSONB                      -- Error details if failed
);

CREATE INDEX idx_jobs_definition ON discovery_jobs(definition_id);
CREATE INDEX idx_jobs_status ON discovery_jobs(status);
CREATE INDEX idx_jobs_started_at ON discovery_jobs(started_at);
```

### Definition-Based Discovery Flow

1. **Definition Scheduler** (cron-based):
   - Queries enabled definitions with `schedule_enabled = true`
   - Checks if current time matches cron pattern
   - Creates discovery job in BullMQ queue
   - Updates `last_run_at` and calculates `next_run_at`

2. **Discovery Worker**:
   - Picks up job from BullMQ queue
   - Retrieves definition from database
   - Fetches and decrypts credential
   - Executes discovery using provider-specific worker
   - Tracks progress (0-100%)
   - Stores result in `discovery_jobs` table

3. **Job Tracking**:
   - All jobs linked to parent definition via `definition_id`
   - Job history queryable per definition
   - Metrics aggregated per definition (success rate, avg duration)

### Scheduling Service

The definition scheduler runs on a separate process/container:

```typescript
class DefinitionScheduler {
  private interval: NodeJS.Timeout;

  async start() {
    // Check every minute for definitions that need to run
    this.interval = setInterval(() => {
      this.checkSchedules();
    }, 60000);
  }

  private async checkSchedules() {
    const definitions = await this.getScheduledDefinitions();

    for (const definition of definitions) {
      if (this.shouldRun(definition)) {
        await this.triggerDiscovery(definition);
        await this.updateNextRunTime(definition);
      }
    }
  }

  private shouldRun(definition: DiscoveryDefinition): boolean {
    const now = new Date();
    const cronPattern = definition.scheduleCronPattern;
    // Use cron parser to check if current time matches pattern
    return cronMatch(cronPattern, now);
  }
}
```

## Performance Optimization

### Caching Strategy
- **Redis Cache**: API responses, user sessions, credential metadata (NOT encrypted values)
- **Cache TTL**: 5 minutes for inventory data, 1 hour for analytics
- **Cache Invalidation**: On CI updates, relationship changes

### Connection Pooling
- **Neo4j**: 50 max connections per instance
- **PostgreSQL**: 20 max connections per instance
- **Redis**: Unlimited connections (multiplexing)

### Query Optimization
- **Indexes**: All frequently queried fields (see schema definitions above)
- **Pagination**: Limit + offset for large result sets
- **Projection**: Only fetch required fields
- **Batch Operations**: Group multiple operations

## Testing Strategy

### Unit Tests
- All business logic functions
- Database query builders
- Validators and transformers
- 80%+ code coverage target

### Integration Tests
- API endpoint testing with Supertest
- Database operations with test containers
- Mock external APIs (AWS, Azure, GCP)

### E2E Tests
- Full discovery workflow
- ETL sync process
- API authentication flow

## Next Steps

- [Frontend Architecture](./frontend)
- [Database Design](./database-design)
- [Job Scheduling](./job-scheduling)
