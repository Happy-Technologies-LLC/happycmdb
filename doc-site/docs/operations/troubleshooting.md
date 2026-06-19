---
title: Troubleshooting
description: Comprehensive guide for diagnosing and resolving common issues
---

# Troubleshooting

Comprehensive guide for diagnosing and resolving common issues in HappyCMDB platform.

## Quick Diagnosis

### System Health Check

Run this comprehensive health check first:

```bash
#!/bin/bash
# Quick health check script

echo "=== Pod Status ==="
kubectl get pods -n cmdb

echo -e "\n=== Service Endpoints ==="
kubectl get endpoints -n cmdb

echo -e "\n=== Recent Events ==="
kubectl get events -n cmdb --sort-by='.lastTimestamp' | tail -20

echo -e "\n=== API Health ==="
curl -f https://cmdb.example.com/health || echo "API UNHEALTHY"

echo -e "\n=== Database Connectivity ==="
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "RETURN 1" 2>&1 | grep -q "1" && echo "Neo4j: OK" || echo "Neo4j: FAILED"
kubectl exec -n cmdb postgresql-0 -- psql -U cmdb_user -d cmdb_datamart -c "SELECT 1" 2>&1 | grep -q "1 row" && echo "PostgreSQL: OK" || echo "PostgreSQL: FAILED"
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> PING 2>&1 | grep -q "PONG" && echo "Redis: OK" || echo "Redis: FAILED"

echo -e "\n=== Queue Status ==="
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> LLEN bullmq:discovery:aws:wait

echo -e "\n=== Recent Errors ==="
kubectl logs -n cmdb -l app=api-server --since=10m | grep -i error | tail -10
```

### Decision Tree

```
Is the API responding?
├─ NO → Check API Server Issues
└─ YES
    ├─ Are discovery jobs failing?
    │  ├─ YES → Check Discovery Job Failures
    │  └─ NO
    │      ├─ Is ETL lagging?
    │      │  ├─ YES → Check ETL Sync Issues
    │      │  └─ NO
    │      │      ├─ Are database queries slow?
    │      │      │  ├─ YES → Check Performance Problems
    │      │      │  └─ NO → Check application logs
```

## API Server Issues

### Issue 1: API Server Not Responding

**Symptoms:**
- `curl https://cmdb.example.com/health` returns error
- No response or timeout
- 502 Bad Gateway errors

**Diagnosis:**

```bash
# Check pod status
kubectl get pods -n cmdb -l app=api-server

# Check pod logs
kubectl logs -n cmdb -l app=api-server --tail=100

# Check service
kubectl get service api-server -n cmdb
kubectl describe service api-server -n cmdb

# Check ingress
kubectl get ingress -n cmdb
kubectl describe ingress cmdb-ingress -n cmdb
```

**Common Causes & Solutions:**

**Cause 1: Pods not running**

```bash
# Check why pods are not starting
kubectl describe pod <api-server-pod> -n cmdb

# Common issues:
# - ImagePullBackOff: Check image name and registry credentials
# - CrashLoopBackOff: Check application logs for startup errors
# - Pending: Check resource availability

# Solution: Delete pod to restart
kubectl delete pod <api-server-pod> -n cmdb
```

**Cause 2: Database connection failure**

```bash
# Check database connectivity from pod
kubectl exec -n cmdb <api-server-pod> -- nc -zv neo4j 7687
kubectl exec -n cmdb <api-server-pod> -- nc -zv postgresql 5433

# Check environment variables
kubectl exec -n cmdb <api-server-pod> -- env | grep -E 'NEO4J|POSTGRES|REDIS'

# Solution: Verify secrets and restart pod
kubectl delete pod <api-server-pod> -n cmdb
```

**Cause 3: Ingress misconfiguration**

```bash
# Check ingress controller logs
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx

# Check ingress configuration
kubectl get ingress cmdb-ingress -n cmdb -o yaml

# Solution: Update ingress rules
kubectl edit ingress cmdb-ingress -n cmdb
```

### Issue 2: High Latency / Slow Responses

**Symptoms:**
- API responses taking > 2 seconds
- Timeouts on complex queries
- p95 latency > 5 seconds

**Diagnosis:**

```bash
# Check API metrics
curl https://cmdb.example.com/metrics | grep http_request_duration

# Check database query performance
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  CALL dbms.listQueries()
  YIELD queryId, query, elapsedTimeMillis
  WHERE elapsedTimeMillis > 1000
  RETURN queryId, query, elapsedTimeMillis;
"

# Check resource usage
kubectl top pods -n cmdb -l app=api-server
```

**Solutions:**

```bash
# Solution 1: Scale API server
kubectl scale deployment/api-server --replicas=5 -n cmdb

# Solution 2: Increase resource limits
kubectl edit deployment/api-server -n cmdb
# Update resources.limits.cpu and resources.limits.memory

# Solution 3: Clear cache
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> FLUSHDB
```

### Issue 3: 401 Unauthorized Errors

**Symptoms:**
- API returns 401 for valid credentials
- Authentication failures

**Diagnosis:**

```bash
# Check API logs for auth errors
kubectl logs -n cmdb -l app=api-server | grep -i "unauthorized\|401"

# Verify JWT secret is configured
kubectl get secret cmdb-secrets -n cmdb -o jsonpath='{.data.jwt-secret}' | base64 -d

# Test authentication
curl -X POST https://cmdb.example.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"password"}'
```

**Solutions:**

```bash
# Solution 1: Regenerate JWT secret
kubectl create secret generic cmdb-secrets \
  --from-literal=jwt-secret=$(openssl rand -hex 32) \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart API server
kubectl rollout restart deployment/api-server -n cmdb
```

### Issue 4: Rate Limiting Errors (429)

**Symptoms:**
- API returns 429 Too Many Requests
- Legitimate users being rate limited

**Solutions:**

```bash
# Solution 1: Increase rate limits
kubectl set env deployment/api-server -n cmdb \
  API_RATE_LIMIT_WINDOW=60000 \
  API_RATE_LIMIT_MAX=1000

# Solution 2: Add more API server replicas
kubectl scale deployment/api-server --replicas=5 -n cmdb
```

## Discovery Job Failures

### Issue 1: AWS Discovery Failing

**Symptoms:**
- Discovery jobs status = "failed"
- Error: "AWS credentials not found"
- Error: "Access denied" for AWS services

**Diagnosis:**

```bash
# Check discovery job details
curl -X GET https://cmdb.example.com/api/v1/discovery/jobs/<job-id> \
  -H "Authorization: Bearer <api-key>"

# Check discovery engine logs
kubectl logs -n cmdb -l app=discovery-engine,provider=aws --tail=100

# Verify AWS credentials
kubectl exec -n cmdb <discovery-engine-pod> -- env | grep AWS

# Test AWS connectivity
kubectl exec -n cmdb <discovery-engine-pod> -- \
  aws ec2 describe-regions --output text
```

**Solutions:**

**Solution 1: Update AWS credentials**

```bash
# Update secret with valid credentials
kubectl create secret generic aws-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=<key> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<secret> \
  --from-literal=AWS_REGION=us-east-1 \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart discovery engine
kubectl rollout restart deployment/discovery-engine -n cmdb
```

**Solution 2: Fix IAM permissions**

Required IAM policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "rds:Describe*",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "elasticloadbalancing:Describe*",
        "lambda:List*",
        "ecs:Describe*",
        "ecs:List*"
      ],
      "Resource": "*"
    }
  ]
}
```

**Solution 3: Check AWS rate limits**

```bash
# AWS may throttle API calls
# Reduce discovery concurrency
kubectl edit deployment/discovery-engine -n cmdb
# Update DISCOVERY_CONCURRENCY environment variable to lower value (e.g., 5)
```

### Issue 2: Azure Discovery Failing

**Symptoms:**
- Error: "Azure authentication failed"
- Error: "Subscription not found"

**Solutions:**

```bash
# Update Azure credentials
kubectl create secret generic azure-credentials \
  --from-literal=AZURE_SUBSCRIPTION_ID=<subscription-id> \
  --from-literal=AZURE_TENANT_ID=<tenant-id> \
  --from-literal=AZURE_CLIENT_ID=<client-id> \
  --from-literal=AZURE_CLIENT_SECRET=<client-secret> \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart discovery engine
kubectl rollout restart deployment/discovery-engine -n cmdb
```

### Issue 3: Discovery Jobs Stuck in "Running"

**Symptoms:**
- Jobs never complete
- Job running for hours with no progress

**Diagnosis:**

```bash
# Check job status
curl -X GET https://cmdb.example.com/api/v1/discovery/jobs?status=running \
  -H "Authorization: Bearer <api-key>"

# Check worker logs
kubectl logs -n cmdb -l app=discovery-engine -f

# Check queue status
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  LLEN bullmq:discovery:aws:active
```

**Solutions:**

```bash
# Solution 1: Restart discovery engine
kubectl rollout restart deployment/discovery-engine -n cmdb

# Solution 2: Clear stuck jobs from queue
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  DEL bullmq:discovery:aws:active

# Solution 3: Increase job timeout
kubectl set env deployment/discovery-engine -n cmdb \
  DISCOVERY_JOB_TIMEOUT=3600000
```

### Issue 4: Duplicate CIs Being Created

**Symptoms:**
- Same CI appearing multiple times in database
- CI IDs not matching expected format

**Diagnosis:**

```bash
# Check for duplicate CIs
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (n:CI)
  WITH n.name as name, COUNT(*) as count
  WHERE count > 1
  RETURN name, count
  ORDER BY count DESC;
"

# Check discovery logs for ID generation
kubectl logs -n cmdb -l app=discovery-engine | grep "Creating CI"
```

**Solutions:**

```bash
# Solution 2: De-duplicate existing CIs
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (n:CI)
  WITH n.name as name, COLLECT(n) as nodes
  WHERE SIZE(nodes) > 1
  FOREACH (n IN TAIL(nodes) | DETACH DELETE n);
"

# Solution 3: Add unique constraint
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  CREATE CONSTRAINT ci_id_unique IF NOT EXISTS
  FOR (n:CI) REQUIRE n.id IS UNIQUE;
"
```

## ETL Sync Issues

### Issue 1: ETL Sync Lag

**Symptoms:**
- Data in PostgreSQL is stale (> 15 minutes old)
- Metrics show high ETL sync lag

**Diagnosis:**

```bash
# Check last sync time
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT MAX(last_updated) as last_sync FROM dim_ci;
  "

# Check ETL processor logs
kubectl logs -n cmdb -l app=etl-processor --tail=100

# Check ETL job queue
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  LLEN bullmq:etl:sync:wait
```

**Solutions:**

```bash
# Solution 1: Trigger manual sync
curl -X POST https://cmdb.example.com/api/v1/etl/sync \
  -H "Authorization: Bearer <api-key>"

# Solution 2: Increase ETL processor resources
kubectl edit deployment/etl-processor -n cmdb
# Update resources

# Solution 3: Reduce sync interval
kubectl set env deployment/etl-processor -n cmdb \
  ETL_SYNC_INTERVAL=300000  # 5 minutes
```

### Issue 2: ETL Job Failing

**Symptoms:**
- ETL processor crashes
- Error: "Out of memory"
- Error: "Query timeout"

**Diagnosis:**

```bash
# Check ETL processor logs
kubectl logs -n cmdb -l app=etl-processor --tail=200

# Check memory usage
kubectl top pod -n cmdb -l app=etl-processor

# Check PostgreSQL connection pool
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active';
  "
```

**Solutions:**

```bash
# Solution 1: Increase memory limits
kubectl edit deployment/etl-processor -n cmdb
# Update resources.limits.memory to 8Gi

# Solution 2: Process in batches
kubectl set env deployment/etl-processor -n cmdb \
  ETL_BATCH_SIZE=1000

# Solution 3: Increase PostgreSQL query timeout
kubectl exec -n cmdb postgresql-0 -- \
  psql -U postgres -c "ALTER DATABASE cmdb_datamart SET statement_timeout = '300s';"
```

### Issue 3: Data Inconsistency

**Symptoms:**
- CI count in Neo4j != CI count in PostgreSQL
- Missing relationships in data mart

**Diagnosis:**

```bash
# Compare CI counts
echo "Neo4j:"
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> \
  "MATCH (n:CI) RETURN COUNT(n) as count;"

echo "PostgreSQL:"
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "SELECT COUNT(*) FROM dim_ci;"

# Check for failed ETL records
kubectl logs -n cmdb -l app=etl-processor | grep -i "failed to sync"
```

**Solutions:**

```bash
# Solution 2: Sync specific CIs
curl -X POST https://cmdb.example.com/api/v1/etl/sync \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api-key>" \
  -d '{"ciIds": ["vm-001", "vm-002"]}'
```

## Database Connection Errors

### Issue 1: Neo4j Connection Refused

**Symptoms:**
- Error: "Failed to connect to Neo4j"
- Error: "Connection refused bolt://neo4j:7687"

**Diagnosis:**

```bash
# Check Neo4j pod status
kubectl get pod neo4j-0 -n cmdb

# Check Neo4j logs
kubectl logs neo4j-0 -n cmdb

# Test Neo4j connectivity
kubectl exec -n cmdb neo4j-0 -- nc -zv localhost 7687

# Check service
kubectl get service neo4j -n cmdb
kubectl get endpoints neo4j -n cmdb
```

**Solutions:**

```bash
# Solution 1: Restart Neo4j
kubectl delete pod neo4j-0 -n cmdb
kubectl wait --for=condition=ready pod/neo4j-0 -n cmdb --timeout=300s

# Solution 2: Check Neo4j configuration
kubectl exec -n cmdb neo4j-0 -- cat /conf/neo4j.conf | grep bolt

# Solution 3: Verify network policies
kubectl get networkpolicy -n cmdb
# Ensure Neo4j port 7687 is allowed
```

### Issue 2: PostgreSQL Connection Pool Exhausted

**Symptoms:**
- Error: "remaining connection slots are reserved"
- API requests timing out

**Diagnosis:**

```bash
# Check active connections
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT COUNT(*) as active,
           max_conn,
           max_conn - COUNT(*) as remaining
    FROM pg_stat_activity
    CROSS JOIN (SELECT setting::int as max_conn FROM pg_settings WHERE name = 'max_connections') mc
    GROUP BY max_conn;
  "

# Check long-running queries
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT pid, now() - pg_stat_activity.query_start AS duration, query
    FROM pg_stat_activity
    WHERE state = 'active'
    ORDER BY duration DESC;
  "
```

**Solutions:**

```bash
# Solution 1: Increase max_connections
kubectl exec -n cmdb postgresql-0 -- \
  psql -U postgres -c "ALTER SYSTEM SET max_connections = 300;"
kubectl delete pod postgresql-0 -n cmdb

# Solution 2: Kill long-running queries
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE state = 'active' AND now() - query_start > interval '10 minutes';
  "

# Solution 3: Optimize connection pooling in application
kubectl set env deployment/api-server -n cmdb \
  DB_POOL_SIZE=20 \
  DB_POOL_IDLE_TIMEOUT=30000
```

### Issue 3: Redis Connection Timeout

**Symptoms:**
- Error: "Redis connection timeout"
- Queue operations failing

**Diagnosis:**

```bash
# Check Redis status
kubectl get pod redis-0 -n cmdb
kubectl logs redis-0 -n cmdb

# Test Redis connectivity
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> PING

# Check connected clients
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> CLIENT LIST
```

**Solutions:**

```bash
# Solution 1: Restart Redis
kubectl delete pod redis-0 -n cmdb

# Solution 2: Increase timeout
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  CONFIG SET timeout 300

# Solution 3: Check network latency
kubectl exec -n cmdb <api-server-pod> -- ping redis
```

## Queue Backlog Issues

### Issue 1: Queue Depth Growing

**Symptoms:**
- Queue depth continuously increasing
- Jobs not being processed

**Diagnosis:**

```bash
# Check queue depths
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> <<EOF
LLEN bullmq:discovery:aws:wait
LLEN bullmq:discovery:azure:wait
LLEN bullmq:discovery:gcp:wait
LLEN bullmq:etl:sync:wait
EOF

# Check worker status
kubectl get pods -n cmdb -l app=discovery-engine
kubectl logs -n cmdb -l app=discovery-engine --tail=50
```

**Solutions:**

```bash
# Solution 1: Scale workers
kubectl scale deployment/discovery-engine --replicas=5 -n cmdb

# Solution 2: Increase concurrency
kubectl set env deployment/discovery-engine -n cmdb \
  DISCOVERY_CONCURRENCY=10

# Solution 3: Clear failed jobs
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  DEL bullmq:discovery:aws:failed
```

### Issue 2: Jobs Stuck in "Active" State

**Symptoms:**
- Jobs in active queue but not processing
- Worker logs show no activity

**Diagnosis:**

```bash
# Check active jobs
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  LRANGE bullmq:discovery:aws:active 0 -1

# Check worker logs
kubectl logs -n cmdb -l app=discovery-engine -f
```

**Solutions:**

```bash
# Solution 1: Move stuck jobs back to waiting queue
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> <<EOF
RPOPLPUSH bullmq:discovery:aws:active bullmq:discovery:aws:wait
EOF

# Solution 2: Restart workers
kubectl rollout restart deployment/discovery-engine -n cmdb

# Solution 3: Clear all active jobs (use with caution)
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> \
  DEL bullmq:discovery:aws:active
```

## Performance Problems

### Issue 1: High Memory Usage

**Symptoms:**
- Pods being OOMKilled
- Memory usage > 90%

**Diagnosis:**

```bash
# Check memory usage
kubectl top pods -n cmdb

# Check pod events
kubectl describe pod <pod-name> -n cmdb | grep -A 10 Events
```

**Solutions:**

```bash
# Solution 1: Increase memory limits
kubectl edit deployment/api-server -n cmdb
# Update resources.limits.memory

# Solution 2: Add memory limits to prevent OOM
kubectl set resources deployment/api-server -n cmdb \
  --limits=memory=8Gi \
  --requests=memory=4Gi
```

### Issue 2: High CPU Usage

**Symptoms:**
- CPU throttling
- Slow response times
- CPU usage consistently > 80%

**Solutions:**

```bash
# Solution 1: Increase CPU limits
kubectl set resources deployment/api-server -n cmdb \
  --limits=cpu=4 \
  --requests=cpu=2

# Solution 2: Scale horizontally
kubectl scale deployment/api-server --replicas=5 -n cmdb
```

### Issue 3: Slow Database Queries

**Symptoms:**
- Query times > 1 second
- Database CPU at 100%

**Diagnosis:**

```bash
# Neo4j slow queries
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  CALL dbms.listQueries()
  YIELD queryId, query, elapsedTimeMillis
  WHERE elapsedTimeMillis > 1000
  RETURN queryId, query, elapsedTimeMillis
  ORDER BY elapsedTimeMillis DESC;
"

# PostgreSQL slow queries
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT query, calls, total_time, mean_time
    FROM pg_stat_statements
    ORDER BY mean_time DESC
    LIMIT 10;
  "
```

**Solutions:**

```bash
# Solution 1: Add indexes
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  CREATE INDEX ci_type_index IF NOT EXISTS FOR (n:CI) ON (n.type);
"

kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    CREATE INDEX idx_dim_ci_type ON dim_ci(ci_type);
  "
```

## v3.0 Specific Issues

### BSM Enrichment Issues

#### Issue 1: CIs Not Getting BSM Attributes

**Symptoms:**
- CIs missing `bsm_tier`, `bsm_criticality`, or `bsm_health` attributes
- Business services not appearing in dashboard
- Error: "BSM enrichment job failed"

**Diagnosis:**

```bash
# Check if BSM enrichment is enabled
kubectl exec -n cmdb <api-server-pod> -- env | grep BSM_ENABLED

# Check BSM enrichment job status
curl -X GET https://cmdb.example.com/api/v1/jobs?type=bsm_enrichment \
  -H "Authorization: Bearer <api-key>"

# Check CI for BSM attributes
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (n:CI {_id: 'vm-001'})
  RETURN n.bsm_tier, n.bsm_criticality, n.bsm_health;
"

# Check BSM enrichment logs
kubectl logs -n cmdb -l app=api-server | grep -i "bsm enrichment"
```

**Common Causes & Solutions:**

**Cause 1: BSM enrichment disabled**

```bash
# Solution: Enable BSM enrichment
kubectl set env deployment/api-server -n cmdb \
  BSM_ENABLED=true \
  BSM_ENRICHMENT_SCHEDULE="0 */6 * * *"

# Trigger manual enrichment
curl -X POST https://cmdb.example.com/api/v1/bsm/enrich \
  -H "Authorization: Bearer <api-key>"
```

**Cause 2: Confidence threshold too high**

```bash
# Check current threshold
kubectl exec -n cmdb <api-server-pod> -- env | grep BSM_CONFIDENCE_THRESHOLD

# Solution: Lower threshold for testing
kubectl set env deployment/api-server -n cmdb \
  BSM_CONFIDENCE_THRESHOLD=0.3

# Re-run enrichment
curl -X POST https://cmdb.example.com/api/v1/bsm/enrich \
  -H "Authorization: Bearer <api-key>"
```

**Cause 3: Missing business service definitions**

```bash
# Check if business services exist
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (n:CI:BusinessService)
  RETURN n._id, n._name, n.bsm_criticality
  LIMIT 10;
"

# Solution: Create business services
curl -X POST https://cmdb.example.com/api/v1/ci \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "_id": "bsvc-payment-api",
    "_name": "Payment API",
    "_type": "business-service",
    "bsm_tier": "tier_0",
    "bsm_criticality": "mission_critical",
    "revenue_impact": 1000000
  }'
```

**Cause 4: Relationship mapping incomplete**

```bash
# Check if CIs have relationships to business services
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (ci:CI)-[r:SUPPORTS]->(bs:BusinessService)
  RETURN ci._id, bs._id, COUNT(*) as relationships
  LIMIT 10;
"

# Solution: Create relationships
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (vm:CI {_id: 'vm-001'})
  MATCH (bs:BusinessService {_id: 'bsvc-payment-api'})
  MERGE (vm)-[:SUPPORTS]->(bs);
"
```

---

#### Issue 2: BSM Health Scores Incorrect

**Symptoms:**
- Health scores showing 0 or 100 (extremes)
- Health scores not propagating up service tree
- Parent service health not aggregating from children

**Diagnosis:**

```bash
# Check health calculation schedule
kubectl exec -n cmdb <api-server-pod> -- env | grep BSM_HEALTH_CALCULATION_SCHEDULE

# Check health scores
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (n:CI:BusinessService)
  RETURN n._id, n._name, n.bsm_health, n.bsm_status
  ORDER BY n.bsm_health ASC
  LIMIT 20;
"

# Check health propagation logs
kubectl logs -n cmdb -l app=api-server | grep -i "health calculation"
```

**Solutions:**

**Solution 1: Verify health calculation is running**

```bash
# Check cron schedule
kubectl exec -n cmdb <api-server-pod> -- env | grep BSM_HEALTH_CALCULATION_SCHEDULE

# Trigger manual health calculation
curl -X POST https://cmdb.example.com/api/v1/bsm/calculate-health \
  -H "Authorization: Bearer <api-key>"
```

**Solution 2: Adjust health thresholds**

Edit `/config/bsm/thresholds.json` on api-server pod:

```json
{
  "health": {
    "critical_threshold": 0.5,
    "warning_threshold": 0.7,
    "healthy_threshold": 0.9
  }
}
```

Then restart api-server:

```bash
kubectl rollout restart deployment/api-server -n cmdb
```

**Solution 3: Fix health aggregation method**

```bash
# Use weighted aggregation (default)
kubectl set env deployment/api-server -n cmdb \
  BSM_HEALTH_AGGREGATION=weighted

# Or use worst-case (most conservative)
kubectl set env deployment/api-server -n cmdb \
  BSM_HEALTH_AGGREGATION=worst
```

**Solution 4: Enable critical status propagation**

```bash
kubectl set env deployment/api-server -n cmdb \
  BSM_PROPAGATE_CRITICAL=true

# Re-calculate health
curl -X POST https://cmdb.example.com/api/v1/bsm/calculate-health \
  -H "Authorization: Bearer <api-key>"
```

---

#### Issue 3: Impact Analysis Not Working

**Symptoms:**
- Impact analysis returns empty results
- Affected services not identified correctly
- Error: "Unable to calculate blast radius"

**Diagnosis:**

```bash
# Test impact analysis for a specific CI
curl -X GET "https://cmdb.example.com/api/v1/bsm/impact?ciId=vm-001" \
  -H "Authorization: Bearer <api-key>"

# Check service dependencies
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (ci:CI {_id: 'vm-001'})-[r*1..5]-(affected)
  RETURN ci._id, TYPE(r), affected._id, affected._type
  LIMIT 50;
"

# Check propagation depth setting
kubectl exec -n cmdb <api-server-pod> -- cat /config/bsm/thresholds.json | grep max_depth
```

**Solutions:**

**Solution 1: Increase propagation depth**

Edit `/config/bsm/thresholds.json`:

```json
{
  "propagation": {
    "max_depth": 10,
    "stop_on_critical": false
  }
}
```

Restart api-server:

```bash
kubectl rollout restart deployment/api-server -n cmdb
```

**Solution 2: Verify relationships exist**

```bash
# Create missing relationships
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (vm:CI {_type: 'virtual-machine'})
  MATCH (app:CI {_type: 'application'})
  WHERE app.hostname = vm._name
  MERGE (app)-[:HOSTED_ON]->(vm);
"
```

---

### Dashboard Data Loading Issues

#### Issue 1: Dashboards Showing Mock Data

**Symptoms:**
- Executive Dashboard shows sample data instead of real metrics
- Cost charts show "Sample Cost Pool" entries
- CI counts don't match actual inventory

**Diagnosis:**

```bash
# Check if data mart is populated
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT 'dim_ci' as table_name, COUNT(*) as row_count FROM dim_ci
    UNION ALL
    SELECT 'fact_cost', COUNT(*) FROM fact_cost
    UNION ALL
    SELECT 'fact_incidents', COUNT(*) FROM fact_incidents
    UNION ALL
    SELECT 'dim_business_services', COUNT(*) FROM dim_business_services
    UNION ALL
    SELECT 'tbm_cost_pools', COUNT(*) FROM tbm_cost_pools;
  "

# Check ETL sync status
curl -X GET https://cmdb.example.com/api/v1/etl/status \
  -H "Authorization: Bearer <api-key>"

# Check last ETL sync time
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT MAX(last_updated) as last_sync FROM dim_ci;
  "
```

**Solutions:**

**Solution 1: Trigger full ETL sync**

```bash
# Run full sync from Neo4j to PostgreSQL
curl -X POST https://cmdb.example.com/api/v1/etl/sync?full=true \
  -H "Authorization: Bearer <api-key>"

# Monitor sync progress
kubectl logs -n cmdb -l app=etl-processor -f
```

**Solution 2: Enable automatic ETL sync**

```bash
kubectl set env deployment/etl-processor -n cmdb \
  ETL_SYNC_ENABLED=true \
  ETL_SYNC_INTERVAL=300000

kubectl rollout restart deployment/etl-processor -n cmdb
```

**Solution 3: Verify Metabase connection to data mart**

```bash
# Log into Metabase (http://localhost:3002 or https://cmdb.example.com/metabase)
# Settings → Admin → Databases → HappyCMDB Data Mart
# Click "Test Connection"

# If connection fails, update connection string:
# - Host: postgresql (Docker) or postgres-0 (Kubernetes)
# - Port: 5432
# - Database: cmdb_datamart
# - Username: cmdb_user
# - Password: <from secret>
```

**Solution 4: Refresh Metabase cache**

```bash
# Clear Metabase query cache
kubectl exec -n cmdb <metabase-pod> -- \
  java -jar metabase.jar migrate release-locks

# Restart Metabase
kubectl rollout restart deployment/metabase -n cmdb
```

---

#### Issue 2: Dashboard Queries Timing Out

**Symptoms:**
- Dashboards load partially or timeout
- Error: "Query execution timeout"
- Slow dashboard rendering (> 30 seconds)

**Diagnosis:**

```bash
# Check Metabase query timeout
kubectl exec -n cmdb <metabase-pod> -- env | grep METABASE_QUERY_TIMEOUT

# Check for long-running PostgreSQL queries
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT pid, now() - pg_stat_activity.query_start AS duration,
           left(query, 100) as query_snippet
    FROM pg_stat_activity
    WHERE state = 'active' AND datname = 'cmdb_datamart'
    ORDER BY duration DESC;
  "

# Check database statistics
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT schemaname, tablename, n_live_tup as rows
    FROM pg_stat_user_tables
    ORDER BY n_live_tup DESC;
  "
```

**Solutions:**

**Solution 1: Increase Metabase query timeout**

```bash
kubectl set env deployment/metabase -n cmdb \
  METABASE_QUERY_TIMEOUT=300

kubectl rollout restart deployment/metabase -n cmdb
```

**Solution 2: Add database indexes**

```bash
# Add indexes on commonly queried columns
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart <<EOF
    CREATE INDEX CONCURRENTLY idx_dim_ci_type ON dim_ci(ci_type);
    CREATE INDEX CONCURRENTLY idx_dim_ci_env ON dim_ci(environment);
    CREATE INDEX CONCURRENTLY idx_fact_cost_date ON fact_cost(cost_date);
    CREATE INDEX CONCURRENTLY idx_fact_cost_pool ON fact_cost(cost_pool_id);
    CREATE INDEX CONCURRENTLY idx_fact_incidents_date ON fact_incidents(incident_date);
EOF
```

**Solution 3: Optimize queries with materialized views**

```bash
# Create materialized view for cost summary (refreshed hourly)
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart <<EOF
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cost_summary AS
    SELECT
      cp.tower,
      cp.pool_name,
      SUM(fc.amount) as total_cost,
      DATE_TRUNC('month', fc.cost_date) as cost_month
    FROM fact_cost fc
    JOIN tbm_cost_pools cp ON fc.cost_pool_id = cp.cost_pool_id
    GROUP BY cp.tower, cp.pool_name, DATE_TRUNC('month', fc.cost_date);

    CREATE INDEX ON mv_cost_summary(tower);
    CREATE INDEX ON mv_cost_summary(cost_month);
EOF

# Set up cron to refresh view hourly
kubectl set env deployment/etl-processor -n cmdb \
  ETL_REFRESH_MATERIALIZED_VIEWS=true \
  ETL_MATERIALIZED_VIEW_SCHEDULE="0 * * * *"
```

**Solution 4: Archive old data**

```bash
# Archive fact tables older than 2 years
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart <<EOF
    -- Create archive table
    CREATE TABLE IF NOT EXISTS fact_cost_archive (LIKE fact_cost);

    -- Move old data
    WITH deleted AS (
      DELETE FROM fact_cost
      WHERE cost_date < NOW() - INTERVAL '2 years'
      RETURNING *
    )
    INSERT INTO fact_cost_archive SELECT * FROM deleted;

    -- Vacuum to reclaim space
    VACUUM ANALYZE fact_cost;
EOF
```

---

#### Issue 3: Missing Dashboard Visualizations

**Symptoms:**
- Charts not rendering
- Error: "No data available"
- Blank dashboard panels

**Diagnosis:**

```bash
# Check if required tables exist
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "\dt"

# Check if data exists in fact tables
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart <<EOF
    SELECT 'Business Services' as metric, COUNT(*) as count
    FROM dim_business_services
    UNION ALL
    SELECT 'Cost Records', COUNT(*) FROM fact_cost
    UNION ALL
    SELECT 'Incidents', COUNT(*) FROM fact_incidents
    UNION ALL
    SELECT 'Changes', COUNT(*) FROM fact_changes;
EOF

# Check Metabase logs for errors
kubectl logs -n cmdb -l app=metabase | grep -i error
```

**Solutions:**

**Solution 1: Populate missing dimensional data**

```bash
# Run business service sync
curl -X POST https://cmdb.example.com/api/v1/etl/sync/business-services \
  -H "Authorization: Bearer <api-key>"

# Run cost pool sync
curl -X POST https://cmdb.example.com/api/v1/etl/sync/cost-pools \
  -H "Authorization: Bearer <api-key>"
```

**Solution 2: Import ITIL data**

```bash
# Enable ITIL APIs (if currently disabled)
kubectl set env deployment/api-server -n cmdb \
  ITIL_ENABLED=true

# Create sample incidents for testing
curl -X POST https://cmdb.example.com/api/v1/incidents \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Database connection timeout",
    "priority": "P2",
    "affected_ci_id": "db-prod-001",
    "status": "open"
  }'
```

**Solution 3: Re-import Metabase dashboards**

```bash
# Export current dashboards (backup)
# Metabase UI → Collections → Export

# Re-import pre-configured v3.0 dashboards
kubectl cp ./infrastructure/metabase/dashboards/ \
  cmdb/<metabase-pod>:/tmp/dashboards/

# Import via Metabase API
curl -X POST https://cmdb.example.com/metabase/api/collection/root/items \
  -H "X-Metabase-Session: <session-token>" \
  -F "file=@/tmp/dashboards/executive-dashboard.json"
```

---

### Cost Calculation Accuracy Problems

#### Issue 1: Incorrect Cost Allocations

**Symptoms:**
- Service costs don't match expected values
- Total allocated cost > actual cloud bill
- Some services show $0 cost despite resource usage

**Diagnosis:**

```bash
# Compare total allocated vs actual costs
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart <<EOF
    SELECT
      SUM(fc.amount) as total_allocated,
      (SELECT SUM(actual_cost) FROM cloud_billing_import) as actual_cost,
      SUM(fc.amount) - (SELECT SUM(actual_cost) FROM cloud_billing_import) as variance
    FROM fact_cost fc
    WHERE fc.cost_date >= DATE_TRUNC('month', CURRENT_DATE);
EOF

# Check allocation method
kubectl exec -n cmdb <api-server-pod> -- env | grep COST_ALLOCATION_METHOD

# Check for unallocated costs
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart <<EOF
    SELECT
      cp.pool_name,
      SUM(fc.amount) as allocated,
      cp.total_cost as actual,
      (cp.total_cost - SUM(fc.amount)) as unallocated
    FROM fact_cost fc
    JOIN tbm_cost_pools cp ON fc.cost_pool_id = cp.cost_pool_id
    WHERE fc.cost_date >= DATE_TRUNC('month', CURRENT_DATE)
    GROUP BY cp.pool_name, cp.total_cost
    HAVING cp.total_cost - SUM(fc.amount) > 0;
EOF

# Check cost allocation logs
kubectl logs -n cmdb -l app=api-server | grep -i "cost allocation"
```

**Solutions:**

**Solution 1: Switch allocation method**

```bash
# Try usage-based allocation (most accurate for shared resources)
kubectl set env deployment/api-server -n cmdb \
  COST_ALLOCATION_METHOD=usage_based

# Re-run cost allocation
curl -X POST https://cmdb.example.com/api/v1/financial/allocate-costs \
  -H "Authorization: Bearer <api-key>"
```

**Solution 2: Fix tagging on cloud resources**

For AWS resources:

```bash
# Tag EC2 instances with service names
aws ec2 create-tags \
  --resources i-1234567890abcdef0 \
  --tags Key=Service,Value=payment-api Key=Environment,Value=production
```

For Azure resources:

```bash
# Tag VMs with service names
az resource tag \
  --resource-group production-rg \
  --name vm-web-01 \
  --resource-type Microsoft.Compute/virtualMachines \
  --tags Service=payment-api Environment=production
```

Then re-run discovery to pick up new tags:

```bash
curl -X POST https://cmdb.example.com/api/v1/discovery/run?connector=aws \
  -H "Authorization: Bearer <api-key>"
```

**Solution 3: Define allocation keys for shared resources**

```bash
# Set allocation keys for shared database
curl -X PATCH https://cmdb.example.com/api/v1/ci/db-shared-001 \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "cost_allocation_keys": {
      "payment-api": 0.4,
      "user-service": 0.3,
      "inventory-service": 0.3
    }
  }'

# Re-allocate costs
curl -X POST https://cmdb.example.com/api/v1/financial/allocate-costs \
  -H "Authorization: Bearer <api-key>"
```

**Solution 4: Reconcile with actual cloud bills**

```bash
# Import AWS Cost & Usage Report
curl -X POST https://cmdb.example.com/api/v1/financial/import/aws-cur \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "s3_bucket": "your-billing-bucket",
    "report_name": "hourly-cost-usage",
    "month": "2025-11"
  }'

# Import Azure Cost Management data
curl -X POST https://cmdb.example.com/api/v1/financial/import/azure-costs \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "subscription_id": "your-subscription-id",
    "month": "2025-11"
  }'
```

---

#### Issue 2: Missing Cost Data from Cloud Providers

**Symptoms:**
- Some AWS/Azure/GCP resources show no costs
- Cost sync job failing
- Error: "Unable to fetch billing data"

**Diagnosis:**

```bash
# Check cost sync job status
curl -X GET https://cmdb.example.com/api/v1/jobs?type=cost_sync \
  -H "Authorization: Bearer <api-key>"

# Check if cost sync is enabled
kubectl exec -n cmdb <api-server-pod> -- env | grep COST_SYNC_ENABLED

# Check cost sync logs
kubectl logs -n cmdb -l app=api-server | grep -i "cost sync"

# Verify billing data source is configured
kubectl exec -n cmdb <api-server-pod> -- env | grep -E "AWS_COST|AZURE_COST|GCP_COST"
```

**Solutions:**

**Solution 1: Enable cost sync jobs**

```bash
kubectl set env deployment/api-server -n cmdb \
  AWS_COST_SYNC_ENABLED=true \
  AZURE_COST_SYNC_ENABLED=true \
  GCP_COST_SYNC_ENABLED=true \
  AWS_COST_SYNC_SCHEDULE="0 8 * * *" \
  AZURE_COST_SYNC_SCHEDULE="0 9 * * *" \
  GCP_COST_SYNC_SCHEDULE="0 10 * * *"

kubectl rollout restart deployment/api-server -n cmdb
```

**Solution 2: Configure AWS Cost & Usage Report**

```bash
# Verify S3 bucket configuration
kubectl set env deployment/api-server -n cmdb \
  AWS_COST_SYNC_S3_BUCKET=your-aws-billing-bucket \
  AWS_COST_SYNC_REPORT_PREFIX=cur/

# Ensure IAM role has S3 read access
# Required IAM policy:
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::your-aws-billing-bucket",
      "arn:aws:s3:::your-aws-billing-bucket/*"
    ]
  }]
}
```

**Solution 3: Configure Azure Cost Management API**

```bash
# Set Azure subscription ID
kubectl set env deployment/api-server -n cmdb \
  AZURE_COST_SYNC_SUBSCRIPTION_ID=your-subscription-id

# Ensure service principal has Cost Management Reader role
az role assignment create \
  --assignee <service-principal-id> \
  --role "Cost Management Reader" \
  --scope /subscriptions/<subscription-id>
```

**Solution 4: Trigger manual cost sync**

```bash
# Run cost sync manually
curl -X POST https://cmdb.example.com/api/v1/financial/sync-costs \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "providers": ["aws", "azure", "gcp"],
    "start_date": "2025-11-01",
    "end_date": "2025-11-30"
  }'
```

---

#### Issue 3: TBM Cost Pool Mapping Errors

**Symptoms:**
- Cloud resources not mapped to TBM towers
- Cost pools empty or showing unexpected totals
- Error: "Unable to determine cost pool"

**Diagnosis:**

```bash
# Check TBM cost pool definitions
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT tower, pool_name, COUNT(*) as ci_count, SUM(total_cost) as total
    FROM tbm_cost_pools
    GROUP BY tower, pool_name;
  "

# Check if CIs have cost pool assignments
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (n:CI)
  RETURN n.tbm_tower, n.tbm_cost_pool, COUNT(*) as count
  LIMIT 20;
"

# Check cost pool mapping logs
kubectl logs -n cmdb -l app=api-server | grep -i "cost pool"
```

**Solutions:**

**Solution 1: Run TBM tower classification**

```bash
# Classify CIs into TBM towers based on type
curl -X POST https://cmdb.example.com/api/v1/financial/classify-tbm \
  -H "Authorization: Bearer <api-key>"

# Verify classification
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  MATCH (n:CI)
  WHERE n.tbm_tower IS NOT NULL
  RETURN n._type, n.tbm_tower, COUNT(*) as count
  GROUP BY n._type, n.tbm_tower;
"
```

**Solution 2: Map services to cost pools manually**

```bash
# Configure tower mappings
kubectl set env deployment/api-server -n cmdb \
  TBM_TOWER_COMPUTE=EC2,Lambda,ECS,EKS,VirtualMachine \
  TBM_TOWER_STORAGE=S3,EBS,EFS,BlobStorage,FileStorage \
  TBM_TOWER_NETWORK=VPC,LoadBalancer,VirtualNetwork,CDN \
  TBM_TOWER_DATA=RDS,DynamoDB,PostgreSQL,MySQL,SQLDatabase

# Re-run classification
curl -X POST https://cmdb.example.com/api/v1/financial/classify-tbm \
  -H "Authorization: Bearer <api-key>"
```

**Solution 3: Create custom cost pools**

```bash
# Add cost pool for specific service
curl -X POST https://cmdb.example.com/api/v1/financial/cost-pools \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "pool_name": "Payment Processing",
    "tower": "compute",
    "category": "application",
    "allocation_method": "usage_based",
    "ci_filter": {"service": "payment-api"}
  }'
```

---

## Diagnostic Commands

### General Diagnostics

```bash
# Get all resources in namespace
kubectl get all -n cmdb

# Describe all pods
kubectl describe pods -n cmdb

# Get recent events
kubectl get events -n cmdb --sort-by='.lastTimestamp' | tail -50

# Check resource usage
kubectl top nodes
kubectl top pods -n cmdb
```

### Network Diagnostics

```bash
# Test service connectivity
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- /bin/bash
# From inside pod:
nslookup neo4j
curl http://api-server:3000/health
nc -zv postgresql 5433

# Check DNS resolution
kubectl exec -n cmdb <pod-name> -- nslookup neo4j

# Check network policies
kubectl get networkpolicies -n cmdb
kubectl describe networkpolicy <policy-name> -n cmdb
```

### Database Diagnostics

```bash
# Neo4j diagnostics
kubectl exec -n cmdb neo4j-0 -- cypher-shell -u neo4j -p <password> "
  CALL dbms.queryJmx('org.neo4j:*')
  YIELD attributes
  RETURN attributes;
"

# PostgreSQL diagnostics
kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "\l+"

kubectl exec -n cmdb postgresql-0 -- \
  psql -U cmdb_user -d cmdb_datamart -c "
    SELECT * FROM pg_stat_database WHERE datname = 'cmdb_datamart';
  "

# Redis diagnostics
kubectl exec -n cmdb redis-0 -- redis-cli -a <password> INFO all
```

## See Also

- [Daily Operations Guide](/operations/daily-operations)
- [CLI Commands Reference](/quick-reference/cli-commands)
- [Performance Tuning](/guides/performance)
- [Monitoring Guide](/guides/monitoring)
