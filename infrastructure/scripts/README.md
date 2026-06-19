# HappyCMDB Infrastructure Scripts

This directory contains scripts for database initialization, backup/restore, and operational tasks.

## Script Categories

1. **Database Initialization & Seed Data** - Setup and test data scripts
2. **Backup & Restore** - Automated backup and recovery scripts
3. **Full Stack Startup** - Complete environment orchestration

---

# Backup & Restore Scripts

## Quick Reference

| Script | Description | Usage |
|--------|-------------|-------|
| `backup-all.sh` | Backup both databases | `./backup-all.sh` |
| `backup-postgres.sh` | Backup PostgreSQL only | `./backup-postgres.sh` |
| `backup-neo4j.sh` | Backup Neo4j only | `./backup-neo4j.sh` |
| `backup-health-check.sh` | Check backup health | `./backup-health-check.sh` |
| `restore-postgres.sh` | Restore PostgreSQL | `./restore-postgres.sh --file backup.sql.gz` |
| `restore-neo4j.sh` | Restore Neo4j | `./restore-neo4j.sh --file backup.dump.gz` |

## Backup Quick Start

### 1. Configure Environment

```bash
# Add to .env file
BACKUP_DIR=/var/backups/happycmdb
POSTGRES_PASSWORD=your-password
NEO4J_PASSWORD=your-password
```

### 2. Create Backup Directories

```bash
mkdir -p /var/backups/happycmdb/{postgres,neo4j}/{daily,weekly,monthly}
mkdir -p /var/log/happycmdb/backups
```

### 3. Run Backup

```bash
./backup-all.sh
```

## Backup Features

- **Compression**: gzip level 9
- **Retention**: 7 daily, 4 weekly, 12 monthly
- **Cloud Upload**: AWS S3, Azure Blob
- **Verification**: Integrity checks
- **Notifications**: Webhook support
- **Monitoring**: Health checks

## Restore Examples

### PostgreSQL

```bash
# List available backups
./restore-postgres.sh --list

# Restore latest backup
./restore-postgres.sh \
  --file $(ls -t /var/backups/happycmdb/postgres/daily/*.sql.gz | head -1) \
  --drop \
  --verify
```

### Neo4j

```bash
# List available backups
./restore-neo4j.sh --list

# Restore latest backup
./restore-neo4j.sh \
  --file $(ls -t /var/backups/happycmdb/neo4j/daily/*.dump.gz | head -1) \
  --force \
  --verify
```

## Complete Documentation

For detailed backup/restore documentation, see:
- [Backup & Restore Guide](/doc-site/docs/operations/backup-restore.md)
- Cron configuration: `/infrastructure/config/cron/happycmdb-backup.cron`
- Systemd configuration: `/infrastructure/config/systemd/`

---

# Database Initialization & Seed Data Scripts

This section contains comprehensive scripts for initializing and populating the HappyCMDB database with test data.

## v3.0 Initialization Scripts

### init-kafka.sh

**Location**: `/infrastructure/scripts/init-kafka.sh`

**Purpose**: Initialize all Kafka topics for v3.0 event streaming

**What it does**:
- Waits for Kafka to be ready (30 retry attempts with 5s delay)
- Creates 11 event topics with appropriate partitions and retention policies
- Uses snappy compression for all topics
- Configures different retention periods based on data importance

**Topics Created**:
| Topic | Partitions | Retention | Purpose |
|-------|-----------|-----------|---------|
| discovery-events | 3 | 7 days | CI discovery events |
| enrichment-events | 3 | 7 days | Attribute enrichment operations |
| change-events | 3 | 30 days | CI changes and updates |
| itil-events | 3 | 30 days | ITIL incident and change records |
| cost-events | 2 | 90 days | TBM cost allocation updates |
| bsm-events | 3 | 30 days | Business service mapping events |
| audit-events | 2 | 365 days | Audit trail (long retention) |
| alert-events | 4 | 7 days | Alert notifications |
| etl-events | 2 | 30 days | ETL job status and metrics |
| integration-events | 2 | 7 days | External system integrations |
| dlq-events | 1 | 90 days | Dead letter queue for failed messages |

**Usage**:
```bash
# Make executable
chmod +x infrastructure/scripts/init-kafka.sh

# Run script (Kafka must be running)
./infrastructure/scripts/init-kafka.sh
```

**Prerequisites**:
```bash
# Start Kafka and Zookeeper
docker-compose -f infrastructure/docker/docker-compose.yml up -d zookeeper kafka

# Wait for Kafka to be ready (script handles this automatically)
```

**Verification**:
```bash
# View topics in Kafka UI
open http://localhost:8090

# Or use CLI
docker exec cmdb-kafka kafka-topics --list --bootstrap-server localhost:9092
```

---

### init-metabase-db.sql

**Location**: `/infrastructure/scripts/init-metabase-db.sql`

**Purpose**: Initialize PostgreSQL databases for Metabase and Grafana application data

**What it does**:
- Creates `metabase_user` role with login credentials
- Creates `grafana_user` role with login credentials
- Creates `metabase` database owned by metabase_user
- Creates `grafana` database owned by grafana_user
- Grants all privileges on respective databases
- Uses conditional logic to avoid errors if already exists

**Usage**:
```bash
# Run via psql
psql -U postgres -h localhost -f infrastructure/scripts/init-metabase-db.sql

# Or via Docker
docker exec -i cmdb-postgres psql -U postgres < infrastructure/scripts/init-metabase-db.sql
```

**Security Notes**:
- Default passwords are `metabase_password_change_me` and `grafana_password_change_me`
- **IMPORTANT**: Change these passwords in production via `.env` file
- Set `METABASE_DB_PASSWORD` and `GRAFANA_ADMIN_PASSWORD` environment variables

**Post-Installation**:
```bash
# Access Metabase
open http://localhost:3002

# Complete initial setup
# 1. Create admin account
# 2. Add CMDB data mart as data source
#    - Type: PostgreSQL
#    - Host: postgres
#    - Port: 5432
#    - Database: cmdb
#    - Username: metabase_readonly (from .env)
#    - Password: <from METABASE_READONLY_PASSWORD in .env>
```

---

## Scripts Overview

### 1. init-neo4j.cypher

**Location**: `/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/scripts/init-neo4j.cypher`

**Purpose**: Neo4j database schema initialization and comprehensive test data creation

**What it does**:
- Creates database constraints (unique IDs for CIs, Users, all CI types)
- Creates performance indexes (single and composite indexes on CI properties)
- Creates full-text search indexes for CI names and metadata
- Creates admin user with authentication credentials
- Creates 30+ sample CIs:
  - 10 servers (Linux, Windows, various environments and statuses)
  - 5 applications (frontend, backend, workers)
  - 5 databases (Neo4j, PostgreSQL, Redis, MongoDB, MySQL)
  - 5 services (API Gateway, Auth, Metrics, Logs, Queue)
  - 5 network devices (Load Balancer, Switch, Firewall, Router, VPN)
  - 2 storage resources (S3, EBS)
- Creates 50+ relationships between CIs (HOSTS, DEPENDS_ON, USES, CONNECTS_TO, etc.)
- Includes realistic metadata for each CI
- Verification queries to confirm data was created

**Usage**:
```bash
# Run via cypher-shell
cat infrastructure/scripts/init-neo4j.cypher | docker exec -i neo4j cypher-shell -u neo4j -p cmdb_password_dev

# Or run via Neo4j Browser
# Copy/paste the contents into Neo4j Browser and execute
```

**Test Credentials Created**:
- Email: `admin@happycmdb.local`
- Username: `admin`
- Password: `Admin123!`
- Role: `admin`

**Sample Data Created**:
- 10 servers across production, staging, development environments
- Mix of active, inactive, maintenance, decommissioned statuses
- Realistic IP addresses, hostnames, cloud provider info
- Complete application stack (frontend → API → databases)
- Network infrastructure (load balancer, switches, firewall, router)
- Storage and backup relationships

---

### 2. seed-data.ts

**Location**: `/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/scripts/seed-data.ts`

**Purpose**: TypeScript/Node.js script to programmatically load comprehensive test data into Neo4j

**What it does**:
- Connects to Neo4j using neo4j-driver
- Optionally cleans existing test data
- Creates admin user with bcrypt-hashed password
- Creates 32 test CIs with full attributes and metadata:
  - 10 servers (production, staging, development)
  - 5 applications
  - 5 databases
  - 5 services
  - 5 network devices
  - 2 storage resources
- Creates 35+ relationships between CIs with properties
- Creates 7 discovery job history records (completed and running jobs)
- Displays comprehensive statistics after loading
- Validates all data was created successfully

**Usage**:
```bash
# Run with ts-node
npx ts-node infrastructure/scripts/seed-data.ts

# Or run with Node.js (after building)
npm run build
node infrastructure/scripts/seed-data.js

# Environment variables (optional)
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USERNAME=neo4j
export NEO4J_PASSWORD=cmdb_password_dev
npx ts-node infrastructure/scripts/seed-data.ts
```

**Features**:
- Idempotent (uses MERGE for CI creation)
- Transaction-safe
- Comprehensive error handling
- Progress logging
- Statistics display after completion
- Discovery job history for testing discovery features
- Realistic metadata for all CIs

**Output**:
```
HappyCMDB Seed Data Loader
==================================

Cleaning existing test data...
Cleanup complete
Creating admin user...
Admin user created: admin@happycmdb.local / Admin123!
Creating test CIs...
Created 32 test CIs
Creating relationships...
Created 35 relationships
Creating discovery job history...
Created 7 discovery job records

=== Database Statistics ===

CIs by type:
  server: 10
  application: 5
  database: 5
  service: 5
  network-device: 4
  load-balancer: 1
  storage: 2

Relationships by type:
  HOSTS: 15
  USES: 8
  DEPENDS_ON: 3
  CONNECTS_TO: 7
  BACKED_UP_BY: 2

Total users: 1
Total discovery jobs: 7

=== Seed Data Loading Complete ===

Test Credentials:
  Email: admin@happycmdb.local
  Password: Admin123!
  Role: admin

You can now login to the application using these credentials.
```

---

### 3. start-full-stack.sh

**Location**: `/Users/nczitzer/WebstormProjects/happycmdb/scripts/start-full-stack.sh`

**Purpose**: Complete full-stack startup script that orchestrates all services

**What it does**:
1. **Checks Docker services**: Verifies Neo4j, PostgreSQL, and Redis are running
2. **Builds packages**: Compiles TypeScript packages if not already built
3. **Checks environment**: Loads .env file and sets default environment variables
4. **Loads seed data**: Runs seed-data.ts to populate test data
5. **Starts API server**: Launches the API server in the background
6. **Waits for readiness**: Polls health endpoint until server is ready
7. **Displays summary**: Shows all URLs, credentials, and testing commands

**Usage**:
```bash
# Start everything (builds, seeds, starts)
./scripts/start-full-stack.sh

# Skip seed data loading
./scripts/start-full-stack.sh --no-seed

# Skip building packages
./scripts/start-full-stack.sh --no-build

# Skip both
./scripts/start-full-stack.sh --no-seed --no-build

# Show help
./scripts/start-full-stack.sh --help
```

**Prerequisites**:
```bash
# Start Docker services first
docker-compose up -d
```

**Features**:
- Color-coded output (green = success, red = error, yellow = info)
- Progress indicators for each step
- Docker service health checks
- API server health polling with timeout
- Background process management (saves PID to .api.pid)
- Comprehensive error handling
- Helpful test commands in output

**Output**:
```
=========================================
HappyCMDB Full Stack Started Successfully!
=========================================

Service URLs:
  API Server:       http://localhost:8080
  Health Check:     http://localhost:8080/api/health
  GraphQL:          http://localhost:8080/graphql
  Metrics:          http://localhost:8080/metrics

Test Credentials:
  Email:            admin@happycmdb.local
  Password:         Admin123!
  Role:             admin

Test Authentication:
  Login endpoint:   POST http://localhost:8080/api/v1/auth/login
  Example curl:
  curl -X POST http://localhost:8080/api/v1/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username": "admin", "password": "Admin123!"}'

Quick API Tests:
  # Get all CIs
  curl http://localhost:8080/api/v1/cis

  # Search CIs by type
  curl http://localhost:8080/api/v1/cis?type=server

  # Get CI relationships
  curl http://localhost:8080/api/v1/cis/srv-prod-web-01/relationships

Database Statistics:
  Total CIs:        32

Logs:
  API Server:       tail -f /path/to/api-server.log
  Docker Services:  docker-compose logs -f

To stop the API server:
  kill $(cat .api.pid)

To stop all services:
  docker-compose down

Happy Testing! 🎉
```

---

## Complete Workflow

### Initial Setup

```bash
# 1. Clone repository
cd /Users/nczitzer/WebstormProjects/happycmdb

# 2. Install dependencies
npm install

# 3. Start Docker services
docker-compose up -d

# 4. Wait for services to be ready (30 seconds)
sleep 30

# 5. Run full stack startup
./scripts/start-full-stack.sh
```

### Testing Authentication

```bash
# Login to get JWT token
curl -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "Admin123!"}' \
  | jq .

# Expected response:
# {
#   "success": true,
#   "data": {
#     "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
#     "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
#     "expiresIn": 3600,
#     "user": {
#       "id": "user-admin-001",
#       "username": "admin",
#       "role": "admin"
#     }
#   }
# }

# Use token for authenticated requests
TOKEN="<your-access-token>"
curl http://localhost:8080/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

### Testing CI Queries

```bash
# Get all CIs
curl http://localhost:8080/api/v1/cis | jq .

# Get CIs by type
curl http://localhost:8080/api/v1/cis?type=server | jq .

# Get specific CI
curl http://localhost:8080/api/v1/cis/srv-prod-web-01 | jq .

# Get CI relationships
curl http://localhost:8080/api/v1/cis/srv-prod-web-01/relationships | jq .

# Search CIs
curl http://localhost:8080/api/v1/search?q=production | jq .
```

### Testing GraphQL

```bash
# GraphQL query
curl -X POST http://localhost:8080/graphql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ cis(type: \"server\") { id name status environment } }"
  }' | jq .
```

---

## Troubleshooting

### Docker Services Not Running

```bash
# Check Docker services
docker ps

# If not running, start them
docker-compose up -d

# Check logs
docker-compose logs -f neo4j
docker-compose logs -f postgres
docker-compose logs -f redis
```

### API Server Won't Start

```bash
# Check API server logs
tail -f api-server.log

# Check if port is already in use
lsof -i :8080

# Kill existing process
kill $(lsof -t -i :8080)

# Restart
./scripts/start-full-stack.sh
```

### Neo4j Connection Errors

```bash
# Verify Neo4j is accessible
docker exec -it neo4j cypher-shell -u neo4j -p cmdb_password_dev

# Test connection
MATCH (n) RETURN count(n) LIMIT 1;

# Check environment variables
echo $NEO4J_URI
echo $NEO4J_PASSWORD
```

### Seed Data Issues

```bash
# Run seed script manually with debug
NEO4J_URI=bolt://localhost:7687 \
NEO4J_USERNAME=neo4j \
NEO4J_PASSWORD=cmdb_password_dev \
npx ts-node infrastructure/scripts/seed-data.ts

# Clear all data and re-seed
docker exec -it neo4j cypher-shell -u neo4j -p cmdb_password_dev \
  "MATCH (n) DETACH DELETE n"

npx ts-node infrastructure/scripts/seed-data.ts
```

---

## Sample Data Details

### Test Credentials

| Field | Value |
|-------|-------|
| Email | admin@happycmdb.local |
| Username | admin |
| Password | Admin123! |
| Role | admin |
| Enabled | true |

### CI Breakdown

| Type | Count | Environments | Statuses |
|------|-------|--------------|----------|
| Server | 10 | prod (5), staging (2), dev (1) | active (8), maintenance (1), decommissioned (1) |
| Application | 5 | prod (5) | active (5) |
| Database | 5 | prod (5) | active (4), inactive (1) |
| Service | 5 | prod (5) | active (5) |
| Network Device | 5 | prod (5) | active (5) |
| Storage | 2 | prod (2) | active (2) |

### Relationship Breakdown

| Type | Count | Description |
|------|-------|-------------|
| HOSTS | 15 | Server/container hosts application/service |
| USES | 8 | Application uses database/service |
| DEPENDS_ON | 3 | Application depends on another service |
| CONNECTS_TO | 7 | Network connectivity between components |
| BACKED_UP_BY | 2 | Database backed up to storage |

### Discovery Jobs

| Provider | Status | CIs Discovered | Errors |
|----------|--------|----------------|--------|
| aws | completed | 45, 48, 50 | 0, 2, 0 |
| azure | completed | 12 | 0 |
| gcp | completed | 8 | 0 |
| ssh | completed | 15 | 1 |
| nmap | running | 0 | 0 |

---

## Environment Variables

All scripts support these environment variables:

```bash
# Neo4j
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=cmdb_password_dev

# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=cmdb_datamart
POSTGRES_USER=postgres
POSTGRES_PASSWORD=cmdb_password_dev

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# API Server
API_PORT=8080
JWT_SECRET=dev-secret-key-change-in-production
```

---

## Next Steps

After running these scripts, you can:

1. **Test the API** using the provided curl commands
2. **Explore the UI** at http://localhost:3000 (if running)
3. **Query Neo4j** directly via cypher-shell or Neo4j Browser
4. **Run discovery jobs** to add more CIs
5. **Test GraphQL** queries at http://localhost:8080/graphql
6. **View metrics** at http://localhost:8080/metrics

---

## Files Created

| File | Purpose | Lines |
|------|---------|-------|
| `init-neo4j.cypher` | Neo4j schema + test data | 959 |
| `seed-data.ts` | Programmatic data loader | 1100+ |
| `start-full-stack.sh` | Full stack orchestration | 250+ |

**Total**: Comprehensive test environment with 30+ CIs, 50+ relationships, discovery history, and full authentication.
