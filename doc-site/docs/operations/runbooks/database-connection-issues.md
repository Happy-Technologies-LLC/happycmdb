# Runbook: Database Connection Issues

**Alert Name**: `Neo4jDown`, `PostgreSQLDown`, `RedisDown`, `Neo4jConnectionPoolExhausted`, `PostgreSQLTooManyConnections`
**Severity**: Critical / Warning
**Component**: neo4j, postgresql, redis
**Initial Response Time**: 5 minutes (critical), 15 minutes (warning)

## Symptoms

- Applications logging "Connection refused" or "Connection timeout" errors
- Database health checks failing
- Connection pool exhaustion warnings
- Slow query performance
- Discovery jobs failing with database errors

## Impact

- **Neo4j Down**: All CI queries fail, discovery cannot persist data, relationship traversals impossible
- **PostgreSQL Down**: Connector registry unavailable, credentials inaccessible, metadata operations fail
- **Redis Down**: Cache unavailable, job queue stopped, session management degraded
- **Connection Pool Exhausted**: New operations delayed or fail, performance degradation

## Diagnosis

### 1. Check Database Service Status

```bash
# Check if database containers are running
docker ps | grep -E "cmdb-neo4j|cmdb-postgres|cmdb-redis"

# Check database logs
docker logs cmdb-neo4j --tail=100
docker logs cmdb-postgres --tail=100
docker logs cmdb-redis --tail=100

# Check health status
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j "RETURN 1;"
docker exec cmdb-postgres pg_isready -U cmdb_user -d cmdb
docker exec cmdb-redis redis-cli ping
```

### 2. Check Resource Utilization

```bash
# Check CPU and memory for each database
docker stats cmdb-neo4j --no-stream
docker stats cmdb-postgres --no-stream
docker stats cmdb-redis --no-stream

# Check disk space
df -h
docker exec cmdb-neo4j df -h
docker exec cmdb-postgres df -h
```

### 3. Check Connection Counts

```bash
# Neo4j - Check active connections
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
  "CALL dbms.listConnections() YIELD connectionId, connector, userAgent RETURN count(*) as total;"

# PostgreSQL - Check connection count
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT count(*) FROM pg_stat_activity WHERE datname='cmdb';"

# PostgreSQL - Check max connections setting
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SHOW max_connections;"

# PostgreSQL - Check idle connections
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"

# Redis - Check connected clients
docker exec cmdb-redis redis-cli info clients
```

### 4. Check Network Connectivity

```bash
# Test database reachability from API server
docker exec cmdb-api-server nc -zv cmdb-neo4j 7687
docker exec cmdb-api-server nc -zv cmdb-postgres 5432
docker exec cmdb-api-server nc -zv cmdb-redis 6379

# Check Docker network
docker network inspect cmdb-network
```

### 5. Check for Locks and Blocking Queries

```bash
# PostgreSQL - Check for locks
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT pid, state, wait_event_type, wait_event, query
   FROM pg_stat_activity
   WHERE wait_event IS NOT NULL;"

# PostgreSQL - Check for long-running queries
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT pid, now() - query_start AS duration, state, query
   FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY duration DESC
   LIMIT 10;"
```

## Resolution Steps

### Neo4j Connection Issues

#### Step 1: Restart Neo4j

```bash
# Restart Neo4j container
docker restart cmdb-neo4j

# Wait for startup (30-60 seconds)
sleep 60

# Verify connection
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j "RETURN 1;"
```

#### Step 2: Check Neo4j Memory Settings

```bash
# Check current memory configuration
docker exec cmdb-neo4j cat /var/lib/neo4j/conf/neo4j.conf | grep -E "heap|memory"

# Recommended settings for production:
# dbms.memory.heap.initial_size=2g
# dbms.memory.heap.max_size=4g
# dbms.memory.pagecache.size=2g
```

#### Step 3: Clear Connection Pool (Application Side)

```bash
# Restart API server to reset connection pool
docker restart cmdb-api-server

# Restart discovery engine
docker restart cmdb-discovery-engine
```

### PostgreSQL Connection Issues

#### Step 1: Restart PostgreSQL

```bash
# Restart PostgreSQL container
docker restart cmdb-postgres

# Wait for startup
sleep 30

# Verify connection
docker exec cmdb-postgres pg_isready -U cmdb_user -d cmdb
```

#### Step 2: Kill Idle Connections

```bash
# Terminate idle connections
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE datname = 'cmdb'
   AND state = 'idle'
   AND state_change < current_timestamp - INTERVAL '10 minutes';"
```

#### Step 3: Increase Max Connections (if exhausted)

```bash
# Edit PostgreSQL configuration
docker exec cmdb-postgres bash -c "echo 'max_connections = 200' >> /var/lib/postgresql/data/postgresql.conf"

# Restart PostgreSQL for changes to take effect
docker restart cmdb-postgres
```

#### Step 4: Check for Connection Leaks

```bash
# Review application code for unclosed connections
# Check connection pool configuration in packages/database/src/postgres-client.ts

# Monitor connection pool metrics
# Look for connections not being returned to pool
```

### Redis Connection Issues

#### Step 1: Restart Redis

```bash
# Restart Redis container
docker restart cmdb-redis

# Wait for startup
sleep 10

# Verify connection
docker exec cmdb-redis redis-cli ping
```

#### Step 2: Check Redis Memory

```bash
# Check memory usage
docker exec cmdb-redis redis-cli info memory

# Check maxmemory setting
docker exec cmdb-redis redis-cli config get maxmemory

# Set maxmemory if needed (e.g., 2GB)
docker exec cmdb-redis redis-cli config set maxmemory 2147483648
```

#### Step 3: Check for Blocking Operations

```bash
# Check slow log
docker exec cmdb-redis redis-cli slowlog get 10

# Check current operations
docker exec cmdb-redis redis-cli client list
```

### Connection Pool Exhaustion

#### Step 1: Identify Connection Leaks

```bash
# Check application logs for connection errors
docker logs cmdb-api-server 2>&1 | grep -i "connection\|pool"

# Look for patterns:
# - "Connection pool exhausted"
# - "Failed to acquire connection"
# - "Timeout waiting for connection"
```

#### Step 2: Restart Application Services

```bash
# Restart all application services to reset pools
docker restart cmdb-api-server
docker restart cmdb-discovery-engine
docker restart cmdb-etl-processor
```

#### Step 3: Increase Connection Pool Size

Edit configuration files to increase pool sizes:

**Neo4j** (`packages/database/src/neo4j-client.ts`):
```typescript
maxConnectionPoolSize: 100,  // Increase from 50
maxConnectionLifetime: 3600000,
connectionAcquisitionTimeout: 60000
```

**PostgreSQL** (`packages/database/src/postgres-client.ts`):
```typescript
max: 50,  // Increase from 20
min: 10,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 10000
```

## Verification

After resolution:

1. **Connection Test**: Each database responds to health checks
2. **Connection Count**: Within normal range (< 70% of max)
3. **No Errors**: Application logs show no connection errors
4. **Performance**: Query response times normal
5. **Pool Metrics**: Connection pool metrics healthy
6. **Discovery Jobs**: Discovery jobs resume successfully

## Escalation

If issue persists after 30 minutes:

1. **Escalate to**: Database Administrator / Senior Infrastructure Engineer
2. **Provide**:
   - Database logs (full)
   - Connection pool statistics
   - Resource utilization graphs
   - Query performance metrics
   - Recent schema changes
3. **Consider**:
   - Database failover (if replication configured)
   - Restore from backup (data corruption suspected)

## Post-Incident Actions

1. **Review connection pool settings** - Optimize based on actual usage
2. **Add monitoring** for connection pool utilization
3. **Code review** - Check for connection leaks in recent changes
4. **Load testing** - Verify connection pool sizes under peak load
5. **Documentation** - Update capacity planning with findings

## Common Causes

| Cause | Database | Prevention |
|-------|----------|------------|
| Connection pool too small | All | Monitor pool usage, right-size pools |
| Connection leaks in code | All | Code review, connection tracking |
| Long-running queries holding connections | PostgreSQL, Neo4j | Query timeout enforcement, optimization |
| Memory exhaustion | All | Set appropriate memory limits |
| Too many concurrent discovery jobs | All | Rate limit job execution |
| Network partition | All | Health checks, circuit breakers |
| Disk full | PostgreSQL, Neo4j | Monitor disk usage, log rotation |

## Related Runbooks

- [High Memory Usage](./high-memory-usage.md)
- [Performance Degradation](./performance-degradation.md)
- [Backup Failure](./backup-failure.md)

## Useful Commands

```bash
# Quick health check all databases
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j "RETURN 'OK';"
docker exec cmdb-postgres pg_isready
docker exec cmdb-redis redis-cli ping

# Check connection counts
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# Kill all idle PostgreSQL connections
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction';"

# Clear Redis cache
docker exec cmdb-redis redis-cli FLUSHDB

# Export Neo4j logs
docker logs cmdb-neo4j > /tmp/neo4j-debug.log

# Full database restart sequence
docker restart cmdb-neo4j && sleep 60 && \
docker restart cmdb-postgres && sleep 30 && \
docker restart cmdb-redis && sleep 10 && \
docker restart cmdb-api-server
```

## Monitoring Queries

```promql
# Database uptime
up{job=~"neo4j|postgresql|redis"}

# Neo4j connection pool usage
neo4j_connection_pool_total_used / neo4j_connection_pool_total_created

# PostgreSQL connection count
pg_stat_activity_count

# PostgreSQL connection utilization
pg_stat_activity_count / pg_settings_max_connections

# Redis connected clients
redis_connected_clients

# Redis memory usage
redis_memory_used_bytes / redis_memory_max_bytes
```
