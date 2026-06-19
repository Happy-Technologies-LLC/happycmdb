# System Architecture Overview

HappyCMDB is designed as a modern, cloud-native microservices application with a graph database at its core.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Web UI (React)                       │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway Layer                         │
│  ┌──────────────────┐          ┌──────────────────┐        │
│  │   REST API       │          │   GraphQL API    │        │
│  └──────────────────┘          └──────────────────┘        │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Discovery   │ │     ETL      │ │   Data Mart  │
│   Engine     │ │  Processor   │ │   Service    │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       ▼                ▼                ▼
┌─────────────────────────────────────────────┐
│           Message Queue (BullMQ/Redis)       │
└─────────────────────────────────────────────┘
       │                │                │
       ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│    Neo4j     │ │  PostgreSQL  │ │    Redis     │
│   (Graph)    │ │ (Data Mart)  │ │   (Cache)    │
└──────────────┘ └──────────────┘ └──────────────┘
```

## Core Components

### 1. Web UI Layer
- **Technology**: React 18+ with TypeScript
- **Purpose**: User interface for visualization, configuration, and management
- **Features**: Graph visualization, CI management, reporting, configuration

### 2. API Layer
- **REST API**: Express-based RESTful endpoints
- **GraphQL API**: Apollo Server for flexible querying
- **Purpose**: Unified interface for all CMDB operations
- **Authentication**: JWT-based with role-based access control

### 3. Discovery Engine
- **Technology**: Node.js microservice with cloud provider SDKs
- **Purpose**: Automated infrastructure discovery across cloud providers
- **Capabilities**:
  - AWS: EC2, RDS, S3, ECS, Lambda, VPC
  - Azure: VMs, SQL, Storage, App Services
  - GCP: Compute Engine, Cloud SQL, Cloud Storage
  - SSH: Linux/Unix server discovery
  - Network: NMAP-based device scanning

### 4. ETL Processor
- **Technology**: BullMQ workers for job processing
- **Purpose**: Transform and synchronize data between Neo4j and PostgreSQL
- **Operations**:
  - Data transformation and enrichment
  - Relationship mapping
  - Dimension table updates
  - Fact table population

### 5. Data Stores

#### Neo4j (Primary)
- **Role**: Source of truth for CI data and relationships
- **Why Graph**: Natural fit for representing infrastructure dependencies
- **Features**: Cypher query language, ACID transactions, clustering support

#### PostgreSQL (Analytics)
- **Role**: Data mart for reporting and analytics
- **Extensions**: TimescaleDB for time-series data
- **Schema**: Star schema with dimension and fact tables

#### Redis (Cache & Queue)
- **Role**: Caching layer and message queue backend
- **Features**: High-performance in-memory storage, pub/sub, persistence

## Data Flow

### Discovery Flow

```
1. Discovery Job Created
   ↓
2. Job Queued in BullMQ
   ↓
3. Discovery Worker Picks Up Job
   ↓
4. Cloud Provider API Calls
   ↓
5. DiscoveredCI Objects Created
   ↓
6. Persisted to Neo4j (upsert)
   ↓
7. ETL Job Triggered
   ↓
8. Data Synced to PostgreSQL
   ↓
9. Cache Updated in Redis
```

### Query Flow

```
1. API Request (REST/GraphQL)
   ↓
2. Check Redis Cache
   ↓
3. Cache Hit? → Return Data
   ↓
4. Cache Miss → Query Neo4j/PostgreSQL
   ↓
5. Transform Results
   ↓
6. Update Cache
   ↓
7. Return Response
```

## Design Principles

### 1. Graph-First
Neo4j is the source of truth for configuration items and relationships. The graph model naturally represents infrastructure dependencies.

### 2. Microservices
Independent services with clear boundaries enable:
- Independent scaling
- Technology flexibility
- Fault isolation
- Team autonomy

### 3. Async Processing
BullMQ job queues enable:
- Long-running discovery jobs
- Retry logic with exponential backoff
- Job prioritization
- Parallel processing

### 4. Dual Storage
- **Neo4j**: Operational queries, relationship traversal, real-time updates
- **PostgreSQL**: Analytics, reporting, time-series data, SQL compatibility

### 5. API-First
All functionality exposed through REST and GraphQL APIs enables:
- Multiple clients (UI, CLI, integrations)
- Third-party integrations
- Automation and scripting

## Scalability

### Horizontal Scaling
- **Discovery Workers**: Scale by adding more worker instances
- **API Servers**: Stateless design allows load balancing
- **ETL Processors**: Multiple workers can process jobs in parallel

### Vertical Scaling
- **Neo4j**: Increase memory and CPU for larger graphs
- **PostgreSQL**: Scale compute and storage for data mart
- **Redis**: Increase memory for larger caches

### Database Scaling
- **Neo4j Clustering**: Causal clustering for read replicas
- **PostgreSQL Replication**: Primary-replica setup for read scaling
- **Redis Clustering**: Distributed cache with Redis Cluster

## High Availability

- **Load Balancing**: Multiple API server instances
- **Database Replication**: Primary-replica setup
- **Queue Redundancy**: Redis persistence and clustering
- **Health Checks**: Kubernetes liveness and readiness probes
- **Automated Failover**: Database automatic failover

## Security Architecture

- **Authentication**: JWT tokens with refresh mechanism
- **Authorization**: Role-based access control (RBAC)
- **Secrets Management**: Environment variables, Kubernetes secrets, or Vault
- **Network Security**: TLS/SSL for all connections
- **Audit Logging**: All operations logged for compliance

## Next Steps

- [Backend Architecture](/architecture/backend/overview)
- [Frontend Architecture](/architecture/frontend/overview)
- [Database Architecture](/architecture/database/overview)
- [Job Scheduling](/architecture/scheduling/bullmq)
