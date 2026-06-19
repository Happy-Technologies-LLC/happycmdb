# v3.0 Configuration Guide

Complete reference for configuring HappyCMDB v3.0 with environment variables, BSM thresholds, and deployment best practices.

## Overview

HappyCMDB v3.0 introduces significant configuration changes from v2.0:

**Key Changes**:
- **Unified Credentials** - Cloud provider credentials moved from `.env` to PostgreSQL
- **Event Streaming** - Kafka configuration for real-time event processing
- **Business Intelligence** - Metabase and Grafana configuration
- **BSM Enrichment** - Business Service Mapping threshold tuning
- **Financial Management** - TBM v5.0.1 cost pool configuration
- **ITIL Integration** - ServiceNow/Jira connector settings

**Configuration Locations**:
- **Environment Variables**: `.env` file in project root (gitignored)
- **Template**: `.env.example` (checked into git)
- **Credentials**: PostgreSQL `dim_credentials` table (encrypted)
- **BSM Thresholds**: Configuration files in `/config/bsm/`
- **Connector Config**: Per-connector settings in UI or API

---

## Environment Variables Reference

### Core Application Settings

```bash
# Node.js Environment
NODE_ENV=production                    # development | staging | production
LOG_LEVEL=info                         # error | warn | info | debug | trace

# API Server
API_PORT=3000                          # Default: 3000
API_HOST=0.0.0.0                       # Bind address (0.0.0.0 for all interfaces)
API_CORS_ORIGIN=*                      # CORS allowed origins (comma-separated)

# Web UI Server
WEB_UI_PORT=3001                       # Default: 3001
WEB_UI_BASE_URL=http://localhost:3001  # Public URL for UI
```

**Production Recommendations**:
- `NODE_ENV=production` - Enables optimizations, disables debug features
- `LOG_LEVEL=warn` - Reduce log verbosity in production
- `API_CORS_ORIGIN=https://cmdb.yourcompany.com` - Restrict CORS to your domain

---

### Authentication & Security

```bash
# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-minimum-32-chars
JWT_EXPIRATION=24h                     # Token lifetime (e.g., 15m, 1h, 24h, 7d)
JWT_REFRESH_EXPIRATION=7d              # Refresh token lifetime

# Encryption (for credentials storage)
ENCRYPTION_KEY=your-encryption-key-for-sensitive-data-minimum-32-characters
ENCRYPTION_ALGORITHM=aes-256-gcm       # Default: aes-256-gcm

# API Key Authentication
API_KEY_HEADER=X-API-Key               # Header name for API keys
API_KEY_PREFIX=cmdb_                   # Prefix for generated keys

# Session Configuration
SESSION_SECRET=your-session-secret-minimum-32-characters
SESSION_MAX_AGE=86400000               # Session lifetime in ms (24 hours)

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000             # Rate limit window (1 minute)
RATE_LIMIT_MAX_REQUESTS=100            # Max requests per window per IP
```

**Security Best Practices**:
- **JWT_SECRET**: Use 64+ character random string (generate with `openssl rand -base64 64`)
- **ENCRYPTION_KEY**: Use 64+ character random string, NEVER commit to git
- **JWT_EXPIRATION**: Use shorter expiration (15m-1h) for high-security environments
- **Rotate secrets quarterly** using `infrastructure/scripts/secret-rotation.sh`

---

### Database Configuration

#### Neo4j (Graph Database)

```bash
# Connection
NEO4J_URI=bolt://localhost:7687        # Connection string
NEO4J_USERNAME=neo4j                   # Default: neo4j
NEO4J_PASSWORD=your-neo4j-password     # Change from default!
NEO4J_DATABASE=cmdb                    # Database name (v4.0+)

# Connection Pool
NEO4J_MAX_CONNECTION_POOL_SIZE=100     # Max connections (default: 100)
NEO4J_CONNECTION_TIMEOUT=30000         # Timeout in ms (default: 30s)
NEO4J_MAX_TRANSACTION_RETRY_TIME=30000 # Retry time for transient errors

# Memory Configuration (tuning)
NEO4J_HEAP_INITIAL_SIZE=2G             # Initial heap size
NEO4J_HEAP_MAX_SIZE=4G                 # Max heap size
NEO4J_PAGECACHE_SIZE=2G                # Page cache (should be ~50% of RAM)
```

**Production Tuning**:
- **Heap**: Set to 50% of available RAM (max 31GB due to JVM limits)
- **Page Cache**: Set to 50% of remaining RAM after heap
- **Example (16GB RAM)**: `HEAP_MAX_SIZE=8G`, `PAGECACHE_SIZE=6G`

#### PostgreSQL (Data Mart)

```bash
# Connection
POSTGRES_HOST=localhost                # Hostname or IP
POSTGRES_PORT=5432                     # Default: 5432
POSTGRES_DATABASE=cmdb                 # Database name
POSTGRES_USER=cmdb_user                # Username
POSTGRES_PASSWORD=your-postgres-password

# Connection Pool
POSTGRES_MAX_CONNECTIONS=50            # Max connections (default: 50)
POSTGRES_IDLE_TIMEOUT=10000            # Idle connection timeout (ms)
POSTGRES_CONNECTION_TIMEOUT=5000       # Connection timeout (ms)

# Query Performance
POSTGRES_STATEMENT_TIMEOUT=30000       # Query timeout (ms)
POSTGRES_LOCK_TIMEOUT=5000             # Lock timeout (ms)
```

**Production Tuning**:
- **MAX_CONNECTIONS**: Set to `(CPU cores * 2) + disk spindles` for traditional disk, `CPU cores * 4` for SSD
- **STATEMENT_TIMEOUT**: Prevent runaway queries (30s recommended)
- **Connection Pooling**: Use PgBouncer for high-concurrency workloads

#### Redis (Cache & Queue)

```bash
# Connection
REDIS_HOST=localhost                   # Hostname or IP
REDIS_PORT=6379                        # Default: 6379
REDIS_PASSWORD=                        # Leave empty for no auth (dev only!)
REDIS_DB=0                             # Database number (0-15)

# Connection Pool
REDIS_MAX_RETRY_DELAY=3000             # Max retry delay (ms)
REDIS_ENABLE_READY_CHECK=true          # Check connection on startup
REDIS_ENABLE_OFFLINE_QUEUE=true        # Queue commands when offline

# Cache Configuration
REDIS_DEFAULT_TTL=3600                 # Default cache TTL (seconds)
REDIS_CI_CACHE_TTL=300                 # CI cache TTL (5 minutes)
REDIS_DISCOVERY_CACHE_TTL=3600         # Discovery results cache (1 hour)
```

**Production Recommendations**:
- **REDIS_PASSWORD**: Always set password in production
- **REDIS_MAX_RETRY_DELAY**: Increase to 5000ms for unstable networks
- **Cache TTL**: Tune based on data freshness requirements

---

### Event Streaming (Kafka)

```bash
# Kafka Broker
KAFKA_BROKER=localhost:9092            # Kafka broker address(es), comma-separated
KAFKA_CLIENT_ID=happycmdb-api        # Client identifier

# Zookeeper (managed by Kafka)
ZOOKEEPER_CLIENT_PORT=2181             # Default: 2181
ZOOKEEPER_TICK_TIME=2000               # Tick time in ms

# Kafka UI (Topic Management)
KAFKA_UI_PORT=8090                     # Web UI port (http://localhost:8090)

# Producer Configuration
KAFKA_PRODUCER_ACKS=all                # Acknowledgment level (0, 1, all)
KAFKA_PRODUCER_COMPRESSION=snappy      # Compression (none, gzip, snappy, lz4)
KAFKA_PRODUCER_BATCH_SIZE=16384        # Batch size in bytes
KAFKA_PRODUCER_LINGER_MS=10            # Wait time before sending batch

# Consumer Configuration
KAFKA_CONSUMER_GROUP_ID=happycmdb-consumers
KAFKA_CONSUMER_SESSION_TIMEOUT=30000   # Session timeout (ms)
KAFKA_CONSUMER_AUTO_COMMIT=false       # Manual commit for reliability
```

**Topic Configuration** (created via `infrastructure/scripts/init-kafka.sh`):

| Topic | Partitions | Retention | Purpose |
|-------|-----------|-----------|---------|
| `discovery-events` | 3 | 7 days | CI discovery completions |
| `enrichment-events` | 3 | 7 days | BSM enrichment results |
| `change-events` | 3 | 30 days | CI lifecycle changes |
| `itil-events` | 3 | 30 days | Incidents, changes, problems |
| `cost-events` | 2 | 90 days | Cost pool updates |
| `bsm-events` | 3 | 30 days | Business service changes |
| `audit-events` | 2 | 365 days | Audit trail (long retention) |
| `alert-events` | 4 | 7 days | Real-time alerts |
| `etl-events` | 2 | 30 days | ETL job status |
| `integration-events` | 2 | 7 days | External integrations |
| `dlq-events` | 1 | 90 days | Dead letter queue |

**Production Tuning**:
- **Partitions**: Increase for higher throughput (max = number of consumers)
- **Retention**: Adjust based on compliance requirements
- **Compression**: Use `lz4` for low-latency, `snappy` for balanced, `gzip` for best compression

---

### Business Intelligence (Metabase & Grafana)

#### Metabase

```bash
# Application
METABASE_PORT=3002                     # Web UI port
METABASE_SITE_NAME=HappyCMDB Analytics
METABASE_SITE_URL=http://localhost:3002

# Database (PostgreSQL backend)
METABASE_DB_TYPE=postgres
METABASE_DB_HOST=localhost
METABASE_DB_PORT=5432
METABASE_DB_NAME=metabase
METABASE_DB_USER=metabase_user
METABASE_DB_PASS=metabase_password_change_me

# Admin Account (initial setup)
METABASE_ADMIN_EMAIL=admin@yourcompany.com
METABASE_ADMIN_PASSWORD=ChangeMeOnFirstLogin!

# Performance
METABASE_MAX_SESSION_AGE=20160         # Session age in minutes (14 days)
METABASE_QUERY_TIMEOUT=120             # Query timeout in seconds
```

**First-Time Setup**:
1. Navigate to `http://localhost:3002`
2. Complete setup wizard with admin credentials
3. Add HappyCMDB PostgreSQL data mart as data source:
   - Host: `postgres` (Docker) or `localhost`
   - Database: `cmdb`
   - User: `cmdb_user`

#### Grafana

```bash
# Application
GRAFANA_PORT=3003                      # Web UI port
GRAFANA_ADMIN_USER=admin               # Initial admin username
GRAFANA_ADMIN_PASSWORD=admin           # Change on first login!

# Data Sources (auto-configured)
GRAFANA_POSTGRES_HOST=localhost
GRAFANA_POSTGRES_DATABASE=cmdb
GRAFANA_POSTGRES_USER=cmdb_user
GRAFANA_POSTGRES_PASSWORD=your-postgres-password

# Plugins
GRAFANA_INSTALL_PLUGINS=grafana-clock-panel,grafana-simple-json-datasource
```

**Grafana Dashboards** (pre-configured):
- **Infrastructure Overview** - CI counts, discovery status
- **Cost Dashboard** - TBM cost pools, trends, allocation
- **ITIL Operations** - Incidents, changes, SLAs
- **BSM Health** - Business service health scores

---

### Discovery Configuration

```bash
# Discovery Engine
DISCOVERY_ENABLED=true                 # Enable/disable discovery
DISCOVERY_WORKER_CONCURRENCY=5         # Concurrent discovery jobs
DISCOVERY_DEFAULT_INTERVAL=3600000     # Default interval (ms) = 1 hour
DISCOVERY_BATCH_SIZE=100               # CIs per batch
DISCOVERY_TIMEOUT=300000               # Job timeout (ms) = 5 minutes

# Discovery Agent
AGENT_ENABLED=true                     # Enable discovery agent
AGENT_ID=agent-001                     # Unique agent identifier
AGENT_HEARTBEAT_INTERVAL=30000         # Heartbeat interval (ms)
AGENT_MAX_JOBS=10                      # Max concurrent jobs per agent

# Connector Configuration
CONNECTOR_REGISTRY_ENABLED=true        # Enable connector registry
CONNECTOR_AUTO_UPDATE=false            # Auto-update connectors (use cautiously!)
CONNECTOR_TIMEOUT=120000               # Connector timeout (ms) = 2 minutes
```

**Production Recommendations**:
- **DISCOVERY_WORKER_CONCURRENCY**: Set to CPU cores - 1
- **DISCOVERY_TIMEOUT**: Increase to 600000 (10 min) for large cloud accounts
- **CONNECTOR_AUTO_UPDATE**: Disable in production, test updates in staging first

---

### BSM (Business Service Mapping) Configuration

```bash
# BSM Enrichment
BSM_ENABLED=true                       # Enable BSM enrichment
BSM_ENRICHMENT_SCHEDULE=0 */6 * * *    # Cron schedule (every 6 hours)
BSM_BATCH_SIZE=500                     # CIs processed per batch
BSM_CONFIDENCE_THRESHOLD=0.6           # Min confidence for relationships

# Health Calculation
BSM_HEALTH_CALCULATION_SCHEDULE=*/15 * * * *  # Every 15 minutes
BSM_HEALTH_AGGREGATION=weighted        # average | weighted | worst
BSM_PROPAGATE_CRITICAL=true            # Propagate CRITICAL status up tree
```

**BSM Threshold Tuning**:

Create `/config/bsm/thresholds.json`:

```json
{
  "confidence": {
    "high": 0.9,
    "medium": 0.6,
    "low": 0.3
  },
  "health": {
    "critical_threshold": 0.5,
    "warning_threshold": 0.7,
    "healthy_threshold": 0.9
  },
  "impact": {
    "critical": {
      "min_dependent_services": 5,
      "min_revenue_impact": 100000
    },
    "high": {
      "min_dependent_services": 3,
      "min_revenue_impact": 50000
    },
    "medium": {
      "min_dependent_services": 1,
      "min_revenue_impact": 10000
    }
  },
  "propagation": {
    "max_depth": 5,
    "stop_on_critical": true,
    "aggregate_method": "weighted"
  }
}
```

**Tuning Guidance**:

- **confidence.high (0.9)**: Only very strong signals create relationships
  - Use for mission-critical service mapping
  - Reduces false positives

- **confidence.medium (0.6)**: Balanced approach (default)
  - Good for most environments
  - Acceptable false positive rate

- **confidence.low (0.3)**: Aggressive relationship creation
  - Use for discovery phase
  - Higher false positive rate, requires manual cleanup

- **health.critical_threshold (0.5)**: Service marked CRITICAL if health < 50%
  - Increase to 0.6 for more sensitive alerting
  - Decrease to 0.3 for less noise

- **propagation.max_depth (5)**: Limit impact analysis depth
  - Increase for deep service hierarchies
  - Decrease for performance (large graphs)

**Example Scenarios**:

**Scenario 1: High-Availability E-commerce**
```json
{
  "confidence": {"high": 0.95, "medium": 0.8, "low": 0.5},
  "health": {"critical_threshold": 0.7, "warning_threshold": 0.85},
  "impact": {"critical": {"min_dependent_services": 10}},
  "propagation": {"stop_on_critical": true, "max_depth": 3}
}
```
- Very conservative (high confidence thresholds)
- Sensitive health checks (70% critical threshold)
- Stop propagation early to reduce alert fatigue

**Scenario 2: Development Environment**
```json
{
  "confidence": {"high": 0.7, "medium": 0.4, "low": 0.2},
  "health": {"critical_threshold": 0.3, "warning_threshold": 0.6},
  "propagation": {"max_depth": 10, "aggregate_method": "average"}
}
```
- Permissive (low confidence thresholds)
- Less sensitive health checks
- Deep propagation for discovery

---

### Financial Management (TBM v5.0.1)

```bash
# TBM Configuration
TBM_ENABLED=true                       # Enable TBM cost management
TBM_VERSION=5.0.1                      # TBM framework version
TBM_FISCAL_YEAR_START=01-01            # Fiscal year start (MM-DD)
TBM_CURRENCY=USD                       # Default currency
TBM_EXCHANGE_RATE_API=https://api.exchangerate.host/latest

# Cost Allocation
COST_ALLOCATION_METHOD=usage_based     # direct | usage_based | equal
COST_ALLOCATION_SCHEDULE=0 2 * * *     # Daily at 2 AM
COST_ALLOCATION_RETROACTIVE_DAYS=30    # Recalculate last N days

# Cloud Provider Cost Sync
AWS_COST_SYNC_ENABLED=true
AWS_COST_SYNC_SCHEDULE=0 8 * * *       # Daily at 8 AM
AWS_COST_SYNC_S3_BUCKET=your-aws-billing-bucket

AZURE_COST_SYNC_ENABLED=true
AZURE_COST_SYNC_SCHEDULE=0 9 * * *
AZURE_COST_SYNC_SUBSCRIPTION_ID=your-subscription-id

GCP_COST_SYNC_ENABLED=true
GCP_COST_SYNC_SCHEDULE=0 10 * * *
GCP_COST_SYNC_BIGQUERY_TABLE=your-project.billing.gcp_billing_export
```

**Cost Allocation Methods**:

1. **Direct Allocation** (`COST_ALLOCATION_METHOD=direct`)
   - Assigns costs directly to services based on tags
   - Fastest, most accurate when tagging is complete
   - Example: EC2 instance tagged `Service=payment-api` → 100% to Payment Service

2. **Usage-Based Allocation** (`COST_ALLOCATION_METHOD=usage_based`)
   - Allocates shared costs proportionally by usage metrics
   - Use when tagging is incomplete
   - Example: Shared database → split by query count per service

3. **Equal Allocation** (`COST_ALLOCATION_METHOD=equal`)
   - Splits costs equally across all consumers
   - Simplest, least accurate
   - Use for truly shared resources (e.g., corporate network)

**TBM Capability Towers** (11 towers in v5.0.1):

```bash
# Configure cost pools per tower
TBM_TOWER_COMPUTE=EC2,Lambda,ECS,EKS
TBM_TOWER_STORAGE=S3,EBS,EFS,Glacier
TBM_TOWER_NETWORK=VPC,DirectConnect,CloudFront,Route53
TBM_TOWER_DATA=RDS,DynamoDB,Redshift,Athena
TBM_TOWER_SECURITY=GuardDuty,SecurityHub,WAF,Shield
TBM_TOWER_END_USER=WorkSpaces,AppStream,Chime
TBM_TOWER_FACILITIES=DataCenter,Power,Cooling
TBM_TOWER_RISK_COMPLIANCE=Audit,Insurance,Certifications
TBM_TOWER_IOT=IoT_Core,Greengrass,FreeRTOS
TBM_TOWER_BLOCKCHAIN=QLDB,ManagedBlockchain
TBM_TOWER_QUANTUM=Braket
```

---

### ITIL Integration

```bash
# ITIL Configuration
ITIL_ENABLED=true                      # Enable ITIL workflows
ITIL_VERSION=v4                        # ITIL framework version

# ServiceNow Integration
SERVICENOW_ENABLED=true
SERVICENOW_INSTANCE=your-instance.service-now.com
SERVICENOW_SYNC_SCHEDULE=*/15 * * * *  # Every 15 minutes
SERVICENOW_SYNC_TABLES=incident,change_request,cmdb_ci

# Jira Integration
JIRA_ENABLED=false
JIRA_HOST=your-company.atlassian.net
JIRA_SYNC_SCHEDULE=*/30 * * * *
JIRA_PROJECT_KEY=OPS

# SLA Configuration
SLA_TRACKING_ENABLED=true
SLA_P1_RESPONSE_TIME=15                # Minutes
SLA_P1_RESOLUTION_TIME=240             # Minutes (4 hours)
SLA_P2_RESPONSE_TIME=60
SLA_P2_RESOLUTION_TIME=480
SLA_P3_RESPONSE_TIME=240
SLA_P3_RESOLUTION_TIME=1440
```

**ITIL Workflow Integration**:

- **Incident Management**: Sync incidents from ServiceNow/Jira → HappyCMDB
- **Change Management**: Update CI baseline on approved changes
- **Problem Management**: Link problems to affected CIs
- **Service Requests**: Track service request fulfillment

**Credential Configuration** (via API, not .env):
```bash
# Create ServiceNow credential
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "ServiceNow Production",
    "_protocol": "oauth2_client_credentials",
    "_scope": "integration",
    "_credentials": {
      "clientId": "your-client-id",
      "clientSecret": "your-client-secret",
      "tokenUrl": "https://your-instance.service-now.com/oauth_token.do"
    }
  }'
```

---

### Monitoring & Observability

```bash
# Metrics Collection
METRICS_ENABLED=true                   # Enable Prometheus metrics
METRICS_PORT=9090                      # Prometheus scrape port
METRICS_PATH=/metrics                  # Metrics endpoint path

# Logging
LOG_DESTINATION=stdout                 # stdout | file | syslog
LOG_FILE_PATH=/var/log/happycmdb/app.log
LOG_MAX_SIZE=100M                      # Max log file size
LOG_MAX_FILES=10                       # Log rotation count
LOG_COMPRESS=true                      # Compress rotated logs

# Distributed Tracing
TRACING_ENABLED=false                  # Enable OpenTelemetry tracing
TRACING_EXPORTER=jaeger                # jaeger | zipkin | otlp
TRACING_ENDPOINT=http://localhost:14268/api/traces
TRACING_SAMPLE_RATE=0.1                # Sample 10% of traces

# Audit Logging
AUDIT_LOG_ENABLED=true                 # Enable audit trail
AUDIT_LOG_RETENTION_DAYS=365           # Audit log retention
AUDIT_LOG_INCLUDE_READ=false           # Log read operations (verbose!)
```

**Prometheus Metrics Exposed**:

- `happycmdb_discovery_jobs_total` - Total discovery jobs
- `happycmdb_discovery_jobs_duration_seconds` - Job duration histogram
- `happycmdb_ci_count` - Total CIs by type
- `happycmdb_api_requests_total` - API request count
- `happycmdb_api_request_duration_seconds` - API latency histogram
- `happycmdb_neo4j_connections_active` - Active Neo4j connections
- `happycmdb_postgres_connections_active` - Active PostgreSQL connections

---

## Configuration Templates

### Development Environment

```bash
# .env.development
NODE_ENV=development
LOG_LEVEL=debug

# Databases (localhost)
NEO4J_URI=bolt://localhost:7687
POSTGRES_HOST=localhost
REDIS_HOST=localhost

# Relaxed security (dev only!)
JWT_EXPIRATION=7d
RATE_LIMIT_MAX_REQUESTS=1000

# Discovery (lower frequency)
DISCOVERY_DEFAULT_INTERVAL=3600000
DISCOVERY_WORKER_CONCURRENCY=2

# BSM (permissive thresholds for testing)
BSM_CONFIDENCE_THRESHOLD=0.3
BSM_HEALTH_CALCULATION_SCHEDULE=*/30 * * * *
```

### Staging Environment

```bash
# .env.staging
NODE_ENV=staging
LOG_LEVEL=info

# Databases (staging servers)
NEO4J_URI=bolt://neo4j-staging:7687
POSTGRES_HOST=postgres-staging
REDIS_HOST=redis-staging

# Moderate security
JWT_EXPIRATION=24h
RATE_LIMIT_MAX_REQUESTS=500

# Discovery (production-like)
DISCOVERY_DEFAULT_INTERVAL=3600000
DISCOVERY_WORKER_CONCURRENCY=5

# BSM (production thresholds)
BSM_CONFIDENCE_THRESHOLD=0.6
BSM_HEALTH_CALCULATION_SCHEDULE=*/15 * * * *

# Enable integrations for testing
SERVICENOW_ENABLED=true
AWS_COST_SYNC_ENABLED=true
```

### Production Environment

```bash
# .env.production
NODE_ENV=production
LOG_LEVEL=warn

# Databases (production cluster)
NEO4J_URI=bolt://neo4j-prod-01:7687,bolt://neo4j-prod-02:7687,bolt://neo4j-prod-03:7687
POSTGRES_HOST=postgres-prod-master
REDIS_HOST=redis-prod-sentinel

# Strict security
JWT_SECRET=$(openssl rand -base64 64)
JWT_EXPIRATION=1h
JWT_REFRESH_EXPIRATION=7d
ENCRYPTION_KEY=$(openssl rand -base64 64)
RATE_LIMIT_MAX_REQUESTS=100

# Discovery (high concurrency)
DISCOVERY_WORKER_CONCURRENCY=10
DISCOVERY_DEFAULT_INTERVAL=3600000
DISCOVERY_TIMEOUT=600000

# BSM (tuned for scale)
BSM_CONFIDENCE_THRESHOLD=0.7
BSM_BATCH_SIZE=1000
BSM_HEALTH_CALCULATION_SCHEDULE=*/10 * * * *

# TBM (all cost sources)
TBM_ENABLED=true
AWS_COST_SYNC_ENABLED=true
AZURE_COST_SYNC_ENABLED=true
GCP_COST_SYNC_ENABLED=true
COST_ALLOCATION_METHOD=usage_based

# Monitoring
METRICS_ENABLED=true
AUDIT_LOG_ENABLED=true
TRACING_ENABLED=true
TRACING_SAMPLE_RATE=0.01

# High Availability
API_REPLICAS=3
DISCOVERY_WORKER_REPLICAS=5
```

---

## Best Practices

### Security

1. **Never commit `.env` to git** - Use `.env.example` as template
2. **Rotate secrets quarterly** - Use `infrastructure/scripts/secret-rotation.sh`
3. **Use strong secrets** - Minimum 32 characters, use `openssl rand -base64 64`
4. **Separate credentials by environment** - Different keys for dev/staging/prod
5. **Enable audit logging** - Set `AUDIT_LOG_ENABLED=true` in production
6. **Use HTTPS in production** - Configure SSL/TLS for all endpoints
7. **Restrict CORS** - Set `API_CORS_ORIGIN` to specific domains, not `*`

### Performance

1. **Tune database connection pools** - Set based on CPU cores and workload
2. **Enable Redis caching** - Reduces database load significantly
3. **Configure BSM batch size** - Larger batches (500-1000) for better throughput
4. **Use Kafka compression** - `snappy` for balanced performance/size
5. **Monitor and tune discovery concurrency** - Start low, increase based on CPU
6. **Set appropriate timeouts** - Balance responsiveness vs job completion
7. **Enable metrics collection** - Monitor for performance bottlenecks

### Reliability

1. **Configure health checks** - Monitor all services via `/api/health`
2. **Set up automated backups** - Daily backups with 7-day retention
3. **Test disaster recovery** - Quarterly restore tests
4. **Use connection retry logic** - Built into all database clients
5. **Configure dead letter queues** - Kafka DLQ for failed events
6. **Enable heartbeats** - Discovery agent heartbeat every 30s
7. **Implement circuit breakers** - Prevent cascade failures

### Cost Optimization

1. **Tune discovery intervals** - Less frequent for static resources
2. **Configure log retention** - Balance compliance vs storage costs
3. **Use Kafka retention policies** - Shorter retention for high-volume topics
4. **Enable query result caching** - Redis cache for frequent queries
5. **Right-size database resources** - Monitor usage, adjust heap/connections
6. **Archive old audit logs** - Move to cold storage after 90 days
7. **Compress backups** - Enable gzip compression for backups

---

## Troubleshooting Configuration Issues

### Issue: API server won't start

**Check**:
```bash
# Verify .env file exists
ls -la .env

# Check for syntax errors (no spaces around =)
cat .env | grep " ="

# Validate required variables are set
grep -E "JWT_SECRET|NEO4J_PASSWORD|POSTGRES_PASSWORD" .env
```

**Solution**: Ensure all required variables are set, no syntax errors

---

### Issue: Database connection failures

**Check**:
```bash
# Test Neo4j connection
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1;"

# Test PostgreSQL connection
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SELECT 1;"

# Test Redis connection
docker exec cmdb-redis redis-cli PING
```

**Solution**: Verify `NEO4J_URI`, `POSTGRES_HOST`, `REDIS_HOST` match actual hostnames

---

### Issue: Kafka topics not created

**Check**:
```bash
# List topics
docker exec cmdb-kafka kafka-topics --list --bootstrap-server localhost:9092

# Run initialization script
./infrastructure/scripts/init-kafka.sh
```

**Solution**: Ensure Kafka is running before topic creation, verify `KAFKA_BROKER` setting

---

### Issue: Discovery jobs not running

**Check**:
```bash
# Check discovery enabled
grep DISCOVERY_ENABLED .env

# Check worker concurrency
grep DISCOVERY_WORKER_CONCURRENCY .env

# View discovery logs
docker-compose logs api-server | grep -i discovery
```

**Solution**: Ensure `DISCOVERY_ENABLED=true`, check logs for credential errors

---

### Issue: BSM enrichment not working

**Check**:
```bash
# Verify BSM enabled
grep BSM_ENABLED .env

# Check threshold settings
grep BSM_CONFIDENCE_THRESHOLD .env

# Review enrichment logs
docker-compose logs api-server | grep -i bsm
```

**Solution**: Lower `BSM_CONFIDENCE_THRESHOLD` to 0.3 for testing, verify CIs have necessary attributes

---

## See Also

- [Environment Variables Reference](/configuration/environment-variables.md) - Full variable listing
- [Backup & Restore](/operations/backup-restore.md) - Backup procedures
- [Security Hardening](/configuration/security/README.md) - Security best practices
- [Monitoring Setup](/operations/MONITORING_SETUP_SUMMARY.md) - Prometheus/Grafana setup
- [Troubleshooting](/operations/troubleshooting.md) - Common issues and solutions

---

**Guide Version**: 3.0
**Last Updated**: November 2025
**Audience**: System Administrators, DevOps Engineers
