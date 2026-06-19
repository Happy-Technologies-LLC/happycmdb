<p align="center">
  <img src=".github/assets/happycmdb-logo.png" alt="HappyCMDB" width="120" />
</p>

<h1 align="center">HappyCMDB</h1>

<p align="center">
  Open-source Configuration Management Database (CMDB) with graph-based relationship modeling, AI-powered discovery, and 43 integration connectors.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.3-blue.svg" alt="TypeScript" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20.x-green.svg" alt="Node.js" /></a>
</p>

## What Is This

HappyCMDB is an enterprise CMDB platform that discovers, maps, and tracks infrastructure across multi-cloud and on-premise environments. It stores configuration items (CIs) and their relationships in a Neo4j graph database, syncs to a PostgreSQL analytics data mart, and exposes everything via REST and GraphQL APIs.

### Key Capabilities

- **43 Integration Connectors** (17 TypeScript + 26 JSON declarative) — AWS, Azure, GCP, ServiceNow, Jira, VMware, Kubernetes, SCCM, Datadog, and more
- **AI-Powered Discovery** — LLM-based infrastructure discovery (Anthropic, OpenAI) with automatic pattern learning that compiles successful discoveries into reusable zero-cost patterns
- **Graph-Based Relationships** — Neo4j models CI dependencies, hosting, and connectivity for impact analysis and dependency mapping
- **ITIL v4 + TBM v5 + BSM** — Built-in service management, cost transparency, and business service impact frameworks
- **Hybrid Discovery** — Network protocols (NMAP, SSH, SNMP, Active Directory) via agents + cloud/SaaS APIs via connectors
- **Unified Credentials** — Protocol-based authentication with encrypted storage and affinity matching
- **Analytics Data Mart** — PostgreSQL with TimescaleDB for reporting, with ETL pipeline from Neo4j
- **Event Streaming** — Kafka-based pipeline for real-time CI change processing
- **React Dashboard** — 5 executive dashboards (CIO, ITSM, FinOps, Business Service, Executive)
- **REST + GraphQL APIs** — 20+ endpoints with JWT authentication

## Architecture

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
│   Discovery Engine │  ETL Processors  │  Event Streaming     │
└────────────┬──────────────────────────────────┬──────────────┘
             │                                  │
┌────────────▼──────────────────────────────────▼──────────────┐
│  Neo4j (Graph)  │  PostgreSQL (Mart)  │  Redis (Cache/Queue) │
└───────────────────────────────────────────────────────────────┘
```

## Quick Start

**Prerequisites**: Docker >= 20.10, Docker Compose >= 2.0, Node.js >= 20

```bash
git clone https://github.com/Happy-Technologies-LLC/happycmdb.git
cd happycmdb
cp .env.example .env
./deploy.sh --seed
```

Access points after deployment:
- **Web UI**: http://localhost:3001
- **API**: http://localhost:3000
- **GraphQL Playground**: http://localhost:3000/graphql
- **Documentation**: http://localhost:8080

### Manual Setup

```bash
npm install
cp .env.example .env
docker-compose -f infrastructure/docker/docker-compose.yml up -d
./scripts/db-init.sh
npm run build
npm run dev:api
```

## Repository Structure

| Package | Description |
|---------|-------------|
| `packages/common` | Shared types, utilities, logging, validation, security |
| `packages/database` | Neo4j, PostgreSQL, Redis clients and BullMQ queue manager |
| `packages/api-server` | REST (Express) + GraphQL (Apollo) API server |
| `packages/discovery-engine` | Connector orchestration, job routing, enrichment pipeline |
| `packages/etl-processor` | Neo4j → PostgreSQL data mart sync, reconciliation |
| `packages/agent` | Lightweight discovery agent (NMAP, SSH, SNMP) |
| `packages/cli` | Command-line interface |
| `packages/ai-discovery` | LLM-powered discovery with pattern learning |
| `packages/ai-ml-engine` | Anomaly detection, drift detection, impact prediction |
| `packages/integration-framework` | Base connector framework, auth adapters, registry |
| `packages/data-mapper` | Field mapping and transformation engine |
| `packages/identity-resolution` | Cross-source entity matching and deduplication |
| `packages/itil-service-manager` | ITIL v4 incident, change, and problem management |
| `packages/tbm-cost-engine` | TBM v5.0.1 cost allocation and financial analysis |
| `packages/bsm-impact-engine` | Business service impact analysis |
| `packages/unified-model` | Shared domain model across ITIL, TBM, BSM |
| `packages/event-streaming` | Kafka event pub/sub infrastructure |
| `packages/event-processor` | Event consumer and change processor |
| `packages/framework-integration` | Adapter layer between frameworks |
| `packages/integration-hub` | Integration orchestration |
| `packages/connectors/*` | 43 connectors (17 TypeScript + 26 JSON-only) |
| `web-ui` | React dashboard with TailwindCSS |
| `doc-site` | VitePress documentation site (80+ pages) |
| `infrastructure` | Docker, Kubernetes, Terraform, monitoring configs |

## Roadmap

- **Connector SDK** — Standalone SDK for building custom connectors for any REST/GraphQL API
- **AI Discovery Module** — Standalone AI-powered infrastructure discovery with pattern learning
- **Terraform Provider** — Manage HappyCMDB resources as infrastructure-as-code
- **Helm Chart** — Production Kubernetes deployment with auto-scaling

## Development

```bash
npm run dev               # Start all services in dev mode
npm run build             # Build all packages
npm run test:unit         # Unit tests
npm run test:integration  # Integration tests (requires Docker services)
npm run lint              # ESLint
npm run format            # Prettier
```

## API Examples

```bash
# List all CIs
curl http://localhost:3000/api/v1/cis

# Create a CI
curl -X POST http://localhost:3000/api/v1/cis \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"id":"vm-001","name":"web-server-01","type":"virtual-machine","status":"active"}'

# GraphQL query
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getCIs(type: \"server\") { id name status } }"}'
```

Full API reference: `doc-site/docs/api/`

## Documentation

The documentation site at `doc-site/` covers architecture, deployment, operations, API reference, and connector development. Start it with `./deploy.sh` or:

```bash
cd doc-site && npm run docs:dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributors must sign the [CLA](CLA.md).

## Commercial Support

For deployment assistance, custom connectors, or commercial licensing inquiries, contact **commercial@happy-tech.biz**.

## License

Copyright 2026 Happy Technologies LLC. Licensed under the [Apache License, Version 2.0](LICENSE).

See [NOTICE](NOTICE) for third-party attribution and trademark notices.

---

<p align="center">
  <a href="https://happy-tech.biz">
    <img src=".github/assets/happy-technologies-logo.svg" alt="Happy Technologies LLC" width="280" />
  </a>
</p>

<p align="center">
  Built with care by <a href="https://happy-tech.biz">Happy Technologies LLC</a>
</p>
