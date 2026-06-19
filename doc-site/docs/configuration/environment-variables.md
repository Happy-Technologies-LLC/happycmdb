---
title: Environment Variables
description: Complete reference for all HappyCMDB environment variables
---

# Environment Variables

Complete reference for configuring HappyCMDB platform through environment variables.

## Core Application Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | `development` | Application environment (`development`, `staging`, `production`) |
| `API_PORT` | No | `3000` | API server port |
| `LOG_LEVEL` | No | `info` | Logging level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `LOG_FORMAT` | No | `json` | Log format (`json`, `pretty`) |
| `TZ` | No | `UTC` | Timezone for timestamps |

**Example:**

```bash
NODE_ENV=production
API_PORT=3000
LOG_LEVEL=info
LOG_FORMAT=json
TZ=UTC
```

## Neo4j Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEO4J_URI` | Yes | - | Neo4j connection URI (`bolt://hostname:7687`) |
| `NEO4J_USERNAME` | Yes | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | Yes | - | Neo4j password (use secrets management) |
| `NEO4J_DATABASE` | No | `neo4j` | Database name |
| `NEO4J_MAX_CONNECTION_POOL_SIZE` | No | `50` | Maximum connection pool size |
| `NEO4J_ACQUISITION_TIMEOUT` | No | `60000` | Connection acquisition timeout (ms) |
| `NEO4J_MAX_TRANSACTION_RETRY_TIME` | No | `30000` | Max transaction retry time (ms) |
| `NEO4J_ENCRYPTED` | No | `false` | Enable SSL/TLS for Neo4j connection |

**Example:**

```bash
NEO4J_URI=bolt://neo4j.internal:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=${NEO4J_PASSWORD}  # From secrets
NEO4J_DATABASE=neo4j
NEO4J_MAX_CONNECTION_POOL_SIZE=100
NEO4J_ENCRYPTED=true
```

## PostgreSQL Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_HOST` | Yes | `localhost` | PostgreSQL hostname |
| `POSTGRES_PORT` | No | `5433` | PostgreSQL port (Docker default: 5433) |
| `POSTGRES_DB` | Yes | `cmdb_datamart` | Database name |
| `POSTGRES_USER` | Yes | - | PostgreSQL username |
| `POSTGRES_PASSWORD` | Yes | - | PostgreSQL password (use secrets management) |
| `POSTGRES_MAX_CONNECTIONS` | No | `20` | Maximum connection pool size |
| `POSTGRES_IDLE_TIMEOUT` | No | `30000` | Idle connection timeout (ms) |
| `POSTGRES_CONNECTION_TIMEOUT` | No | `5000` | Connection timeout (ms) |
| `POSTGRES_SSL` | No | `false` | Enable SSL/TLS |
| `POSTGRES_SSL_CA` | No | - | Path to CA certificate for SSL |

**Example:**

```bash
POSTGRES_HOST=postgresql.internal
POSTGRES_PORT=5433
POSTGRES_DB=cmdb_datamart
POSTGRES_USER=cmdb_user
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}  # From secrets
POSTGRES_MAX_CONNECTIONS=50
POSTGRES_SSL=true
POSTGRES_SSL_CA=/certs/ca.crt
```

## Redis Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_HOST` | Yes | `localhost` | Redis hostname |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | - | Redis password (if authentication enabled) |
| `REDIS_DB` | No | `0` | Redis database number |
| `REDIS_MAX_RETRIES` | No | `3` | Maximum connection retry attempts |
| `REDIS_RETRY_DELAY` | No | `1000` | Delay between retries (ms) |
| `REDIS_TLS` | No | `false` | Enable TLS |

**Example:**

```bash
REDIS_HOST=redis.internal
REDIS_PORT=6379
REDIS_PASSWORD=${REDIS_PASSWORD}  # From secrets
REDIS_DB=0
REDIS_MAX_RETRIES=5
REDIS_TLS=true
```

## Queue Configuration (BullMQ)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `QUEUE_CONCURRENCY` | No | `5` | Number of concurrent workers per queue |
| `QUEUE_MAX_JOBS_PER_WORKER` | No | `1` | Max jobs per worker |
| `QUEUE_JOB_TIMEOUT` | No | `300000` | Job timeout (ms) - 5 minutes |
| `QUEUE_RETRY_ATTEMPTS` | No | `3` | Number of retry attempts for failed jobs |
| `QUEUE_RETRY_DELAY` | No | `2000` | Delay between retries (ms) |
| `QUEUE_BACKOFF_TYPE` | No | `exponential` | Backoff strategy (`exponential`, `fixed`) |
| `QUEUE_REMOVE_ON_COMPLETE` | No | `100` | Keep last N completed jobs |
| `QUEUE_REMOVE_ON_FAIL` | No | `1000` | Keep last N failed jobs |

**Example:**

```bash
QUEUE_CONCURRENCY=10
QUEUE_JOB_TIMEOUT=600000  # 10 minutes
QUEUE_RETRY_ATTEMPTS=5
QUEUE_RETRY_DELAY=5000
QUEUE_BACKOFF_TYPE=exponential
```

## Discovery Engine Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCOVERY_ENABLED` | No | `true` | Enable/disable discovery engine |
| `DISCOVERY_CONCURRENCY` | No | `5` | Concurrent discovery jobs |
| `DISCOVERY_INTERVAL` | No | `3600000` | Discovery interval (ms) - 1 hour |
| `DISCOVERY_TIMEOUT` | No | `1800000` | Discovery job timeout (ms) - 30 minutes |
| `DISCOVERY_BATCH_SIZE` | No | `100` | Batch size for CI creation |
| `DISCOVERY_PROVIDERS` | No | `aws,azure,gcp` | Comma-separated list of enabled providers |

**Example:**

```bash
DISCOVERY_ENABLED=true
DISCOVERY_CONCURRENCY=10
DISCOVERY_INTERVAL=1800000  # 30 minutes
DISCOVERY_TIMEOUT=3600000   # 1 hour
DISCOVERY_BATCH_SIZE=500
DISCOVERY_PROVIDERS=aws,azure,gcp,ssh
```

## ETL Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ETL_ENABLED` | No | `true` | Enable/disable ETL processor |
| `ETL_SYNC_INTERVAL` | No | `300000` | ETL sync interval (ms) - 5 minutes |
| `ETL_BATCH_SIZE` | No | `1000` | Number of CIs to process per batch |
| `ETL_CONCURRENCY` | No | `3` | Concurrent ETL jobs |
| `ETL_TIMEOUT` | No | `600000` | ETL job timeout (ms) - 10 minutes |
| `ETL_FULL_SYNC_SCHEDULE` | No | `0 2 * * *` | Cron expression for full sync (2 AM daily) |

**Example:**

```bash
ETL_ENABLED=true
ETL_SYNC_INTERVAL=600000    # 10 minutes
ETL_BATCH_SIZE=2000
ETL_CONCURRENCY=5
ETL_FULL_SYNC_SCHEDULE="0 3 * * *"  # 3 AM daily
```

## Authentication & Security

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | - | Secret key for JWT token signing (use secrets management) |
| `JWT_EXPIRES_IN` | No | `3600` | JWT token expiration (seconds) - 1 hour |
| `API_KEY` | No | - | Static API key (for backward compatibility) |
| `API_KEY_HEADER` | No | `X-API-Key` | Header name for API key |
| `SESSION_SECRET` | No | - | Session secret for cookie-based auth |
| `CORS_ORIGIN` | No | `*` | CORS allowed origins (comma-separated) |
| `RATE_LIMIT_WINDOW` | No | `60000` | Rate limit window (ms) - 1 minute |
| `RATE_LIMIT_MAX` | No | `1000` | Max requests per window |
| `BCRYPT_ROUNDS` | No | `10` | Bcrypt hashing rounds |

**Example:**

```bash
JWT_SECRET=${JWT_SECRET}  # From secrets - minimum 32 characters
JWT_EXPIRES_IN=7200       # 2 hours
API_KEY=${API_KEY}        # From secrets
CORS_ORIGIN=https://dashboard.example.com,https://admin.example.com
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=1000
BCRYPT_ROUNDS=12
```

## Monitoring & Telemetry

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROMETHEUS_ENABLED` | No | `true` | Enable Prometheus metrics endpoint |
| `PROMETHEUS_PORT` | No | `9090` | Prometheus metrics port |
| `GRAFANA_ENABLED` | No | `true` | Enable Grafana integration |
| `JAEGER_ENABLED` | No | `false` | Enable Jaeger distributed tracing |
| `JAEGER_AGENT_HOST` | No | `localhost` | Jaeger agent hostname |
| `JAEGER_AGENT_PORT` | No | `6831` | Jaeger agent port |
| `METRICS_INTERVAL` | No | `10000` | Metrics collection interval (ms) |
| `HEALTH_CHECK_INTERVAL` | No | `30000` | Health check interval (ms) |

**Example:**

```bash
PROMETHEUS_ENABLED=true
PROMETHEUS_PORT=9090
GRAFANA_ENABLED=true
JAEGER_ENABLED=true
JAEGER_AGENT_HOST=jaeger.internal
METRICS_INTERVAL=15000
```

---

## Legacy v1.0 Configuration (Deprecated)

::: warning DEPRECATED
The following sections are for HappyCMDB v1.0 only and are **deprecated** in v2.0.

**v2.0 uses a unified credential system** stored in PostgreSQL. Do NOT use environment variables for connector credentials. See [Credentials Management](/components/credentials) for v2.0 configuration.
:::

## AWS Configuration (v1.0 Only - DEPRECATED)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AWS_REGION` | Yes | `us-east-1` | Default AWS region |
| `AWS_ACCESS_KEY_ID` | Yes* | - | AWS access key (*or use IAM role) |
| `AWS_SECRET_ACCESS_KEY` | Yes* | - | AWS secret key (*or use IAM role) |
| `AWS_SESSION_TOKEN` | No | - | AWS session token (for temporary credentials) |
| `AWS_DISCOVERY_REGIONS` | No | `all` | Comma-separated regions or `all` |
| `AWS_DISCOVERY_SERVICES` | No | `all` | Comma-separated services or `all` |
| `AWS_MAX_RETRIES` | No | `3` | Max API retry attempts |
| `AWS_TIMEOUT` | No | `30000` | API timeout (ms) |

**Example:**

```bash
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID}  # From secrets or IAM role
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}  # From secrets or IAM role
AWS_DISCOVERY_REGIONS=us-east-1,us-west-2,eu-west-1
AWS_DISCOVERY_SERVICES=ec2,rds,s3,lambda,ecs
AWS_MAX_RETRIES=5
```

## Azure Configuration (v1.0 Only - DEPRECATED)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_SUBSCRIPTION_ID` | Yes | - | Azure subscription ID |
| `AZURE_TENANT_ID` | Yes | - | Azure tenant ID |
| `AZURE_CLIENT_ID` | Yes | - | Service principal client ID |
| `AZURE_CLIENT_SECRET` | Yes | - | Service principal client secret |
| `AZURE_DISCOVERY_RESOURCE_GROUPS` | No | `all` | Comma-separated resource groups or `all` |
| `AZURE_DISCOVERY_REGIONS` | No | `all` | Comma-separated regions or `all` |

**Example:**

```bash
AZURE_SUBSCRIPTION_ID=${AZURE_SUBSCRIPTION_ID}
AZURE_TENANT_ID=${AZURE_TENANT_ID}
AZURE_CLIENT_ID=${AZURE_CLIENT_ID}
AZURE_CLIENT_SECRET=${AZURE_CLIENT_SECRET}
AZURE_DISCOVERY_RESOURCE_GROUPS=production-rg,staging-rg
AZURE_DISCOVERY_REGIONS=eastus,westus2,westeurope
```

## GCP Configuration (v1.0 Only - DEPRECATED)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GCP_PROJECT_ID` | Yes | - | GCP project ID |
| `GCP_CREDENTIALS_JSON` | No | - | Path to service account JSON file |
| `GOOGLE_APPLICATION_CREDENTIALS` | No | - | Path to service account JSON (alternative) |
| `GCP_DISCOVERY_ZONES` | No | `all` | Comma-separated zones or `all` |
| `GCP_DISCOVERY_REGIONS` | No | `all` | Comma-separated regions or `all` |

**Example:**

```bash
GCP_PROJECT_ID=my-project-123
GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcp-service-account.json
GCP_DISCOVERY_ZONES=us-central1-a,us-central1-b,europe-west1-b
```

## Performance Tuning

### High-Traffic Configuration

```bash
# API Server
API_PORT=3000
CLUSTER_WORKERS=4  # Number of Node.js cluster workers

# Databases
NEO4J_MAX_CONNECTION_POOL_SIZE=200
POSTGRES_MAX_CONNECTIONS=100

# Queue
QUEUE_CONCURRENCY=20
QUEUE_MAX_JOBS_PER_WORKER=3

# Discovery
DISCOVERY_CONCURRENCY=20
DISCOVERY_BATCH_SIZE=1000

# ETL
ETL_BATCH_SIZE=5000
ETL_CONCURRENCY=10

# Caching
REDIS_MAX_MEMORY=8gb
REDIS_EVICTION_POLICY=allkeys-lru
```

### Low-Resource Configuration

```bash
# API Server
CLUSTER_WORKERS=1

# Databases
NEO4J_MAX_CONNECTION_POOL_SIZE=10
POSTGRES_MAX_CONNECTIONS=10

# Queue
QUEUE_CONCURRENCY=2

# Discovery
DISCOVERY_CONCURRENCY=2
DISCOVERY_BATCH_SIZE=100

# ETL
ETL_BATCH_SIZE=500
ETL_CONCURRENCY=1
```

## Secrets Management

### Development (.env file)

```bash
# .env.development (DO NOT COMMIT)
NEO4J_PASSWORD=dev-password
POSTGRES_PASSWORD=dev-password
REDIS_PASSWORD=dev-password
JWT_SECRET=dev-jwt-secret-min-32-chars-long
```

### Production (Kubernetes Secrets)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cmdb-secrets
  namespace: cmdb
type: Opaque
stringData:
  neo4j-password: <secure-password>
  postgres-password: <secure-password>
  redis-password: <secure-password>
  jwt-secret: <secure-secret-min-32-chars>
  aws-access-key-id: <aws-key>
  aws-secret-access-key: <aws-secret>
  azure-client-secret: <azure-secret>
```

**Reference in Deployment:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  template:
    spec:
      containers:
      - name: api-server
        env:
        - name: NEO4J_PASSWORD
          valueFrom:
            secretKeyRef:
              name: cmdb-secrets
              key: neo4j-password
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: cmdb-secrets
              key: jwt-secret
```

## See Also

- [Configuration Guide](/guides/configuration)
- [Security Best Practices](/guides/security)
- [Deployment Guide](/deployment/overview)
- [Troubleshooting](/operations/troubleshooting)
