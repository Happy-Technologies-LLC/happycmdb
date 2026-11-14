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
API_HOST=0.0.0.0     # Read by infrastructure/scripts only, not the api-server
SERVER_HOST=         # api-server bind address (unset: all interfaces)
```

#### Authentication & Security

```bash
# CRITICAL: Generate strong secrets
# Use: openssl rand -base64 64
JWT_SECRET=<64-character-random-string>
JWT_ACCESS_TOKEN_EXPIRES_IN=15m

# CRITICAL: For encrypting credential storage
# Use: openssl rand -base64 64
ENCRYPTION_KEY=<64-character-random-string>

# Optional internal service bypass: a request whose RATE_LIMIT_BYPASS_HEADER equals this skips every rate
# limiter, login included. Leave empty (bypass off) unless an internal service needs it.
# Use: openssl rand -base64 32 (ConfigurationLoader refuses values under 32 characters or a shipped placeholder)
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
# Server side (compose): POSTGRES_SSL_ENABLED=on starts postgres with `-c ssl=on`.
POSTGRES_SSL_ENABLED=on
# Client side: POSTGRES_SSL_MODE = disable | require | prefer | verify-full.
#   require / prefer: TLS, server certificate NOT verified (pg has no cleartext fallback).
#   verify-full: verifies the certificate chain and host name.
POSTGRES_SSL_MODE=verify-full
# verify-full only: CA bundle to trust (default: the Node.js trust store). Must be readable by the api-server process.
POSTGRES_SSL_CA_FILE=/ssl/ca.crt
```

The Postgres client reads only `POSTGRES_SSL_MODE`, `POSTGRES_SSL_ENABLED` and `POSTGRES_SSL_CA_FILE` (`resolveSsl` in
`packages/database/src/postgres/client.ts`). `POSTGRES_SSL_ENABLED` is consulted only when `POSTGRES_SSL_MODE` is unset
(or empty): `on` means `require`, and any other value is used as the mode itself, so `off`, `false`, `disable`,
`require`, `prefer` and `verify-full` are all accepted. It does not present a client certificate or
key, and no other `POSTGRES_SSL_*` variable is honored (there are no client certificate, client key or CA-path settings;
use `POSTGRES_SSL_CA_FILE` for the CA). The server certificate and key are the postgres `ssl_cert_file` / `ssl_key_file`
flags shown under Docker Compose Configuration below.
With `NODE_ENV=production` and a non-local host, leaving both `POSTGRES_SSL_MODE` and `POSTGRES_SSL_ENABLED` unset
refuses to start. An unsupported mode value (for example `POSTGRES_SSL_MODE=bogus`, or `POSTGRES_SSL_ENABLED=true` while
`POSTGRES_SSL_MODE` is unset) also refuses to start, in every environment. The shipped compose always sets
`POSTGRES_SSL_MODE` for the api-server (`${POSTGRES_SSL_MODE:-prefer}`), so for compose deploys `POSTGRES_SSL_ENABLED`
never selects the api-server's client mode there; it only drives the server flag `-c ssl=${POSTGRES_SSL_ENABLED:-off}`
on the `postgres` service.
See [environment-variables.md](../configuration/environment-variables.md) for the full table.

::: warning The shipped compose does not support `verify-full`
`infrastructure/docker/docker-compose.yml` is wired for `require` / `prefer` only:

- **api-server**: forwards only `POSTGRES_SSL_ENABLED` and `POSTGRES_SSL_MODE` (default `prefer`). It does not forward
  `POSTGRES_SSL_CA_FILE` and mounts no `/ssl` volume. With `POSTGRES_SSL_MODE=verify-full` in `.env`, the api-server
  verifies against the Node.js trust store, so a private CA is rejected. A `POSTGRES_SSL_CA_FILE=/ssl/ca.crt` line in
  `.env` has no effect, because the variable never reaches the container.
- **Grafana's own database**: `GF_DATABASE_SSL_MODE` is `${POSTGRES_SSL_MODE:-disable}`, so `verify-full` in `.env`
  switches it to verify-full. The compose file sets no `GF_DATABASE_CA_CERT_PATH`, and Grafana 10.2.0 then passes an
  empty `sslrootcert` to `lib/pq` v1.10.9, which loads no root certificate and verifies against the system roots, so a
  private CA is rejected (checked in the Grafana v10.2.0 and `lib/pq` v1.10.9 sources, not by running a container).
- **Grafana datasources**: `infrastructure/monitoring/grafana/provisioning/datasources/postgres.yml` reads
  `GRAFANA_DS_HOST`, `GRAFANA_DS_PORT`, `GRAFANA_DS_DATABASE`, `GRAFANA_DS_USER`, `GRAFANA_DS_PASSWORD` and
  `GRAFANA_DS_SSL_MODE` from the Grafana container's own environment, and the compose `grafana` service forwards exactly
  those (HAP-1827). The datasource variables never fall back to `POSTGRES_*`. (The `GF_DATABASE_*` variables for
  Grafana's own metadata database are separate and still carry `POSTGRES_USER` / `POSTGRES_PASSWORD`; see the end of the
  reporting-role section.) `GRAFANA_DS_SSL_MODE` defaults to `require` (TLS, certificate not verified), not `verify-full`,
  because the compose mounts no CA into Grafana. With `GRAFANA_DS_USER` / `GRAFANA_DS_PASSWORD` unset the datasources
  are provisioned but their health check fails. On a stack whose Postgres has `POSTGRES_SSL_ENABLED=off` (the compose
  default), set `GRAFANA_DS_SSL_MODE=disable` explicitly. See [Grafana datasource reporting role](#grafana-datasource-reporting-role-hap-1827).

To run `verify-full` with this compose file, add these in a compose override file; the shipped file does none of it:

1. api-server: forward `POSTGRES_SSL_CA_FILE=/ssl/ca.crt` and mount only the CA certificate read-only, for example
   `- ./ssl/postgres/ca.crt:/ssl/ca.crt:ro`. Never mount the server key (`server.key`) or the whole `ssl/postgres`
   directory into a client container: the api-server is network-facing, and the key would let a compromised client
   impersonate Postgres.
2. Server certificate host name: `verify-full` checks the host the client dials (`POSTGRES_HOST=postgres` for the
   api-server, `GF_DATABASE_HOST=postgres:5432` for Grafana) against the certificate's subject alternative names, so the
   server certificate must carry `subjectAltName=DNS:postgres` (or whatever host your clients use). Section 5 of
   `infrastructure/docker/SSL_CERTIFICATE_SETUP.md` now issues that SAN; a certificate issued from an earlier copy of
   that section has `CN=cmdb-postgres` and no SAN, fails the host-name check, and must be re-issued, then Postgres
   restarted.
3. Grafana's own database: set `GF_DATABASE_CA_CERT_PATH` to a CA file mounted into the Grafana container, and set
   `GF_DATABASE_SSL_MODE` independently of the shared `POSTGRES_SSL_MODE` if it should differ.
4. Grafana datasources: set `GRAFANA_DS_SSL_MODE=verify-full` and, in the datasource file or an override copy, use one
   CA method: `jsonData.sslRootCertFile` pointing at a mounted CA file, with the default `tlsConfigurationMethod`
   (`file-path`). Do not mix it with `secureJsonData.tlsCACert`, which applies only to
   `tlsConfigurationMethod: file-content`. As in item 1, mount only the CA certificate.
:::

#### Grafana datasource reporting role (HAP-1827)

The Grafana datasources must connect as a dedicated read-only role, never as `POSTGRES_USER` (`cmdb_user`, the
bootstrap superuser). The role is **not created by this repository**; creating it needs an operator and SENSITIVE
review. Proposed, not run (and not validated against a live server):

```sql
-- Run as a superuser on the cmdb database. Set the password from your secret store; never commit it.
CREATE ROLE grafana_reporting LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
  CONNECTION LIMIT 20 PASSWORD '<from secret store>';  -- two datasources x maxOpenConns 10
ALTER ROLE grafana_reporting SET default_transaction_read_only = on;
ALTER ROLE grafana_reporting SET statement_timeout = '30s';
GRANT CONNECT ON DATABASE cmdb TO grafana_reporting;
GRANT USAGE ON SCHEMA cmdb, public TO grafana_reporting;
-- Column-level grants: only the columns the shipped dashboards read (derived from dashboards/*.json; re-derive
-- when they change). Payload columns are deliberately left out: dim_ci.metadata / external_id,
-- fact_ci_changes.old_value / new_value / changed_by / metadata, fact_ci_relationships.properties,
-- connector_run_history.errors / error_message / triggered_by_user. Migration 033 (HAP-644) already keeps these
-- tables closed to PUBLIC and BI for the same reason.
GRANT SELECT (ci_key, ci_name, ci_type, ci_status, environment, is_current, created_at)
  ON cmdb.dim_ci TO grafana_reporting;
GRANT SELECT (change_key, ci_key, change_type, field_name, changed_at, change_source)
  ON cmdb.fact_ci_changes TO grafana_reporting;
GRANT SELECT (from_ci_key, to_ci_key, relationship_type, relationship_strength, discovered_at,
  last_verified_at, is_active)
  ON cmdb.fact_ci_relationships TO grafana_reporting;
GRANT SELECT (connector_type, config_name, started_at, status, duration_ms, records_loaded)
  ON public.connector_run_history TO grafana_reporting;
```

- **Two shipped panels need a decision before the role is used.** `cmdb-change-tracking.json` "Recent Changes with Field
  Details" reads `old_value`, `new_value` and `changed_by`, and `cmdb-discovery-operations.json` "Failed Discoveries by
  Connector (Last 7 Days)" reads `error_message`. Under the grants above both fail with permission denied. Either
  rewrite or retire them (dashboard JSON is outside HAP-1827), or accept the exposure by granting those columns.
- **Reuse of `metabase_readonly`**: rejected. `infrastructure/database/metabase-init.sql` revokes all table grants and
  grants only named `public` reporting views (plus `cmdb.v_ci_discovery_summary`); it has no grant on the four relations
  above, and widening it would also widen Metabase. A separate role keeps each BI tool's blast radius independent.
- **Not granted**: any other `public` table (`audit_log`, credentials, journals), any sequence, any `INSERT`/`UPDATE`/
  `DELETE`/`TRUNCATE`, and no default privileges for future tables. `default_transaction_read_only` is a role default a
  session can `SET` back, so the missing write grants are the control, not that setting. Privileges PUBLIC holds
  regardless of this role still apply: `CONNECT` on every database (the role can log in to `grafana`, `metabase` and
  `postgres`), `TEMPORARY`, and `EXECUTE` on functions (after a `--no-acl` restore this includes the SECURITY DEFINER
  `cmdb.fn_business_service_health`, which takes any organization id). Review those PUBLIC grants before use.
- **Tenant scoping**: no `CREATE POLICY` / `ROW LEVEL SECURITY` exists in the shipped migrations, so tenant scoping is
  application-side. `cmdb.dim_ci` has `organization_id`; `cmdb.fact_ci_changes` and `cmdb.fact_ci_relationships` have
  none, and `connector_run_history` gets it only from migration 018 (the compose `init-postgres.sql` does not add it).
  The role above therefore reads **every organization's** rows: safe only for single-organization deployments, or where
  every Grafana user may see all tenants. Multi-tenant Grafana needs a design decision first: a role per tenant plus RLS
  or `security_invoker` views whose filter keys on `current_user` (a role-to-organization mapping), **not** on a
  `SET`-able session setting such as `app.organization_id`, which anyone running free-form SQL can change.
- **Password delivery**: Grafana 10.2 provisioning expands `${VAR}` / `$__env{VAR}` from the environment and
  `$__file{path}` from a file (contents, trimmed). The shipped `postgres.yml` uses `password: ${GRAFANA_DS_PASSWORD}`,
  so by default the password reaches the container's environment (from the deploy-time secret store, not from `.env`
  in git). **Recommended**: deliver it as a file secret, which keeps it out of the container environment
  (`docker inspect`, `/proc/<pid>/environ`). In `postgres.yml` use
  `password: $__file{/run/secrets/grafana_ds_password}` and mount the secret in a compose override:

  ```yaml
  services:
    grafana:
      secrets:
        - grafana_ds_password
  secrets:
    grafana_ds_password:
      file: ./secrets/grafana_ds_password   # operator-provided host file, not in git
  ```

  The shipped compose file does not make this switch: it needs a host secret file that the operator provides, and the
  file must be readable by the Grafana container user [INFERENCE: not exercised]. Grafana provisioning has no
  `${VAR:-default}` either: use plain `${VAR}` and let compose supply defaults.
  `GRAFANA_DS_USER` must be non-empty: with an empty user the driver falls back to the OS user and `PG*` environment,
  which fails only because the stock Postgres image requires password authentication [INFERENCE: not exercised].
- **Who can run free-form SQL**: Grafana provisioning has no read-only switch for the Postgres datasource, and [INFERENCE,
  Grafana OSS 10.2] any member of the Grafana organization, Viewers included, can send raw SQL to any datasource of
  that organization (per-datasource query permissions are Enterprise/Cloud only). That covers the default `HappyCMDB`
  datasource as well as `HappyCMDB (Explore)`; `editable: false` only blocks editing the datasource definitions. With
  `GRAFANA_ANONYMOUS_ENABLED=true` it is reachable without login. Keep anonymous access off whenever the role exists:
  the database role, and who may log in to Grafana, are the real controls.
- **Grafana's own metadata database is not covered by this change**: `GF_DATABASE_USER` / `GF_DATABASE_PASSWORD` in
  the compose `grafana` service are still `POSTGRES_USER` / `POSTGRES_PASSWORD` (the superuser), so the container
  environment still holds them. Moving Grafana to the dedicated `grafana_user` created by
  `infrastructure/scripts/init-metabase-db.sql` is a separate, operator-gated change.

#### Docker Compose Configuration

```yaml
postgres:
  command: >
    postgres
    -c shared_preload_libraries=timescaledb
    -c max_connections=200
    -c superuser_reserved_connections=3
    -c shared_buffers=2GB
    -c effective_cache_size=6GB
    -c maintenance_work_mem=512MB
    -c work_mem=128MB
    -c checkpoint_completion_target=0.9
    -c checkpoint_timeout=15min
    -c max_wal_size=4GB
    -c min_wal_size=1GB
    -c random_page_cost=1.1
    -c effective_io_concurrency=200
    -c log_min_duration_statement=1000
    -c log_line_prefix='%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
    -c log_checkpoints=on
    -c log_connections=on
    -c log_disconnections=on
    -c log_lock_waits=on
    -c ssl=on
    -c ssl_cert_file=/ssl/server.crt
    -c ssl_key_file=/ssl/server.key
    -c ssl_ca_file=/ssl/ca.crt
```

The `command: >` value is a folded scalar, so it carries no `# ...` comment lines (they would reach `postgres` as literal arguments). In order, the `-c` settings cover connections, memory (`shared_buffers`, `effective_cache_size`, `maintenance_work_mem`, `work_mem`), checkpoints, the query planner, logging and SSL.

**Memory Sizing Guidelines:**
- **shared_buffers** and **work_mem** by deployment tier: Small 256MB / 64MB, Medium 2GB / 128MB (the values above), Large 8GB / 256MB
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
    redis-server /usr/local/etc/redis/redis-auth.conf
    --maxmemory 2gb
    --maxmemory-policy allkeys-lru
    --appendonly yes
    --appendfsync everysec
    --auto-aof-rewrite-percentage 100
    --auto-aof-rewrite-min-size 64mb
    --hz 10
    --tcp-backlog 511
    --timeout 300
    --rename-command CONFIG ""
    --rename-command FLUSHDB ""
    --rename-command FLUSHALL ""
    --tls-port 6380
    --tls-cert-file /ssl/redis.crt
    --tls-key-file /ssl/redis.key
    --tls-ca-cert-file /ssl/ca.crt
    --tls-auth-clients yes
  volumes:
    - ./secrets/redis-auth.conf:/usr/local/etc/redis/redis-auth.conf:ro
  environment:
    # redis-cli reads REDISCLI_AUTH from its environment, so the healthcheck needs no -a flag
    REDISCLI_AUTH: ${REDIS_PASSWORD:?REDIS_PASSWORD is required}
  healthcheck:
    test: ["CMD-SHELL", "redis-cli ping"]
```

**Password handling**: do not pass `--requirepass` (or `redis-cli -a`) on a command line: `ps`, `/proc/<pid>/cmdline` and `docker top` show it. `redis-auth.conf` holds `requirepass "<hex-escaped password>"` and `masterauth "<hex-escaped password>"` (mode `0600`, owner `999:1000`, never committed); `redis-server` receives only its path. `infrastructure/kubernetes/statefulsets/redis-statefulset.yaml` builds the same file in an init container from the `redis-password` key of `cmdb-secrets` (HAP-1719), and `redis-cli` clients read the password from `REDISCLI_AUTH` (HAP-1664).

Generate the Compose `./secrets/redis-auth.conf` with the same pipeline as that init container. The password is read from `REDIS_PASSWORD` in the shell environment (`printf` is a shell builtin, and `od`, `tr` and `sed` see it only on stdin), so it never reaches an argv:

```bash
( set -eu; umask 077; mkdir -p secrets; hex=$(printf '%s' "${REDIS_PASSWORD:?REDIS_PASSWORD must be set}" | od -An -v -tx1 | tr -d ' \n' | sed 's/../\\x&/g'); [ -n "$hex" ]; printf 'requirepass "%s"\nmasterauth "%s"\n' "$hex" "$hex" > secrets/redis-auth.conf; chown 999:1000 secrets/redis-auth.conf )
```

Run it as root (for example `sudo --preserve-env=REDIS_PASSWORD sh`, then paste it): the last step, `chown 999:1000`, needs root. It is required under Compose because the official `redis` image's entrypoint starts `redis-server` as uid 999, gid 1000 (it drops from root only when the command is `redis-server`), and that uid cannot open a `0600` file owned by the operator through the `:ro` bind mount (`Fatal error, can't open config file ... Permission denied`). Owner `999:1000` with mode `0600` keeps the file unreadable by anyone else. The Kubernetes path is unchanged: its init container builds the file and `redis-statefulset.yaml` does not go through the image entrypoint.

**Rootless Docker and `userns-remap`.** `chown 999:1000` names host ids, so it is right only for a rootful daemon without `userns-remap`. With a user namespace, container uid 999 / gid 1000 (the identity the image entrypoint gives `redis-server`) is a different host id, and `redis-auth.conf` must be owned by that host id instead (`user_namespaces(7)`; the ranges are the `/etc/subuid` and `/etc/subgid` lines of the remap user). Check the result with `ls -ln secrets/redis-auth.conf`, which prints host ids.

- **`userns-remap`** (`"userns-remap"` in `/etc/docker/daemon.json`): container id `N` is host `<start> + N`, with `<start>` the first id of the remap user's range (for `dockremap:165536:65536` in both files, 999:1000 is `166535:166536`). Keep running the snippet as root, with its `chown` argument changed to those two host ids.
- **Rootless Docker**: container root is the invoking user, and container id `N >= 1` is host `<start> + N - 1` (for `alice:100000:65536`, 999:1000 is `100998:100999`). The operator cannot `chown` to a subordinate id, so run the snippet unprivileged without its trailing `; chown 999:1000 secrets/redis-auth.conf`, then do the `chown` inside the namespace, where container root owns the file: `docker run --rm --entrypoint chown -v "$PWD/secrets:/s" redis:7.2-alpine 999:1000 /s/redis-auth.conf`.

The `command: >` value above is a folded scalar: YAML folds every line into one string, so a `# ...` line inside it is not a comment but literal `redis-server` arguments. Keep comments out of it (put them above the key or in the prose).

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

#### Rate Limiting (Nginx)

`infrastructure/docker/nginx.conf` also rate-limits per client address in front of the application limits above:

| Zone | Applies to | Limit | Why |
|------|------------|-------|-----|
| `auth_limit` | `POST /api/v1/auth/login`, `PUT /api/v1/auth/password` (any letter case, optional trailing slash) | 5r/m, burst 2 | Password guessing. Only these two endpoints check a password. |
| `auth_session_limit` | Every other `/api/v1/auth/` path (`refresh`, `me`, `logout`, `profile`, `api-key(s)`, `account`) | 2r/s, burst 20 | Flood damping only. A page load sends `refresh` + `me`, and the web UI signs the user out on a 429 from `refresh`, so this zone admits 10 tabs restored at once. |
| `api_limit` / `graphql_limit` | Remaining `/api/` paths, `/graphql` | 100r/s burst 50, 50r/s burst 20 | General flood protection. |

**Behind a load balancer, CDN or NAT**, nginx sees the proxy's address, so every client shares one bucket and a few failed logins lock everyone out of `auth_limit`. Uncomment the `set_real_ip_from` / `real_ip_header` / `real_ip_recursive` lines at the top of `nginx.conf` and replace the `set_real_ip_from 203.0.113.10/32` placeholder (RFC 5737 documentation address) with your load balancer / proxy address, one line per address. The trusted proxy must set or append the `real_ip_header` value itself. If it does not (an L4 / TLS-passthrough load balancer, or an L7 proxy that passes the client's header through), any client chooses its own bucket by sending that header, whatever its own address; behind an L4 / TLS-passthrough load balancer use `real_ip_header proxy_protocol` and add `proxy_protocol` to the `listen 443` lines of `nginx.conf`. The trusted range must also contain only the load balancer / proxy, never client addresses: a client whose own address falls inside it chooses its own bucket by sending the header named by `real_ip_header` (`X-Forwarded-For` in the example) when it connects straight to nginx, with `real_ip_recursive` on or off. Through a proxy that appends with `$proxy_add_x_forwarded_for` it chooses only with `real_ip_recursive on`, which skips trusted hops from the right, including the client's own address; with `real_ip_recursive` off nginx takes the last `X-Forwarded-For` entry, which the proxy appends itself, so the client cannot choose. That choice re-keys every zone in `nginx.conf` (`api_limit`, `auth_limit`, `auth_session_limit`, `graphql_limit` and the `conn_limit` connection zone) and the api-server's per-client bucket, and it rewrites `$remote_addr`, which the `access_log ... combined` line in `nginx.conf` logs: wherever a client can choose its bucket it also chooses the logged address (`$realip_remote_addr` is the connecting peer; the shipped `combined` format does not log it). So never `0.0.0.0/0`, and never a broad range such as `10.0.0.0/8` that also holds clients. nginx then appends that client address to `X-Forwarded-For`, so the api-server's own limits keep `TRUST_PROXY=1`; see [Proxy Trust & Login Rate Limiting](/configuration/environment-variables#proxy-trust-login-rate-limiting).

`bash infrastructure/docker/test-nginx-auth-limits.sh` (needs Docker) runs the config against a stub upstream and checks these limits, including that a login sent with four different `X-Forwarded-For` values is still refused on the fourth (a client cannot choose its `auth_limit` bucket while `set_real_ip_from` stays commented out), that `auth_limit` still refuses a login 9 s after its burst (so a loosening to 10r/m fails) and admits one at 14 s.

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
  # requirepass is in redis-auth.conf (see Docker Compose Configuration above), never in argv
  command: redis-server /usr/local/etc/redis/redis-auth.conf
  volumes:
    - ./secrets/redis-auth.conf:/usr/local/etc/redis/redis-auth.conf:ro

# Redis sentinel
redis-sentinel:
  image: redis:7.2-alpine
  command: redis-sentinel /usr/local/etc/redis-sentinel/sentinel.conf
  volumes:
    - ./secrets/sentinel/:/usr/local/etc/redis-sentinel/
```

`secrets/sentinel/sentinel.conf` holds the monitor settings and `sentinel auth-pass cmdb-master <password>`. Without `auth-pass` the sentinels cannot authenticate to the master (its `redis-auth.conf` sets `requirepass`), so they report it `s_down` instead of monitoring it. A `--sentinel auth-pass` argument would put the password in argv, so it goes in the configuration file.

**Sentinel requires a config-safe password.** When Sentinel is used, `REDIS_PASSWORD` MUST match `^[A-Za-z0-9]+$` (generate one with `openssl rand -hex 32`). Sentinel rewrites its configuration file to persist state (`myid`, epochs, failover results) and writes `auth-pass` back unquoted and unescaped (`sentinel.c`, `sdscatprintf("sentinel auth-pass %s %s", ...)` in Redis 6.2, 7.2 and 7.4; only `unstable` quotes it). A password with whitespace, `"`, `'`, `\` or non-printable bytes is therefore corrupted by the first rewrite and the next Sentinel start fails with `FATAL CONFIG FILE ERROR ... Unbalanced quotes in configuration line`. `redis-auth.conf` is read by `redis-server`, which never rewrites it, so it keeps the hex escaping and accepts any password; only `sentinel.conf` is restricted. The generator below refuses a password that does not match, before it writes anything:

```bash
( set -eu; umask 077; export LC_ALL=C; case "${REDIS_PASSWORD:?REDIS_PASSWORD must be set}" in *[!A-Za-z0-9]*) echo 'REDIS_PASSWORD must match ^[A-Za-z0-9]+$ when Sentinel is used (sentinel.conf stores auth-pass unquoted); generate one with: openssl rand -hex 32' >&2; exit 1;; esac; mkdir -p secrets/sentinel; printf 'sentinel resolve-hostnames yes\nsentinel monitor cmdb-master redis-master 6379 1\nsentinel down-after-milliseconds cmdb-master 5000\nsentinel parallel-syncs cmdb-master 1\nsentinel failover-timeout cmdb-master 10000\nsentinel auth-pass cmdb-master %s\n' "$REDIS_PASSWORD" > secrets/sentinel/sentinel.conf )
```

The password reaches only the `printf` builtin and the redirect, never an argv. Do not commit `secrets/`.

**Run the Sentinel generator as root too, if the `redis-auth.conf` snippet did.** That snippet runs under `umask 077` as root, so it leaves `secrets/` owned by root with mode `0700`. A later unprivileged run of the generator above fails at `mkdir -p secrets/sentinel` (`Permission denied`; `set -e` makes it exit non-zero), and pre-creating `secrets/sentinel` would not help, because the redirect to `secrets/sentinel/sentinel.conf` still has to traverse the root-owned `secrets/`. Paste it into the same root shell (`sudo --preserve-env=REDIS_PASSWORD sh`). The `redis-sentinel` container runs as root, so a root-owned `secrets/sentinel` is what it needs.

**One sentinel is not HA.** The `redis-sentinel` service above is a single sentinel, so `sentinel monitor cmdb-master redis-master 6379 1` sets quorum `1`: the quorum is the number of sentinels that must agree the master is down (`SDOWN` to `ODOWN`), and a quorum above the sentinel count (for example `2` with one sentinel) can never be reached, so it can never authorize a failover. Quorum `1` lets this example mark `redis-master` objectively down, but there is no replica to promote either, so it gives monitoring, not failover. For HA run at least three sentinels on separate hosts with quorum `2` (a majority; a failover also needs a majority of all sentinels to authorize it), give each its own `secrets/sentinel` directory (every sentinel rewrites its file with its own `myid`), and define at least one replica of `redis-master`.

**Plaintext after the first flush.** Once Sentinel has rewritten `sentinel.conf` (it does at startup to save `myid`, and after every failover or epoch change) the file holds the password in plaintext, and its mode is then `0644 & ~umask` of the Sentinel process (upstream redis/redis#8369), not the `0600` the generator set. In the official image `redis-sentinel` runs under the entrypoint's `umask 0077`, so the file stays `0600`. On bare metal with the usual umask 022 it becomes `0644`, world-readable: run Sentinel under `umask 077` and keep the directory restrictive (`chmod 700 secrets/sentinel`).

**Why a directory mount, and who runs Sentinel.** Redis 7.x writes its configuration by creating a temporary file next to it and `rename`-ing it over the original (`rewriteConfigOverwriteFile` in `config.c`). `rename(2)` onto a bind-mounted single file fails with `EBUSY`, so a `./secrets/sentinel.conf:/usr/local/etc/redis/sentinel.conf` mount makes Sentinel log `Could not rename tmp config file (Device or resource busy)` and never persist its state. Mounting the directory (no `:ro`) lets the rename succeed. In the official `redis` image the entrypoint drops to uid 999 only when the command is `redis-server`; `redis-sentinel` runs as container root, so on a rootful daemon without `userns-remap` the root-owned directory needs no ownership change. Under `userns-remap` container root is host `<start>` (see the note under the `redis-auth.conf` snippet), so run `chown -R <start>:<start> secrets/sentinel` with the first id of the `/etc/subuid` and `/etc/subgid` ranges; under rootless Docker container root is the invoking user, who already owns the directory.

`sentinel resolve-hostnames yes` is required because `sentinel monitor` names the master by its Compose service name `redis-master`, a hostname.

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
