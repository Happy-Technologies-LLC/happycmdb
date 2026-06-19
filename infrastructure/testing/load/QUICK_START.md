# HappyCMDB Load Testing - Quick Start Guide

## 30-Second Quick Start

```bash
# 1. Start HappyCMDB
cd /Users/nczitzer/WebstormProjects/happycmdb
./deploy.sh

# 2. Run load tests
cd infrastructure/testing/load
./run-loadtest.sh all

# 3. View results
open reports/summary.html
```

## Common Commands

### Run Specific Tests

```bash
# API endpoints only (8 minutes)
./run-loadtest.sh api

# GraphQL queries only (14 minutes)
./run-loadtest.sh graphql

# Discovery operations only (18 minutes)
./run-loadtest.sh discovery

# Database performance only (13 minutes)
./run-loadtest.sh database

# All tests (~53 minutes total)
./run-loadtest.sh all
```

### Seed Test Data

```bash
# Automatic (done by run-loadtest.sh)
./run-loadtest.sh all

# Manual
node data/seed-testdata.js

# Custom data volume
CI_COUNT=50000 REL_DENSITY=0.5 node data/seed-testdata.js
```

### Docker Testing

```bash
# Start load testing environment
docker-compose -f docker-compose.loadtest.yml up -d

# Run test
docker-compose -f docker-compose.loadtest.yml run --rm k6 run /scripts/api-endpoints.js

# Stop
docker-compose -f docker-compose.loadtest.yml down
```

### View Reports

```bash
# Summary report
open reports/summary.html

# Individual test reports
open reports/api-summary.html
open reports/graphql-summary.html
open reports/discovery-summary.html
open reports/database-summary.html

# Raw JSON data
cat reports/api-results.json | jq '.metrics'
```

## Test Configuration

### Environment Variables

```bash
# API URL
export API_URL=http://localhost:3000

# Skip data seeding
export SEED_DATA=false

# Test data volume
export CI_COUNT=10000
export REL_DENSITY=0.3
```

### Performance Thresholds

Edit `performance-thresholds.yml` to customize:

```yaml
api:
  response_times:
    p95: 500ms  # Change to 1000ms for less strict
```

## Expected Results

### Passing Tests ✅

```
API Endpoints:
  ✓ p50 < 200ms
  ✓ p95 < 500ms
  ✓ Error rate < 1%

GraphQL:
  ✓ Simple queries p95 < 300ms
  ✓ Complex queries p95 < 800ms

Discovery:
  ✓ Job completion p95 < 2 min
  ✓ Success rate > 95%

Database:
  ✓ Neo4j simple p95 < 100ms
  ✓ PostgreSQL p95 < 300ms
  ✓ Cache hit rate > 70%
```

## Troubleshooting

### API Not Available

```bash
# Check health
curl http://localhost:3000/health

# Restart HappyCMDB
cd /Users/nczitzer/WebstormProjects/happycmdb
./deploy.sh
```

### Tests Failing

```bash
# Check if services are running
docker ps

# Check logs
docker logs cmdb-api-server
docker logs cmdb-neo4j
docker logs cmdb-postgres
```

### k6 Not Installed

```bash
# Install k6
brew install k6  # macOS

# OR use Docker
docker-compose -f docker-compose.loadtest.yml run --rm k6 version
```

## Performance Targets

| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| API p95 | < 500ms | < 1000ms | > 1000ms |
| Error Rate | < 1% | < 5% | > 5% |
| Throughput | > 100/s | > 50/s | < 50/s |
| Cache Hit | > 70% | > 50% | < 50% |

## Test Duration

| Test | Duration | VUs |
|------|----------|-----|
| API Endpoints | ~8 min | 1-1000 |
| GraphQL | ~14 min | 50-100 |
| Discovery | ~18 min | 5-50 |
| Database | ~13 min | 30-100 |
| **Total** | **~53 min** | - |

## Next Steps

After running tests:

1. Review HTML reports in `reports/`
2. Compare against baseline in `performance-thresholds.yml`
3. If tests fail, see [README.md](README.md) for tuning guidance
4. For production, run tests in staging environment first

## Full Documentation

See [README.md](README.md) for complete documentation.
