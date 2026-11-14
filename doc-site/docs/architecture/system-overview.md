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

### 6. Evidence over assertion (Proposed)
A relationship shown to an operator should say how it is known and how recently. Graph reachability is not runtime blast radius. See [Evidence-qualified relationships and impact](#evidence-qualified-relationships-and-impact-proposed). Proposed by HAP-171; not decided.

## Evidence-qualified relationships and impact (Proposed)

Source: HAP-171 (idea, assessed 2026-11-14 in HAP-2024). **Everything under "Target design" is Proposed**: an uncommitted product direction awaiting founder review, not a decision and not implemented. Claims are labelled **Observed** (read in code on `main` at `71c43f92`, with file:line), **Inferred**, **Proposed** or **Unresolved**.

Path key for cites below: `journal.ts` = `packages/database/src/journal/journal.ts`; `client.ts` = `packages/database/src/neo4j/client.ts`; `001_complete_schema.sql` = `packages/database/src/postgres/migrations/001_complete_schema.sql`; `*.controller.ts` = `packages/api-server/src/rest/controllers/`; `openapi.yaml` = `packages/api-server/src/openapi/openapi.yaml`.

### Current behaviour

* **Observed:** a relationship write stores caller-supplied `properties` verbatim and nothing else: `relationship.controller.ts:117,163-164` passes the request body's `properties` to `writeRelationship`, and the journal statement is `SET r += $props, r.created_at = coalesce(r.created_at, datetime()), r.updated_at = datetime()` (`packages/database/src/journal/journal.ts:105-107`). No server-assigned source, method or verification time is written on the edge. Reads return the stored map as `_properties` (`packages/database/src/neo4j/client.ts:878`).
* **Observed:** traversal output carries no per-edge evidence. Edges are `{ from, to, type }` (`client.ts:919`); the business-service context adds `dependency_type` or `mapping_type` and nothing else (`business-service.controller.ts:861,875`).
* **Observed:** provenance exists per CI, not per edge: `ci_source_lineage` holds `source_name`, `source_id`, `confidence_score`, `last_seen_at` (`journal.ts:257-261`; read at `reconciliation.controller.ts:300-306`).
* **Observed:** evidence columns exist but are unwired. `service_dependencies` has `discovered_at`, `last_verified_at`, `discovered_by` (`001_complete_schema.sql:544-546`), yet no TypeScript in `api-server`, `database` or `discovery-engine` references that table (search of `src/` for `service_dependencies`: only `business_service_dependencies` matches). The table the C1 context actually reads, `business_service_dependencies`, has only `dependency_type` and `created_at` (`001_complete_schema.sql:2587-2595`). The mart table `cmdb.fact_ci_relationships` has `last_verified_at` and `properties`, but the ETL insert writes neither (`etl-processor/src/jobs/neo4j-to-postgres.job.ts:588-592`).
* **Observed:** mapping confidence is caller-asserted: `confidence_score` comes from the request body and defaults to `1.0` (`business-service.controller.ts:541,579-585`).
* **Observed:** the impact summary is a count. `impact_score = min(totalImpacted / 10, 1.0)` (`ci.controller.ts:505-506`). The web UI renders it as a percentage next to "Changes to this CI may affect N other configuration items" (`web-ui/src/components/visualization/ImpactChart.tsx:106-107,115-116`). OpenAPI documents the same field as "Severity score 0-100" (`openapi.yaml:838-840`), while the controller emits 0 to 1.
* **Observed:** the repo already qualifies some claims. `circular_dependencies: 0` means none detected within the supported range (`README.md:121`); an exhausted traversal budget returns a fixed 503, never a truncated graph (`README.md:125,129`).
* **Observed, scoped:** a search of `packages/**/*.ts|json` for `netflow|sflow|traceparent|opentelemetry|otel` matched only `packages/common/src/tracing/` (the service's own tracing). No relationship-producing runtime source was found. Whether the Datadog or Prometheus connectors could produce one is **Unresolved**.
* **Observed:** `ssh-discovery.worker.ts:629-636` builds `LOCATED_IN` edges with `confidence: 0.7, inferred_from: 'same_subnet'`; the egress design records that no queued SSH/nmap/AI handler runs at this head (`docs/discovery-egress-agent-registry-design.md:21`). So that heuristic is present in code but is not a live producer.
* **Inferred:** an operator reading a dependency or impact view cannot tell a hand-declared edge from a discovered one, or a fresh one from a stale one, and a bounded traversal reads as a complete blast radius. **Unresolved:** how often this causes wrong impact assessments; no measurement exists.

### Target design (Proposed)

One capability, **evidence-qualified relationships**, covering the four sub-asks of HAP-171 (receipts, currentness, coverage, reachability is not blast radius). They are one design element because each depends on the receipt.

1. **Evidence class (Proposed).** Per supporting observation: `declared` (a verified principal asserted it via REST, GraphQL or portfolio import), `static_observed` (a connector or discovery read configuration or inventory stating the link), `runtime_observed` (a time-stamped observation of actual traffic, call or connection), `inferred` (heuristic, such as same-subnet). `runtime_observed` is defined but has no producer today (see Later).
2. **Relationship evidence receipt (Proposed).** A server-written row, organization-scoped, referencing the existing identifiers and not a second catalog: org, `from_ci_id` and `to_ci_id` with their CI `incarnation_id`s, relationship type, evidence class, polarity (`supports` or `contradicts`), `source_name`, `source_id`, source version, method, `observed_at`, observer (verified actor or connector run id), and a bounded coded rationale. It is appended in the journal's T2 transaction beside `ci_source_lineage`, never from request `properties` or body, and the organization comes only from the verified identity, as for connectors (`docs/connector-org-security-design.md`, "Data model and trusted authority"). Receipts hold coded fields only: no raw provider text or secrets.
3. **Currentness is derived at read, never stored as "verified" (Proposed).** Per edge: `current` (a supporting receipt inside its class freshness window, source still enabled and seen), `stale`, `contradicted` (a newer `contradicts` receipt), or `unsupported` (no live receipt; this includes a declared edge whose receipt was removed). Receipts bind to CI incarnations, the same rule the derived PostgreSQL rows follow (`README.md:98-100`), so a deleted and re-created CI inherits no support. Removing or invalidating one receipt changes only the claims that rest on it. Freshness windows per class are **Unresolved**.
4. **Coverage stays visible (Proposed).** Each traversal reports the nodes for which no source of any class has reported (derivable from lineage `last_seen_at`) and whether any `runtime_observed` receipt exists in scope. A missing edge is not evidence of no dependency; the response says so.
5. **Impact envelope (Proposed).** Additive fields on `GET /cis/:id/impact`, `/cis/:id/dependencies`, `/impact/graph/:rootCiId` and `/business-services/:id/context`: `basis: "declared_graph_reachability"` and `runtime_blast_radius: "not_established"` unless runtime coverage supports more, plus per-edge `evidence { classes, support, receipt_count }` linking to an org-scoped receipts read (foreign, NULL-org and missing return the same 404, per existing rules). Traversal bounds and fixed 503 on exhaustion are unchanged. The `impact_score` count heuristic keeps its meaning but is labelled with its basis; its 0-1 vs 0-100 contract conflict is fixed in the first story (which side is right is **Unresolved**).

**Boundaries (Proposed).**

* Neo4j stays the source of truth for relationships (Design Principle 1). Receipts are evidence about an edge, stored in PostgreSQL next to `ci_source_lineage` (**Observed** precedent for CI provenance). Cost of the split: an edge can exist without a receipt; the safe direction is that it renders `unsupported`, not `current`.
* No second catalog, no knowledge authority, no adoption of the Ontology Atlas schema. Atlas is the origin of the framing only (**Observed** external: "A graph path is a declared relationship, not proof of a complete runtime blast radius", per the HAP-171 text).
* No tenant identity inferred from folder or project membership. Legacy NULL-org rows stay inaccessible to every caller.
* No new authority: entity and service authorization are unchanged. The HAP-171 text was cut off at "Keep entity/service auth"; reading it as "keep existing entity/service authorization unchanged" is **Inferred**.
* Not every receipt is audit-chained (connector-run volume); declared writes already append chained audit rows (CLAUDE.md, HAP-784). Whether receipts need chaining or a retention policy is **Unresolved**.

**Acceptance for the capability (Proposed, from HAP-171 steps 2-7).** A disposable fixture holds a declared dependency, an observed one, a stale observation, a contradicted claim and an unobserved runtime connection, plus a case whose real impact extends beyond the recorded graph. Every displayed edge opens its receipts and names its class. Changing or deleting a supporting source qualifies only dependent claims. A declared-edge traversal is never labelled complete runtime blast radius. Negative control: delete a receipt, or bypass the currentness check, and the scenario must show `unsupported`, not the old presentation. Operator error and review-effort measurement against the current view (story 5); graph size is not a value metric.

### Story ladder (Proposed)

| # | Story (one PR each) | Repo | Size | Priority | Depends on |
|---|---|---|---|---|---|
| 1 | Qualify impact reads with a basis and coverage envelope | happycmdb (`api-server`, OpenAPI) | S | P2 | none |
| 2 | Relationship evidence receipts: table and journal T2 append | happycmdb (`database`, `api-server`) | M | P2 | none |
| 3 | Per-edge evidence and derived currentness on impact reads, with negative control | happycmdb (`api-server`) | M | P2 | 1, 2 |
| 4 | Evidence drawer and unknown-coverage markers in impact views | happycmdb (`web-ui`) | M | P3 | 3 |
| 5 | Impact-assessment error and review-effort measurement protocol | happycmdb (docs and fixture) | S | P3 | 3 |

### Later (Proposed)

* **Runtime observation producer.** Trigger: stories 2 and 3 merged, and a named runtime source (an existing connector, or an agent-side flow collector) chosen with an owner. An agent-side collector widens the discovery agent's scope beyond NMAP/SSH/SNMP/AD and needs a founder decision first. Until then the UI states "no runtime source connected" rather than implying coverage.

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

## Idea intake 2026-11-14

Founder direction 2026-11-14: triage parked Idea issues and integrate them into the product design. One idea was parked at triage; HAP-2024 is the authority. The Linear issue was not reachable from this lane, so the text in the lane brief was used; it is cut off mid-sentence at "Keep entity/service auth". **Proposed:** all dispositions below, pending founder review.

| HAP id | idea | disposition | design section changed | first story (title) | trigger/reason |
|---|---|---|---|---|---|
| HAP-171 | Evidence-qualified dependency and impact views (Ontology Atlas assessment) | INTEGRATE. Producer of `runtime_observed` evidence split to Later | Design Principle 6; "Evidence-qualified relationships and impact" (this page); README Roadmap bullet | Qualify impact reads with a basis and coverage envelope | Builds on honest-bound precedent (`README.md:121,125`) and per-CI lineage (`journal.ts:257-261`); no second catalog. Runtime producer waits for stories 2 and 3 and a named source. Rejected parts: Atlas schema adoption, folder-inferred tenancy, graph size as value evidence |

**Clusters.** One idea, so no cross-idea cluster. HAP-171 is itself a cluster of four sub-asks (receipts, currentness, coverage, reachability is not blast radius), written once as a single design element above.

**Overlap check.** No MERGE: nothing observed in the repo already provides per-edge evidence (see Current behaviour). Unwired columns (`service_dependencies.last_verified_at`) are reuse candidates for story 2 (**Unresolved**: reuse them or add receipts).

## Next Steps

- [Backend Architecture](/architecture/backend/overview)
- [Frontend Architecture](/architecture/frontend/overview)
- [Database Architecture](/architecture/database/overview)
- [Job Scheduling](/architecture/scheduling/bullmq)
