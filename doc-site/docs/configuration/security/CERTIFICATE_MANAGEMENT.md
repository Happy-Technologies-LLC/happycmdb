# Certificate Management Guide

## Overview

This document outlines the SSL/TLS certificate management procedures for HappyCMDB v2.0. Database encryption is **CRITICAL** for production deployments to protect sensitive CMDB data in transit.

**Affected Services**:
- PostgreSQL (primary data store for credentials, connector registry, metadata)
- Neo4j (graph database for CI relationships)
- Redis (cache and job queue)
- Nginx (web UI HTTPS)

---

## Table of Contents

1. [Certificate Types](#certificate-types)
2. [Development Setup (Self-Signed)](#development-setup-self-signed)
3. [Production Setup (Let's Encrypt)](#production-setup-lets-encrypt)
4. [Certificate Rotation](#certificate-rotation)
5. [Monitoring Certificate Expiration](#monitoring-certificate-expiration)
6. [Troubleshooting](#troubleshooting)
7. [Security Best Practices](#security-best-practices)

---

## Certificate Types

HappyCMDB uses SSL/TLS certificates for the following services:

| Service | Certificate Path | Key Path | CA Path | Purpose |
|---------|------------------|----------|---------|---------|
| PostgreSQL | `/ssl/server.crt` | `/ssl/server.key` | `/ssl/ca.crt` | Encrypt database connections |
| Neo4j | `/ssl/neo4j.cert` | `/ssl/neo4j.key` | `/ssl/ca.crt` | Encrypt Bolt and HTTPS connections |
| Redis | `/ssl/redis.crt` | `/ssl/redis.key` | `/ssl/ca.crt` | Encrypt cache connections (optional) |
| Nginx | `/etc/nginx/ssl/cert.pem` | `/etc/nginx/ssl/key.pem` | `/etc/nginx/ssl/chain.pem` | HTTPS web UI |

### Certificate Requirements

- **Development**: Self-signed certificates (365-day validity)
- **Production**: CA-signed certificates (Let's Encrypt or enterprise CA, 90-day auto-renewal)
- **Key Size**: Minimum 2048-bit RSA (4096-bit recommended for production)
- **Algorithm**: SHA-256 or stronger
- **TLS Version**: Minimum TLSv1.2 (TLSv1.3 recommended)

---

## Development Setup (Self-Signed)

### Quick Start

HappyCMDB includes an automated script to generate self-signed certificates for all services:

```bash
cd /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/docker/ssl
./generate-self-signed-certs.sh
```

**Output**:
```
infrastructure/docker/ssl/
├── ca.crt                 # Root CA certificate
├── ca.key                 # Root CA private key
├── nginx/
│   ├── cert.pem          # Nginx certificate
│   ├── key.pem           # Nginx private key
│   ├── chain.pem         # Certificate chain
│   └── dhparam.pem       # Diffie-Hellman parameters
├── neo4j/
│   ├── neo4j.cert        # Neo4j certificate
│   ├── neo4j.key         # Neo4j private key
│   └── ca.crt            # CA certificate
├── postgres/
│   ├── server.crt        # PostgreSQL certificate
│   ├── server.key        # PostgreSQL private key
│   └── ca.crt            # CA certificate
└── redis/
    ├── redis.crt         # Redis certificate
    ├── redis.key         # Redis private key
    └── ca.crt            # CA certificate
```

### Enable SSL in Development

Update `.env` file:

```bash
# Enable SSL for all services
SSL_ENABLED=true

# PostgreSQL SSL
POSTGRES_SSL_ENABLED=on
POSTGRES_SSL_MODE=require

# Neo4j SSL
NEO4J_SSL_ENABLED=true
NEO4J_BOLT_TLS_LEVEL=REQUIRED
NEO4J_ENCRYPTION=true

# Nginx SSL
NGINX_SSL_ENABLED=true
```

### Restart Services

```bash
./deploy.sh
```

### Trust Self-Signed CA (Optional)

To avoid browser warnings, trust the self-signed CA certificate:

**macOS**:
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  infrastructure/docker/ssl/ca.crt
```

**Ubuntu/Debian**:
```bash
sudo cp infrastructure/docker/ssl/ca.crt /usr/local/share/ca-certificates/happycmdb-ca.crt
sudo update-ca-certificates
```

**Windows**:
```powershell
certutil -addstore -f ROOT infrastructure\docker\ssl\ca.crt
```

---

## Production Setup (Let's Encrypt)

### Prerequisites

1. **Public Domain**: Own a domain (e.g., `cmdb.example.com`)
2. **DNS Configuration**: Point domain to server IP address
3. **Port 80 Open**: Let's Encrypt requires HTTP challenge on port 80
4. **Email Address**: For renewal notifications

### Automated Setup

HappyCMDB includes a Let's Encrypt setup script:

```bash
cd /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/ssl

# Set environment variables
export DOMAIN="cmdb.example.com"
export LETSENCRYPT_EMAIL="admin@example.com"
export USE_LETSENCRYPT=true

# Run setup script (requires root)
sudo ./setup-ssl.sh
```

**What the script does**:
1. Installs certbot (if not already installed)
2. Requests Let's Encrypt certificate via HTTP challenge
3. Copies certificates to HappyCMDB SSL directories
4. Sets correct file permissions
5. Configures automatic renewal cron job

### Manual Setup

If you prefer manual setup:

```bash
# Install certbot
sudo apt-get update
sudo apt-get install -y certbot

# Request certificate (standalone mode)
sudo certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email admin@example.com \
  --domains cmdb.example.com

# Copy certificates to HappyCMDB
sudo cp /etc/letsencrypt/live/cmdb.example.com/fullchain.pem \
  /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/docker/ssl/nginx/cert.pem

sudo cp /etc/letsencrypt/live/cmdb.example.com/privkey.pem \
  /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/docker/ssl/nginx/key.pem

sudo cp /etc/letsencrypt/live/cmdb.example.com/chain.pem \
  /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/docker/ssl/nginx/chain.pem

# Set permissions
sudo chmod 644 infrastructure/docker/ssl/nginx/cert.pem
sudo chmod 600 infrastructure/docker/ssl/nginx/key.pem
```

### Production Environment Variables

Update `.env.production`:

```bash
# Enable SSL for all services
SSL_ENABLED=true

# PostgreSQL SSL (verify-full mode for production)
POSTGRES_SSL_ENABLED=on
POSTGRES_SSL_MODE=verify-full

# Neo4j SSL
NEO4J_SSL_ENABLED=true
NEO4J_BOLT_TLS_LEVEL=REQUIRED
NEO4J_ENCRYPTION=true
NEO4J_SSL_TRUST_STRATEGY=TRUST_SYSTEM_CA_SIGNED_CERTIFICATES

# Nginx SSL
NGINX_SSL_ENABLED=true
NGINX_HSTS_MAX_AGE=31536000
NGINX_HSTS_INCLUDE_SUBDOMAINS=true
NGINX_HSTS_PRELOAD=true
```

---

## Certificate Rotation

### Why Rotate Certificates?

- **Security**: Limit exposure window if private key is compromised
- **Compliance**: Many standards require regular rotation (e.g., PCI-DSS)
- **Expiration**: Certificates expire (Let's Encrypt: 90 days, self-signed: 365 days)

### Automated Renewal (Let's Encrypt)

Let's Encrypt certificates auto-renew via cron job (installed by setup script):

```bash
# View renewal cron job
crontab -l | grep renew-ssl

# Expected output:
# 0 2 * * * /path/to/renew-ssl.sh >> /var/log/cmdb-ssl-renewal.log 2>&1
```

**Manual renewal**:
```bash
cd /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/ssl
sudo ./renew-ssl.sh
```

### Manual Rotation (Self-Signed)

For self-signed certificates, regenerate before expiration:

```bash
cd /Users/nczitzer/WebstormProjects/happycmdb/infrastructure/docker/ssl

# Backup existing certificates
tar -czf ssl-backup-$(date +%Y%m%d).tar.gz *.crt *.key nginx/ neo4j/ postgres/ redis/

# Regenerate certificates
./generate-self-signed-certs.sh --force

# Restart services to load new certificates
cd ../..
./deploy.sh
```

### PostgreSQL Certificate Rotation

PostgreSQL requires server restart to load new certificates:

```bash
# After updating certificates in infrastructure/docker/ssl/postgres/
docker-compose -f infrastructure/docker/docker-compose.yml restart postgres

# Verify SSL is active
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SHOW ssl;" \
  -c "SELECT * FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
```

### Neo4j Certificate Rotation

Neo4j requires restart to load new certificates:

```bash
# After updating certificates in infrastructure/docker/ssl/neo4j/
docker-compose -f infrastructure/docker/docker-compose.yml restart neo4j

# Verify SSL is active
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "CALL dbms.listConfig() YIELD name, value WHERE name CONTAINS 'ssl' RETURN name, value;"
```

---

## Monitoring Certificate Expiration

### Prometheus Alerts

HappyCMDB includes Prometheus alerts for certificate expiration. Add to `monitoring/prometheus/alerts/ssl.yml`:

```yaml
groups:
  - name: ssl_certificate_alerts
    interval: 1h
    rules:
      # PostgreSQL SSL Certificate Expiration
      - alert: PostgreSQLCertificateExpiringSoon
        expr: (file_mtime{path="/ssl/server.crt"} - time()) < (7 * 24 * 3600)
        for: 1h
        labels:
          severity: warning
          service: postgresql
        annotations:
          summary: "PostgreSQL SSL certificate expires in less than 7 days"
          description: "Certificate at /ssl/server.crt expires soon. Rotate immediately."

      # Neo4j SSL Certificate Expiration
      - alert: Neo4jCertificateExpiringSoon
        expr: (file_mtime{path="/ssl/neo4j.cert"} - time()) < (7 * 24 * 3600)
        for: 1h
        labels:
          severity: warning
          service: neo4j
        annotations:
          summary: "Neo4j SSL certificate expires in less than 7 days"
          description: "Certificate at /ssl/neo4j.cert expires soon. Rotate immediately."

      # Critical alert (3 days before expiration)
      - alert: DatabaseCertificateExpiringCritical
        expr: (file_mtime{path=~"/ssl/(server|neo4j)\\.(crt|cert)"} - time()) < (3 * 24 * 3600)
        for: 1h
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Database SSL certificate expires in less than 3 days - CRITICAL"
          description: "Certificate expires imminently. Rotate NOW to prevent service disruption."
```

### Manual Certificate Expiration Check

```bash
# Check PostgreSQL certificate expiration
openssl x509 -in infrastructure/docker/ssl/postgres/server.crt -noout -enddate

# Check Neo4j certificate expiration
openssl x509 -in infrastructure/docker/ssl/neo4j/neo4j.cert -noout -enddate

# Check Nginx certificate expiration
openssl x509 -in infrastructure/docker/ssl/nginx/cert.pem -noout -enddate

# Check all certificates and show days until expiration
for cert in infrastructure/docker/ssl/{postgres/server.crt,neo4j/neo4j.cert,nginx/cert.pem}; do
  echo "Certificate: $cert"
  openssl x509 -in "$cert" -noout -enddate -checkend 0 && echo "  Status: Valid" || echo "  Status: EXPIRED"
  echo ""
done
```

### Automated Monitoring Script

Create a monitoring script at `infrastructure/scripts/check-ssl-expiration.sh`:

```bash
#!/bin/bash

WARN_DAYS=14
CRITICAL_DAYS=7

for cert in /ssl/postgres/server.crt /ssl/neo4j/neo4j.cert /ssl/nginx/cert.pem; do
  if [ -f "$cert" ]; then
    expiry=$(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)
    expiry_epoch=$(date -d "$expiry" +%s)
    now_epoch=$(date +%s)
    days_until_expiry=$(( ($expiry_epoch - $now_epoch) / 86400 ))

    if [ $days_until_expiry -lt $CRITICAL_DAYS ]; then
      echo "CRITICAL: $cert expires in $days_until_expiry days!"
      exit 2
    elif [ $days_until_expiry -lt $WARN_DAYS ]; then
      echo "WARNING: $cert expires in $days_until_expiry days"
      exit 1
    fi
  fi
done

echo "OK: All certificates valid for at least $WARN_DAYS days"
exit 0
```

Run via cron:
```bash
# Add to crontab (runs daily at 9 AM)
0 9 * * * /path/to/check-ssl-expiration.sh | mail -s "SSL Certificate Check" admin@example.com
```

---

## Troubleshooting

### PostgreSQL SSL Connection Failed

**Error**: `SSL connection has been closed unexpectedly`

**Diagnosis**:
```bash
# Check if SSL is enabled in PostgreSQL
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SHOW ssl;"

# Verify certificate files exist and have correct permissions
docker exec cmdb-postgres ls -la /ssl/

# Expected output:
# -rw-r--r-- server.crt
# -rw------- server.key
# -rw-r--r-- ca.crt
```

**Solution**:
```bash
# Fix certificate permissions
chmod 644 infrastructure/docker/ssl/postgres/server.crt
chmod 600 infrastructure/docker/ssl/postgres/server.key
chmod 644 infrastructure/docker/ssl/postgres/ca.crt

# Restart PostgreSQL
docker-compose -f infrastructure/docker/docker-compose.yml restart postgres
```

### Neo4j SSL Connection Refused

**Error**: `ServiceUnavailable: Connection refused`

**Diagnosis**:
```bash
# Check Neo4j logs
docker logs cmdb-neo4j | grep -i ssl

# Verify SSL configuration
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "CALL dbms.listConfig() YIELD name, value WHERE name CONTAINS 'ssl' RETURN name, value;"
```

**Solution**:
```bash
# Ensure NEO4J_BOLT_TLS_LEVEL is set correctly
# In .env file:
NEO4J_BOLT_TLS_LEVEL=REQUIRED  # or OPTIONAL for gradual migration

# Use correct connection URI
# Encrypted: bolt+s://localhost:7687 or bolt+ssc://localhost:7687
# Unencrypted: bolt://localhost:7687

# Restart Neo4j
docker-compose -f infrastructure/docker/docker-compose.yml restart neo4j
```

### Certificate Validation Failed

**Error**: `self signed certificate in certificate chain`

**Cause**: Client attempting to verify self-signed certificate

**Solution (Development)**:
```bash
# PostgreSQL: Use 'require' mode instead of 'verify-full'
POSTGRES_SSL_MODE=require

# Neo4j: Use trust all certificates strategy
NEO4J_SSL_TRUST_STRATEGY=TRUST_ALL_CERTIFICATES
```

**Solution (Production)**:
```bash
# Use CA-signed certificates (Let's Encrypt)
cd infrastructure/ssl
sudo ./setup-ssl.sh

# Or trust your self-signed CA system-wide (not recommended for production)
```

### Connection Timeout After Enabling SSL

**Error**: `Connection timeout` or `Connection acquisition timeout`

**Diagnosis**:
```bash
# Test PostgreSQL SSL connection manually
docker exec cmdb-postgres psql "sslmode=require host=postgres user=cmdb_user dbname=cmdb"

# Test Neo4j bolt+s connection
docker exec cmdb-neo4j cypher-shell -a bolt+s://localhost:7687 -u neo4j -p "$NEO4J_PASSWORD"
```

**Solution**:
```bash
# Verify SSL ports are open
docker exec cmdb-postgres netstat -tlnp | grep 5432
docker exec cmdb-neo4j netstat -tlnp | grep 7687

# Check firewall rules
sudo ufw status | grep -E "(5432|7687)"

# Verify environment variables are set
docker exec cmdb-api-server printenv | grep -E "(POSTGRES_SSL|NEO4J_SSL)"
```

---

## Security Best Practices

### 1. Certificate Storage

- **Never commit certificates to version control** - Add `*.key`, `*.crt`, `*.pem` to `.gitignore`
- **Restrict file permissions**:
  - Private keys: `600` (owner read/write only)
  - Certificates: `644` (world-readable)
  - CA certificates: `644` (world-readable)

### 2. Key Management

- **Use strong key sizes**: Minimum 2048-bit RSA, 4096-bit recommended
- **Rotate regularly**: Every 90 days for Let's Encrypt, annually for self-signed
- **Separate keys per service**: Don't reuse the same key/cert for multiple services
- **Secure key generation**: Use `/dev/urandom` or hardware RNG

### 3. Certificate Validation

- **Production**: Always use `verify-full` mode for PostgreSQL
- **Production**: Use `TRUST_SYSTEM_CA_SIGNED_CERTIFICATES` for Neo4j
- **Development**: `require` mode acceptable for PostgreSQL
- **Development**: `TRUST_ALL_CERTIFICATES` acceptable for Neo4j

### 4. TLS Configuration

- **Minimum TLS version**: TLSv1.2 (TLSv1.3 preferred)
- **Strong cipher suites**: `HIGH:MEDIUM:+3DES:!aNULL` (PostgreSQL)
- **Disable weak protocols**: No SSLv2, SSLv3, TLSv1.0, TLSv1.1
- **Enable HSTS**: Force HTTPS for web UI (31536000 seconds)

### 5. Monitoring

- **Alert on expiration**: 14 days warning, 7 days critical
- **Test renewals**: Dry-run certificate renewal monthly
- **Log all SSL events**: Connection attempts, handshake failures
- **Audit certificate changes**: Track who rotated certificates when

### 6. Backup Procedures

```bash
# Backup certificates before rotation
cd infrastructure/docker/ssl
tar -czf ssl-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  ca.crt ca.key \
  nginx/ neo4j/ postgres/ redis/

# Store backup securely (encrypted storage)
gpg --encrypt --recipient admin@example.com ssl-backup-*.tar.gz

# Upload to secure backup location
aws s3 cp ssl-backup-*.tar.gz.gpg s3://backups/happycmdb/ssl/
```

### 7. Incident Response

If a private key is compromised:

1. **Immediately revoke compromised certificate**:
   ```bash
   # For Let's Encrypt certificates
   certbot revoke --cert-path /etc/letsencrypt/live/cmdb.example.com/cert.pem
   ```

2. **Generate new certificates**:
   ```bash
   cd infrastructure/docker/ssl
   ./generate-self-signed-certs.sh --force
   ```

3. **Update all services**:
   ```bash
   ./deploy.sh
   ```

4. **Audit access logs** to determine scope of compromise

5. **Notify security team** and document incident

---

## Appendix: Connection String Examples

### PostgreSQL

```bash
# Unencrypted (development only)
postgresql://cmdb_user:password@localhost:5432/cmdb

# SSL required (self-signed)
postgresql://cmdb_user:password@localhost:5432/cmdb?sslmode=require

# SSL with full verification (production)
postgresql://cmdb_user:password@localhost:5432/cmdb?sslmode=verify-full&sslrootcert=/path/to/ca.crt
```

### Neo4j

```bash
# Unencrypted (development only)
bolt://localhost:7687

# Encrypted with self-signed (development)
bolt+ssc://localhost:7687

# Encrypted with CA-signed (production)
bolt+s://localhost:7687
```

### Testing Connections

```bash
# Test PostgreSQL SSL connection
psql "sslmode=require host=localhost port=5433 user=cmdb_user dbname=cmdb" \
  -c "SELECT version();" \
  -c "SELECT ssl_is_used();"

# Test Neo4j encrypted connection
cypher-shell -a bolt+s://localhost:7687 -u neo4j -p password \
  "RETURN 'Connection successful' AS message;"
```

---

## Support

For questions or issues with certificate management:

- **Documentation**: http://localhost:8080/operations/troubleshooting
- **GitHub Issues**: https://github.com/happycmdb/cmdb/issues
- **Security Issues**: security@happycmdb.example.com (use PGP key for sensitive reports)

---

**Last Updated**: October 2025
**Version**: HappyCMDB v2.0
**Maintained By**: Platform Engineering Team
