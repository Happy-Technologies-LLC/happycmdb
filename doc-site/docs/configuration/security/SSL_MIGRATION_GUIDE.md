# SSL/TLS Migration Guide

## Overview

This document provides a step-by-step guide for migrating HappyCMDB from unencrypted database connections to SSL/TLS encrypted connections.

**Target Audience**: DevOps Engineers, System Administrators
**Estimated Time**: 30-60 minutes
**Downtime Required**: 5-10 minutes (for service restart)

---

## Migration Strategy

### Gradual Migration (Recommended)

HappyCMDB supports a gradual migration approach to minimize risk:

1. **Phase 1**: Enable SSL with `OPTIONAL` mode (allows both encrypted and unencrypted connections)
2. **Phase 2**: Verify all clients connect with SSL
3. **Phase 3**: Enforce SSL with `REQUIRED` mode (reject unencrypted connections)

### Quick Migration (Advanced Users)

For non-production environments or during initial deployment, you can enable SSL immediately with `REQUIRED` mode.

---

## Pre-Migration Checklist

- [ ] Backup current `.env` file
- [ ] Verify all services are running: `docker ps`
- [ ] Backup databases (PostgreSQL and Neo4j)
- [ ] Test certificate generation script in development
- [ ] Schedule maintenance window (if production)

---

## Step-by-Step Migration

### Step 1: Generate SSL Certificates

```bash
cd /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/docker/ssl

# Generate self-signed certificates (development/staging)
./generate-self-signed-certs.sh

# Expected output:
# ✓ Root CA certificate generated
# ✓ Nginx certificate generated
# ✓ Neo4j certificate generated
# ✓ PostgreSQL certificate generated
# ✓ Redis certificate generated
```

**For Production**: Use Let's Encrypt or enterprise CA certificates instead of self-signed.

### Step 2: Update Environment Configuration

Edit your `.env` file (or `.env.production` for production):

#### Phase 1: Enable SSL (OPTIONAL mode)

```bash
# Master SSL toggle
SSL_ENABLED=true

# PostgreSQL SSL (prefer mode - attempts SSL, falls back to unencrypted)
POSTGRES_SSL_ENABLED=on
POSTGRES_SSL_MODE=prefer

# Neo4j SSL (OPTIONAL mode - allows both encrypted and unencrypted)
NEO4J_SSL_ENABLED=true
NEO4J_BOLT_TLS_LEVEL=OPTIONAL
NEO4J_ENCRYPTION=true
NEO4J_SSL_TRUST_STRATEGY=TRUST_ALL_CERTIFICATES  # For self-signed certs

# Nginx SSL
NGINX_SSL_ENABLED=true
```

#### Phase 3: Enforce SSL (REQUIRED mode)

After verifying all connections work with SSL:

```bash
# PostgreSQL SSL (require mode - rejects unencrypted connections)
POSTGRES_SSL_MODE=require  # Development/staging
POSTGRES_SSL_MODE=verify-full  # Production (recommended)

# Neo4j SSL (REQUIRED mode - rejects unencrypted connections)
NEO4J_BOLT_TLS_LEVEL=REQUIRED
NEO4J_SSL_TRUST_STRATEGY=TRUST_SYSTEM_CA_SIGNED_CERTIFICATES  # Production
```

### Step 3: Restart Services

```bash
cd /Users/nczitzer/WebstormProjects/happycmdb

# Restart all services to load new configuration
./deploy.sh

# Or restart individual services:
docker-compose -f infrastructure/docker/docker-compose.yml restart postgres
docker-compose -f infrastructure/docker/docker-compose.yml restart neo4j
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server
```

### Step 4: Verify SSL Connections

Run the SSL validation script:

```bash
./infrastructure/scripts/validate-ssl-config.sh --env production

# Expected output:
# ✓ All SSL checks passed - Configuration is production-ready!
```

**Manual verification**:

```bash
# Verify PostgreSQL SSL
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SHOW ssl;" \
  -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"

# Expected output:
# ssl | on
# ssl | t
# version | TLSv1.3

# Verify Neo4j SSL
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "CALL dbms.listConfig() YIELD name, value
   WHERE name IN ['dbms.ssl.policy.bolt.enabled', 'dbms.connector.bolt.tls_level']
   RETURN name, value;"

# Expected output:
# dbms.ssl.policy.bolt.enabled | true
# dbms.connector.bolt.tls_level | REQUIRED
```

### Step 5: Monitor Logs for Errors

```bash
# Check API server logs for SSL connection errors
docker logs cmdb-api-server --tail 50 | grep -i ssl

# Check PostgreSQL logs
docker logs cmdb-postgres --tail 50 | grep -i ssl

# Check Neo4j logs
docker logs cmdb-neo4j --tail 50 | grep -i ssl
```

**Look for**:
- ✅ `SSL connection established` (PostgreSQL)
- ✅ `Bolt SSL enabled` (Neo4j)
- ❌ `SSL connection failed` (indicates configuration issue)
- ❌ `Connection refused` (indicates service not listening on SSL port)

---

## Connection String Changes

### PostgreSQL

#### Before SSL Migration

```bash
# Environment variable
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_SSL_ENABLED=off

# Connection string
postgresql://cmdb_user:password@postgres:5432/cmdb
```

#### After SSL Migration (Development)

```bash
# Environment variable
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_SSL_ENABLED=on
POSTGRES_SSL_MODE=require

# Connection string
postgresql://cmdb_user:password@postgres:5432/cmdb?sslmode=require
```

#### After SSL Migration (Production)

```bash
# Environment variable
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_SSL_ENABLED=on
POSTGRES_SSL_MODE=verify-full

# Connection string
postgresql://cmdb_user:password@postgres:5432/cmdb?sslmode=verify-full&sslrootcert=/ssl/ca.crt
```

### Neo4j

#### Before SSL Migration

```bash
# Environment variable
NEO4J_URI=bolt://neo4j:7687
NEO4J_SSL_ENABLED=false
NEO4J_ENCRYPTION=false

# Connection URI
bolt://neo4j:7687
```

#### After SSL Migration (Development)

```bash
# Environment variable
NEO4J_URI=bolt://neo4j:7687  # URI stays the same, encryption set via config
NEO4J_SSL_ENABLED=true
NEO4J_ENCRYPTION=true
NEO4J_BOLT_TLS_LEVEL=OPTIONAL

# Connection URI (driver auto-detects encryption via config)
bolt://neo4j:7687
```

#### After SSL Migration (Production)

```bash
# Environment variable
NEO4J_URI=bolt+s://neo4j:7687  # bolt+s:// indicates encrypted connection
NEO4J_SSL_ENABLED=true
NEO4J_ENCRYPTION=true
NEO4J_BOLT_TLS_LEVEL=REQUIRED
NEO4J_SSL_TRUST_STRATEGY=TRUST_SYSTEM_CA_SIGNED_CERTIFICATES

# Connection URI
bolt+s://neo4j:7687  # Encrypted Bolt connection
```

---

## Rollback Procedure

If you encounter issues after migration, follow this rollback procedure:

### Quick Rollback

```bash
# 1. Restore original .env file
cp .env.backup .env

# 2. Restart services
./deploy.sh

# 3. Verify services are running
docker ps
docker logs cmdb-api-server --tail 20
```

### Manual Rollback

Edit `.env` file:

```bash
# Disable SSL
SSL_ENABLED=false
POSTGRES_SSL_ENABLED=off
NEO4J_SSL_ENABLED=false
NEO4J_ENCRYPTION=false
NGINX_SSL_ENABLED=false
```

Restart services:

```bash
./deploy.sh
```

---

## Troubleshooting

### Issue: PostgreSQL SSL connection refused

**Error**: `psql: error: SSL connection has been closed unexpectedly`

**Solution**:
```bash
# Check certificate permissions
ls -la infrastructure/docker/ssl/postgres/
# server.key should be 600 (rw-------)
# server.crt should be 644 (rw-r--r--)

# Fix permissions if needed
chmod 600 infrastructure/docker/ssl/postgres/server.key
chmod 644 infrastructure/docker/ssl/postgres/server.crt

# Restart PostgreSQL
docker-compose -f infrastructure/docker/docker-compose.yml restart postgres
```

### Issue: Neo4j connection timeout

**Error**: `ServiceUnavailable: Connection refused`

**Solution**:
```bash
# Verify Neo4j SSL configuration
docker exec cmdb-neo4j cat /var/lib/neo4j/conf/neo4j.conf | grep ssl

# Check if SSL files are accessible
docker exec cmdb-neo4j ls -la /ssl/

# Restart Neo4j
docker-compose -f infrastructure/docker/docker-compose.yml restart neo4j
```

### Issue: Self-signed certificate warnings

**Error**: `self signed certificate in certificate chain`

**Solution (Development)**:
```bash
# Use TRUST_ALL_CERTIFICATES strategy
NEO4J_SSL_TRUST_STRATEGY=TRUST_ALL_CERTIFICATES

# Use 'require' mode instead of 'verify-full'
POSTGRES_SSL_MODE=require
```

**Solution (Production)**:
```bash
# Use CA-signed certificates (Let's Encrypt)
cd infrastructure/ssl
sudo ./setup-ssl.sh

# Trust your self-signed CA system-wide (alternative, not recommended)
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  infrastructure/docker/ssl/ca.crt
```

### Issue: API server cannot connect to databases

**Error**: `Connection acquisition timeout`

**Solution**:
```bash
# Check API server environment variables
docker exec cmdb-api-server printenv | grep -E "(POSTGRES_SSL|NEO4J_SSL)"

# Ensure SSL environment variables are set
# In docker-compose.yml, api-server section:
environment:
  - POSTGRES_SSL_ENABLED=${POSTGRES_SSL_ENABLED:-off}
  - POSTGRES_SSL_MODE=${POSTGRES_SSL_MODE:-prefer}
  - NEO4J_SSL_ENABLED=${NEO4J_SSL_ENABLED:-false}
  - NEO4J_ENCRYPTION=${NEO4J_ENCRYPTION:-false}

# Restart API server
docker-compose -f infrastructure/docker/docker-compose.yml restart api-server
```

---

## Testing SSL Connections

### PostgreSQL SSL Test

```bash
# Test from host machine
psql "sslmode=require host=localhost port=5433 user=cmdb_user dbname=cmdb" \
  -c "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"

# Expected output:
#  ssl | version
# -----+---------
#  t   | TLSv1.3
```

### Neo4j SSL Test

```bash
# Test from host machine
cypher-shell -a bolt+s://localhost:7687 -u neo4j -p "$NEO4J_PASSWORD" \
  "RETURN 'SSL connection successful' AS message;"

# Expected output:
# +---------------------------+
# | message                   |
# +---------------------------+
# | "SSL connection successful" |
# +---------------------------+
```

### API Health Check

```bash
# Test API server health endpoint
curl -k https://localhost/api/v1/cmdb-health

# Expected output:
# {"status":"healthy","database":{"neo4j":"connected","postgres":"connected"}}
```

---

## Performance Considerations

### SSL Overhead

SSL/TLS encryption adds minimal overhead:

- **CPU**: ~2-5% increase (TLSv1.3 is highly optimized)
- **Latency**: ~5-10ms per connection establishment (persistent connections minimize this)
- **Throughput**: ~5-10% reduction (negligible for most CMDB workloads)

### Connection Pooling

HappyCMDB uses connection pooling to minimize SSL handshake overhead:

- **PostgreSQL**: 20 connections per pool (configurable via `POSTGRES_MAX_CONNECTIONS`)
- **Neo4j**: 50 connections per pool (configurable via `NEO4J_MAX_CONNECTION_POOL_SIZE`)

Connections are reused, so SSL handshake only occurs once per connection.

### Cipher Suite Selection

HappyCMDB uses strong, modern cipher suites:

- **PostgreSQL**: `HIGH:MEDIUM:+3DES:!aNULL` (TLSv1.2+)
- **Neo4j**: Default Neo4j cipher suite (TLSv1.2+)
- **Nginx**: Mozilla Modern compatibility (TLSv1.3 preferred)

---

## Compliance and Security

### Standards Met

With SSL/TLS enabled, HappyCMDB meets:

- ✅ **PCI-DSS 4.0**: Requirement 4.1 (encrypt data in transit)
- ✅ **HIPAA**: § 164.312(e)(1) (transmission security)
- ✅ **SOC 2 Type II**: CC6.6 (encryption of data in transit)
- ✅ **ISO 27001**: A.10.1.1 (cryptographic controls)
- ✅ **GDPR**: Article 32 (security of processing)

### Security Benefits

- **Confidentiality**: Prevents eavesdropping on database queries and results
- **Integrity**: Prevents tampering with data in transit
- **Authentication**: Validates server identity (with CA-signed certificates)
- **Compliance**: Meets regulatory requirements for data protection

---

## Next Steps

After successful SSL migration:

1. **Update Monitoring**: Configure Prometheus alerts for certificate expiration
2. **Document Procedures**: Add certificate rotation to runbook
3. **Schedule Renewals**: Set up automated certificate renewal (Let's Encrypt)
4. **Review Logs**: Monitor SSL connection logs for 24-48 hours
5. **Update Documentation**: Record any environment-specific SSL configuration
6. **Train Team**: Ensure team knows certificate management procedures

---

## Additional Resources

- **Certificate Management Guide**: `/docs/security/CERTIFICATE_MANAGEMENT.md`
- **Production Deployment Checklist**: `/docs/deployment/PRODUCTION_DEPLOYMENT_CHECKLIST.md`
- **SSL Validation Script**: `/infrastructure/scripts/validate-ssl-config.sh`
- **Certificate Generation Script**: `/infrastructure/docker/ssl/generate-self-signed-certs.sh`

---

**Last Updated**: October 2025
**Version**: HappyCMDB v2.0
**Maintained By**: Platform Security Team
