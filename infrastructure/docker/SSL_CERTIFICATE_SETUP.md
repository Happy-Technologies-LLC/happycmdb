# SSL/TLS Certificate Setup Guide

This guide provides comprehensive instructions for setting up SSL/TLS certificates for HappyCMDB, including Let's Encrypt (production), self-signed certificates (development), and enterprise CA certificates.

## Table of Contents

1. [Overview](#overview)
2. [Production Setup (Let's Encrypt)](#production-setup-lets-encrypt)
3. [Development Setup (Self-Signed)](#development-setup-self-signed)
4. [Enterprise CA Certificates](#enterprise-ca-certificates)
5. [Certificate Locations](#certificate-locations)
6. [Troubleshooting](#troubleshooting)

---

## Overview

HappyCMDB v2.0 supports SSL/TLS encryption for:

- **Web UI (Nginx)**: HTTPS connections on port 443
- **Neo4j**: Bolt protocol with TLS and HTTPS web interface
- **PostgreSQL**: SSL-encrypted database connections
- **Redis**: TLS-encrypted cache connections

### Certificate Requirements

Each service requires the following certificate files:

| Service | Certificate | Private Key | CA Certificate (optional) |
|---------|-------------|-------------|---------------------------|
| Nginx | `/infrastructure/docker/ssl/nginx/cert.pem` | `/infrastructure/docker/ssl/nginx/key.pem` | `/infrastructure/docker/ssl/nginx/chain.pem` |
| Neo4j | `/infrastructure/docker/ssl/neo4j/neo4j.cert` | `/infrastructure/docker/ssl/neo4j/neo4j.key` | `/infrastructure/docker/ssl/neo4j/ca.crt` |
| PostgreSQL | `/infrastructure/docker/ssl/postgres/server.crt` | `/infrastructure/docker/ssl/postgres/server.key` | `/infrastructure/docker/ssl/postgres/ca.crt` |
| Redis | `/infrastructure/docker/ssl/redis/redis.crt` | `/infrastructure/docker/ssl/redis/redis.key` | `/infrastructure/docker/ssl/redis/ca.crt` |

---

## Production Setup (Let's Encrypt)

Let's Encrypt provides free, automated SSL/TLS certificates trusted by all major browsers.

### Prerequisites

- Public domain name pointing to your server (e.g., `cmdb.example.com`)
- Ports 80 and 443 accessible from the internet
- Docker and docker-compose installed

### Step 1: Install Certbot

```bash
# On Ubuntu/Debian
sudo apt-get update
sudo apt-get install certbot

# On RHEL/CentOS/Fedora
sudo dnf install certbot

# On macOS (via Homebrew)
brew install certbot
```

### Step 2: Obtain Certificates

Run Certbot in standalone mode (before starting HappyCMDB):

```bash
# Stop any services using port 80
docker-compose -f infrastructure/docker/docker-compose.yml down

# Request certificate
sudo certbot certonly --standalone \
  -d cmdb.example.com \
  -d www.cmdb.example.com \
  --email admin@example.com \
  --agree-tos \
  --non-interactive

# Certificates will be saved to:
# /etc/letsencrypt/live/cmdb.example.com/fullchain.pem
# /etc/letsencrypt/live/cmdb.example.com/privkey.pem
# /etc/letsencrypt/live/cmdb.example.com/chain.pem
```

### Step 3: Copy Certificates to HappyCMDB

```bash
# Create SSL directories
mkdir -p infrastructure/docker/ssl/{nginx,neo4j,postgres,redis}

# Copy Let's Encrypt certificates for Nginx
sudo cp /etc/letsencrypt/live/cmdb.example.com/fullchain.pem \
  infrastructure/docker/ssl/nginx/cert.pem
sudo cp /etc/letsencrypt/live/cmdb.example.com/privkey.pem \
  infrastructure/docker/ssl/nginx/key.pem
sudo cp /etc/letsencrypt/live/cmdb.example.com/chain.pem \
  infrastructure/docker/ssl/nginx/chain.pem

# Set appropriate permissions
sudo chown -R $USER:$USER infrastructure/docker/ssl/nginx
chmod 644 infrastructure/docker/ssl/nginx/cert.pem
chmod 600 infrastructure/docker/ssl/nginx/key.pem
chmod 644 infrastructure/docker/ssl/nginx/chain.pem
```

### Step 4: Generate Diffie-Hellman Parameters

```bash
# Generate 4096-bit DH params (takes 5-10 minutes)
openssl dhparam -out infrastructure/docker/ssl/nginx/dhparam.pem 4096

# For faster generation (2048-bit, less secure):
openssl dhparam -out infrastructure/docker/ssl/nginx/dhparam.pem 2048
```

### Step 5: Update Environment Variables

Edit `.env` file:

```bash
# SSL/TLS Configuration
SSL_ENABLED=true
NGINX_SSL_ENABLED=true
```

### Step 6: Start HappyCMDB

```bash
./deploy.sh
```

### Step 7: Configure Auto-Renewal

Let's Encrypt certificates expire after 90 days. Set up automatic renewal:

```bash
# Test renewal (dry run)
sudo certbot renew --dry-run

# Add cron job for automatic renewal (runs twice daily)
sudo crontab -e

# Add this line:
0 0,12 * * * certbot renew --quiet --deploy-hook "docker restart cmdb-web-ui"
```

---

## Development Setup (Self-Signed)

For local development and testing, generate self-signed certificates.

### Quick Setup Script

We provide a script to generate all required certificates:

```bash
# Navigate to SSL directory
cd infrastructure/docker/ssl

# Run the setup script
./generate-self-signed-certs.sh
```

### Manual Setup

If you prefer to generate certificates manually:

#### 1. Create SSL Directories

```bash
mkdir -p infrastructure/docker/ssl/{nginx,neo4j,postgres,redis}
cd infrastructure/docker/ssl
```

#### 2. Generate Root CA Certificate

```bash
# Generate CA private key
openssl genrsa -out ca.key 4096

# Generate CA certificate (valid for 10 years)
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt \
  -subj "/C=US/ST=State/L=City/O=HappyCMDB Dev/OU=IT/CN=HappyCMDB Root CA"
```

#### 3. Generate Nginx Certificates

```bash
# Generate private key
openssl genrsa -out nginx/key.pem 2048

# Generate certificate signing request
openssl req -new -key nginx/key.pem -out nginx/cert.csr \
  -subj "/C=US/ST=State/L=City/O=HappyCMDB/OU=IT/CN=localhost"

# Create SAN configuration
cat > nginx/san.cnf <<EOF
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = State
L = City
O = HappyCMDB
OU = IT
CN = localhost

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = cmdb-web-ui
DNS.3 = *.localhost
IP.1 = 127.0.0.1
IP.2 = 0.0.0.0
EOF

# Sign certificate with CA
openssl x509 -req -in nginx/cert.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out nginx/cert.pem -days 365 -sha256 \
  -extfile nginx/san.cnf -extensions v3_req

# Copy chain
cp ca.crt nginx/chain.pem

# Generate DH params
openssl dhparam -out nginx/dhparam.pem 2048

# Clean up
rm nginx/cert.csr nginx/san.cnf
```

#### 4. Generate Neo4j Certificates

```bash
# Generate private key
openssl genrsa -out neo4j/neo4j.key 2048

# Generate certificate signing request
openssl req -new -key neo4j/neo4j.key -out neo4j/neo4j.csr \
  -subj "/C=US/ST=State/L=City/O=HappyCMDB/OU=IT/CN=cmdb-neo4j"

# Sign certificate
openssl x509 -req -in neo4j/neo4j.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out neo4j/neo4j.cert -days 365 -sha256

# Copy CA certificate
cp ca.crt neo4j/ca.crt

# Clean up
rm neo4j/neo4j.csr
```

#### 5. Generate PostgreSQL Certificates

```bash
# Generate private key
openssl genrsa -out postgres/server.key 2048

# Generate certificate signing request
openssl req -new -key postgres/server.key -out postgres/server.csr \
  -subj "/C=US/ST=State/L=City/O=HappyCMDB/OU=IT/CN=cmdb-postgres"

# Sign certificate
openssl x509 -req -in postgres/server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out postgres/server.crt -days 365 -sha256

# Copy CA certificate
cp ca.crt postgres/ca.crt

# Set strict permissions (PostgreSQL requires this)
chmod 600 postgres/server.key

# Clean up
rm postgres/server.csr
```

#### 6. Generate Redis Certificates

```bash
# Generate private key
openssl genrsa -out redis/redis.key 2048

# Generate certificate signing request
openssl req -new -key redis/redis.key -out redis/redis.csr \
  -subj "/C=US/ST=State/L=City/O=HappyCMDB/OU=IT/CN=cmdb-redis"

# Sign certificate
openssl x509 -req -in redis/redis.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out redis/redis.crt -days 365 -sha256

# Copy CA certificate
cp ca.crt redis/ca.crt

# Clean up
rm redis/redis.csr
```

#### 7. Set Permissions

```bash
# Set appropriate permissions
chmod 644 nginx/cert.pem nginx/chain.pem
chmod 600 nginx/key.pem
chmod 644 neo4j/neo4j.cert neo4j/ca.crt
chmod 600 neo4j/neo4j.key
chmod 644 postgres/server.crt postgres/ca.crt
chmod 600 postgres/server.key
chmod 644 redis/redis.crt redis/ca.crt
chmod 600 redis/redis.key
```

#### 8. Trust Self-Signed CA (Optional)

To avoid browser warnings, add the CA certificate to your system's trusted certificates:

**macOS:**
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt
```

**Ubuntu/Debian:**
```bash
sudo cp ca.crt /usr/local/share/ca-certificates/happycmdb-ca.crt
sudo update-ca-certificates
```

**Windows:**
```powershell
# Run as Administrator
certutil -addstore -f "ROOT" ca.crt
```

---

## Enterprise CA Certificates

If your organization uses an internal Certificate Authority:

### Step 1: Obtain Certificates

Request certificates from your CA for:
- `cmdb.yourdomain.com` (Nginx)
- `cmdb-neo4j.yourdomain.com` (Neo4j)
- `cmdb-postgres.yourdomain.com` (PostgreSQL)
- `cmdb-redis.yourdomain.com` (Redis)

### Step 2: Copy Certificates

```bash
# Create SSL directories
mkdir -p infrastructure/docker/ssl/{nginx,neo4j,postgres,redis}

# Copy your certificates to appropriate locations
cp /path/to/nginx.crt infrastructure/docker/ssl/nginx/cert.pem
cp /path/to/nginx.key infrastructure/docker/ssl/nginx/key.pem
cp /path/to/ca-chain.crt infrastructure/docker/ssl/nginx/chain.pem

# Repeat for other services...
```

### Step 3: Update Service Names

Edit `docker-compose.yml` to match your certificate CNs if needed.

---

## Certificate Locations

### Directory Structure

```
infrastructure/docker/ssl/
├── ca.crt                    # Root CA certificate (self-signed only)
├── ca.key                    # Root CA private key (self-signed only)
├── nginx/
│   ├── cert.pem             # Nginx server certificate
│   ├── key.pem              # Nginx private key
│   ├── chain.pem            # CA certificate chain
│   └── dhparam.pem          # Diffie-Hellman parameters
├── neo4j/
│   ├── neo4j.cert           # Neo4j server certificate
│   ├── neo4j.key            # Neo4j private key
│   └── ca.crt               # CA certificate
├── postgres/
│   ├── server.crt           # PostgreSQL server certificate
│   ├── server.key           # PostgreSQL private key
│   └── ca.crt               # CA certificate
└── redis/
    ├── redis.crt            # Redis server certificate
    ├── redis.key            # Redis private key
    └── ca.crt               # CA certificate
```

### Environment Variable Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `SSL_ENABLED` | `false` | Master SSL toggle |
| `NGINX_SSL_ENABLED` | `false` | Enable HTTPS for web UI |
| `NEO4J_SSL_ENABLED` | `false` | Enable SSL for Neo4j connections |
| `NEO4J_BOLT_TLS_LEVEL` | `OPTIONAL` | Bolt TLS level: `DISABLED`, `OPTIONAL`, `REQUIRED` |
| `NEO4J_HTTPS_ENABLED` | `false` | Enable HTTPS for Neo4j browser |
| `POSTGRES_SSL_ENABLED` | `off` | PostgreSQL SSL mode: `off`, `on`, `require` |
| `REDIS_TLS_PORT` | `0` | Redis TLS port (0=disabled, 6380=enabled) |
| `REDIS_TLS_AUTH_CLIENTS` | `no` | Require client certificates for Redis |

---

## Troubleshooting

### Issue: "Certificate verification failed"

**Cause**: Self-signed certificates not trusted by client.

**Solution**: Add the CA certificate to your system's trusted certificates (see Step 8 in Development Setup).

### Issue: "Permission denied" when accessing private key

**Cause**: Incorrect file permissions.

**Solution**:
```bash
chmod 600 infrastructure/docker/ssl/*/server.key
chmod 600 infrastructure/docker/ssl/*/neo4j.key
chmod 600 infrastructure/docker/ssl/*/redis.key
chmod 600 infrastructure/docker/ssl/nginx/key.pem
```

### Issue: PostgreSQL won't start with SSL enabled

**Cause**: PostgreSQL is very strict about key file permissions.

**Solution**:
```bash
# Key file must be owned by user running PostgreSQL (usually 'postgres' in container)
chmod 600 infrastructure/docker/ssl/postgres/server.key

# If using docker volumes, rebuild the container:
docker-compose -f infrastructure/docker/docker-compose.yml down
docker-compose -f infrastructure/docker/docker-compose.yml up -d postgres
```

### Issue: Neo4j Bolt connection fails with TLS

**Cause**: Bolt TLS level set to `REQUIRED` but client doesn't support TLS.

**Solution**: Set `NEO4J_BOLT_TLS_LEVEL=OPTIONAL` in `.env` to allow both encrypted and unencrypted connections.

### Issue: Nginx fails to start with SSL

**Check nginx configuration syntax:**
```bash
docker exec cmdb-web-ui nginx -t
```

**Verify certificate files exist:**
```bash
ls -la infrastructure/docker/ssl/nginx/
```

**Check nginx error logs:**
```bash
docker logs cmdb-web-ui
```

### Issue: Browser shows "NET::ERR_CERT_AUTHORITY_INVALID"

**Cause**: Using self-signed certificates without trusting the CA.

**Solution**:
1. **Development**: Trust the self-signed CA certificate (see Step 8 in Development Setup)
2. **Production**: Use Let's Encrypt or a trusted CA

### Issue: Certificate expired

**Let's Encrypt certificates**:
```bash
# Check expiration
sudo certbot certificates

# Renew certificates
sudo certbot renew
docker restart cmdb-web-ui
```

**Self-signed certificates**:
```bash
# Check expiration
openssl x509 -in infrastructure/docker/ssl/nginx/cert.pem -noout -enddate

# Regenerate if expired
cd infrastructure/docker/ssl
./generate-self-signed-certs.sh
docker-compose -f ../../docker-compose.yml restart
```

### Issue: "Unable to connect" after enabling SSL

**Check that SSL is properly enabled in .env:**
```bash
cat .env | grep SSL
```

**Verify services are listening on correct ports:**
```bash
# Check Nginx (should show 443)
docker exec cmdb-web-ui netstat -tlnp | grep nginx

# Check Neo4j (should show 7473 for HTTPS, 7687 for Bolt)
docker exec cmdb-neo4j netstat -tlnp

# Check PostgreSQL (should show 5432)
docker exec cmdb-postgres netstat -tlnp | grep postgres
```

**Test connectivity:**
```bash
# Test Nginx HTTPS
curl -k https://localhost

# Test Neo4j HTTPS
curl -k https://localhost:7473

# Test PostgreSQL SSL
psql "postgresql://cmdb_user@localhost:5433/cmdb?sslmode=require"

# Test Redis TLS
redis-cli --tls --cert infrastructure/docker/ssl/redis/redis.crt \
  --key infrastructure/docker/ssl/redis/redis.key \
  --cacert infrastructure/docker/ssl/redis/ca.crt \
  -p 6380 ping
```

---

## Security Best Practices

1. **Never commit private keys to version control**
   - Add `*.key` and `*.pem` to `.gitignore`
   - Use environment variables for sensitive configuration

2. **Use strong key lengths**
   - Minimum 2048-bit RSA keys
   - 4096-bit for production environments

3. **Rotate certificates regularly**
   - Let's Encrypt: Auto-renews every 60 days
   - Self-signed: Regenerate annually
   - Enterprise CA: Follow organization policy

4. **Restrict file permissions**
   - Private keys: `600` (read/write for owner only)
   - Certificates: `644` (read for all, write for owner)

5. **Use HSTS headers**
   - Already configured in `nginx.conf`
   - Forces HTTPS for all connections

6. **Monitor certificate expiration**
   - Set up alerts 30 days before expiration
   - Use tools like `certbot` or monitoring services

7. **Disable weak protocols and ciphers**
   - TLS 1.2+ only (already configured)
   - Modern cipher suites (already configured)

---

## Additional Resources

- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [OpenSSL Certificate Authority Guide](https://jamielinux.com/docs/openssl-certificate-authority/)
- [Neo4j SSL Configuration](https://neo4j.com/docs/operations-manual/current/security/ssl-framework/)
- [PostgreSQL SSL Support](https://www.postgresql.org/docs/current/ssl-tcp.html)
- [Redis TLS Support](https://redis.io/docs/manual/security/encryption/)
- [Mozilla SSL Configuration Generator](https://ssl-config.mozilla.org/)

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/yourusername/happycmdb/issues
- Documentation: http://localhost:8080 (when running)
- Email: support@happycmdb.io
