# E2E Testing Guide

Comprehensive end-to-end testing framework for the HappyCMDB platform.

## Overview

The E2E test suite validates the complete CMDB workflow from API requests through discovery, persistence in Neo4j, ETL synchronization to PostgreSQL, and data retrieval. These tests run against a fully isolated Docker-based environment.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       E2E Test Suite                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  API Client  │  │  DB Helpers  │  │  Test Data Gen  │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                 │                    │           │
│         └─────────────────┼────────────────────┘           │
│                           │                                │
└───────────────────────────┼────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 ▼                 │
          │     Docker Compose E2E Env       │
          ├──────────────────────────────────┤
          │                                  │
          │  ┌────────────┐  ┌────────────┐ │
          │  │   Neo4j    │  │ PostgreSQL │ │
          │  │  (Graph)   │  │ (DataMart) │ │
          │  └────────────┘  └────────────┘ │
          │                                  │
          │  ┌────────────┐  ┌────────────┐ │
          │  │   Redis    │  │ API Server │ │
          │  │  (Queue)   │  │            │ │
          │  └────────────┘  └────────────┘ │
          │                                  │
          │  ┌────────────┐  ┌────────────┐ │
          │  │ Discovery  │  │    ETL     │ │
          │  │  Engine    │  │ Processor  │ │
          │  └────────────┘  └────────────┘ │
          │                                  │
          └──────────────────────────────────┘
```

## Prerequisites

### Required Software
- **Docker Desktop** (v24.0+) or Docker Engine + Docker Compose
- **Node.js** (v20.0+)
- **pnpm** (v8.0+)

### System Requirements
- **RAM**: Minimum 8GB (16GB recommended)
- **Disk**: 10GB free space
- **CPU**: 4+ cores recommended

### Installation

```bash
# Install dependencies
pnpm install

# Verify Docker is running
docker --version
docker-compose --version
```

## Running E2E Tests

### Quick Start

```bash
# Run all E2E tests
pnpm test:e2e

# Run with detailed output
pnpm test:e2e --verbose

# Run specific test suite
pnpm test:e2e --testNamePattern="Discovery Workflow"
```

### Step-by-Step Execution

```bash
# 1. Start E2E environment manually (optional - setup does this automatically)
docker-compose -f tests/e2e/docker-compose.e2e.yml up -d

# 2. Wait for services to be healthy
docker-compose -f tests/e2e/docker-compose.e2e.yml ps

# 3. Run tests
pnpm test:e2e

# 4. Stop environment (optional - teardown does this automatically)
docker-compose -f tests/e2e/docker-compose.e2e.yml down -v
```

### Environment Variables

Configure E2E tests with environment variables:

```bash
# Enable debug logging
DEBUG=true pnpm test:e2e

# Save container logs on test completion
E2E_SAVE_LOGS=true pnpm test:e2e

# Keep volumes after tests (for debugging)
E2E_CLEANUP_VOLUMES=false pnpm test:e2e

# Custom API URL (if not using Docker Compose)
E2E_API_URL=http://localhost:3001 pnpm test:e2e
```

## Test Scenarios

### 1. Full Discovery Flow

**File**: `full-discovery-flow.test.ts`

Tests the complete discovery workflow:
- Schedule AWS discovery via API
- Wait for discovery job completion
- Verify CIs created in Neo4j
- Wait for ETL sync to PostgreSQL
- Verify data in data mart
- Query API to retrieve discovered CIs
- Perform impact analysis

**Duration**: ~2-3 minutes

### 2. CI Operations

Tests CRUD operations on Configuration Items:
- Create CI
- Read CI
- Update CI
- Delete CI
- Search CIs

**Duration**: ~30 seconds

### 3. Relationship Management

Tests relationship operations:
- Create relationships between CIs
- Query relationships
- Verify relationship integrity
- Delete relationships

**Duration**: ~30 seconds

### 4. Impact Analysis

Tests impact analysis functionality:
- Create CI hierarchy
- Analyze upstream dependencies
- Analyze downstream dependencies
- Calculate total impact

**Duration**: ~1 minute

### 5. Data Consistency

Tests data consistency between Neo4j and PostgreSQL:
- Create CIs
- Wait for ETL sync
- Verify data consistency
- Validate field mappings

**Duration**: ~1 minute

### 6. Discovery Job Management

Tests discovery job lifecycle:
- Schedule multiple jobs
- List jobs
- Get job status
- Cancel jobs

**Duration**: ~2 minutes

## Test Utilities

### API Client (`utils/api-client.ts`)

HTTP client for interacting with the CMDB API:

```typescript
import { createApiClient } from './utils/api-client';

const client = createApiClient({
  baseURL: 'http://localhost:3001',
  timeout: 30000,
  debug: true,
});

// Create a CI
const ci = await client.createCI({
  id: 'test-001',
  name: 'Test Server',
  type: 'server',
  status: 'active',
});

// Schedule discovery
const job = await client.scheduleDiscovery('aws', config);

// Wait for job completion
await client.waitForDiscoveryJob(job.id);
```

### Database Helpers (`utils/database-helpers.ts`)

Direct database access for verification:

```typescript
import { createDatabaseHelpers } from './utils/database-helpers';

const db = createDatabaseHelpers();

// Query Neo4j
const ci = await db.neo4j.getCIById('test-001');
const count = await db.neo4j.getCICount();
const relationships = await db.neo4j.getRelationships('test-001');

// Query PostgreSQL
const dmCI = await db.postgres.getCIFromDataMart('test-001');
const metrics = await db.postgres.getCIMetrics(ciKey, 'cpu_usage');

// Cleanup
await db.neo4j.clearAllData();
await db.postgres.clearAllData();
```

### Test Data Generator (`utils/test-data-generator.ts`)

Generate realistic test data:

```typescript
import {
  generateCI,
  generateCIHierarchy,
  generateAWSEC2Instances,
} from './utils/test-data-generator';

// Generate random CI
const ci = generateCI({ type: 'server', environment: 'production' });

// Generate CI hierarchy with relationships
const { cis, relationships } = generateCIHierarchy();

// Generate AWS EC2 instances
const instances = generateAWSEC2Instances(10);
```

### Wait Utilities (`utils/wait-for-services.ts`)

Wait for services to be ready:

```typescript
import {
  waitForNeo4j,
  waitForPostgres,
  waitForService,
} from './utils/wait-for-services';

// Wait for Neo4j
await waitForNeo4j({
  uri: 'bolt://localhost:7688',
  user: 'neo4j',
  password: 'test_password',
  timeout: 60000,
});

// Wait for HTTP service
await waitForService({
  name: 'API Server',
  url: 'http://localhost:3001/health',
  timeout: 60000,
});
```

## Docker Compose Configuration

### Services

The E2E environment includes:

| Service | Port | Purpose |
|---------|------|---------|
| neo4j-e2e | 7688 (Bolt), 7475 (HTTP) | Graph database |
| postgres-e2e | 5433 | Data mart with TimescaleDB |
| redis-e2e | 6380 | Cache and queue |
| api-server-e2e | 3001 | REST API server |
| discovery-engine-e2e | - | Discovery workers |
| etl-processor-e2e | - | ETL sync jobs |

**Note**: Ports are offset by 1 to avoid conflicts with development environment.

### Healthchecks

All services have healthchecks configured:
- **Neo4j**: Cypher query `RETURN 1`
- **PostgreSQL**: `pg_isready` check
- **Redis**: `redis-cli ping`
- **API Server**: HTTP GET `/health`
- **Workers**: Process check

### Volumes

Persistent data volumes:
- `cmdb_neo4j_e2e_data`: Neo4j graph data
- `cmdb_postgres_e2e_data`: PostgreSQL data mart

Volumes are automatically cleaned up after tests unless `E2E_CLEANUP_VOLUMES=false`.

## Troubleshooting

### Tests Failing to Start

**Symptom**: Setup timeout or services not healthy

**Solutions**:
1. Check Docker is running: `docker ps`
2. Check port conflicts: `lsof -i :3001,7688,5433,6380`
3. Increase Docker memory allocation (8GB minimum)
4. Clean up old containers: `docker system prune -a`

### Discovery Jobs Timing Out

**Symptom**: `waitForDiscoveryJob` timeout

**Solutions**:
1. Check discovery engine logs:
   ```bash
   docker-compose -f tests/e2e/docker-compose.e2e.yml logs discovery-engine-e2e
   ```
2. Increase timeout in test configuration
3. Verify Redis connection (job queue)

### ETL Sync Not Working

**Symptom**: CIs not appearing in PostgreSQL

**Solutions**:
1. Check ETL processor logs:
   ```bash
   docker-compose -f tests/e2e/docker-compose.e2e.yml logs etl-processor-e2e
   ```
2. Verify PostgreSQL connection
3. Check BullMQ queues in Redis

### Database Connection Errors

**Symptom**: Connection timeout or refused

**Solutions**:
1. Verify services are healthy:
   ```bash
   docker-compose -f tests/e2e/docker-compose.e2e.yml ps
   ```
2. Check service logs for errors
3. Restart services:
   ```bash
   docker-compose -f tests/e2e/docker-compose.e2e.yml restart
   ```

### Port Conflicts

**Symptom**: Address already in use

**Solutions**:
1. Identify process using port:
   ```bash
   lsof -i :3001
   ```
2. Stop conflicting service or change E2E ports
3. Use different port configuration

## Debugging

### Enable Debug Logging

```bash
DEBUG=true pnpm test:e2e
```

### Save Container Logs

```bash
E2E_SAVE_LOGS=true pnpm test:e2e
```

Logs are saved to `logs/e2e/` directory.

### Run Single Test

```bash
pnpm test:e2e --testNamePattern="should complete full AWS discovery workflow"
```

### Interactive Debugging

```bash
# Start environment
docker-compose -f tests/e2e/docker-compose.e2e.yml up -d

# Wait for services
sleep 30

# Run test with Node debugger
node --inspect-brk node_modules/.bin/jest tests/e2e/full-discovery-flow.test.ts
```

### Manual Service Testing

```bash
# Check API health
curl http://localhost:3001/health

# Query Neo4j
docker exec -it cmdb-neo4j-e2e cypher-shell -u neo4j -p test_password "MATCH (n) RETURN count(n)"

# Query PostgreSQL
docker exec -it cmdb-postgres-e2e psql -U test_user -d cmdb_test -c "SELECT COUNT(*) FROM dim_ci"

# Check Redis
docker exec -it cmdb-redis-e2e redis-cli ping
```

## CI/CD Integration

### GitHub Actions

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - name: Install pnpm
        run: npm install -g pnpm@8
      - name: Install dependencies
        run: pnpm install
      - name: Run E2E tests
        run: pnpm test:e2e
        env:
          E2E_SAVE_LOGS: true
      - name: Upload logs on failure
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: e2e-logs
          path: logs/e2e/
```

### GitLab CI

```yaml
e2e-tests:
  image: node:20
  services:
    - docker:dind
  before_script:
    - npm install -g pnpm@8
    - pnpm install
  script:
    - pnpm test:e2e
  artifacts:
    when: on_failure
    paths:
      - logs/e2e/
```

## Performance Considerations

### Test Execution Time

- **Full suite**: ~8-10 minutes
- **Single test**: ~30 seconds - 3 minutes
- **Setup/teardown**: ~1-2 minutes

### Optimization Tips

1. **Parallel execution**: Not recommended (shared Docker environment)
2. **Cleanup optimization**: Set `E2E_CLEANUP_VOLUMES=false` for local development
3. **Selective testing**: Use `--testNamePattern` for specific tests
4. **CI caching**: Cache Docker images and pnpm store

## Best Practices

### Writing E2E Tests

1. **Test realistic scenarios**: Simulate real user workflows
2. **Use test data generators**: Avoid hardcoded test data
3. **Verify at multiple layers**: Check API, Neo4j, and PostgreSQL
4. **Clean up after tests**: Use `beforeEach` to clear data
5. **Set appropriate timeouts**: Discovery workflows take time
6. **Log test progress**: Use logger for debugging
7. **Handle async operations**: Use proper wait utilities

### Test Isolation

1. **Clear data between tests**: Use database helpers
2. **Generate unique IDs**: Use UUIDs or timestamps
3. **Avoid shared state**: Each test should be independent
4. **Use separate Docker network**: Isolated from dev environment

### Error Handling

1. **Use descriptive error messages**: Include context
2. **Add retry logic**: Handle timing issues
3. **Log intermediate states**: Debug complex workflows
4. **Save logs on failure**: Enable `E2E_SAVE_LOGS`

## Maintenance

### Updating Tests

When adding new features:
1. Add test scenarios to `full-discovery-flow.test.ts`
2. Update utilities if needed
3. Update this README
4. Verify CI/CD integration

### Updating Docker Images

```bash
# Pull latest images
docker-compose -f tests/e2e/docker-compose.e2e.yml pull

# Rebuild application containers
docker-compose -f tests/e2e/docker-compose.e2e.yml build --no-cache
```

### Database Schema Changes

When schemas change:
1. Update `setup.ts` initialization
2. Update database helpers
3. Update test assertions
4. Run full test suite

## Support

For issues or questions:
- Check [Troubleshooting](#troubleshooting) section
- Review container logs
- Open GitHub issue with logs and error details

## Related Documentation

- [CMDB Technical Design](/cmdb-technical-design.md)
- [Project README](/README.md)
- [API Documentation](/docs/api.md)
