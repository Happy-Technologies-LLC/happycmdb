# Runbook: High Memory Usage

**Alert Name**: `HighMemoryUsage`, `CriticalMemoryUsage`, `RedisMemoryHigh`, `ContainerMemoryNearLimit`
**Severity**: Warning / Critical
**Component**: infrastructure, redis, containers
**Initial Response Time**: 15 minutes (warning), 5 minutes (critical)

## Symptoms

- Memory usage >85% (warning) or >95% (critical)
- System swapping heavily
- Applications being OOM (Out of Memory) killed
- Container restarts due to memory limits
- Slow performance across all services
- Redis evicting keys unexpectedly

## Impact

- **Warning (85%+)**: System may start swapping, performance degraded
- **Critical (95%+)**: OOM killer may terminate processes, service instability
- **Container OOM**: Service crashes and restarts, data loss possible

## Diagnosis

### 1. Check Overall System Memory

```bash
# Check system-wide memory usage
free -h

# Check memory usage by process
top -o %MEM | head -20

# Check if swapping is occurring
vmstat 1 5

# Check OOM killer activity
dmesg | grep -i "killed process"
journalctl -k | grep -i "out of memory"
```

### 2. Check Container Memory Usage

```bash
# Check all container memory usage
docker stats --no-stream

# Detailed view of specific container
docker stats cmdb-api-server --no-stream
docker stats cmdb-neo4j --no-stream
docker stats cmdb-postgres --no-stream
docker stats cmdb-redis --no-stream

# Check container memory limits
docker inspect cmdb-api-server | jq '.[0].HostConfig.Memory'
```

### 3. Identify Memory-Hungry Processes

```bash
# Top memory consumers
ps aux --sort=-%mem | head -20

# Memory usage by Docker containers
docker ps -q | xargs docker stats --no-stream --format "table {{.Container}}\t{{.MemUsage}}"

# Check for memory leaks in Node.js processes
docker exec cmdb-api-server node -e "console.log(process.memoryUsage())"
```

### 4. Check Application-Specific Memory

```bash
# Neo4j heap usage
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
  "CALL dbms.queryJmx('org.neo4j:instance=kernel#0,name=Memory Pools') YIELD attributes RETURN attributes.HeapMemoryUsage;"

# PostgreSQL memory usage
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT pg_size_pretty(pg_database_size('cmdb')) AS db_size;"

# Redis memory stats
docker exec cmdb-redis redis-cli info memory
```

### 5. Check for Memory Leaks

```bash
# Check application logs for memory-related errors
docker logs cmdb-api-server 2>&1 | grep -i "memory\|heap\|allocation"

# Monitor memory growth over time
watch -n 5 "docker stats --no-stream --format 'table {{.Container}}\t{{.MemUsage}}'"

# Check if memory is growing continuously (sign of leak)
# Take snapshots 5 minutes apart and compare
```

## Resolution Steps

### Step 1: Identify and Restart Problematic Container

```bash
# Identify container with highest memory usage
CONTAINER=$(docker stats --no-stream --format "{{.Container}}\t{{.MemUsage}}" | sort -k2 -hr | head -1 | awk '{print $1}')
echo "Highest memory user: $CONTAINER"

# Restart the container
docker restart $CONTAINER

# Monitor memory after restart
sleep 30
docker stats $CONTAINER --no-stream
```

### Step 2: Clear Caches

```bash
# Clear Redis cache (if Redis is the culprit)
docker exec cmdb-redis redis-cli FLUSHDB

# Clear system cache (Linux)
sync
echo 3 | sudo tee /proc/sys/vm/drop_caches

# Clear Neo4j page cache (restart required)
docker restart cmdb-neo4j
```

### Step 3: Adjust Memory Limits (if containers hitting limits)

Edit `infrastructure/docker/docker-compose.yml`:

```yaml
services:
  api-server:
    deploy:
      resources:
        limits:
          memory: 2G  # Increase from 1G
        reservations:
          memory: 512M
```

Then recreate containers:

```bash
docker-compose -f infrastructure/docker/docker-compose.yml up -d --force-recreate api-server
```

### Step 4: Optimize Database Memory Settings

**Neo4j Memory Tuning**:

```bash
# Edit Neo4j configuration
docker exec cmdb-neo4j bash -c "cat >> /var/lib/neo4j/conf/neo4j.conf << EOF
dbms.memory.heap.initial_size=1g
dbms.memory.heap.max_size=2g
dbms.memory.pagecache.size=1g
EOF"

# Restart Neo4j
docker restart cmdb-neo4j
```

**PostgreSQL Memory Tuning**:

```bash
# Adjust PostgreSQL memory settings
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "ALTER SYSTEM SET shared_buffers = '512MB';"
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "ALTER SYSTEM SET effective_cache_size = '2GB';"

# Restart PostgreSQL
docker restart cmdb-postgres
```

**Redis Memory Tuning**:

```bash
# Set max memory for Redis (e.g., 1GB)
docker exec cmdb-redis redis-cli config set maxmemory 1073741824

# Set eviction policy (if not already set)
docker exec cmdb-redis redis-cli config set maxmemory-policy allkeys-lru

# Persist changes
docker exec cmdb-redis redis-cli config rewrite
```

### Step 5: Scale Down or Throttle Operations

```bash
# Pause discovery jobs temporarily
docker exec cmdb-api-server node -e "
const { getRedisClient } = require('@cmdb/database');
(async () => {
  const redis = getRedisClient();
  await redis.set('discovery:paused', 'true', 'EX', 3600);
  console.log('Discovery paused for 1 hour');
})();
"

# Reduce concurrent workers
# Edit discovery engine configuration to reduce parallelism
```

### Step 6: Add More Memory (if infrastructure allows)

```bash
# If running on VM or cloud instance, scale up the instance
# AWS example:
aws ec2 modify-instance-attribute --instance-id i-xxxxx --instance-type t3.large

# Or add swap space as temporary measure
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Step 7: Investigate and Fix Memory Leaks

```bash
# Take heap dump (Node.js applications)
docker exec cmdb-api-server node -e "
const v8 = require('v8');
const fs = require('fs');
const heapdump = v8.writeHeapSnapshot();
console.log('Heap dump written to', heapdump);
"

# Analyze heap dump with Chrome DevTools
# Look for detached DOM nodes, closures, large objects

# Review recent code changes for memory leak patterns:
# - Event listeners not being removed
# - Caching without bounds
# - Circular references
# - Large objects in global scope
```

## Verification

After resolution:

1. **Memory Usage**: Below 80% and stable
2. **No Swapping**: `vmstat` shows minimal swap usage
3. **Containers Stable**: No container restarts due to OOM
4. **No OOM Kills**: No entries in `dmesg` or `journalctl`
5. **Performance**: System responsive, no lag
6. **Monitoring**: Prometheus metrics show healthy memory levels

## Escalation

If issue persists after 1 hour:

1. **Escalate to**: Senior Infrastructure Engineer / Platform Team Lead
2. **Provide**:
   - Memory usage graphs (last 24 hours)
   - List of memory-hungry processes
   - Heap dump (if available)
   - Recent deployment history
   - Container logs showing OOM events
3. **Consider**:
   - Emergency infrastructure scaling
   - Rollback to previous version
   - Temporary service degradation to reduce load

## Post-Incident Actions

1. **Root Cause Analysis**: Identify source of memory growth
2. **Code Review**: Check for memory leaks in recent changes
3. **Optimize Queries**: Review and optimize database queries
4. **Capacity Planning**: Adjust memory allocation based on actual usage
5. **Add Monitoring**: Set up memory usage trends and leak detection
6. **Load Testing**: Verify memory usage under sustained load
7. **Documentation**: Update memory requirements in capacity planning

## Common Causes

| Cause | Frequency | Prevention |
|-------|-----------|------------|
| Memory leak in application code | High | Code review, heap profiling, automated testing |
| Unbounded cache growth | High | Implement cache eviction policies, set max sizes |
| Large dataset loaded into memory | Medium | Implement pagination, streaming, lazy loading |
| Too many concurrent operations | Medium | Implement rate limiting, queue management |
| Database memory not tuned | Medium | Proper database memory configuration |
| Insufficient memory allocation | Low | Capacity planning, monitoring-based scaling |
| Memory-intensive discovery jobs | Medium | Batch processing, memory-efficient algorithms |

## Related Runbooks

- [Database Connection Issues](./database-connection-issues.md)
- [Performance Degradation](./performance-degradation.md)
- [Discovery Jobs Failing](./discovery-jobs-failing.md)

## Useful Commands

```bash
# Continuous memory monitoring
watch -n 5 "free -h && echo && docker stats --no-stream"

# Memory usage summary
docker stats --no-stream --format "table {{.Container}}\t{{.MemUsage}}\t{{.MemPerc}}"

# Find largest processes
ps aux --sort=-%mem | head -20

# Check for OOM kills in last 24 hours
journalctl -k --since "24 hours ago" | grep -i "out of memory"

# Memory usage by container (JSON)
docker stats --no-stream --format '{{json .}}' | jq -r '. | "\(.Container): \(.MemUsage)"'

# Restart all containers to clear memory
docker-compose -f infrastructure/docker/docker-compose.yml restart

# Emergency: Kill most memory-hungry container
docker ps --format '{{.Names}}' | xargs -I {} docker stats {} --no-stream --format '{{.Container}} {{.MemUsage}}' | sort -k2 -hr | head -1 | awk '{print $1}' | xargs docker restart
```

## Monitoring Queries

```promql
# System memory usage
(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))

# Container memory usage
container_memory_usage_bytes / container_spec_memory_limit_bytes

# Redis memory usage
redis_memory_used_bytes / redis_memory_max_bytes

# Memory growth rate (potential leak indicator)
rate(container_memory_usage_bytes[30m])

# Containers hitting memory limits
container_memory_usage_bytes >= container_spec_memory_limit_bytes

# Swap usage
node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes
```

## Memory Leak Detection

```javascript
// Add to application startup for leak detection
const memwatch = require('memwatch-next');

memwatch.on('leak', (info) => {
  console.error('Memory leak detected:', info);
  // Send alert or write to log
});

// Periodic memory report
setInterval(() => {
  const mem = process.memoryUsage();
  console.log({
    rss: (mem.rss / 1024 / 1024).toFixed(2) + ' MB',
    heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
    heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
    external: (mem.external / 1024 / 1024).toFixed(2) + ' MB'
  });
}, 60000); // Every minute
```
