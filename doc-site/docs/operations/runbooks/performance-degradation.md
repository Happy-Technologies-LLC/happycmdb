# Runbook: Performance Degradation

**Alert Name**: `APIResponseTimeSlow`, `GraphQLQuerySlow`, `DatabaseQuerySlow`, `HighAPIErrorRate`
**Severity**: Warning / Critical
**Component**: api-server, databases, etl-processor
**Initial Response Time**: 15 minutes (warning), 10 minutes (critical)

## Symptoms

- API response time >1s (p95) warning, >3s critical
- GraphQL queries >2s (p95)
- Database queries >500ms (p95)
- High API error rate (>5% warning, >20% critical)
- User complaints about slow application
- Timeouts in logs

## Impact

- **User Experience**: Slow application, poor UX, user frustration
- **Operations**: Discovery jobs timing out, incomplete data collection
- **Business**: SLA violations, potential customer churn
- **System Stability**: Cascading failures possible if not addressed

## Diagnosis

### 1. Check Current Performance Metrics

```bash
# Check API response times
curl -s http://localhost:9090/api/v1/query?query=histogram_quantile\(0.95,rate\(http_request_duration_seconds_bucket[5m]\)\) | jq

# Check error rate
curl -s http://localhost:9090/api/v1/query?query=rate\(http_requests_total{status=~\"5..\"}[5m]\)/rate\(http_requests_total[5m]\) | jq

# Check request rate
curl -s http://localhost:9090/api/v1/query?query=rate\(http_requests_total[5m]\) | jq

# Quick health check
curl -w "@curl-format.txt" -o /dev/null -s http://localhost:3000/health
# curl-format.txt:
# time_namelookup: %{time_namelookup}\n
# time_connect: %{time_connect}\n
# time_starttransfer: %{time_starttransfer}\n
# time_total: %{time_total}\n
```

### 2. Check Resource Utilization

```bash
# CPU usage
docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}" | sort -k2 -hr

# Memory usage
docker stats --no-stream --format "table {{.Container}}\t{{.MemUsage}}\t{{.MemPerc}}" | sort -k3 -hr

# System load
uptime
top -bn1 | head -20

# Check for CPU throttling
for container in $(docker ps --format '{{.Names}}'); do
  echo "=== $container ==="
  docker stats $container --no-stream --format "{{.CPUPerc}}"
done
```

### 3. Check Database Performance

**Neo4j**:
```bash
# Check slow queries
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
  "CALL dbms.listQueries() YIELD queryId, query, elapsedTimeMillis
   WHERE elapsedTimeMillis > 1000
   RETURN queryId, query, elapsedTimeMillis
   ORDER BY elapsedTimeMillis DESC;"

# Check connection pool
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
  "CALL dbms.listConnections();"

# Check page cache hit rate
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
  "CALL dbms.queryJmx('org.neo4j:instance=kernel#0,name=Page cache')
   YIELD attributes
   RETURN attributes.PageCacheHitRatio;"
```

**PostgreSQL**:
```bash
# Check slow queries
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT pid, now() - query_start AS duration, state, query
   FROM pg_stat_activity
   WHERE state != 'idle'
   AND query NOT ILIKE '%pg_stat_activity%'
   ORDER BY duration DESC
   LIMIT 10;"

# Check for locks
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT blocked_locks.pid AS blocked_pid,
          blocked_activity.usename AS blocked_user,
          blocking_locks.pid AS blocking_pid,
          blocking_activity.usename AS blocking_user,
          blocked_activity.query AS blocked_statement,
          blocking_activity.query AS blocking_statement
   FROM pg_catalog.pg_locks blocked_locks
   JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
   JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
   JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
   WHERE NOT blocked_locks.granted
   AND blocking_locks.granted;"

# Check cache hit rate
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT sum(heap_blks_read) as heap_read,
          sum(heap_blks_hit) as heap_hit,
          sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) as cache_hit_ratio
   FROM pg_statio_user_tables;"

# Check table sizes
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT schemaname, tablename,
          pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
   FROM pg_tables
   WHERE schemaname = 'public'
   ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
   LIMIT 10;"
```

### 4. Check Application Logs

```bash
# Check for errors
docker logs cmdb-api-server --since 10m 2>&1 | grep -i "error\|timeout\|slow"

# Check for database connection issues
docker logs cmdb-api-server --since 10m 2>&1 | grep -i "connection\|pool"

# Check request patterns
docker logs cmdb-api-server --since 10m | awk '{print $7}' | sort | uniq -c | sort -rn | head -20
```

### 5. Check Network Performance

```bash
# Check network latency to databases
time docker exec cmdb-api-server nc -zv cmdb-neo4j 7687
time docker exec cmdb-api-server nc -zv cmdb-postgres 5432
time docker exec cmdb-api-server nc -zv cmdb-redis 6379

# Check for packet loss
docker exec cmdb-api-server ping -c 10 cmdb-neo4j
```

## Resolution Steps

### Step 1: Quick Wins - Clear Caches

```bash
# Clear Redis cache
docker exec cmdb-redis redis-cli FLUSHDB

# Restart API server to clear in-memory caches
docker restart cmdb-api-server

# Wait and verify improvement
sleep 30
curl -w "%{time_total}\n" -o /dev/null -s http://localhost:3000/api/v1/cis?limit=10
```

### Step 2: Kill Long-Running Queries

**PostgreSQL**:
```bash
# Terminate long-running queries
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state != 'idle'
   AND query_start < NOW() - INTERVAL '5 minutes'
   AND pid != pg_backend_pid();"
```

**Neo4j**:
```bash
# List and kill slow queries
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
  "CALL dbms.listQueries() YIELD queryId, elapsedTimeMillis
   WHERE elapsedTimeMillis > 10000
   RETURN queryId;" | \
while read queryId; do
  docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
    "CALL dbms.killQuery('$queryId');"
done
```

### Step 3: Optimize Database Queries

**Identify N+1 query problems**:
```bash
# Check for repeated similar queries
docker logs cmdb-api-server --since 10m 2>&1 | grep -i "SELECT\|MATCH" | sort | uniq -c | sort -rn | head -20

# Profile a specific query (PostgreSQL)
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "EXPLAIN ANALYZE SELECT * FROM connectors WHERE enabled = true;"
```

**Add missing indexes** (if identified):
```bash
# PostgreSQL - Add index on frequently queried columns
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "CREATE INDEX CONCURRENTLY idx_connectors_enabled ON connectors(enabled) WHERE enabled = true;"

# Neo4j - Add index on frequently searched properties
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
  "CREATE INDEX ci_name_index IF NOT EXISTS FOR (n:CI) ON (n.name);"
```

### Step 4: Scale Resources

**Increase container resources**:

Edit `infrastructure/docker/docker-compose.yml`:
```yaml
services:
  api-server:
    deploy:
      resources:
        limits:
          cpus: '2.0'      # Increase from 1.0
          memory: 4G       # Increase from 2G
        reservations:
          cpus: '1.0'
          memory: 1G
```

Recreate containers:
```bash
docker-compose -f infrastructure/docker/docker-compose.yml up -d --force-recreate api-server
```

**Scale horizontally**:
```bash
# Add more API server instances
docker-compose -f infrastructure/docker/docker-compose.yml up -d --scale api-server=3

# Add load balancer if not present
# See infrastructure/docker/nginx-lb.conf
```

### Step 5: Optimize Neo4j Configuration

Edit Neo4j memory settings:
```bash
docker exec cmdb-neo4j bash -c "cat >> /var/lib/neo4j/conf/neo4j.conf << EOF
dbms.memory.heap.initial_size=2g
dbms.memory.heap.max_size=4g
dbms.memory.pagecache.size=2g
dbms.jvm.additional=-XX:+UseG1GC
dbms.jvm.additional=-XX:+PrintGCDetails
dbms.jvm.additional=-XX:+PrintGCDateStamps
EOF"

docker restart cmdb-neo4j
```

### Step 6: Optimize PostgreSQL Configuration

```bash
# Tune PostgreSQL settings
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "ALTER SYSTEM SET shared_buffers = '1GB';"
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "ALTER SYSTEM SET effective_cache_size = '3GB';"
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "ALTER SYSTEM SET work_mem = '16MB';"
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "ALTER SYSTEM SET maintenance_work_mem = '256MB';"

# Restart PostgreSQL
docker restart cmdb-postgres

# Run VACUUM ANALYZE
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "VACUUM ANALYZE;"
```

### Step 7: Implement Query Result Caching

Add Redis caching to frequently accessed endpoints:

```typescript
// packages/api-server/src/middleware/cache.middleware.ts
import { getRedisClient } from '@cmdb/database';

export async function cacheMiddleware(req, res, next) {
  const key = `cache:${req.path}:${JSON.stringify(req.query)}`;
  const cached = await getRedisClient().get(key);

  if (cached) {
    return res.json(JSON.parse(cached));
  }

  const originalJson = res.json;
  res.json = function(data) {
    getRedisClient().setex(key, 300, JSON.stringify(data)); // 5 min TTL
    return originalJson.call(this, data);
  };

  next();
}
```

### Step 8: Reduce Discovery Load

```bash
# Temporarily pause discovery jobs
curl -X POST http://localhost:3000/api/v1/discovery/pause

# Or reduce discovery frequency
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "UPDATE discovery_definitions
   SET schedule_interval = schedule_interval * 2
   WHERE enabled = true;"

# Reduce concurrent workers
docker exec cmdb-discovery-engine node -e \
  "process.env.DISCOVERY_WORKER_CONCURRENCY = '3';"  # Reduce from 5
docker restart cmdb-discovery-engine
```

## Verification

After resolution:

1. **Response Times**: API p95 < 500ms, GraphQL p95 < 1s
2. **Error Rate**: <1% of requests returning errors
3. **Resource Usage**: CPU <60%, Memory <70%
4. **Database Performance**: Query times normal
5. **User Reports**: No complaints about performance
6. **Monitoring**: All performance metrics green

## Escalation

If issue persists after 1 hour:

1. **Escalate to**: Senior Backend Engineer / Database Administrator
2. **Provide**:
   - Performance graphs (last 24 hours)
   - Slow query logs
   - Resource utilization metrics
   - Recent deployments or changes
   - Database explain plans
3. **Consider**:
   - Emergency rollback to previous version
   - Database failover (if replication configured)
   - Temporary service degradation

## Post-Incident Actions

1. **Query Optimization**: Review and optimize identified slow queries
2. **Index Strategy**: Add missing indexes based on query patterns
3. **Load Testing**: Conduct load testing to identify bottlenecks
4. **Capacity Planning**: Review and adjust resource allocations
5. **Caching Strategy**: Implement caching for hot paths
6. **Code Review**: Review recent code changes for performance issues
7. **Monitoring**: Add detailed performance monitoring for key operations

## Common Causes

| Cause | Frequency | Prevention |
|-------|-----------|------------|
| Missing database indexes | High | Regular query performance review |
| N+1 query problems | High | Code review, ORM query inspection |
| Unbounded result sets | Medium | Enforce pagination everywhere |
| Memory leaks | Medium | Memory profiling, heap dumps |
| Inefficient queries | Medium | Query explain plans, optimization |
| High load / traffic spike | Medium | Auto-scaling, load balancing |
| Resource exhaustion | Low | Resource monitoring, limits |
| Database locks | Low | Lock monitoring, query optimization |

## Related Runbooks

- [High Memory Usage](./high-memory-usage.md)
- [Database Connection Issues](./database-connection-issues.md)
- [Discovery Jobs Failing](./discovery-jobs-failing.md)

## Useful Commands

```bash
# Real-time performance monitoring
watch -n 2 "curl -w '%{time_total}\n' -o /dev/null -s http://localhost:3000/health"

# Database query performance summary
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT query, mean_exec_time, calls
   FROM pg_stat_statements
   ORDER BY mean_exec_time DESC
   LIMIT 20;"

# Check connection pools
docker logs cmdb-api-server 2>&1 | grep -i "pool"

# Profile API endpoint
time curl -X GET http://localhost:3000/api/v1/cis?limit=100

# Check for memory leaks
docker exec cmdb-api-server node -e "console.log(process.memoryUsage())"

# Full system restart (last resort)
docker-compose -f infrastructure/docker/docker-compose.yml restart
```

## Monitoring Queries

```promql
# API response time (p95)
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# API error rate
rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])

# Database query time (p95)
histogram_quantile(0.95, rate(database_query_duration_seconds_bucket[5m]))

# CPU usage
100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Memory usage
(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))

# Request rate
rate(http_requests_total[5m])
```
