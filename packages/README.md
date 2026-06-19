# HappyCMDB Packages

This directory contains all backend packages for the HappyCMDB platform, organized as a TypeScript monorepo using npm/pnpm workspaces.

## 📦 Package Overview

HappyCMDB follows a **layered architecture** with 14 packages organized by responsibility:

### Layer 1: Foundation (1 package)

**[@cmdb/common](./common/)**
- Shared TypeScript types, interfaces, and utilities
- Logger configuration (Winston)
- Validation schemas (Joi)
- Prometheus metrics
- **No dependencies** - foundation for all other packages

### Layer 2: Infrastructure (2 packages)

**[@cmdb/database](./database/)**
- Database clients: Neo4j (graph), PostgreSQL (data mart), Redis (cache/queue)
- Connection pooling and singleton patterns
- Query builders and utilities
- **Depends on**: `@cmdb/common`

**[@cmdb/event-processor](./event-processor/)**
- Kafka event streaming
- Event publishers and consumers
- Async event handling
- **Depends on**: `@cmdb/common`, `@cmdb/database`

### Layer 3: Core Services (3 packages)

**[@cmdb/discovery-engine](./discovery-engine/)**
- Connector orchestration and job routing
- Discovery job scheduling (BullMQ)
- Smart agent routing with network affinity
- **Depends on**: `@cmdb/common`, `@cmdb/database`, cloud SDKs

**[@cmdb/etl-processor](./etl-processor/)**
- ETL jobs (Extract, Transform, Load)
- Neo4j → PostgreSQL data mart synchronization
- Data transformation pipelines
- **Depends on**: `@cmdb/common`, `@cmdb/database`

**[@cmdb/agent](./agent/)**
- Lightweight discovery agent (network protocols)
- NMAP, SSH, SNMP discovery
- Runs on remote networks
- **Depends on**: `@cmdb/common`

### Layer 4: Integration Framework (4 packages) - v2.0

**[@cmdb/integration-framework](./integration-framework/)**
- Base framework for external integrations
- Connector interface definitions
- Authentication handling
- **Depends on**: `@cmdb/common`, `@cmdb/database`

**[@cmdb/data-mapper](./data-mapper/)**
- Field mapping between systems
- Data transformation rules
- Schema translation
- **Depends on**: `@cmdb/common`, `@cmdb/database`

**[@cmdb/identity-resolution](./identity-resolution/)**
- CI deduplication and matching
- Fuzzy matching algorithms
- Confidence scoring
- **Depends on**: `@cmdb/common`, `@cmdb/database`

**[@cmdb/integration-hub](./integration-hub/)**
- Integration orchestration
- Workflow coordination
- External system routing
- **Depends on**: All integration packages

### Layer 5: AI/ML (1 package) - v2.0

**[@cmdb/ai-ml-engine](./ai-ml-engine/)**
- Anomaly detection
- Drift detection
- Impact analysis
- Predictive models
- **Depends on**: `@cmdb/common`, `@cmdb/database`, `@cmdb/event-processor`, ML libraries

### Layer 6: Applications (2 packages)

**[@cmdb/api-server](./api-server/)**
- REST API (Express)
- GraphQL API (Apollo Server)
- Authentication and authorization
- Main application entry point
- **Depends on**: `@cmdb/common`, `@cmdb/database`

**[@cmdb/cli](./cli/)**
- Command-line interface
- Operational tooling
- Discovery management
- **Depends on**: `@cmdb/common`, `@cmdb/discovery-engine`, `@cmdb/etl-processor`

### Layer 7: Connectors (43 connectors)

**[connectors/](./connectors/)**
- **17 TypeScript connectors**: Custom logic (AWS, Azure, GCP, VMware, Kubernetes, etc.)
- **20 JSON-only connectors**: Declarative ETL (Jira, Datadog, ServiceNow, etc.)
- Each connector is self-contained
- See [Connector Catalog](/doc-site/docs/components/connector-registry.md)

---

## 🏗️ Architecture Principles

### Dependency Flow
```
common (no deps)
  ↓
database, event-processor
  ↓
discovery-engine, etl-processor, agent
  ↓
integration-framework, data-mapper, identity-resolution
  ↓
integration-hub, ai-ml-engine
  ↓
api-server, cli
```

### Key Rules
1. **No circular dependencies** - All packages follow strict layering
2. **Single responsibility** - Each package has one clear purpose
3. **Dependency minimization** - Packages only depend on lower layers
4. **Interface segregation** - Packages expose minimal public APIs

---

## 🚀 Working with Packages

### Building Packages

**Build all packages**:
```bash
npm run build
# or
./scripts/build-all.sh
```

**Build specific package**:
```bash
cd packages/common
npm run build
```

**Build order** (automated by scripts):
1. `@cmdb/common`
2. `@cmdb/database`
3. `@cmdb/event-processor`
4. Integration framework packages
5. `@cmdb/ai-ml-engine`
6. `@cmdb/discovery-engine`, `@cmdb/etl-processor`
7. `@cmdb/api-server`

### Package Structure

All packages follow this structure:
```
packages/<package-name>/
├── package.json          # Package metadata and dependencies
├── tsconfig.json         # TypeScript configuration
├── src/                  # Source code (TypeScript)
│   ├── index.ts         # Main entry point
│   ├── types/           # Type definitions
│   └── ...
├── dist/                 # Compiled JavaScript (generated)
└── tests/               # Unit and integration tests
```

### Creating New Packages

1. **Create directory**: `mkdir packages/my-package`
2. **Add package.json**:
   ```json
   {
     "name": "@cmdb/my-package",
     "version": "1.0.0",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc",
       "test": "jest"
     },
     "dependencies": {
       "@cmdb/common": "*"
     }
   }
   ```
3. **Add tsconfig.json**: Extend from `tsconfig.base.json`
4. **Create src/index.ts**: Main entry point
5. **Update dependency graph**: Ensure no circular dependencies

---

## 📊 Package Dependencies

### Core Dependencies (all packages)
- `typescript` ^5.3.3
- `@types/node` ^20.10.0

### Common Patterns
- **Database access**: Use `@cmdb/database` singletons
- **Logging**: Use `logger` from `@cmdb/common`
- **Types**: Import from `@cmdb/common/types`
- **Validation**: Use Joi schemas from `@cmdb/common`

---

## 🧪 Testing

**Run all tests**:
```bash
npm test
# or
./scripts/test-all.sh
```

**Test specific package**:
```bash
cd packages/common
npm test
```

**Test types**:
- Unit tests: Fast, isolated, no dependencies
- Integration tests: Database operations, external services
- E2E tests: Full workflow testing

---

## 🐛 Troubleshooting

### TypeScript Build Cache Issues

**Problem**: Changes not appearing after build

**Solution**:
```bash
# Clean cache
find packages -name "tsconfig.tsbuildinfo" -delete
rm -rf packages/*/dist

# Rebuild all
npm run build
```

### Workspace Dependency Issues

**Problem**: Package not found or version mismatch

**Solution**:
```bash
# Reinstall all dependencies
npm run clean
npm install
npm run build
```

### Import Errors

**Problem**: Cannot find module '@cmdb/...'

**Check**:
1. Package has been built (`dist/` folder exists)
2. Package is listed in dependencies
3. Import path is correct

---

## 📚 Documentation

- **Architecture**: `/doc-site/docs/architecture/`
- **Package APIs**: `/doc-site/docs/api/`
- **Development Guide**: `/doc-site/docs/development/`
- **Connector Development**: `/doc-site/docs/components/connector-registry.md`

---

## 🎯 Package Status

| Package | Status | Build | Tests |
|---------|--------|-------|-------|
| common | ✅ Complete | ✅ Built | ✅ Passing |
| database | ✅ Complete | ✅ Built | ✅ Passing |
| event-processor | ✅ Complete | ✅ Built | ✅ Passing |
| discovery-engine | ✅ Complete | ✅ Built | ✅ Passing |
| etl-processor | ✅ Complete | ✅ Built | ✅ Passing |
| agent | ✅ Complete | ⚠️  Needs build | - |
| integration-framework | ✅ Complete | ✅ Built | ✅ Passing |
| data-mapper | ✅ Complete | ✅ Built | ✅ Passing |
| identity-resolution | ✅ Complete | ✅ Built | ✅ Passing |
| integration-hub | ✅ Complete | ✅ Built | ✅ Passing |
| ai-ml-engine | ✅ Complete | ✅ Built | ✅ Passing |
| api-server | ✅ Complete | ✅ Built | ✅ Passing |
| cli | ✅ Complete | ⚠️  Needs build | - |
| connectors/* | ✅ Complete | ✅ Built | ✅ Passing |

---

## 🔗 Related

- **Web UI**: Located at `/web-ui/` (separate workspace)
- **Documentation**: Located at `/doc-site/`
- **Infrastructure**: Located at `/infrastructure/`
- **Scripts**: Located at `/scripts/`

---

**Questions?** See full documentation at http://localhost:8080 (when running)
