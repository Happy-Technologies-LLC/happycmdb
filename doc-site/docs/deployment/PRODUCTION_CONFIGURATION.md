# HappyCMDB - Production Configuration Guide

## Table of Contents

1. [Overview](#overview)
2. [Environment Configuration](#environment-configuration)
3. [Database Configuration](#database-configuration)
4. [Security Hardening](#security-hardening)
5. [Resource Limits](#resource-limits)
6. [Performance Tuning](#performance-tuning)
7. [High Availability](#high-availability)
8. [Monitoring & Observability](#monitoring--observability)
9. [Backup & Recovery](#backup--recovery)
10. [Deployment Checklist](#deployment-checklist)

---

## Overview

This guide provides comprehensive production configuration recommendations for HappyCMDB v2.0. It covers security, performance, scalability, and reliability considerations for enterprise deployments.

### Deployment Tiers

- **Small** (10-50 users, <10K CIs): Single-node deployment
- **Medium** (50-200 users, 10K-100K CIs): Multi-node with database replication
- **Large** (200+ users, 100K+ CIs): Full HA cluster with load balancing

---

## Environment Configuration

### Required Environment Variables

These variables MUST be set in production. See `.env.production.example` for a complete template.

#### Application Core

```bash
# CRITICAL: Must be set to 'production'
NODE_ENV=production

# Logging (info, warn, or error in production - never debug)
LOG_LEVEL=info

# API Server
API_PORT=3000
API_HOST=0.0.0.0
```

#### Authentication & Security

```bash
# CRITICAL: Generate strong secrets
# Use: openssl rand -base64 64
JWT_SECRET=<64-character-random-string>
JWT_EXPIRATION=24h

# CRITICAL: For encrypting credential storage
# Use: openssl rand -base64 64
ENCRYPTION_KEY=<64-character-random-string>

# Internal service bypass for service-to-service calls
# Use: openssl rand -base64 32
RATE_LIMIT_BYPASS_SECRET=<32-character-random-string>

# API key for internal authentication
# Use: openssl rand -base64 32
API_KEY=<32-character-random-string>
```

**Security Notes:**
- NEVER use example values in production
- Store secrets in a secrets manager (AWS Secrets Manager, Azure Key Vault, HashiCorp Vault)
- Rotate secrets regularly (90-day cycle recommended)
- Use different secrets for each environment

#### SSL/TLS Configuration

```bash
# CRITICAL: Enable SSL in production
SSL_ENABLED=true

# Nginx SSL Configuration
NGINX_SSL_ENABLED=true
NGINX_SSL_CERT_PATH=/etc/nginx/ssl/cert.pem
NGINX_SSL_KEY_PATH=/etc/nginx/ssl/key.pem
NGINX_SSL_CHAIN_PATH=/etc/nginx/ssl/chain.pem
NGINX_SSL_DHPARAM_PATH=/etc/nginx/ssl/dhparam.pem

# HSTS Configuration (force HTTPS)
NGINX_HSTS_MAX_AGE=31536000
NGINX_HSTS_INCLUDE_SUBDOMAINS=true
NGINX_HSTS_PRELOAD=true
```

**SSL Certificate Management:**
- Use Let's Encrypt for automated certificate renewal
- Generate strong DH parameters: `openssl dhparam -out dhparam.pem 4096`
- Enable OCSP stapling for performance
- Test SSL configuration: https://www.ssllabs.com/ssltest/

---

## Database Configuration

### Neo4j Graph Database

#### Production Settings

```bash
# Connection
NEO4J_URI=bolt://neo4j:7687  # Use neo4j+s:// for SSL
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<strong-random-password>
NEO4J_DATABASE=cmdb

# Connection Pool
NEO4J_MAX_CONNECTION_POOL_SIZE=100  # Small: 50, Medium: 100, Large: 200
NEO4J_CONNECTION_TIMEOUT=30000

# SSL/TLS (CRITICAL for production)
NEO4J_SSL_ENABLED=true
NEO4J_BOLT_TLS_LEVEL=REQUIRED
NEO4J_HTTPS_ENABLED=true
```

#### Docker Compose Configuration

```yaml
neo4j:
  environment:
    # Memory Configuration (adjust based on deployment tier)
    # Small: 2G heap, 1G pagecache
    # Medium: 4G heap, 2G pagecache
    # Large: 8G heap, 4G pagecache
    - NEO4J_dbms_memory_heap_initial__size=4G
    - NEO4J_dbms_memory_heap_max__size=4G
    - NEO4J_dbms_memory_pagecache_size=2G

    # Transaction Configuration
    - NEO4J_dbms_transaction_timeout=60s
    - NEO4J_dbms_transaction_concurrent_maximum=1000

    # Query Performance
    - NEO4J_dbms_query_cache__size=1000
    - NEO4J_cypher_min__replan__interval=10s

    # Security
    - NEO4J_dbms_security_auth__enabled=true
    - NEO4J_dbms_connector_bolt_tls__level=REQUIRED
```

**Memory Sizing Guidelines:**
- **Heap**: 25-50% of system RAM (max 31GB for optimal compressed oops)
- **Page Cache**: 50-75% of remaining RAM after heap
- **OS Reserve**: Minimum 1GB for OS operations

#### Performance Tuning

1. **Index Strategy**:
   ```cypher
   // Create indexes on frequently queried properties
   CREATE INDEX ci_name IF NOT EXISTS FOR (c:CI) ON (c.ci_name);
   CREATE INDEX ci_type IF NOT EXISTS FOR (c:CI) ON (c.ci_type);
   CREATE INDEX ci_environment IF NOT EXISTS FOR (c:CI) ON (c.environment);
   CREATE INDEX ci_external_id IF NOT EXISTS FOR (c:CI) ON (c.external_id);
   ```

2. **Query Optimization**:
   - Use `PROFILE` to analyze slow queries
   - Add indexes for frequently filtered properties
   - Limit result sets with `LIMIT` clauses
   - Use relationship direction hints

3. **Monitoring**:
   - Enable query logging: `NEO4J_dbms_logs_query_enabled=INFO`
   - Set slow query threshold: `NEO4J_dbms_logs_query_threshold=5s`

### PostgreSQL Configuration

#### Production Settings

```bash
# Connection
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DATABASE=cmdb
POSTGRES_USER=cmdb_user
POSTGRES_PASSWORD=<strong-random-password>
POSTGRES_MAX_CONNECTIONS=100  # Small: 50, Medium: 100, Large: 200

# SSL/TLS (CRITICAL for production)
POSTGRES_SSL_ENABLED=on
POSTGRES_SSL_MODE=require
POSTGRES_SSL_CERT_PATH=/ssl/server.crt
POSTGRES_SSL_KEY_PATH=/ssl/server.key
POSTGRES_SSL_CA_PATH=/ssl/ca.crt
```

#### Docker Compose Configuration

```yaml
postgres:
  command: >
    postgres
    -c shared_preload_libraries=timescaledb

    # Connection Settings
    -c max_connections=200
    -c superuser_reserved_connections=3

    # Memory Settings (adjust based on deployment tier)
    # Small: 256MB shared_buffers, 64MB work_mem
    # Medium: 2GB shared_buffers, 128MB work_mem
    # Large: 8GB shared_buffers, 256MB work_mem
    -c shared_buffers=2GB
    -c effective_cache_size=6GB
    -c maintenance_work_mem=512MB
    -c work_mem=128MB

    # Checkpoint Settings (reduce I/O spikes)
    -c checkpoint_completion_target=0.9
    -c checkpoint_timeout=15min
    -c max_wal_size=4GB
    -c min_wal_size=1GB

    # Query Planner
    -c random_page_cost=1.1
    -c effective_io_concurrency=200

    # Logging
    -c log_min_duration_statement=1000
    -c log_line_prefix='%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
    -c log_checkpoints=on
    -c log_connections=on
    -c log_disconnections=on
    -c log_lock_waits=on

    # SSL
    -c ssl=on
    -c ssl_cert_file=/ssl/server.crt
    -c ssl_key_file=/ssl/server.key
    -c ssl_ca_file=/ssl/ca.crt
```

**Memory Sizing Guidelines:**
- **shared_buffers**: 25% of system RAM (max 8GB)
- **effective_cache_size**: 50-75% of system RAM
- **work_mem**: Total RAM / max_connections / 2
- **maintenance_work_mem**: 5-10% of RAM (max 2GB)

#### Performance Tuning

1. **Index Strategy**:
   ```sql
   -- Monitor index usage
   SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read
   FROM pg_stat_user_indexes
   ORDER BY idx_scan ASC;

   -- Remove unused indexes (idx_scan = 0)
   -- Add indexes for slow queries
   ```

2. **Vacuum Configuration**:
   ```bash
   -c autovacuum=on
   -c autovacuum_max_workers=4
   -c autovacuum_naptime=10s
   -c autovacuum_vacuum_scale_factor=0.05
   -c autovacuum_analyze_scale_factor=0.02
   ```

3. **Connection Pooling**:
   - Use PgBouncer for connection pooling
   - Pool mode: `transaction` (recommended)
   - Max connections: 2-3x application pool size

### Redis Configuration

#### Production Settings

```bash
# Connection
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=<strong-random-password>
REDIS_DB=0
REDIS_KEY_PREFIX=cmdb:

# SSL/TLS (CRITICAL for production)
REDIS_TLS_ENABLED=true
REDIS_TLS_PORT=6380
REDIS_TLS_AUTH_CLIENTS=yes
```

#### Docker Compose Configuration

```yaml
redis:
  command: >
    redis-server

    # Memory Management
    --maxmemory 2gb
    --maxmemory-policy allkeys-lru

    # Persistence (AOF for durability)
    --appendonly yes
    --appendfsync everysec
    --auto-aof-rewrite-percentage 100
    --auto-aof-rewrite-min-size 64mb

    # Performance
    --hz 10
    --tcp-backlog 511
    --timeout 300

    # Security
    --requirepass <strong-random-password>
    --rename-command CONFIG ""
    --rename-command FLUSHDB ""
    --rename-command FLUSHALL ""

    # SSL/TLS
    --tls-port 6380
    --tls-cert-file /ssl/redis.crt
    --tls-key-file /ssl/redis.key
    --tls-ca-cert-file /ssl/ca.crt
    --tls-auth-clients yes
```

**Memory Sizing Guidelines:**
- **Small**: 512MB (cache only)
- **Medium**: 2GB (cache + queues)
- **Large**: 4GB+ (high-volume queues)

**Eviction Policy:**
- `allkeys-lru`: Evict any key using LRU (recommended for cache)
- `volatile-lru`: Evict keys with TTL using LRU (if using mixed workload)

---

## Security Hardening

### SSL/TLS Certificates

#### Generate Self-Signed Certificates (Development/Testing)

```bash
# Create SSL directory
mkdir -p infrastructure/docker/ssl/{nginx,neo4j,postgres,redis}

# Generate CA certificate
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout infrastructure/docker/ssl/ca.key \
  -out infrastructure/docker/ssl/ca.crt \
  -days 3650 -subj "/CN=HappyCMDB-CA"

# Generate Nginx certificate
openssl req -newkey rsa:4096 -nodes \
  -keyout infrastructure/docker/ssl/nginx/key.pem \
  -out infrastructure/docker/ssl/nginx/csr.pem \
  -subj "/CN=happycmdb.example.com"

openssl x509 -req -in infrastructure/docker/ssl/nginx/csr.pem \
  -CA infrastructure/docker/ssl/ca.crt \
  -CAkey infrastructure/docker/ssl/ca.key \
  -CAcreateserial \
  -out infrastructure/docker/ssl/nginx/cert.pem \
  -days 365

# Generate DH parameters (CRITICAL for security)
openssl dhparam -out infrastructure/docker/ssl/nginx/dhparam.pem 4096
```

#### Production Certificate Setup (Let's Encrypt)

```bash
# Install certbot
sudo apt-get install certbot

# Generate certificate
sudo certbot certonly --standalone \
  -d happycmdb.example.com \
  --email admin@example.com \
  --agree-tos

# Copy certificates to Docker volume
cp /etc/letsencrypt/live/happycmdb.example.com/fullchain.pem \
   infrastructure/docker/ssl/nginx/cert.pem
cp /etc/letsencrypt/live/happycmdb.example.com/privkey.pem \
   infrastructure/docker/ssl/nginx/key.pem
cp /etc/letsencrypt/live/happycmdb.example.com/chain.pem \
   infrastructure/docker/ssl/nginx/chain.pem

# Set up auto-renewal
echo "0 0 1 * * certbot renew --quiet && docker restart cmdb-web-ui" | sudo crontab -
```

### Network Security

#### Firewall Rules (iptables)

```bash
# Allow SSH
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# Allow HTTP/HTTPS
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# Block direct database access (allow only from Docker network)
iptables -A INPUT -p tcp --dport 7687 -j DROP  # Neo4j
iptables -A INPUT -p tcp --dport 5432 -j DROP  # PostgreSQL
iptables -A INPUT -p tcp --dport 6379 -j DROP  # Redis

# Allow established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Drop all other inbound traffic
iptables -A INPUT -j DROP
```

#### Docker Network Isolation

```yaml
networks:
  cmdb_network:
    driver: bridge
    internal: false  # Set to true for complete isolation (requires bastion host)
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### Application Security

#### API Rate Limiting (Production Settings)

```bash
# Enable rate limiting
RATE_LIMIT_ENABLED=true

# REST API (per hour per IP)
RATE_LIMIT_REST_MAX=5000
RATE_LIMIT_REST_WINDOW_MS=3600000

# GraphQL (per hour per IP)
RATE_LIMIT_GRAPHQL_MAX=2000
RATE_LIMIT_GRAPHQL_WINDOW_MS=3600000

# Authentication (prevent brute force)
RATE_LIMIT_AUTH_MAX=10
RATE_LIMIT_AUTH_WINDOW_MS=3600000

# Admin endpoints (stricter limits)
RATE_LIMIT_ADMIN_MAX=500
RATE_LIMIT_ADMIN_WINDOW_MS=3600000
```

#### Security Headers (Nginx)

Already configured in `infrastructure/docker/nginx.conf`:
- HSTS (Strict-Transport-Security)
- CSP (Content-Security-Policy)
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- X-XSS-Protection: 1; mode=block
- Referrer-Policy: strict-origin-when-cross-origin

### Secrets Management

#### AWS Secrets Manager

```bash
# Store secrets in AWS Secrets Manager
aws secretsmanager create-secret \
  --name happycmdb/production/jwt-secret \
  --secret-string "<jwt-secret>"

# Retrieve at runtime
export JWT_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id happycmdb/production/jwt-secret \
  --query SecretString --output text)
```

#### HashiCorp Vault

```bash
# Write secrets to Vault
vault kv put secret/happycmdb/production \
  jwt_secret="<jwt-secret>" \
  encryption_key="<encryption-key>" \
  neo4j_password="<neo4j-password>"

# Read at runtime
export JWT_SECRET=$(vault kv get -field=jwt_secret secret/happycmdb/production)
```

---

## Resource Limits

### Docker Resource Constraints

#### Small Deployment (10-50 users, <10K CIs)

```yaml
services:
  neo4j:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '1'
          memory: 2G

  postgres:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  redis:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M

  api-server:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  web-ui:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

#### Medium Deployment (50-200 users, 10K-100K CIs)

```yaml
services:
  neo4j:
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 8G
        reservations:
          cpus: '2'
          memory: 4G

  postgres:
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 4G
        reservations:
          cpus: '2'
          memory: 2G

  redis:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  api-server:
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 4G
        reservations:
          cpus: '2'
          memory: 2G

  web-ui:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 1G
        reservations:
          cpus: '1'
          memory: 512M
```

#### Large Deployment (200+ users, 100K+ CIs)

```yaml
services:
  neo4j:
    deploy:
      resources:
        limits:
          cpus: '8'
          memory: 16G
        reservations:
          cpus: '4'
          memory: 8G

  postgres:
    deploy:
      resources:
        limits:
          cpus: '8'
          memory: 8G
        reservations:
          cpus: '4'
          memory: 4G

  redis:
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 4G
        reservations:
          cpus: '2'
          memory: 2G

  api-server:
    deploy:
      resources:
        limits:
          cpus: '8'
          memory: 8G
        reservations:
          cpus: '4'
          memory: 4G

  web-ui:
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 2G
        reservations:
          cpus: '2'
          memory: 1G
```

### Disk Space Requirements

| Component | Small | Medium | Large | Notes |
|-----------|-------|--------|-------|-------|
| Neo4j Data | 10GB | 50GB | 200GB | Graph database storage |
| PostgreSQL Data | 5GB | 20GB | 100GB | Relational data + time-series |
| Redis Data | 1GB | 5GB | 10GB | Cache + job queues |
| Logs | 5GB | 10GB | 20GB | Application + access logs |
| Backups | 20GB | 100GB | 500GB | 7-day retention |
| **Total** | **41GB** | **185GB** | **830GB** | Recommended disk size |

**Recommendations:**
- Use SSD for database volumes (NVMe preferred)
- Separate volumes for data, logs, and backups
- Enable disk monitoring with alerts at 80% usage

---

## Performance Tuning

### Application Layer

#### Node.js Settings

```bash
# Increase event loop pool size
UV_THREADPOOL_SIZE=128

# Enable HTTP/2
NODE_OPTIONS="--max-old-space-size=4096 --expose-gc"
```

#### API Server Concurrency

```typescript
// packages/api-server/src/config/server.ts
export const serverConfig = {
  // Worker processes (for cluster mode)
  workers: process.env.NODE_ENV === 'production' ? os.cpus().length : 1,

  // Request timeout
  timeout: 60000,

  // Keep-alive timeout
  keepAliveTimeout: 65000,

  // Max header size
  maxHeaderSize: 16384,
};
```

### Database Optimization

#### Neo4j Query Performance

1. **Use EXPLAIN and PROFILE**:
   ```cypher
   PROFILE
   MATCH (c:CI)-[:DEPENDS_ON]->(d:CI)
   WHERE c.environment = 'production'
   RETURN c, d
   LIMIT 100;
   ```

2. **Index Optimization**:
   ```cypher
   // Check index usage
   CALL db.indexes();

   // Create composite indexes for common queries
   CREATE INDEX ci_env_type IF NOT EXISTS
   FOR (c:CI) ON (c.environment, c.ci_type);
   ```

3. **Query Optimization**:
   - Use `WITH` for query chaining
   - Filter early with `WHERE`
   - Use `LIMIT` to restrict results
   - Avoid `OPTIONAL MATCH` when possible

#### PostgreSQL Query Performance

1. **Analyze Slow Queries**:
   ```sql
   -- Enable pg_stat_statements
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

   -- Find slow queries
   SELECT query, calls, mean_exec_time, max_exec_time
   FROM pg_stat_statements
   ORDER BY mean_exec_time DESC
   LIMIT 20;
   ```

2. **Index Recommendations**:
   ```sql
   -- Missing index detector
   SELECT schemaname, tablename, attname, n_distinct, correlation
   FROM pg_stats
   WHERE schemaname = 'public'
   AND n_distinct > 100
   AND correlation < 0.5
   ORDER BY n_distinct DESC;
   ```

3. **Vacuum and Analyze**:
   ```sql
   -- Run during maintenance window
   VACUUM ANALYZE;

   -- Monitor bloat
   SELECT schemaname, tablename,
          pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
   FROM pg_tables
   WHERE schemaname = 'public'
   ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
   ```

### Caching Strategy

#### Redis Caching

```bash
# Cache configuration
CACHE_TTL_SHORT=300      # 5 minutes (frequently changing data)
CACHE_TTL_MEDIUM=3600    # 1 hour (semi-static data)
CACHE_TTL_LONG=86400     # 24 hours (static data)

# Cache key patterns
# cmdb:ci:<ci_id>                 (individual CI)
# cmdb:ci:list:<hash>             (CI list queries)
# cmdb:relationships:<ci_id>      (CI relationships)
# cmdb:discovery:status:<job_id>  (discovery job status)
```

#### Application-Level Caching

```typescript
// Use in-memory cache for hot data
import NodeCache from 'node-cache';

const cache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
  useClones: false,
});
```

---

## High Availability

### Database Replication

#### Neo4j Cluster (Enterprise Edition Required)

```yaml
# neo4j-core-1.yml
services:
  neo4j-core-1:
    image: neo4j:5.15-enterprise
    environment:
      - NEO4J_ACCEPT_LICENSE_AGREEMENT=yes
      - NEO4J_dbms_mode=CORE
      - NEO4J_causal__clustering_initial__discovery__members=neo4j-core-1:5000,neo4j-core-2:5000,neo4j-core-3:5000
      - NEO4J_causal__clustering_minimum__core__cluster__size__at__formation=3

# neo4j-core-2.yml (similar configuration)
# neo4j-core-3.yml (similar configuration)
```

**Note**: Neo4j Community Edition does not support clustering. For HA, use:
- Backup/restore procedures
- Standby replicas (manual failover)
- Or upgrade to Neo4j Enterprise

#### PostgreSQL Streaming Replication

```bash
# Primary server (postgresql.conf)
wal_level = replica
max_wal_senders = 10
wal_keep_size = 1GB
synchronous_commit = on

# Standby server (recovery.conf)
primary_conninfo = 'host=postgres-primary port=5432 user=replicator password=<password>'
promote_trigger_file = '/tmp/promote_standby'
```

**Setup Script**: `infrastructure/scripts/postgres-primary-setup.sh`

#### Redis Sentinel (HA)

```yaml
# Redis master
redis-master:
  image: redis:7.2-alpine
  command: redis-server --requirepass <password>

# Redis sentinel
redis-sentinel:
  image: redis:7.2-alpine
  command: >
    redis-sentinel --sentinel monitor cmdb-master redis-master 6379 2
                   --sentinel down-after-milliseconds cmdb-master 5000
                   --sentinel parallel-syncs cmdb-master 1
                   --sentinel failover-timeout cmdb-master 10000
```

### Load Balancing

#### Nginx Load Balancer

```nginx
upstream api_backend {
  least_conn;  # Load balancing method

  server api-server-1:3000 max_fails=3 fail_timeout=30s;
  server api-server-2:3000 max_fails=3 fail_timeout=30s;
  server api-server-3:3000 max_fails=3 fail_timeout=30s;

  keepalive 32;
}

server {
  listen 443 ssl http2;

  location /api/ {
    proxy_pass http://api_backend;
    proxy_next_upstream error timeout http_500 http_502 http_503;
    proxy_connect_timeout 5s;
    proxy_read_timeout 60s;
  }
}
```

### Health Checks

#### API Server Health Endpoint

```bash
# Kubernetes liveness probe
livenessProbe:
  httpGet:
    path: /api/v1/cmdb-health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3

# Kubernetes readiness probe
readinessProbe:
  httpGet:
    path: /api/v1/cmdb-health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  successThreshold: 1
  failureThreshold: 3
```

---

## Monitoring & Observability

### Metrics Collection

#### Prometheus Configuration

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'api-server'
    static_configs:
      - targets: ['api-server:9090']

  - job_name: 'neo4j'
    static_configs:
      - targets: ['neo4j:2004']

  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres-exporter:9187']

  - job_name: 'redis'
    static_configs:
      - targets: ['redis-exporter:9121']
```

#### Application Metrics

```bash
# Enable metrics endpoint
METRICS_ENABLED=true
METRICS_PORT=9090

# Metrics exposed:
# - http_requests_total
# - http_request_duration_seconds
# - discovery_jobs_total
# - discovery_duration_seconds
# - database_query_duration_seconds
# - cache_hit_rate
```

### Logging

#### Centralized Logging (ELK Stack)

```yaml
# docker-compose.logging.yml
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    volumes:
      - es_data:/usr/share/elasticsearch/data

  logstash:
    image: docker.elastic.co/logstash/logstash:8.11.0
    volumes:
      - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf

  kibana:
    image: docker.elastic.co/kibana/kibana:8.11.0
    ports:
      - "5601:5601"
```

#### Log Aggregation

```bash
# Application logs -> JSON format
LOG_FORMAT=json

# Log levels by environment
LOG_LEVEL=info  # production
LOG_LEVEL=debug  # development

# Audit logging
AUDIT_LOG_ENABLED=true
```

### Alerting

#### Prometheus Alerts

```yaml
# alerts.yml
groups:
  - name: HappyCMDB
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"

      - alert: DatabaseDown
        expr: up{job="neo4j"} == 0 or up{job="postgres"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database is down"

      - alert: HighMemoryUsage
        expr: container_memory_usage_bytes / container_spec_memory_limit_bytes > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container memory usage >90%"
```

---

## Backup & Recovery

### Automated Backup Configuration

```bash
# Backup directory (host path)
BACKUP_DIR=/var/backups/happycmdb

# Retention policy
BACKUP_RETENTION_DAILY=7
BACKUP_RETENTION_WEEKLY=4
BACKUP_RETENTION_MONTHLY=12

# Cloud storage upload
BACKUP_UPLOAD_ENABLED=true
BACKUP_STORAGE_TYPE=s3  # or 'azure'

# AWS S3 Configuration
BACKUP_S3_BUCKET=happycmdb-backups-prod
BACKUP_S3_PREFIX=production
AWS_ACCESS_KEY_ID=<aws-access-key>
AWS_SECRET_ACCESS_KEY=<aws-secret-key>
AWS_DEFAULT_REGION=us-east-1

# Notifications (Slack webhook)
BACKUP_NOTIFICATION_ENABLED=true
BACKUP_NOTIFICATION_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### Backup Scripts

**Location**: `/infrastructure/scripts/`

1. **backup-all.sh** - Full system backup
2. **backup-neo4j.sh** - Neo4j database backup
3. **backup-postgres.sh** - PostgreSQL backup
4. **restore-neo4j.sh** - Neo4j restore
5. **restore-postgres.sh** - PostgreSQL restore
6. **backup-health-check.sh** - Verify backup integrity

### Backup Schedule (Cron)

```bash
# Daily backup at 2 AM
0 2 * * * /path/to/happycmdb/infrastructure/scripts/backup-all.sh

# Weekly backup verification
0 3 * * 0 /path/to/happycmdb/infrastructure/scripts/backup-health-check.sh
```

### Recovery Testing

**Quarterly Recovery Drill Checklist:**
1. Restore backups to test environment
2. Verify data integrity
3. Test application functionality
4. Document recovery time
5. Update runbooks with findings

---

## Deployment Checklist

### Pre-Deployment

- [ ] All environment variables set in `.env.production`
- [ ] Strong secrets generated (JWT, encryption keys)
- [ ] SSL certificates obtained and configured
- [ ] DH parameters generated (4096-bit)
- [ ] Database passwords changed from defaults
- [ ] Firewall rules configured
- [ ] Backup storage configured (S3/Azure)
- [ ] Monitoring dashboards configured (Grafana)
- [ ] Alerting rules configured (Prometheus)
- [ ] Log aggregation configured (ELK/Splunk)
- [ ] DNS records configured
- [ ] Load balancer configured (if multi-node)

### Security Hardening

- [ ] SSL/TLS enabled for all services
- [ ] HSTS enabled with preload
- [ ] Rate limiting enabled
- [ ] API keys rotated
- [ ] Default credentials changed
- [ ] Unnecessary ports closed
- [ ] Security headers configured
- [ ] CSP policy configured
- [ ] Secrets stored in vault (not .env)
- [ ] Audit logging enabled

### Performance Tuning

- [ ] Database memory configured for workload
- [ ] Connection pools sized appropriately
- [ ] Indexes created on frequently queried fields
- [ ] Query performance tested
- [ ] Cache TTL configured
- [ ] Resource limits set (CPU/memory)
- [ ] Auto-scaling configured (if cloud)

### High Availability

- [ ] Database replication configured
- [ ] Redis Sentinel configured (if HA)
- [ ] Load balancer health checks configured
- [ ] Failover procedures documented
- [ ] Backup/restore tested
- [ ] Recovery time objective (RTO) documented
- [ ] Recovery point objective (RPO) documented

### Monitoring

- [ ] Prometheus scraping configured
- [ ] Grafana dashboards imported
- [ ] Alert rules configured
- [ ] Notification channels configured
- [ ] Log retention configured
- [ ] Metrics retention configured
- [ ] Disk usage monitoring enabled
- [ ] Uptime monitoring configured

### Post-Deployment

- [ ] SSL configuration tested (ssllabs.com)
- [ ] API endpoints tested
- [ ] Authentication tested
- [ ] Discovery jobs tested
- [ ] Backup job tested
- [ ] Recovery procedure tested
- [ ] Performance benchmarks documented
- [ ] Runbooks updated
- [ ] Team trained on operations
- [ ] Incident response plan reviewed

---

## Scaling Considerations

### Vertical Scaling (Scale Up)

**When to scale up:**
- Single-node deployment reaching 80% CPU/memory
- Query response times degrading
- Connection pool exhaustion

**Recommended upgrades:**
| Tier | CPU | RAM | Disk | Network |
|------|-----|-----|------|---------|
| Small → Medium | 4 → 8 cores | 16GB → 32GB | SSD | 1Gbps → 10Gbps |
| Medium → Large | 8 → 16 cores | 32GB → 64GB | NVMe | 10Gbps → 25Gbps |

### Horizontal Scaling (Scale Out)

**When to scale out:**
- Read-heavy workloads (add read replicas)
- High discovery job volume (add more workers)
- Geographic distribution (multi-region deployment)

**Scaling strategy:**
1. **API Server**: Stateless, add instances behind load balancer
2. **Neo4j**: Add read replicas (Enterprise) or sharding
3. **PostgreSQL**: Streaming replication (read replicas)
4. **Redis**: Cluster mode or Sentinel
5. **Discovery Workers**: Add agent nodes

### Auto-Scaling (Kubernetes)

```yaml
# HorizontalPodAutoscaler for API server
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

---

## Troubleshooting

### Common Issues

#### High Memory Usage (Neo4j)

**Symptoms**: Container OOM, slow queries
**Solution**:
1. Reduce heap size: `NEO4J_dbms_memory_heap_max__size=2G`
2. Reduce page cache: `NEO4J_dbms_memory_pagecache_size=1G`
3. Add memory to host or scale vertically

#### Connection Pool Exhaustion (PostgreSQL)

**Symptoms**: "too many connections" errors
**Solution**:
1. Increase max_connections: `-c max_connections=200`
2. Implement connection pooling (PgBouncer)
3. Review application connection leaks

#### Redis Memory Eviction

**Symptoms**: Cache misses, performance degradation
**Solution**:
1. Increase memory: `--maxmemory 4gb`
2. Review eviction policy: `--maxmemory-policy allkeys-lru`
3. Optimize cache TTL values

---

## Support & Resources

- **Documentation**: http://localhost:8080 (when running)
- **GitHub Issues**: https://github.com/happycmdb/cmdb/issues
- **Community**: https://community.happycmdb.io

---

**Last Updated**: 2025-10-19
**Version**: 2.0.0
