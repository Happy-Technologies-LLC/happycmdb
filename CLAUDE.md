# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**HappyCMDB** - Open-source enterprise Configuration Management Database (CMDB) platform
- **Status**: Production-ready (5 phases complete)
- **Stack**: Node.js 20 LTS + TypeScript 5.x
- **Architecture**: Microservices with graph database (Neo4j) as primary datastore
- **License**: 100% open-source components (MIT, Apache 2.0, BSD, GPL)
- **Version**: v2.0 (Connector Framework Architecture)

## Project Organization (Updated Oct 2025)

**Docker Configuration**: All Docker files consolidated in `/infrastructure/docker/`
- `docker-compose.yml` - Main compose file (moved from root)
- `docker-compose.test.yml` - Test environment
- All Dockerfiles (api, web, discovery, etl, agent)

**Configuration Management**:
- Config templates: `/infrastructure/config/templates/` (development.json, staging.json, production.json)
- Environment variables: `.env` file in root (gitignored)
- Template: `.env.example` in root

**Documentation**:
- **Primary source**: `/doc-site/` (VitePress site at http://localhost:8080)
- **Archive only**: `/docs/archive/` (phase reports, historical)
- **No duplicate docs**: All operational docs removed from `/docs/`, now in doc-site only

**Scripts**:
- Deployment: `./deploy.sh` (auto-loads .env, uses infrastructure/docker/docker-compose.yml)
- Infrastructure scripts: `/infrastructure/scripts/`

## Docker Development Workflow

### Docker Compose Commands (Updated Path)

ALL docker-compose commands MUST use the new path:

```bash
docker-compose -f infrastructure/docker/docker-compose.yml [command]
```

Or use the `deploy.sh` script which handles this automatically.

### CRITICAL: TypeScript Build Cache Issues

**Problem**: TypeScript's `.tsbuildinfo` files cache compilation state, causing changes to NOT be compiled even after editing source files.

**Symptoms**:
- You edit a file but changes don't appear in the running container
- `npm run build` completes instantly but no files are updated
- Docker restart doesn't pick up changes

**Solution - Proper Rebuild Process**:

```bash
# 1. Clean TypeScript cache in affected package
cd packages/<package-name>
rm -f tsconfig.tsbuildinfo
npm run build

# 2. Rebuild Docker image (use new path!)
docker-compose -f infrastructure/docker/docker-compose.yml build <service-name>

# 3. Recreate container (restart is NOT enough!)
docker stop <container-name>
docker rm <container-name>
docker-compose -f infrastructure/docker/docker-compose.yml up -d <service-name>
```

**Example - Updating Discovery Engine**:
```bash
# Clean and rebuild
cd packages/discovery-engine
rm -f tsconfig.tsbuildinfo
npm run build

# Rebuild and recreate API server (discovery engine runs inside api-server)
docker-compose -f infrastructure/docker/docker-compose.yml build api-server
docker stop cmdb-api-server
docker rm cmdb-api-server
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server
```

**Example - Updating Web UI**:
```bash
# Build UI
cd web-ui
npm run build

# Rebuild Docker image (use new path!)
docker-compose -f infrastructure/docker/docker-compose.yml build web-ui
# OR force rebuild without cache:
docker-compose -f infrastructure/docker/docker-compose.yml build --no-cache web-ui

# Recreate container (restart is NOT enough for new builds!)
docker stop cmdb-web-ui
docker rm cmdb-web-ui
docker-compose -f infrastructure/docker/docker-compose.yml up -d web-ui
```

### Why `docker restart` Doesn't Work

- **`docker restart`** = Stop and start the SAME container with SAME image
- **`docker rm` + `docker-compose up`** = Create NEW container from REBUILT image

**IMPORTANT**: Even for static files, you MUST recreate the container after rebuilding the image. `docker restart` only restarts the existing container; it doesn't reload the new image.

**When you MUST recreate** (after code changes):
- ❌ API server code changes → Must stop/rm/up
- ❌ Discovery engine code changes → Must stop/rm/up
- ❌ Web UI code changes → Must stop/rm/up
- ❌ Any TypeScript compilation changes → Must stop/rm/up

**The ONLY time restart works**:
- ✅ Configuration file changes ONLY (no new build)
- ✅ Database restarts
- ✅ Service health check issues

### Docker Compose Service Names vs Container Names

**Service names** (use in docker-compose commands):
- `api-server` (not `cmdb-api-server`)
- `web-ui` (not `cmdb-web-ui`)
- `discovery-engine` (runs inside `api-server`)

**Container names** (use in docker stop/rm):
- `cmdb-api-server`
- `cmdb-web-ui`
- `cmdb-neo4j`
- `cmdb-postgres`
- `cmdb-redis`

**Quick Reference**:
```bash
# Build image: use service name (with new path!)
docker-compose -f infrastructure/docker/docker-compose.yml build api-server

# Stop/remove/exec: use container name
docker stop cmdb-api-server
docker rm cmdb-api-server
docker exec cmdb-api-server <command>

# Start: use service name (with new path!)
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server
```

**Recommended**: Use `./deploy.sh` script which handles all paths automatically.

## v2.0 Features

HappyCMDB v2.0 introduces a major architectural evolution focused on extensibility and declarative configuration:

### Unified Credential System
- **Protocol-based authentication**: Single credential record supports multiple auth methods
- **Affinity matching**: Credentials automatically matched to resources by protocol/port
- **Dynamic metadata**: Custom fields for vendor-specific auth requirements
- **Security**: Encrypted storage with Vault integration

### Connector Ecosystem
- **43 connectors**: 17 TypeScript (custom logic) + 26 JSON-only (declarative ETL)
- **Dynamic loading**: Install/update connectors without code changes
- **Version management**: Semantic versioning with compatibility checking
- **Registry system**: Browse, search, and install connectors via UI/CLI

### Discovery Agent Architecture
- **Smart routing**: Jobs routed to agents based on network affinity and capabilities
- **Hybrid discovery**: Agents handle network protocols (NMAP, SSH), API calls route to connectors
- **Parallel execution**: Multiple agents can scan different network segments simultaneously
- **Fault tolerance**: Job redistribution if agent goes offline

### Dynamic Metadata System
- **Schema-less fields**: Add custom attributes without database migrations
- **Indexed search**: Query metadata fields efficiently
- **Type validation**: Optional JSON Schema validation for metadata consistency

## Project Structure

This is a **monorepo** architecture with clear separation of concerns:

```
packages/
├── common/              # Shared types and utilities
├── database/            # Database clients (Neo4j, PostgreSQL, Redis)
├── api-server/          # REST + GraphQL API servers
├── discovery-engine/    # Connector orchestration and job routing
├── etl-processor/       # ETL jobs and data transformers
├── agent/              # Lightweight discovery agent (network protocols)
├── cli/                # Command-line interface
└── connectors/         # Connector package directory (TypeScript + JSON)

web-ui/                 # React dashboard
doc-site/              # VitePress documentation
infrastructure/        # Docker, Kubernetes, Terraform configs
```

## Core Architecture

### Data Storage
- **Neo4j Community Edition** (v5.x) - Primary graph database for CI relationships
  - Connection: `bolt://localhost:7687` (default)
  - All CIs stored as nodes with labels: `CI`, `Server`, `Application`, `Database`, etc.
  - Relationships: `DEPENDS_ON`, `HOSTS`, `CONNECTS_TO`, `USES`, `OWNED_BY`, etc.
- **PostgreSQL** (v15+) with TimescaleDB - Data mart for analytics/reporting
  - Dimensional model with fact and dimension tables
  - Time-series data for metrics
- **Redis** (v7.x) - Caching and queue backend for BullMQ

### Message Queue
- **BullMQ** (v4.x) - Job orchestration with Redis backend
- Queue names follow pattern: `discovery:{connector-id}`, `etl:{job-type}`, `agent:{agent-id}`

### Discovery System

HappyCMDB uses a hybrid discovery approach:

#### Network Discovery (Agent-based)
Agents handle infrastructure protocols that require network access:
- **NMAP**: Network device scanning and service detection
- **SSH**: Linux/Unix server discovery and inventory
- **SNMP**: Network device monitoring and metrics
- **Active Directory**: Windows domain resource discovery

#### API Discovery (Connector-based)
Connectors handle cloud/SaaS platforms with REST/GraphQL APIs:
- **Cloud Providers**: AWS (17 services), Azure (12 services), GCP (10 services)
- **SaaS Platforms**: Salesforce, ServiceNow, Datadog, PagerDuty
- **Infrastructure**: VMware, Docker, Kubernetes
- **Databases**: MySQL, PostgreSQL, MongoDB, Redis
- **Networking**: Cisco, Juniper, Palo Alto

## Connector Architecture

HappyCMDB supports two types of connectors for maximum flexibility:

### TypeScript Connectors (Custom Logic)
For complex integrations requiring custom business logic:

**Structure**:
```
packages/connectors/<connector-id>/
├── connector.json       # Metadata + config schema
├── src/
│   ├── index.ts        # Entry point implementing IConnector
│   ├── client.ts       # API client / SDK wrapper
│   └── transforms.ts   # Data transformation logic
├── package.json        # Dependencies
└── tsconfig.json
```

**Examples**:
- AWS services (multi-region pagination, IAM policies)
- Azure Resource Manager (complex relationship mapping)
- Kubernetes (watch events, CRD handling)
- ServiceNow (CMDB import/export, relationship sync)
- VMware vCenter (performance metrics, distributed switches)

**Use TypeScript when**:
- Complex authentication flows (OAuth2, SAML, custom tokens)
- Advanced data transformations (calculated fields, aggregations)
- Stateful operations (incremental sync, change detection)
- Error handling/retry logic beyond standard patterns

### JSON-Only Connectors (Declarative ETL)
For straightforward REST API integrations:

**Structure**:
```
packages/connectors/<connector-id>/
└── connector.json       # Complete definition (no code!)
```

**Examples**:
- GitHub repositories and issues
- GitLab projects
- Datadog monitors
- PagerDuty services
- Jira projects
- Linear issues

**Use JSON-only when**:
- Simple REST API with standard auth (API key, basic auth)
- Direct field mapping (no transformation needed)
- Standard pagination (offset/limit or cursor-based)
- No complex business logic or state management

**JSON Connector Format**:
```json
{
  "id": "github",
  "version": "1.0.0",
  "auth": {
    "type": "token",
    "header": "Authorization",
    "prefix": "Bearer"
  },
  "resources": [{
    "type": "repository",
    "endpoint": "/repos/{owner}/{repo}",
    "method": "GET",
    "pagination": { "type": "link-header" },
    "fieldMappings": {
      "ci_name": "$.name",
      "ci_type": "code-repository",
      "metadata.language": "$.language",
      "metadata.stars": "$.stargazers_count"
    }
  }]
}
```

## Key Design Patterns

### CI (Configuration Item) Data Flow
1. Connector/Agent finds resources → Create `DiscoveredCI` objects
2. Discovery engine persists to Neo4j (check if exists, update or create)
3. ETL processors sync Neo4j → PostgreSQL data mart
4. API layer exposes via REST/GraphQL

### Type System
- **CI Types**: `server`, `virtual-machine`, `container`, `application`, `service`, `database`, `network-device`, `storage`, `load-balancer`, `cloud-resource`
- **CI Status**: `active`, `inactive`, `maintenance`, `decommissioned`
- **Environments**: `production`, `staging`, `development`, `test`

### Singletons
Database clients use singleton pattern - access via:
- `getNeo4jClient()` from `@cmdb/database`
- `getPostgresClient()` from `@cmdb/database`
- `getRedisClient()` from `@cmdb/database`

## Development Commands

All standard npm scripts are available:

```bash
# Install dependencies
npm install  # or: pnpm install

# Build all packages
npm run build

# Run tests
npm test
npm run test:unit
npm run test:integration

# Start development servers
npm run dev:api           # API server
npm run dev:discovery     # Discovery engine
npm run dev:ui            # React UI
npm run dev:agent         # Discovery agent

# Database operations
npm run db:migrate        # Run PostgreSQL migrations
npm run db:seed           # Seed test data

# Docker development (use new path OR deploy script)
docker-compose -f infrastructure/docker/docker-compose.yml up -d  # Start all services
./deploy.sh               # Full deployment (recommended - handles paths automatically)

# Connector development
npm run connector:new     # Scaffold new connector
npm run connector:build   # Build all connectors
npm run connector:test    # Test connector(s)
```

## Implementation Guidelines

### When Creating New Connectors
1. **Decide on connector type**:
   - Simple REST API with standard auth → JSON-only connector
   - Complex logic or custom SDK → TypeScript connector
2. **Scaffold structure**: Use `npm run connector:new <connector-id>`
3. **Define connector.json**: Metadata, auth schema, resource types
4. **Implement discovery logic** (TypeScript only):
   - Implement `IConnector` interface
   - Return `DiscoveredCI[]` with all required fields
   - Set appropriate `confidence_score` (0-1) based on reliability
5. **Test thoroughly**: Unit tests + integration tests with real API
6. **Document**: Add usage examples to connector.json description

### When Adding CI Types
1. Update `CIType` union in `packages/common/src/types/ci.types.ts`
2. Add corresponding Neo4j label to schema constraints
3. Update GraphQL schema type definitions
4. Add dimension values to PostgreSQL data mart

### API Development
- REST API follows pattern: `/api/v1/{resource}`
- GraphQL endpoint: `/graphql`
- All controllers extend pattern: get/create/update/delete + domain-specific actions
- Error handling uses centralized middleware

### Database Queries
- Neo4j: Use parameterized queries to prevent injection
- PostgreSQL: Use transactions for multi-step ETL operations
- Redis: Set TTL for cache entries (typically 300-3600 seconds)

## Critical Constraints

1. **No hardcoded credentials** - Use unified credential system with encryption
2. **Graph database first** - Neo4j is source of truth for relationships
3. **Async/await everywhere** - No callback-based code
4. **Proper error handling** - All database operations in try/catch with session cleanup
5. **Connection pooling** - Use connection pool settings specified in technical design
6. **Idempotent discovery** - Discovery jobs can run multiple times safely
7. **Connector isolation** - Each connector runs in its own context with resource limits

## Cleanup Policies

HappyCMDB v2.0 was developed as a **greenfield application** with no backwards compatibility requirements. The following cleanup policies were applied:

### Database Migrations
- **Before**: 16 separate SQL migration files (v1.0 incremental changes)
- **After**: Consolidated to 1 comprehensive migration file (`001_initial_schema.sql`)
- **Rationale**: No existing production databases to migrate from

### Legacy Code Removal
- **Removed**: v1.0 discovery workers (aws-discovery.worker.ts, azure-discovery.worker.ts, etc.)
- **Replaced**: Unified connector framework with JSON-only + TypeScript connectors
- **Reason**: Complete architectural redesign made old workers incompatible

### Documentation Consolidation
- **Archived**: Phase 1-5 development reports → `/docs/PHASE-*` (historical reference only)
- **Active**: Single source of truth at `/doc-site/` (VitePress)
- **Removed**: Scattered README files and duplicate markdown documentation

### Configuration Simplification
- **Before**: Separate config files per provider (aws-config.json, azure-config.json)
- **After**: Single `connector-config.json` per connector with unified schema
- **Benefit**: Consistent configuration across all integrations

### No Migration Path Needed
Since HappyCMDB is a new application with no prior production deployments:
- No backwards compatibility requirements
- No data migration scripts needed
- Clean slate architecture without legacy constraints
- Aggressive refactoring enabled

**Key Principle**: When building a new application, don't carry forward legacy patterns. Design for the future, not the past.

## Testing Strategy

- **Unit tests**: All business logic and utilities (Jest)
- **Integration tests**: Database operations with test containers
- **Discovery tests**: Mock cloud provider APIs
- **API tests**: Supertest for REST, GraphQL test client

## Environment Variables (v2.0)

**Key environment variables** (see `.env.example` for complete list):

```bash
# Application Configuration
NODE_ENV=development
LOG_LEVEL=info
API_PORT=3000
API_HOST=0.0.0.0

# Authentication & Security
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-minimum-32-chars
JWT_EXPIRATION=24h
ENCRYPTION_KEY=your-encryption-key-for-sensitive-data-minimum-32-characters

# Neo4j Graph Database
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-neo4j-password
NEO4J_DATABASE=cmdb

# PostgreSQL (Connector Registry, Credentials, Metadata)
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DATABASE=cmdb
POSTGRES_USER=cmdb_user
POSTGRES_PASSWORD=your-postgres-password

# Redis (Cache & Job Queue)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Discovery Configuration
DISCOVERY_ENABLED=true
DISCOVERY_DEFAULT_INTERVAL=3600000
DISCOVERY_BATCH_SIZE=100

# AI/ML Features (v2.0)
AI_ANOMALY_DETECTION_ENABLED=true
AI_DRIFT_DETECTION_ENABLED=true
AI_IMPACT_ANALYSIS_ENABLED=true

# Monitoring & Observability
METRICS_ENABLED=true
METRICS_PORT=9090
AUDIT_LOG_ENABLED=true
```

### v2.0 Credential Management

**IMPORTANT**: HappyCMDB v2.0 uses a **unified credential system** stored in PostgreSQL. Connector credentials (AWS, Azure, GCP, ServiceNow, etc.) are **NOT** configured via environment variables.

**To configure connector credentials**:
1. Create credential records via Web UI or API
2. Associate credentials with discovery definitions
3. Credentials support multiple auth methods per provider

**See documentation**: http://localhost:8080/components/credentials

**Legacy v1.0 variables removed**:
- ❌ `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- ❌ `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`
- ❌ `GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT_KEY_PATH`
- ❌ `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD`
- ❌ `FEATURE_AWS_INGESTION`, `FEATURE_AZURE_INGESTION`, `FEATURE_GCP_INGESTION`
- ❌ `AWS_ENABLED`, `AZURE_ENABLED`, `GCP_ENABLED`

All connector authentication now uses the PostgreSQL credential system with encryption.

## Documentation

### Official Documentation Site

**Location**: `/doc-site/`
**URL (when running)**: http://localhost:8080

HappyCMDB has a comprehensive VitePress documentation site that consolidates all project documentation:

- **30+ structured documentation pages** organized by topic (updated Oct 2025)
- **Full-text search** with fuzzy matching (Ctrl+K / ⌘K)
- **Dark mode** and mobile responsive
- **Docker containerized** for easy deployment
- **Version-aware** - Covers both v1.0 and v2.0 architectures

#### Documentation Structure

```
doc-site/docs/
├── getting-started/     # Quick start guides
├── architecture/        # System design, connector framework, version history
│   ├── system-overview.md
│   ├── connector-framework.md       # NEW v2.0
│   ├── version-history.md           # NEW v2.0
│   ├── backend/
│   ├── frontend/
│   ├── database/
│   └── scheduling/
├── components/          # BullMQ, Web UI, Data Mart, Auth, Connectors
│   ├── credentials.md               # UPDATED v2.0 - Unified credentials
│   ├── discovery-agents.md          # NEW v2.0
│   ├── connector-registry.md        # NEW v2.0
│   ├── discovery-definitions.md
│   ├── authentication.md
│   ├── bullmq.md
│   ├── web-ui.md
│   └── data-mart.md
├── deployment/          # Kubernetes, verification
├── operations/          # Daily ops, troubleshooting
├── configuration/       # Environment variables
├── api/                 # REST and GraphQL reference
└── quick-reference/     # CLI commands, SQL queries
```

#### Key Documentation Pages (v2.0 Updates)

**Architecture**:
- `/architecture/connector-framework.md` - Comprehensive connector system guide
- `/architecture/version-history.md` - Migration guide from v1.0 to v2.0

**Components**:
- `/components/credentials.md` - Unified credential system with affinity matching
- `/components/discovery-agents.md` - Agent-based discovery with smart routing
- `/components/connector-registry.md` - Browse, install, update connectors

#### Working with Documentation

**Local Development:**
```bash
cd doc-site
npm run docs:dev        # Start dev server (http://localhost:5173)
npm run docs:build      # Build static site
npm run docs:preview    # Preview production build
```

**Docker Deployment:**
```bash
cd doc-site
docker-compose up -d    # Start on port 8080
docker-compose down     # Stop
```

**Automatic Deployment:**
The documentation site is automatically built and deployed when running:
```bash
./deploy.sh
```

#### Documentation Guidelines

1. **Single Source of Truth**: All user-facing documentation lives in `/doc-site/docs/`
2. **No Scattered Docs**: Avoid creating random markdown files in root or packages
3. **Use Templates**: Copy `/doc-site/docs/_template.md` for new pages
4. **Update Navigation**: Add new pages to `/doc-site/docs/.vitepress/config.ts` sidebar
5. **Cross-Reference**: Link related docs using relative paths (e.g., `/components/credentials.md`)
6. **Code Examples**: Include practical, copy-paste ready examples with language hints
7. **Keep Updated**: Update docs when changing features or architecture
8. **Version Awareness**: Clearly mark v1.0 vs v2.0 features when relevant

#### Documentation Organization by Topic

**When documenting new features, place them in the appropriate category**:

- **Architecture** (`/architecture/`) - System design, frameworks, patterns, technical decisions
  - Use for: Core platform architecture, connector framework, database design, version history
  - Examples: `connector-framework.md`, `version-history.md`, `database-design.md`

- **Components** (`/components/`) - Functional components and subsystems
  - Use for: Specific features, integrations, services
  - Examples: `credentials.md`, `discovery-agents.md`, `connector-registry.md`, `bullmq.md`

- **Configuration** (`/configuration/`) - Setup and configuration guides
  - Use for: Environment variables, config files, service configuration
  - Examples: `environment-variables.md`, `connectors.md`, `security/secrets.md`

- **Operations** (`/operations/`) - Day-to-day operations and troubleshooting
  - Use for: Maintenance, monitoring, incident response, backup procedures
  - Examples: `daily-operations.md`, `troubleshooting.md`, `backup/strategy.md`

- **Development** (`/development/`) - Developer guides and contribution docs
  - Use for: Building custom connectors, extending the platform, API development
  - Examples: `connector-development.md`, `contributing.md`, `architecture-decisions.md`

#### Maintaining Documentation Consistency

**When updating code that affects documentation**:

1. **Check for existing docs first** - Search `/doc-site/docs/` for related content
2. **Update, don't duplicate** - Edit existing pages rather than creating new ones
3. **Update navigation** - If creating a new page, add it to `.vitepress/config.ts`
4. **Cross-reference** - Link to related documentation pages
5. **Test links** - Verify all internal links work (use relative paths)

#### What NOT to Document

- **Phase reports** - These are archived in `/docs/PHASE-*` and not needed in live docs
- **Internal status updates** - Keep these in root but don't duplicate in doc-site
- **File manifests** - Not user-facing documentation
- **Temporary notes** - Use comments in code or tickets instead

#### Finding Documentation

- **For Users**: Always direct them to http://localhost:8080 when services are running
- **For Developers**: Architecture docs in `/doc-site/docs/architecture/`
- **For Operators**: Operations docs in `/doc-site/docs/operations/`
- **For Integrations**: Component guides in `/doc-site/docs/components/`

## Important Notes

- This is a **production-ready CMDB platform** - fully implemented with 5 phases complete
- All code examples in `cmdb-technical-design.md` are reference implementations
- Follow monorepo structure strictly - use `@cmdb/*` package naming convention
- Graph relationships are directional - document relationship semantics clearly
- Discovery jobs use exponential backoff (3 attempts, 2s initial delay)
- **Comprehensive documentation** available at `/doc-site/` and http://localhost:8080

---

# Important Instruction Reminders

## General Rules
- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested

## Documentation Specific Rules

### ✅ DO:
- **Reference the docs site**: When asked about features, architecture, or operations, point to http://localhost:8080 or `/doc-site/docs/`
- **Update existing docs**: Edit files in `/doc-site/docs/` when content changes
- **Use the template**: Copy `/doc-site/docs/_template.md` for new documentation pages (if explicitly requested)
- **Update navigation**: Add new pages to `/doc-site/docs/.vitepress/config.ts` sidebar

### ❌ DON'T:
- **Create scattered markdown files** in root, packages, or random locations
- **Duplicate documentation** - there should be ONE place for each topic
- **Create phase reports** or status updates in `/doc-site/` - those belong in `/docs/PHASE-*`
- **Generate documentation** unless the user explicitly asks for it
- **Create README files** in packages or subdirectories without explicit request

### 📚 Documentation Sprawl Prevention

**Before creating any .md file, ask yourself:**
1. Does this belong in the docs site at `/doc-site/docs/`?
2. Is this temporary (phase report, status update)? → Keep in `/docs/` or root
3. Is this user-facing documentation? → It belongs in `/doc-site/docs/`
4. Is this internal notes? → Use code comments or issue tracker instead

**When asked "document this feature":**
1. Check if documentation already exists in `/doc-site/docs/`
2. If yes: Update the existing file
3. If no: Ask if they want it added to the docs site
4. If yes: Create in appropriate `/doc-site/docs/` subdirectory and update navigation

**When user asks about project details:**
- For architecture: Point to `/doc-site/docs/architecture/`
- For deployment: Point to `/doc-site/docs/deployment/`
- For operations: Point to `/doc-site/docs/operations/`
- For API: Point to `/doc-site/docs/api/`
- For quick reference: Point to `/doc-site/docs/quick-reference/`

### 🎯 Single Source of Truth

All user-facing documentation lives in exactly ONE place: `/doc-site/docs/`

**Directory Structure:**
```
/doc-site/docs/           ← All user-facing documentation HERE
/docs/                    ← Phase reports, internal status (archived)
/packages/*/README.md     ← ONLY if explicitly requested
/*.md (root)              ← Project overview, deployment guides (minimal)
```

**If you find yourself creating a new .md file, STOP and ask:**
- "Should this be in `/doc-site/docs/` instead?"
- "Does similar content already exist that I should update?"
- "Did the user explicitly request this documentation?"
