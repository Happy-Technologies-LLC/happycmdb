# HappyCMDB - Production Deployment Checklist

## Quick Reference Guide

This checklist ensures all production readiness requirements are met before deploying HappyCMDB to production.

**Related Documents:**
- [Production Configuration Guide](./PRODUCTION_CONFIGURATION.md) - Comprehensive configuration details
- `.env.production.example` - Production environment template
- `.env.staging.example` - Staging environment template
- `infrastructure/scripts/validate-config.sh` - Configuration validation tool

---

## Pre-Deployment Checklist

### 1. Environment Configuration

- [ ] Copy `.env.production.example` to `.env.production`
- [ ] Generate all required secrets (see instructions below)
- [ ] Set `NODE_ENV=production`
- [ ] Set appropriate `LOG_LEVEL` (info, warn, or error)
- [ ] Configure API host and port settings
- [ ] **Run validation**: `./infrastructure/scripts/validate-config.sh production .env.production`

#### Generate Secrets

```bash
# JWT Secret (64 characters)
openssl rand -base64 64

# Encryption Key (64 characters)
openssl rand -base64 64

# API Key (32 characters)
openssl rand -base64 32

# Rate Limit Bypass Secret (32 characters)
openssl rand -base64 32

# Database Passwords (32 characters each)
openssl rand -base64 32  # Neo4j
openssl rand -base64 32  # PostgreSQL
openssl rand -base64 32  # Redis
openssl rand -base64 32  # Grafana
```

**CRITICAL**: Store all secrets in a secrets manager (AWS Secrets Manager, Azure Key Vault, HashiCorp Vault).

---

### 2. SSL/TLS Certificates (CRITICAL for Production)

#### Web UI (Nginx) Certificates

- [ ] Obtain SSL certificates from trusted CA (Let's Encrypt recommended)
- [ ] Generate DH parameters: `openssl dhparam -out dhparam.pem 4096`
- [ ] Place certificates in `infrastructure/docker/ssl/nginx/`:
  - `cert.pem` - Certificate file
  - `key.pem` - Private key
  - `chain.pem` - Certificate chain
  - `dhparam.pem` - DH parameters
- [ ] Set certificate paths in `.env.production`
- [ ] Enable SSL: `SSL_ENABLED=true`
- [ ] Enable HSTS: `NGINX_HSTS_PRELOAD=true`
- [ ] Verify SSL configuration: https://www.ssllabs.com/ssltest/

#### Database Encryption (PostgreSQL & Neo4j)

**CRITICAL**: Database encryption is MANDATORY for production to protect sensitive CMDB data in transit.

- [ ] **Generate database SSL certificates**:
  ```bash
  cd infrastructure/docker/ssl
  ./generate-self-signed-certs.sh  # For development/testing
  # OR use Let's Encrypt for production (recommended)
  ```

- [ ] **PostgreSQL SSL Configuration**:
  - [ ] Certificates placed in `infrastructure/docker/ssl/postgres/`:
    - `server.crt` - PostgreSQL certificate
    - `server.key` - PostgreSQL private key (permissions: 600)
    - `ca.crt` - CA certificate
  - [ ] Enable SSL in `.env.production`:
    ```bash
    POSTGRES_SSL_ENABLED=on
    POSTGRES_SSL_MODE=verify-full  # REQUIRED for production
    ```
  - [ ] Verify PostgreSQL SSL:
    ```bash
    docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
      -c "SHOW ssl;" \
      -c "SELECT * FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
    ```

- [ ] **Neo4j SSL Configuration**:
  - [ ] Certificates placed in `infrastructure/docker/ssl/neo4j/`:
    - `neo4j.cert` - Neo4j certificate
    - `neo4j.key` - Neo4j private key (permissions: 600)
    - `ca.crt` - CA certificate
  - [ ] Enable SSL in `.env.production`:
    ```bash
    NEO4J_SSL_ENABLED=true
    NEO4J_BOLT_TLS_LEVEL=REQUIRED  # REQUIRED for production
    NEO4J_ENCRYPTION=true
    NEO4J_SSL_TRUST_STRATEGY=TRUST_SYSTEM_CA_SIGNED_CERTIFICATES
    ```
  - [ ] Verify Neo4j SSL:
    ```bash
    docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
      "CALL dbms.listConfig() YIELD name, value WHERE name CONTAINS 'ssl' RETURN name, value;"
    ```

- [ ] **Run SSL Validation Script**:
  ```bash
  ./infrastructure/scripts/validate-ssl-config.sh --env production
  ```
  - Must pass all checks before production deployment
  - Review and fix any warnings or failures
  - See [Certificate Management Guide](../security/CERTIFICATE_MANAGEMENT.md) for troubleshooting

- [ ] **Certificate Monitoring**:
  - [ ] Configure Prometheus alerts for certificate expiration (14 days warning, 7 days critical)
  - [ ] Set up automated renewal cron job (Let's Encrypt: runs daily at 2 AM)
  - [ ] Document certificate rotation procedures
  - [ ] Test certificate renewal process in staging environment

**Reference Documentation**: See `docs/security/CERTIFICATE_MANAGEMENT.md` for complete certificate management procedures.

#### Let's Encrypt Setup

```bash
# Install certbot
sudo apt-get install certbot

# Generate certificate
sudo certbot certonly --standalone \
  -d happycmdb.example.com \
  --email admin@example.com \
  --agree-tos

# Copy to Docker volume
cp /etc/letsencrypt/live/happycmdb.example.com/fullchain.pem \
   infrastructure/docker/ssl/nginx/cert.pem
cp /etc/letsencrypt/live/happycmdb.example.com/privkey.pem \
   infrastructure/docker/ssl/nginx/key.pem
cp /etc/letsencrypt/live/happycmdb.example.com/chain.pem \
   infrastructure/docker/ssl/nginx/chain.pem

# Set up auto-renewal
echo "0 0 1 * * certbot renew --quiet && docker restart cmdb-web-ui" | sudo crontab -
```

---

### 3. Database Configuration

#### Neo4j

- [ ] Set strong password (min 32 characters)
- [ ] Enable SSL/TLS: `NEO4J_SSL_ENABLED=true`
- [ ] Set TLS level to REQUIRED: `NEO4J_BOLT_TLS_LEVEL=REQUIRED`
- [ ] Configure memory based on deployment tier:
  - Small: 2G heap, 1G pagecache
  - Medium: 4G heap, 2G pagecache
  - Large: 8G heap, 4G pagecache
- [ ] Set connection pool size: `NEO4J_MAX_CONNECTION_POOL_SIZE=100`
- [ ] Enable query logging for slow queries
- [ ] Create indexes on frequently queried fields

#### PostgreSQL

- [ ] Set strong password (min 32 characters)
- [ ] Enable SSL: `POSTGRES_SSL_ENABLED=on`
- [ ] Set SSL mode to require: `POSTGRES_SSL_MODE=require`
- [ ] Configure memory based on deployment tier:
  - Small: 1GB shared_buffers, 64MB work_mem
  - Medium: 2GB shared_buffers, 128MB work_mem
  - Large: 8GB shared_buffers, 256MB work_mem
- [ ] Set max_connections appropriately (100-200)
- [ ] Enable autovacuum
- [ ] Configure WAL settings for replication (if HA)
- [ ] Enable slow query logging (>1000ms)

#### Redis

- [ ] Set strong password (recommended for production)
- [ ] Enable TLS: `REDIS_TLS_ENABLED=true` (recommended)
- [ ] Configure memory limit (2GB-4GB)
- [ ] Set eviction policy: `allkeys-lru`
- [ ] Enable AOF persistence
- [ ] Configure maxclients limit
- [ ] Enable slow log

---

### 4. Security Hardening

- [ ] Change all default passwords
- [ ] Enable rate limiting: `RATE_LIMIT_ENABLED=true`
- [ ] Configure rate limits for production:
  - REST API: 5000/hour
  - GraphQL: 2000/hour
  - Auth: 10/hour (prevent brute force)
- [ ] Enable audit logging: `AUDIT_LOG_ENABLED=true`
- [ ] Configure firewall rules (see below)
- [ ] Disable anonymous Grafana access: `GRAFANA_ANONYMOUS_ENABLED=false`
- [ ] Enable all security headers (already configured in nginx.conf)
- [ ] Review and restrict API keys/credentials

#### Firewall Rules (iptables)

```bash
# Allow SSH
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# Allow HTTP/HTTPS
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT

# Block direct database access
iptables -A INPUT -p tcp --dport 7687 -j DROP  # Neo4j
iptables -A INPUT -p tcp --dport 5432 -j DROP  # PostgreSQL
iptables -A INPUT -p tcp --dport 6379 -j DROP  # Redis

# Allow established connections
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Drop all other inbound traffic
iptables -A INPUT -j DROP

# Save rules
iptables-save > /etc/iptables/rules.v4
```

---

### 5. Backup Configuration

- [ ] Set backup directory: `BACKUP_DIR=/var/backups/happycmdb`
- [ ] Configure retention policy:
  - Daily: 7 backups
  - Weekly: 4 backups
  - Monthly: 12 backups
- [ ] Enable cloud backup upload: `BACKUP_UPLOAD_ENABLED=true`
- [ ] Configure S3 or Azure storage credentials
- [ ] Enable backup notifications: `BACKUP_NOTIFICATION_ENABLED=true`
- [ ] Configure Slack/Teams webhook for alerts
- [ ] Test backup and restore procedures
- [ ] Schedule automated backups (cron):

```bash
# Daily backup at 2 AM
0 2 * * * /path/to/happycmdb/infrastructure/scripts/backup-all.sh

# Weekly backup verification
0 3 * * 0 /path/to/happycmdb/infrastructure/scripts/backup-health-check.sh
```

---

### 6. Monitoring & Observability

- [ ] Enable metrics: `METRICS_ENABLED=true`
- [ ] Configure metrics port: `METRICS_PORT=9090`
- [ ] Enable tracing (optional): `TRACING_ENABLED=true`
- [ ] Configure Grafana dashboards
- [ ] Set up Prometheus scraping
- [ ] Configure alerting rules:
  - High error rate (>5%)
  - Database down
  - High memory usage (>90%)
  - Disk space low (<15%)
  - Backup failures
- [ ] Configure notification channels (Slack, PagerDuty, email)
- [ ] Set up uptime monitoring (external)
- [ ] Enable centralized logging (ELK, Splunk, CloudWatch)

#### Import Grafana Dashboards

```bash
# Dashboards are auto-provisioned from:
monitoring/grafana/dashboards/

# Access Grafana:
# URL: http://localhost:3001 (or configured GRAFANA_PORT)
# User: admin
# Password: ${GRAFANA_ADMIN_PASSWORD}
```

---

### 7. Resource Limits

- [ ] Configure Docker resource limits based on deployment tier
- [ ] Set appropriate CPU limits (see Production Configuration Guide)
- [ ] Set appropriate memory limits (see Production Configuration Guide)
- [ ] Allocate sufficient disk space:
  - Small: 50GB minimum
  - Medium: 200GB minimum
  - Large: 1TB minimum
- [ ] Use SSD or NVMe storage for databases
- [ ] Separate volumes for data, logs, and backups

---

### 8. High Availability (Optional)

- [ ] Configure database replication:
  - Neo4j clustering (Enterprise only)
  - PostgreSQL streaming replication
  - Redis Sentinel
- [ ] Set up load balancer (Nginx, HAProxy, ALB)
- [ ] Configure health checks
- [ ] Test failover procedures
- [ ] Document RTO (Recovery Time Objective)
- [ ] Document RPO (Recovery Point Objective)
- [ ] Create runbooks for common incidents

---

### 9. Network Configuration

- [ ] Configure DNS records (A, CNAME)
- [ ] Set up load balancer (if multi-node)
- [ ] Configure CDN (optional, for static assets)
- [ ] Enable DDoS protection (Cloudflare, AWS Shield)
- [ ] Configure VPN/bastion host for internal access
- [ ] Whitelist trusted IPs (if applicable)
- [ ] Set up network segmentation (DMZ, backend)

---

### 10. Testing & Validation

- [ ] **Run configuration validation**: `./infrastructure/scripts/validate-config.sh production .env.production`
- [ ] Test SSL configuration: https://www.ssllabs.com/ssltest/
- [ ] Test API endpoints:
  ```bash
  curl -k https://happycmdb.example.com/api/v1/cmdb-health
  ```
- [ ] Test authentication:
  ```bash
  curl -X POST https://happycmdb.example.com/api/v1/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"password"}'
  ```
- [ ] Test database connectivity (from containers)
- [ ] Test discovery jobs
- [ ] Test backup and restore procedures
- [ ] Load test API (recommended: k6, Artillery, JMeter)
- [ ] Verify rate limiting works
- [ ] Check monitoring dashboards
- [ ] Verify alerts are firing correctly

---

### 11. Documentation

- [ ] Document production architecture
- [ ] Create incident response runbooks
- [ ] Document backup and restore procedures
- [ ] Document deployment process
- [ ] Document rollback procedures
- [ ] Create operational procedures:
  - Adding new users
  - Rotating secrets
  - Scaling resources
  - Database maintenance
- [ ] Train operations team
- [ ] Create on-call rotation schedule

---

## Deployment Steps

### Step 1: Prepare Environment

```bash
# Clone repository
git clone https://github.com/your-org/happycmdb.git
cd happycmdb

# Checkout production branch/tag
git checkout v2.0.0

# Create production environment file
cp .env.production.example .env.production

# Edit .env.production with your values
nano .env.production
```

### Step 2: Generate Secrets

```bash
# Generate all required secrets
./infrastructure/scripts/generate-secrets.sh

# Store secrets in secrets manager (AWS/Azure/Vault)
# Update .env.production with secret references
```

### Step 3: Configure SSL Certificates

```bash
# Generate DH parameters (takes 10-30 minutes)
openssl dhparam -out infrastructure/docker/ssl/nginx/dhparam.pem 4096

# Obtain Let's Encrypt certificates
sudo certbot certonly --standalone -d happycmdb.example.com

# Copy certificates to Docker volume
./infrastructure/scripts/setup-ssl.sh
```

### Step 4: Validate Configuration

```bash
# Run validation script
./infrastructure/scripts/validate-config.sh production .env.production

# Check for errors and warnings
# Fix any issues before proceeding
```

### Step 5: Build and Deploy

```bash
# Build Docker images
docker-compose -f infrastructure/docker/docker-compose.yml build

# Start services
./deploy.sh

# Or manually:
docker-compose -f infrastructure/docker/docker-compose.yml up -d
```

### Step 6: Initialize Databases

```bash
# Wait for databases to be ready (30-60 seconds)
docker-compose -f infrastructure/docker/docker-compose.yml logs -f neo4j postgres

# Run database migrations
docker exec cmdb-api-server npm run db:migrate

# (Optional) Seed test data
# docker exec cmdb-api-server npm run db:seed
```

### Step 7: Verify Deployment

```bash
# Check service health
curl -k https://happycmdb.example.com/api/v1/cmdb-health

# Check Docker container status
docker-compose -f infrastructure/docker/docker-compose.yml ps

# Check logs for errors
docker-compose -f infrastructure/docker/docker-compose.yml logs --tail=100

# Access Grafana dashboards
# URL: https://grafana.happycmdb.example.com
```

### Step 8: Configure Monitoring

```bash
# Import Grafana dashboards (auto-provisioned)
# Configure Prometheus targets
# Set up alerting rules
# Test notifications

# Access Grafana
open http://localhost:3001
```

### Step 9: Run First Backup

```bash
# Run manual backup
./infrastructure/scripts/backup-all.sh

# Verify backup files
ls -lh /var/backups/happycmdb/

# Test restore procedure (on test environment)
./infrastructure/scripts/restore-neo4j.sh <backup-file>
```

---

## Post-Deployment Checklist

- [ ] Verify all services are running
- [ ] Check health endpoints
- [ ] Review application logs for errors
- [ ] Verify database connectivity
- [ ] Test API authentication
- [ ] Run a test discovery job
- [ ] Check Grafana dashboards
- [ ] Verify alerts are configured
- [ ] Confirm backups are running
- [ ] Test backup notifications
- [ ] Review security headers
- [ ] Run penetration testing (recommended)
- [ ] Update documentation with production details
- [ ] Notify stakeholders of go-live

---

## Common Issues & Troubleshooting

### Issue: Configuration Validation Fails

**Solution**: Run the validation script to identify specific errors:
```bash
./infrastructure/scripts/validate-config.sh production .env.production
```

### Issue: Database Connection Errors

**Solution**: Check database health and credentials:
```bash
# Check Neo4j
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1"

# Check PostgreSQL
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SELECT 1"

# Check Redis
docker exec cmdb-redis redis-cli ping
```

### Issue: SSL Certificate Errors

**Solution**: Verify certificate files and permissions:
```bash
# Check certificate files exist
ls -l infrastructure/docker/ssl/nginx/

# Verify certificate validity
openssl x509 -in infrastructure/docker/ssl/nginx/cert.pem -noout -dates

# Check certificate matches private key
openssl x509 -noout -modulus -in infrastructure/docker/ssl/nginx/cert.pem | openssl md5
openssl rsa -noout -modulus -in infrastructure/docker/ssl/nginx/key.pem | openssl md5
```

### Issue: High Memory Usage

**Solution**: Adjust database memory settings:
```bash
# Reduce Neo4j heap size
NEO4J_dbms_memory_heap_max__size=2G

# Reduce PostgreSQL shared_buffers
-c shared_buffers=1GB

# Reduce Redis maxmemory
--maxmemory 1gb
```

### Issue: Backup Failures

**Solution**: Check backup logs and permissions:
```bash
# Check backup logs
tail -100 /var/log/happycmdb/backups/backup.log

# Verify backup directory permissions
ls -ld /var/backups/happycmdb/

# Run backup with verbose output
./infrastructure/scripts/backup-all.sh -v
```

---

## Rollback Procedures

### Rollback to Previous Version

```bash
# Stop current deployment
docker-compose -f infrastructure/docker/docker-compose.yml down

# Checkout previous version
git checkout v1.9.0

# Restore from backup (if database changes)
./infrastructure/scripts/restore-neo4j.sh /var/backups/happycmdb/neo4j/backup-YYYYMMDD.tar.gz
./infrastructure/scripts/restore-postgres.sh /var/backups/happycmdb/postgres/backup-YYYYMMDD.sql.gz

# Redeploy
./deploy.sh

# Verify rollback
curl -k https://happycmdb.example.com/api/v1/cmdb-health
```

### Emergency Shutdown

```bash
# Graceful shutdown
docker-compose -f infrastructure/docker/docker-compose.yml down

# Force shutdown (if graceful fails)
docker-compose -f infrastructure/docker/docker-compose.yml kill
```

---

## Support Contacts

- **Documentation**: http://localhost:8080 (when running)
- **Production Configuration Guide**: `/docs/deployment/PRODUCTION_CONFIGURATION.md`
- **GitHub Issues**: https://github.com/happycmdb/cmdb/issues
- **Emergency Contact**: [Your on-call rotation]

---

**Last Updated**: 2025-10-19
**Version**: 2.0.0
