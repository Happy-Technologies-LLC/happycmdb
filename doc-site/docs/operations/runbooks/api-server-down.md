# Runbook: API Server Down

**Alert Name**: `APIServerDown`, `APIServerNoRequests`, `WebUIDown`
**Severity**: Critical
**Component**: api-server, web-ui
**Initial Response Time**: 5 minutes

## Symptoms

- API health check endpoint returning 5xx errors or timing out
- No HTTP requests being processed despite service appearing up
- Users unable to access web interface or API endpoints
- Grafana dashboard showing `up{job="api-server"} == 0`

## Impact

- **User Impact**: Users cannot access API or web interface
- **System Impact**: All discovery jobs blocked, no CI data updates
- **Business Impact**: Complete service outage

## Diagnosis

### 1. Check Service Status

```bash
# Check if API server container is running
docker ps | grep cmdb-api-server

# Check API server logs
docker logs cmdb-api-server --tail=100 --follow

# Check service health
curl -f http://localhost:3000/health || echo "API Server Down"
```

### 2. Check Resource Utilization

```bash
# Check CPU and memory usage
docker stats cmdb-api-server --no-stream

# Check disk space
df -h

# Check if OOM killer terminated the process
dmesg | grep -i "killed process"
```

### 3. Check Dependencies

```bash
# Verify Neo4j is reachable
docker exec cmdb-api-server nc -zv neo4j 7687

# Verify PostgreSQL is reachable
docker exec cmdb-api-server nc -zv postgres 5432

# Verify Redis is reachable
docker exec cmdb-api-server nc -zv redis 6379
```

### 4. Check Network Connectivity

```bash
# Check if port 3000 is listening
netstat -tuln | grep 3000

# Test internal network
docker network inspect cmdb-network
```

## Resolution Steps

### Step 1: Restart API Server

```bash
# Quick restart attempt
docker restart cmdb-api-server

# Wait 30 seconds and check status
sleep 30
curl http://localhost:3000/health
```

### Step 2: Check for Configuration Issues

```bash
# Verify environment variables
docker exec cmdb-api-server env | grep -E "NEO4J|POSTGRES|REDIS|JWT"

# Check for missing or invalid configuration
docker logs cmdb-api-server 2>&1 | grep -i "error\|fatal\|missing"
```

### Step 3: Rebuild and Recreate Container (if restart fails)

```bash
# Stop and remove container
docker stop cmdb-api-server
docker rm cmdb-api-server

# Rebuild image
cd /Users/nczitzer/WebstormProjects/happycmdb
docker-compose -f infrastructure/docker/docker-compose.yml build api-server

# Start fresh container
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server

# Monitor startup
docker logs cmdb-api-server --follow
```

### Step 4: Check Database Connections

```bash
# Test Neo4j connection manually
docker exec cmdb-api-server node -e "
const neo4j = require('neo4j-driver');
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD)
);
driver.verifyConnectivity().then(() => console.log('OK')).catch(console.error);
"

# Test PostgreSQL connection
docker exec cmdb-api-server psql -h postgres -U cmdb_user -d cmdb -c "SELECT 1;"
```

### Step 5: Check for Port Conflicts

```bash
# Check if another process is using port 3000
lsof -i :3000

# If port conflict, kill conflicting process or change API port
```

### Step 6: Restore from Backup (last resort)

```bash
# If data corruption suspected
# See runbook: backup-failure.md for restoration procedures
```

## Verification

After resolution, verify:

1. **Health Check**: `curl http://localhost:3000/health` returns 200 OK
2. **API Functionality**: Test a basic API call: `curl http://localhost:3000/api/v1/cis?limit=1`
3. **GraphQL Endpoint**: `curl http://localhost:3000/graphql -d '{"query": "{ __schema { queryType { name } } }"}'`
4. **Web UI**: Access http://localhost:3000 in browser
5. **Metrics**: Check Prometheus shows `up{job="api-server"} == 1`
6. **Discovery Jobs**: Verify jobs resume processing

## Escalation

If issue persists after 30 minutes:

1. **Escalate to**: Senior Backend Engineer
2. **Provide**:
   - All diagnostic output
   - Recent deployment changes
   - Database status
   - Resource utilization graphs from last 24 hours
3. **Consider**: Rollback to previous known-good version

## Post-Incident Actions

1. **Document root cause** in incident report
2. **Update monitoring** if alert missed the actual issue
3. **Review logs** for warning signs before failure
4. **Update runbook** with new findings
5. **Schedule post-mortem** if outage >30 minutes

## Common Causes

| Cause | Frequency | Prevention |
|-------|-----------|------------|
| Database connection timeout | High | Increase connection pool, add retry logic |
| Memory leak / OOM kill | Medium | Implement memory limits, monitor memory usage |
| Configuration error after deployment | Medium | Add configuration validation on startup |
| Network partition | Low | Implement circuit breakers, health checks |
| Disk full | Low | Monitor disk usage, implement log rotation |
| Port conflict | Low | Use dedicated ports, check before deployment |

## Related Runbooks

- [Database Connection Issues](./database-connection-issues.md)
- [High Memory Usage](./high-memory-usage.md)
- [Performance Degradation](./performance-degradation.md)

## Useful Commands

```bash
# Quick health check all services
docker-compose -f infrastructure/docker/docker-compose.yml ps

# View all container logs
docker-compose -f infrastructure/docker/docker-compose.yml logs --tail=50

# Full system restart
docker-compose -f infrastructure/docker/docker-compose.yml down
docker-compose -f infrastructure/docker/docker-compose.yml up -d

# Check recent deployments
git log -5 --oneline

# Monitor real-time logs
docker logs cmdb-api-server --follow --tail=100
```

## Monitoring Queries

```promql
# API Server uptime
up{job="api-server"}

# Request rate
rate(http_requests_total{job="api-server"}[5m])

# Error rate
rate(http_requests_total{job="api-server",status=~"5.."}[5m])

# Response time (p95)
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="api-server"}[5m]))
```
