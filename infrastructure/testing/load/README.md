# HappyCMDB Load Testing Suite

Comprehensive load testing and performance benchmarking for HappyCMDB v2.0 using [k6](https://k6.io/).

## Overview

This suite tests HappyCMDB's performance under various load conditions:

- **API Endpoints**: REST API performance (smoke, load, stress, spike scenarios)
- **GraphQL Queries**: Query complexity, nested relationships, mixed workloads
- **Discovery Operations**: Job execution, connector performance, CI persistence
- **Database Performance**: Neo4j, PostgreSQL, Redis query performance and caching

## Requirements

### Local Testing

```bash
# Install k6
brew install k6  # macOS
# OR
curl https://github.com/grafana/k6/releases/download/v0.47.0/k6-v0.47.0-linux-amd64.tar.gz -L | tar xvz
sudo mv k6-v0.47.0-linux-amd64/k6 /usr/local/bin/
```

### Docker Testing

```bash
# k6 is included in the Docker Compose setup
docker-compose -f docker-compose.loadtest.yml up
```

## Quick Start

### 1. Start HappyCMDB

Ensure HappyCMDB services are running:

```bash
cd /Users/nczitzer/WebstormProjects/happycmdb
./deploy.sh
```

Wait for all services to be healthy.

### 2. Run Load Tests

```bash
cd infrastructure/testing/load

# Run all tests
./run-loadtest.sh all

# Run specific test
./run-loadtest.sh api          # API endpoints only
./run-loadtest.sh graphql      # GraphQL queries only
./run-loadtest.sh discovery    # Discovery operations only
./run-loadtest.sh database     # Database performance only
```

### 3. View Results

Results are saved to `reports/`:

```bash
# Open summary report
open reports/summary.html

# View specific test results
open reports/api-summary.html
open reports/graphql-summary.html
open reports/discovery-summary.html
open reports/database-summary.html

# View raw JSON data
cat reports/api-results.json
```

## Test Scripts

### API Endpoints Test (`scripts/api-endpoints.js`)

Tests REST API performance with realistic user workflows.

**Scenarios**:
- **Smoke Test**: 1 user for 30s (verify basic functionality)
- **Load Test**: Ramp to 100 users over 8 minutes (expected normal traffic)
- **Stress Test**: Ramp to 500 users over 9 minutes (beyond expected load)
- **Spike Test**: Sudden jump to 1000 users (traffic surge)

**Endpoints Tested**:
- `GET /api/v1/cis` - List CIs
- `POST /api/v1/cis` - Create CI
- `GET /api/v1/cis/:id` - Get CI by ID
- `PATCH /api/v1/cis/:id` - Update CI
- `GET /api/v1/cis/search` - Search CIs
- `GET /api/v1/cis/:id/relationships` - Get relationships

**Thresholds**:
- p50 response time < 200ms
- p95 response time < 500ms
- p99 response time < 1000ms
- Error rate < 1%
- Throughput > 100 req/sec

### GraphQL Queries Test (`scripts/graphql-queries.js`)

Tests GraphQL API with varying query complexity.

**Scenarios**:
- **Simple Queries**: 50 users for 3 minutes (basic lookups)
- **Complex Queries**: Ramp to 50 users (nested relationships, pathfinding)
- **Mixed Workload**: 100 users (70% simple, 20% medium, 10% complex)

**Query Types**:
- Simple: Get CI by ID, list CIs, search by type
- Medium: Multi-hop relationships, multiple relationship types
- Complex: Deep traversal (3 levels), aggregations, full-text search

**Thresholds**:
- Simple queries p95 < 300ms
- Complex queries p95 < 800ms
- Mixed workload p95 < 500ms
- Average query complexity < 100

### Discovery Operations Test (`scripts/discovery-jobs.js`)

Tests discovery job execution and CI persistence.

**Scenarios**:
- **Sequential Discovery**: 5 users for 5 minutes (one job at a time)
- **Parallel Discovery**: Ramp to 30 users (concurrent jobs)
- **High-Volume Ingestion**: 50 users bulk creating CIs

**Metrics**:
- Job creation and completion rates
- CIs discovered per job
- Relationships created
- CI persistence rate (CIs/second)
- Concurrent job capacity

**Thresholds**:
- Job completion p95 < 2 minutes
- Job success rate > 95%
- CI persistence rate > 10 CIs/sec

### Database Performance Test (`scripts/database-operations.js`)

Tests database query performance and caching.

**Scenarios**:
- **Neo4j Simple**: 30 users (indexed lookups, label scans)
- **Neo4j Complex**: Ramp to 40 users (graph traversal, pathfinding)
- **PostgreSQL Analytics**: Ramp to 50 users (aggregations, time-series)
- **Redis Cache**: 100 users (cache hit/miss testing)

**Queries Tested**:

*Neo4j*:
- Get by ID (indexed)
- List by type (label scan)
- Direct relationships (1-hop)
- Deep traversal (3 levels)
- Shortest path
- Impact analysis
- Pattern matching

*PostgreSQL*:
- Time-series data
- Dimensional aggregations
- Discovery job history
- Metrics summary

*Redis*:
- Cache lookups
- Cache writes

**Thresholds**:
- Neo4j simple queries p95 < 100ms
- Neo4j complex queries p95 < 500ms
- PostgreSQL queries p95 < 300ms
- Redis queries p95 < 10ms
- Cache hit rate > 70%

## Configuration

### Environment Variables

```bash
# API URL (default: http://localhost:3000)
export API_URL=http://localhost:3000

# Seed test data before running tests (default: true)
export SEED_DATA=true

# Generate HTML reports (default: true)
export GENERATE_REPORT=true

# Test data configuration
export CI_COUNT=10000              # Number of CIs to create
export REL_DENSITY=0.3             # 30% of CIs have relationships
```

### Performance Thresholds

Edit `performance-thresholds.yml` to customize target metrics:

```yaml
api:
  response_times:
    p50: 200ms
    p95: 500ms
    p99: 1000ms

  throughput:
    min_rps: 100
    target_rps: 500
    max_rps: 1000
```

## Test Data Seeding

### Automatic Seeding

The test runner automatically seeds data:

```bash
./run-loadtest.sh all
```

### Manual Seeding

```bash
cd data
node seed-testdata.js
```

**Creates**:
- 10,000 CIs (configurable via `CI_COUNT`)
- ~3,000 relationships (30% density)
- 6 discovery definitions
- Test user account (username: `loadtest`, password: `loadtest123`)

### Custom Seeding

```bash
CI_COUNT=50000 REL_DENSITY=0.5 node seed-testdata.js
```

## Docker Compose Testing

Run load tests in Docker:

```bash
# Start load testing environment
docker-compose -f docker-compose.loadtest.yml up -d

# Run specific test
docker-compose -f docker-compose.loadtest.yml run --rm k6 run /scripts/api-endpoints.js

# Run all tests
docker-compose -f docker-compose.loadtest.yml run --rm k6 run /scripts/api-endpoints.js
docker-compose -f docker-compose.loadtest.yml run --rm k6 run /scripts/graphql-queries.js
docker-compose -f docker-compose.loadtest.yml run --rm k6 run /scripts/discovery-jobs.js
docker-compose -f docker-compose.loadtest.yml run --rm k6 run /scripts/database-operations.js

# Stop load testing environment
docker-compose -f docker-compose.loadtest.yml down
```

## Metrics and Reporting

### HTML Reports

Each test generates an HTML report with:

- Key performance metrics
- Response time percentiles
- Throughput and error rates
- Test scenario details
- Pass/fail status for thresholds

### JSON Reports

Raw test data in JSON format for analysis:

```bash
cat reports/api-results.json | jq '.metrics.http_req_duration'
```

### InfluxDB + Grafana (Optional)

For real-time monitoring:

```bash
# Start InfluxDB and Grafana
docker-compose -f docker-compose.loadtest.yml up -d influxdb grafana

# Run k6 with InfluxDB output
K6_OUT=influxdb=http://localhost:8086/k6 k6 run scripts/api-endpoints.js

# Access Grafana
open http://localhost:3001
# Login: admin / loadtest123
```

## Performance Tuning

### If Tests Fail

1. **Check API Health**: Ensure all services are running and healthy
   ```bash
   curl http://localhost:3000/health
   ```

2. **Increase Resources**: Allocate more CPU/memory to Docker containers
   ```bash
   # Edit docker-compose.yml
   deploy:
     resources:
       limits:
         cpus: '4.0'
         memory: 8G
   ```

3. **Adjust Thresholds**: Edit `performance-thresholds.yml` if targets are too aggressive

4. **Scale Services**: Run multiple API server instances behind a load balancer

### If Response Times are High

1. **Check Database Connections**: Ensure connection pools are properly configured
2. **Enable Query Caching**: Verify Redis is running and caching is enabled
3. **Optimize Queries**: Review slow query logs
4. **Index Database**: Ensure Neo4j and PostgreSQL have proper indexes

### If Throughput is Low

1. **Horizontal Scaling**: Add more API server instances
2. **Optimize Discovery**: Limit concurrent discovery jobs
3. **Database Tuning**: Adjust Neo4j/PostgreSQL configuration
4. **Network Optimization**: Check network latency between services

## Interpreting Results

### Good Performance Indicators

- ✅ API p95 < 500ms
- ✅ Error rate < 1%
- ✅ Throughput > 100 req/sec
- ✅ Cache hit rate > 70%
- ✅ Discovery job success rate > 95%

### Warning Signs

- ⚠️ API p95 > 500ms (slow responses)
- ⚠️ Error rate > 1% (reliability issues)
- ⚠️ Cache hit rate < 70% (inefficient caching)
- ⚠️ Job failure rate > 5% (discovery problems)

### Critical Issues

- 🔴 API p95 > 1000ms (unacceptable latency)
- 🔴 Error rate > 5% (system instability)
- 🔴 Throughput < 50 req/sec (capacity issues)
- 🔴 Job failure rate > 10% (discovery broken)

## Continuous Performance Testing

### CI/CD Integration

Add to GitHub Actions workflow:

```yaml
- name: Run Load Tests
  run: |
    cd infrastructure/testing/load
    ./run-loadtest.sh all
  env:
    API_URL: http://localhost:3000
    SEED_DATA: true
```

### Scheduled Testing

Run nightly performance tests:

```bash
# Add to crontab
0 2 * * * cd /path/to/happycmdb/infrastructure/testing/load && ./run-loadtest.sh all
```

## Troubleshooting

### k6 Not Found

```bash
# Install k6
brew install k6  # macOS
# OR download from https://k6.io/docs/getting-started/installation/
```

### API Connection Refused

```bash
# Check if API is running
curl http://localhost:3000/health

# Start HappyCMDB if not running
cd /Users/nczitzer/WebstormProjects/happycmdb
./deploy.sh
```

### Test Data Seeding Fails

```bash
# Check credentials
export TEST_USERNAME=loadtest
export TEST_PASSWORD=loadtest123

# Manually seed
cd data
node seed-testdata.js
```

### Reports Not Generated

```bash
# Ensure reports directory exists
mkdir -p reports

# Check permissions
chmod -R 755 reports/
```

## Best Practices

1. **Baseline First**: Run tests on a clean system to establish baseline performance
2. **Consistent Environment**: Use the same test environment for comparisons
3. **Warm Up**: Run a smoke test before heavy load tests
4. **Monitor Resources**: Watch CPU, memory, and disk I/O during tests
5. **Test Incrementally**: Start with smoke tests, then gradually increase load
6. **Clean Up**: Remove test data after load testing to avoid skewing results
7. **Version Control**: Commit test results for historical comparison

## Performance Baselines

### Expected Performance (HappyCMDB v2.0)

| Metric | Target | Production |
|--------|--------|------------|
| API p95 | < 500ms | < 200ms |
| GraphQL p95 | < 500ms | < 300ms |
| Discovery Job p95 | < 2 min | < 1 min |
| Neo4j Simple p95 | < 100ms | < 50ms |
| PostgreSQL p95 | < 300ms | < 100ms |
| Redis p95 | < 10ms | < 5ms |
| Cache Hit Rate | > 70% | > 85% |
| Throughput | > 100 req/s | > 1000 req/s |
| Error Rate | < 1% | < 0.1% |

## Additional Resources

- [k6 Documentation](https://k6.io/docs/)
- [k6 Examples](https://k6.io/docs/examples/)
- [Performance Testing Best Practices](https://k6.io/docs/testing-guides/load-testing/)
- [HappyCMDB Documentation](http://localhost:8080)

## Support

For issues or questions:

1. Check the [troubleshooting section](#troubleshooting)
2. Review [HappyCMDB documentation](http://localhost:8080)
3. Open an issue in the project repository
