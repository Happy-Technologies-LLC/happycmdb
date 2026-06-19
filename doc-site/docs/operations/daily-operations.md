---
title: Daily Operations
description: Daily operational procedures and checklists for managing HappyCMDB
---

# Daily Operations

Comprehensive operational procedures for managing HappyCMDB platform.

## Morning Checklist

**Time Required:** 15-20 minutes

### 1. System Health Check

```bash
# Check all pods are running
kubectl get pods -n cmdb

# Expected output: All pods in Running state
# api-server-*        2/2   Running
# discovery-engine-*  1/1   Running
# etl-processor-*     1/1   Running
# neo4j-*             1/1   Running
# postgresql-*        1/1   Running
# redis-*             1/1   Running

# Quick health check all services
curl -f https://cmdb.example.com/health || echo "API Server DOWN"
```

### 2. Review Monitoring Dashboards

Access Grafana dashboards:

```bash
# Open main overview dashboard
open https://grafana.example.com/d/cmdb-overview

# Key metrics to check:
# - API request rate (should be within normal range)
# - Error rate (< 1%)
# - Discovery job success rate (> 95%)
# - ETL sync lag (< 5 minutes)
# - Database connections (< 80% of max)
# - Queue depth (should be draining)
```

**Red Flags:**
- API error rate > 5%
- Discovery job failure rate > 10%
- ETL sync lag > 15 minutes
- Database connection pool exhaustion
- Queue depth continuously growing

### 3. Check Active Alerts

```bash
# List active Prometheus alerts
kubectl exec -n monitoring prometheus-0 -- \
  promtool query instant http://localhost:9090 \
  'ALERTS{alertstate="firing"}'

# Or via web UI
open https://prometheus.example.com/alerts
```

### 4. Review Discovery Jobs

```bash
# Check recent discovery jobs
curl -X GET https://cmdb.example.com/api/v1/discovery/jobs?limit=20 \
  -H "Authorization: Bearer <api-key>" | jq '.[] | {id, provider, status, started_at}'

# Failed jobs require investigation
curl -X GET https://cmdb.example.com/api/v1/discovery/jobs?status=failed \
  -H "Authorization: Bearer <api-key>"
```

### 5. Database Health

```bash
# Neo4j health
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> \
  "CALL dbms.queryJmx('org.neo4j:instance=kernel#0,name=Store sizes') YIELD attributes RETURN attributes"

# PostgreSQL health
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT count(*) as active_connections
    FROM pg_stat_activity
    WHERE state = 'active';
  "

# Redis health
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> INFO stats
```

### 6. Storage Capacity

```bash
# Check PVC usage
kubectl get pvc -n cmdb
kubectl exec -n cmdb neo4j-0 -- df -h /data
kubectl exec -n cmdb postgresql-0 -- df -h /var/lib/postgresql/data

# Alert if any volume > 80% full
```

## End-of-Day Checklist

**Time Required:** 10 minutes

### 1. Review Day's Metrics

```bash
# Check daily summary
open https://grafana.example.com/d/cmdb-daily-summary

# Key metrics:
# - Total CIs discovered today
# - Total API requests
# - Average response time
# - Error count
# - Discovery jobs completed
```

### 2. Check Backup Status

```bash
# Verify today's backups completed
kubectl logs -n cmdb cronjob/neo4j-backup --tail=50
kubectl logs -n cmdb cronjob/postgres-backup --tail=50

# Check backup sizes
kubectl exec -n cmdb backup-storage -- ls -lh /backups/ | tail -10
```

### 3. Review Logs for Errors

```bash
# Check error logs from last 8 hours
kubectl logs -n cmdb -l app=api-server --since=8h | grep -i error | tail -50
kubectl logs -n cmdb -l app=discovery-engine --since=8h | grep -i error | tail -50
```

### 4. Document Issues

Update operational log:

```bash
# Add entry to operational log
cat >> /ops/logs/cmdb-operations-$(date +%Y-%m).md <<EOF
## $(date +%Y-%m-%d)
- System Status: [Normal/Degraded/Outage]
- Issues: [List any issues encountered]
- Actions Taken: [List actions]
- Follow-ups: [Any pending tasks]
EOF
```

## Common Operational Tasks

### Restarting Services

#### Restart API Server

```bash
# Graceful restart (rolling update)
kubectl rollout restart deployment/api-server -n cmdb

# Monitor restart
kubectl rollout status deployment/api-server -n cmdb

# Verify health
curl -f https://cmdb.example.com/health
```

#### Restart Discovery Engine

```bash
# Restart discovery workers
kubectl rollout restart deployment/discovery-engine -n cmdb

# Check current jobs are not lost
curl -X GET https://cmdb.example.com/api/v1/discovery/jobs?status=running \
  -H "Authorization: Bearer <api-key>"

# Jobs are persisted in Redis, will resume after restart
```

#### Restart ETL Processor

```bash
# Stop ETL processor
kubectl scale deployment/etl-processor --replicas=0 -n cmdb

# Wait for current jobs to complete (check logs)
kubectl logs -n cmdb -l app=etl-processor --tail=20

# Start ETL processor
kubectl scale deployment/etl-processor --replicas=1 -n cmdb
```

### Scaling Workers

#### Scale API Server

```bash
# Check current replicas
kubectl get deployment/api-server -n cmdb

# Scale up
kubectl scale deployment/api-server --replicas=5 -n cmdb

# Scale down
kubectl scale deployment/api-server --replicas=2 -n cmdb

# Autoscaling (HPA)
kubectl autoscale deployment/api-server \
  --min=2 --max=10 --cpu-percent=70 -n cmdb
```

#### Scale Discovery Workers

```bash
# Scale specific provider workers
kubectl scale deployment/discovery-engine --replicas=5 -n cmdb

# Or edit deployment for provider-specific scaling
kubectl edit deployment/discovery-engine -n cmdb
# Update replicas in worker configuration
```

### Clearing Queues

#### View Queue Status

```bash
# Using Redis CLI
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  LLEN bullmq:discovery:aws:wait

# Or via BullMQ Board (if deployed)
open https://cmdb.example.com/queues
```

#### Clear Specific Queue

```bash
# Clear all jobs in a queue (use with caution)
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  DEL bullmq:discovery:aws:wait \
      bullmq:discovery:aws:active \
      bullmq:discovery:aws:completed

# Or clear failed jobs only
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  DEL bullmq:discovery:aws:failed
```

#### Pause/Resume Queue

```bash
# Pause discovery queue
curl -X POST https://cmdb.example.com/api/v1/discovery/queue/pause \
  -H "Authorization: Bearer <api-key>" \
  -d '{"provider": "aws"}'

# Resume queue
curl -X POST https://cmdb.example.com/api/v1/discovery/queue/resume \
  -H "Authorization: Bearer <api-key>" \
  -d '{"provider": "aws"}'
```

### Running Manual Discovery

#### Discover AWS Resources

```bash
# Using CLI
kubectl exec -n cmdb discovery-engine-0 -- \
  cmdb-cli discovery scan --provider aws --region us-east-1

# Using API
curl -X POST https://cmdb.example.com/api/v1/discovery/schedule \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api-key>" \
  -d '{
    "provider": "aws",
    "config": {
      "region": "us-east-1",
      "services": ["ec2", "rds", "s3"]
    }
  }'
```

#### Discover Azure Resources

```bash
curl -X POST https://cmdb.example.com/api/v1/discovery/schedule \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api-key>" \
  -d '{
    "provider": "azure",
    "config": {
      "subscriptionId": "your-subscription-id",
      "resourceGroups": ["production", "staging"]
    }
  }'
```

### ETL Job Management

#### Trigger Manual ETL Sync

```bash
# Sync all CIs from Neo4j to PostgreSQL
curl -X POST https://cmdb.example.com/api/v1/etl/sync \
  -H "Authorization: Bearer <api-key>"

# Sync specific CI types only
curl -X POST https://cmdb.example.com/api/v1/etl/sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api-key>" \
  -d '{"ciTypes": ["virtual-machine", "database"]}'
```

#### Check ETL Sync Status

```bash
# Check last sync time
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT MAX(last_updated) as last_sync
    FROM dim_ci;
  "

# Check sync lag
curl -X GET https://cmdb.example.com/api/v1/etl/status \
  -H "Authorization: Bearer <api-key>"
```

## Database Maintenance

### Neo4j Maintenance

#### Check Database Statistics

```bash
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  CALL apoc.meta.stats()
  YIELD nodeCount, relCount, labelCount, propertyKeyCount
  RETURN nodeCount, relCount, labelCount, propertyKeyCount;
"
```

#### Rebuild Indexes

```bash
# List all indexes
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> \
  "SHOW INDEXES;"

# Rebuild specific index
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  DROP INDEX ci_id_index IF EXISTS;
  CREATE INDEX ci_id_index FOR (n:CI) ON (n.id);
"
```

### PostgreSQL Maintenance

#### Vacuum and Analyze

```bash
# Vacuum all tables
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "VACUUM VERBOSE;"

# Analyze tables for query planner
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "ANALYZE VERBOSE;"
```

#### Check Table Sizes

```bash
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT
      schemaname,
      tablename,
      pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
  "
```

### Redis Maintenance

#### Check Memory Usage

```bash
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> INFO memory
```

#### Clear Cache

```bash
# Clear all cache (use with caution)
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> FLUSHDB

# Clear specific key pattern
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  --scan --pattern 'cache:ci:*' | xargs redis-cli -a <password> DEL
```

## Log Management

### Accessing Logs

#### API Server Logs

```bash
# Tail logs
kubectl logs -n cmdb -l app=api-server -f

# Last 1000 lines
kubectl logs -n cmdb -l app=api-server --tail=1000

# Logs from last hour
kubectl logs -n cmdb -l app=api-server --since=1h

# Filter for errors
kubectl logs -n cmdb -l app=api-server | grep -i error
```

#### Discovery Engine Logs

```bash
# Tail all discovery workers
kubectl logs -n cmdb -l app=discovery-engine -f --all-containers

# Specific provider logs
kubectl logs -n cmdb -l app=discovery-engine,provider=aws -f
```

### Export Logs

```bash
# Export logs for analysis
kubectl logs -n cmdb -l app=api-server --since=24h > api-server-$(date +%Y%m%d).log

# Export to S3
kubectl logs -n cmdb -l app=api-server --since=24h | \
  gzip | \
  aws s3 cp - s3://cmdb-logs/api-server-$(date +%Y%m%d).log.gz
```

## Performance Tuning

### API Server Tuning

```yaml
# Adjust API server resources
kubectl edit deployment/api-server -n cmdb

resources:
  requests:
    cpu: 2
    memory: 4Gi
  limits:
    cpu: 4
    memory: 8Gi

# Adjust connection pool sizes
env:
  - name: DB_POOL_SIZE
    value: "50"
  - name: API_RATE_LIMIT
    value: "1000"
```

### Cache Optimization

```bash
# Adjust Redis maxmemory
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  CONFIG SET maxmemory 8gb

# Set eviction policy
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  CONFIG SET maxmemory-policy allkeys-lru
```

## Incident Response

### Severity Levels

**P1 - Critical:** Complete outage, all users affected
- Response time: Immediate
- Resolution target: 1 hour

**P2 - Major:** Partial outage, some users affected
- Response time: 15 minutes
- Resolution target: 4 hours

**P3 - Minor:** Degraded performance, workaround available
- Response time: 1 hour
- Resolution target: 24 hours

### Incident Workflow

1. **Detect**: Alert triggered or user report
2. **Triage**: Assess severity and impact
3. **Escalate**: Page on-call engineer if P1/P2
4. **Investigate**: Check logs, metrics, recent changes
5. **Mitigate**: Apply immediate fix or workaround
6. **Resolve**: Implement permanent fix
7. **Document**: Write incident report
8. **Review**: Post-mortem for P1/P2 incidents

## See Also

- [Troubleshooting Guide](/operations/troubleshooting)
- [Backup and Restore](/guides/backup-restore)
- [Monitoring Guide](/guides/monitoring)
- [CLI Commands Reference](/quick-reference/cli-commands)
