# Architecture Overview

## Introduction

HappyCMDB is an open-source, enterprise-grade Configuration Management Database (CMDB) platform built with Node.js, TypeScript, and Neo4j. It provides comprehensive infrastructure discovery, relationship mapping, and change management across multi-cloud and on-premise environments.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Presentation Layer                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐    │
│  │  React UI  │  │  CLI Tool  │  │  External Systems  │    │
│  └────────────┘  └────────────┘  └────────────────────┘    │
└────────────┬───────────────┬──────────────────┬─────────────┘
             │               │                  │
┌────────────▼───────────────▼──────────────────▼─────────────┐
│              REST API + GraphQL (Express + Apollo)           │
└────────────┬──────────────────────────────────┬──────────────┘
             │                                  │
┌────────────▼──────────────────────────────────▼──────────────┐
│   Discovery Workers │  ETL Processors  │  Change Detection   │
└────────────┬──────────────────────────────────┬──────────────┘
             │                                  │
┌────────────▼──────────────────────────────────▼──────────────┐
│  Neo4j (Graph)  │  PostgreSQL (Mart)  │  Redis (Cache)       │
└───────────────────────────────────────────────────────────────┘
```

## Key Components

### Presentation Layer
- **React Web UI**: Modern SPA built with React 18, TypeScript, and Material-UI
- **CLI Tool**: Command-line interface for operations and automation
- **API Integrations**: RESTful and GraphQL endpoints for third-party integrations

### Application Layer
- **REST API Server**: Express.js-based API with comprehensive endpoints
- **GraphQL API**: Apollo Server for flexible data queries
- **Authentication**: JWT-based authentication with role-based access control

### Processing Layer
- **Discovery Engine**: Multi-cloud agentless discovery (AWS, Azure, GCP, SSH, Nmap)
- **ETL Processor**: Syncs graph database to relational data mart
- **Job Orchestration**: BullMQ-based job scheduling and queue management
- **Change Detection**: Automated CI change tracking and notifications

### Storage Layer
- **Neo4j**: Primary graph database for CIs and relationships
- **PostgreSQL**: Data mart for analytics and reporting (with TimescaleDB)
- **Redis**: Caching layer and queue backend for BullMQ
- **Kafka**: Event streaming (optional, for enterprise deployments)

## Technology Stack

### Core Runtime
- **Node.js**: v20 LTS
- **TypeScript**: v5.x with strict mode enabled
- **Package Manager**: pnpm (monorepo structure)

### Databases
- **Neo4j Community Edition**: v5.x (graph database)
- **PostgreSQL**: v15+ with TimescaleDB extension
- **Redis**: v7.x (caching and queues)

### Key Libraries
- **Express.js**: REST API framework
- **Apollo Server**: GraphQL server
- **BullMQ**: Job queue and scheduling
- **React**: v18.3+ with concurrent features
- **Material-UI**: v5.x component library

## Design Principles

### 1. Graph-Native Architecture
Neo4j is the source of truth for all configuration items and their relationships. The graph model naturally represents the complex interdependencies in modern IT infrastructure.

### 2. Microservices Separation
The platform is divided into distinct packages with clear responsibilities:
- `@cmdb/common`: Shared types and utilities
- `@cmdb/database`: Database clients
- `@cmdb/api-server`: REST and GraphQL APIs
- `@cmdb/discovery-engine`: Multi-cloud discovery workers
- `@cmdb/etl-processor`: Data mart synchronization
- `@cmdb/agent`: Lightweight discovery agent
- `@cmdb/cli`: Command-line interface

### 3. API-First Design
All operations are accessible via REST and GraphQL APIs, enabling:
- Programmatic automation
- Third-party integrations
- Custom UI development
- CLI tool implementation

### 4. Horizontal Scalability
Each component can be scaled independently:
- API servers: Multiple replicas behind load balancer
- Discovery workers: Scaled based on provider count
- ETL processors: Scaled based on data volume
- Databases: Clustered for high availability

### 5. Cloud-Native Ready
- Docker containers for all services
- Kubernetes manifests for orchestration
- Helm charts for deployment
- Terraform modules for infrastructure

## Data Flow

### Discovery Flow
1. **Trigger**: Scheduled job or manual trigger via API/CLI
2. **Queue**: Job added to provider-specific queue (e.g., `discovery:aws`)
3. **Worker**: Discovery worker picks up job from queue
4. **Discovery**: Worker scans cloud provider or network
5. **Transform**: Raw data transformed to CI format
6. **Persist**: CIs and relationships created/updated in Neo4j
7. **Event**: Discovery completion event published
8. **ETL**: Trigger incremental ETL sync to PostgreSQL

### ETL Sync Flow
1. **Trigger**: Scheduled sync (every 5 minutes) or event-driven
2. **Extract**: Query Neo4j for CIs since last sync
3. **Transform**: Convert graph data to dimensional model
4. **Load**: Upsert records to PostgreSQL data mart (SCD Type 2)
5. **Track**: Record sync timestamp and metrics
6. **Notify**: Update dashboards and metrics

### Query Flow
1. **Request**: API request from UI, CLI, or integration
2. **Validate**: Authentication and authorization check
3. **Route**: Route to appropriate data source
   - Real-time data → Neo4j
   - Analytics/reporting → PostgreSQL
   - Cached data → Redis
4. **Execute**: Query execution with connection pooling
5. **Transform**: Data transformation for response format
6. **Cache**: Cache result in Redis (if applicable)
7. **Response**: Return formatted response

## Security Model

### Authentication
- **JWT Tokens**: Issued after successful login
- **API Keys**: For programmatic access
- **Session Management**: Redis-backed sessions

### Authorization
- **Role-Based Access Control (RBAC)**: Admin, Operator, Viewer roles
- **Resource-Level Permissions**: Fine-grained access control
- **API Key Scopes**: Restricted permissions for API keys

### Data Security
- **Encryption at Rest**: Database encryption enabled
- **Encryption in Transit**: TLS for all external connections
- **Secrets Management**: Kubernetes secrets or external vault
- **Audit Logging**: All changes logged to audit trail

## Performance Characteristics

### Response Times
- **API GET requests**: < 100ms (p95)
- **Simple queries**: < 50ms
- **Complex graph queries**: < 500ms
- **Discovery jobs**: 2-15 minutes (provider-dependent)
- **ETL sync**: < 2 minutes for incremental

### Throughput
- **API requests**: 1000+ req/sec per instance
- **Discovery**: 500+ CIs/minute per worker
- **ETL sync**: 10,000+ CIs/minute

### Scalability Limits
- **CIs**: Tested up to 1 million CIs
- **Relationships**: 10 million+ relationships
- **Concurrent users**: 100+ concurrent users per API instance
- **Discovery workers**: 20+ concurrent workers

## High Availability

### Component Redundancy
- **API Servers**: 3+ replicas (Kubernetes)
- **Neo4j**: 3-node cluster (causal clustering)
- **PostgreSQL**: Primary + read replicas
- **Redis**: 6-node cluster (3 primaries + 3 replicas)

### Failover Strategy
- **API**: Automatic failover via load balancer
- **Neo4j**: Automatic leader election
- **PostgreSQL**: Automatic failover with repmgr
- **Redis**: Sentinel-based failover

### Disaster Recovery
- **Backups**: Daily full + hourly incremental
- **Retention**: 90 days for production
- **RTO**: < 1 hour for full recovery
- **RPO**: < 15 minutes data loss maximum

## Monitoring and Observability

### Metrics Collection
- **Prometheus**: Metrics collection and storage
- **Grafana**: Visualization and dashboards
- **AlertManager**: Alert routing and notification

### Logging
- **Winston**: Structured JSON logging
- **Loki**: Log aggregation (optional)
- **Log Levels**: trace, debug, info, warn, error, fatal

### Tracing
- **OpenTelemetry**: Distributed tracing (optional)
- **Jaeger**: Trace visualization (optional)

### Health Checks
- **Liveness**: `/health/live` - Is the service running?
- **Readiness**: `/health/ready` - Can the service accept traffic?
- **Startup**: `/health/startup` - Has the service finished initialization?

## Deployment Models

### Development
- Docker Compose on local machine
- Single instance of each service
- Minimal resource allocation

### Staging
- Kubernetes cluster (single zone)
- Reduced replica counts
- Production-like configuration

### Production
- Kubernetes cluster (multi-zone)
- Full high-availability setup
- Autoscaling enabled
- Backup and monitoring configured

## Next Steps

- [Backend Architecture](./backend) - Detailed backend design
- [Frontend Architecture](./frontend) - Web UI architecture
- [Database Design](./database-design) - Data models and schemas
- [Job Scheduling](./job-scheduling) - BullMQ implementation
