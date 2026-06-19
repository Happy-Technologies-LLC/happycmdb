# Migrating to v3.0

Complete guide for upgrading HappyCMDB from v2.0 to v3.0.

## Overview

HappyCMDB v3.0 introduces significant new capabilities while maintaining backward compatibility for most features. This guide walks you through the upgrade process step-by-step.

**Estimated Migration Time**: 2-4 hours (depending on data volume)

**Downtime Required**: Yes, approximately 15-30 minutes

---

## What's New in v3.0

### Major Features

1. **Unified Service Interface** - Integrates ITIL, TBM, and BSM into a cohesive framework
2. **ITIL v4 Service Management** - Incident, problem, change, and service request management
3. **TBM v5.0.1 Cost Transparency** - Complete IT financial management with 11 capability towers
4. **Business Service Mapping (BSM)** - Impact analysis and service dependency mapping
5. **Multi-Stakeholder Dashboards** - 5 role-based dashboards (Executive, CIO, FinOps, ITSM, Service Owner)
6. **Event Streaming** - Optional Kafka integration for real-time updates
7. **Business Intelligence** - Metabase integration for self-service analytics
8. **Enhanced Credentials** - Protocol-based unified credential system with affinity matching

### Infrastructure Additions

- **Kafka** - Event streaming platform (optional)
- **Zookeeper** - Kafka coordination service (optional)
- **Metabase** - Business intelligence platform (optional)
- **Grafana Database** - Separate database for Grafana metadata

---

## Breaking Changes

### 1. Credential Management

**Before (v2.0)**: Credentials stored in environment variables
```bash
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AZURE_CLIENT_ID=12345678-1234-1234-1234-123456789012
AZURE_CLIENT_SECRET=your-azure-secret
```

**After (v3.0)**: Credentials stored in PostgreSQL database
```json
{
  "_name": "AWS Production Account",
  "_protocol": "aws_iam",
  "_scope": "cloud_provider",
  "_credentials": {
    "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
    "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  }
}
```

**Migration Required**: Yes - See [Credential Migration](#credential-migration)

---

### 2. Environment Variables

**Removed Variables**:
```bash
# Cloud provider credentials (use unified credential system)
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AZURE_CLIENT_ID
AZURE_CLIENT_SECRET
AZURE_TENANT_ID
GCP_PROJECT_ID
GCP_SERVICE_ACCOUNT_KEY_PATH

# Feature flags (always enabled in v3.0)
FEATURE_AWS_INGESTION
FEATURE_AZURE_INGESTION
FEATURE_GCP_INGESTION
AWS_ENABLED
AZURE_ENABLED
GCP_ENABLED

# Legacy ServiceNow credentials
SERVICENOW_USERNAME
SERVICENOW_PASSWORD
```

**New Variables**:
```bash
# Kafka event streaming (optional)
KAFKA_ENABLED=false
KAFKA_BROKERS=localhost:9092
KAFKA_UI_PORT=8090

# Metabase BI integration
METABASE_PORT=3002
METABASE_DATABASE=metabase
METABASE_DB_PASSWORD=your-metabase-password
METABASE_ENCRYPTION_KEY=your-32-character-encryption-key

# v3.0 unified framework (always enabled, no flags needed)
# ITIL, TBM, BSM attributes automatically added to all CIs
```

---

### 3. Database Schema

**New PostgreSQL Tables**:
- `business_services` - Business service definitions
- `service_dependencies` - Service dependency mappings
- `itil_incidents` - ITIL incident records
- `itil_changes` - ITIL change records
- `itil_problems` - ITIL problem records
- `itil_service_requests` - ITIL service request records
- `tbm_cost_pools` - TBM cost pool allocations
- `cost_allocations` - Cost allocation rules
- `metabase` database - Metabase application database
- `grafana` database - Grafana application database

**Modified Tables**:
- `dim_ci` - Added columns:
  - `itil_attributes` (JSONB) - ITIL v4 attributes
  - `tbm_attributes` (JSONB) - TBM cost attributes
  - `bsm_attributes` (JSONB) - BSM impact attributes
  - `unified_attributes` (JSONB) - Unified framework metadata

**Neo4j Schema**:
- All CIs automatically enriched with `itil_attributes`, `tbm_attributes`, `bsm_attributes`
- No manual migration needed (enrichment happens during discovery)

---

### 4. API Changes

**New Endpoints**:
- `POST /api/v1/credentials` - Unified credentials API
- `GET /api/v1/tbm/costs/*` - Financial management API
- `GET /api/v1/dashboards/*` - Multi-stakeholder dashboards
- `POST /api/v1/services` - Business service management

**Disabled Endpoints** (temporarily in v3.0):
- `POST /api/v1/itil/incidents` - Not yet connected to UI
- `POST /api/v1/itil/changes` - Not yet connected to UI
- `POST /api/v1/unified/*` - Some unified routes disabled

**See**: [API Documentation](/api/overview.md) for complete reference

---

### 5. Docker Compose

**New Services**:
```yaml
zookeeper:        # Kafka coordination (optional)
kafka:            # Event streaming (optional)
kafka-ui:         # Kafka web interface (optional)
metabase:         # Business intelligence (optional)
```

**Updated Services**:
- `postgres` - Now hosts additional databases (metabase, grafana)
- `api-server` - Includes v3.0 enrichment logic

---

## Pre-Migration Checklist

Before starting the migration, complete these prerequisites:

### 1. Backup Everything

```bash
# Backup Neo4j
./infrastructure/scripts/backup-neo4j.sh

# Backup PostgreSQL
./infrastructure/scripts/backup-postgres.sh

# Verify backups exist
ls -lh /var/backups/happycmdb/neo4j/
ls -lh /var/backups/happycmdb/postgres/
```

### 2. Document Current Configuration

```bash
# Export current environment variables
env | grep -E '(AWS|AZURE|GCP|CMDB|NEO4J|POSTGRES|REDIS)' > pre-migration-env.txt

# Export current credentials
# Document all cloud provider credentials for manual migration
```

### 3. Check Disk Space

v3.0 requires additional disk space for new databases:

```bash
# Check available space (need at least 5GB free)
df -h /var/lib/docker
df -h /var/backups
```

### 4. Review Dependencies

```bash
# Ensure Docker has enough resources
docker info | grep -E '(CPUs|Total Memory)'

# Minimum requirements:
# - 4 CPU cores
# - 8GB RAM
# - 20GB disk space
```

### 5. Schedule Maintenance Window

- **Recommended**: Off-peak hours (weekend or evening)
- **Duration**: 2-4 hours
- **Notify**: All stakeholders of planned downtime

---

## Step-by-Step Migration

### Step 1: Stop Current Services

```bash
# Stop all running containers
cd /path/to/happycmdb
docker-compose -f infrastructure/docker/docker-compose.yml down

# Verify all containers stopped
docker ps -a | grep cmdb
```

### Step 2: Pull Latest Code

```bash
# Fetch v3.0 branch
git fetch origin
git checkout main  # or your v3.0 branch

# Verify version
grep "version" package.json
# Should show v3.0.0 or higher
```

### Step 3: Update Dependencies

```bash
# Install/update npm packages
npm install

# Build all packages
npm run build

# Verify build succeeded
ls -la packages/*/dist/
```

### Step 4: Update Environment Variables

```bash
# Copy existing .env to backup
cp .env .env.v2.0.backup

# Update .env with v3.0 variables
cp .env.example .env.v3.0.template

# Merge old settings into new template
# MANUAL STEP: Edit .env to include:
# 1. Keep existing database passwords
# 2. Remove deprecated variables (AWS_ACCESS_KEY_ID, etc.)
# 3. Add new v3.0 variables (KAFKA_*, METABASE_*)
```

**Key Changes to .env**:
```bash
# Remove these (use credential system instead)
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AZURE_CLIENT_ID=...

# Add these (optional Kafka)
KAFKA_ENABLED=false  # Set true if you want event streaming
KAFKA_BROKERS=localhost:9092
KAFKA_UI_PORT=8090

# Add these (Metabase)
METABASE_PORT=3002
METABASE_DB_PASSWORD=generate-secure-password
METABASE_ENCRYPTION_KEY=generate-32-character-key
```

### Step 5: Database Migration

#### 5.1 PostgreSQL Schema Update

```bash
# Start only PostgreSQL
docker-compose -f infrastructure/docker/docker-compose.yml up -d postgres

# Wait for PostgreSQL to be ready
sleep 10

# Run v3.0 schema migrations
# The migrations are idempotent and will add new tables/columns
docker exec -i cmdb-postgres psql -U cmdb_user -d cmdb <<EOF
-- Check current schema version
SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 1;
EOF

# Apply v3.0 migrations (if not already applied)
# These add: business_services, itil_*, tbm_*, updated dim_ci
npm run db:migrate
```

#### 5.2 Initialize Metabase and Grafana Databases

```bash
# Create Metabase and Grafana application databases
docker exec -i cmdb-postgres psql -U postgres < infrastructure/scripts/init-metabase-db.sql

# Verify databases created
docker exec cmdb-postgres psql -U postgres -c "\l" | grep -E "(metabase|grafana)"
```

#### 5.3 Neo4j (No Migration Needed)

Neo4j schema is automatically updated during first discovery run.
v3.0 attributes (`itil_attributes`, `tbm_attributes`, `bsm_attributes`) are added via enrichment.

### Step 6: Credential Migration

This is the most important manual step in the migration.

#### 6.1 Export Existing Credentials

```bash
# Review your v2.0 credentials from backup
cat .env.v2.0.backup | grep -E '(AWS|AZURE|GCP)_'
```

#### 6.2 Start API Server

```bash
# Start core services (Neo4j, PostgreSQL, Redis, API)
docker-compose -f infrastructure/docker/docker-compose.yml up -d neo4j postgres redis api-server

# Wait for API to be ready
sleep 30
curl http://localhost:3000/api/health
```

#### 6.3 Create Credentials via API

For each cloud provider in your v2.0 setup, create a unified credential:

**AWS Example**:
```bash
# Get JWT token first
TOKEN=$(curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin123!"}' \
  | jq -r '.data.accessToken')

# Create AWS credential
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "AWS Production Account",
    "_protocol": "aws_iam",
    "_scope": "cloud_provider",
    "_credentials": {
      "accessKeyId": "YOUR_AWS_ACCESS_KEY_ID",
      "secretAccessKey": "YOUR_AWS_SECRET_ACCESS_KEY",
      "region": "us-east-1"
    },
    "_affinity": {
      "_cloud_providers": ["aws"],
      "_environments": ["production"]
    },
    "_tags": ["aws", "production", "cloud"]
  }'
```

**Azure Example**:
```bash
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "Azure Production Subscription",
    "_protocol": "azure_sp",
    "_scope": "cloud_provider",
    "_credentials": {
      "clientId": "YOUR_AZURE_CLIENT_ID",
      "clientSecret": "YOUR_AZURE_CLIENT_SECRET",
      "tenantId": "YOUR_AZURE_TENANT_ID",
      "subscriptionId": "YOUR_SUBSCRIPTION_ID"
    },
    "_affinity": {
      "_cloud_providers": ["azure"],
      "_environments": ["production"]
    },
    "_tags": ["azure", "production", "cloud"]
  }'
```

**GCP Example**:
```bash
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "GCP Production Project",
    "_protocol": "gcp_sa",
    "_scope": "cloud_provider",
    "_credentials": {
      "projectId": "YOUR_GCP_PROJECT_ID",
      "serviceAccountKey": "YOUR_SERVICE_ACCOUNT_JSON"
    },
    "_affinity": {
      "_cloud_providers": ["gcp"],
      "_environments": ["production"]
    },
    "_tags": ["gcp", "production", "cloud"]
  }'
```

#### 6.4 Update Discovery Definitions

Update your discovery definitions to use new credential IDs:

```bash
# List credentials to get IDs
curl -X GET http://localhost:3000/api/v1/credentials \
  -H "Authorization: Bearer $TOKEN" | jq

# Update each discovery definition with new credential_id
curl -X PUT http://localhost:3000/api/v1/discovery-definitions/{definition-id} \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "credential_id": "NEW_CREDENTIAL_UUID"
  }'
```

### Step 7: Optional Services (Kafka & Metabase)

#### 7.1 Kafka Setup (Optional)

If you want real-time event streaming:

```bash
# Update .env
KAFKA_ENABLED=true

# Start Kafka services
docker-compose -f infrastructure/docker/docker-compose.yml up -d zookeeper kafka kafka-ui

# Wait for Kafka to be ready
sleep 30

# Initialize topics
chmod +x infrastructure/scripts/init-kafka.sh
./infrastructure/scripts/init-kafka.sh

# Verify topics created
docker exec cmdb-kafka kafka-topics --list --bootstrap-server localhost:9092

# Access Kafka UI
open http://localhost:8090
```

#### 7.2 Metabase Setup (Optional)

If you want self-service BI dashboards:

```bash
# Start Metabase
docker-compose -f infrastructure/docker/docker-compose.yml up -d metabase

# Wait for Metabase to initialize (first start takes 2-3 minutes)
sleep 180

# Access Metabase setup
open http://localhost:3002

# Complete setup wizard:
# 1. Create admin account
# 2. Add PostgreSQL database:
#    - Name: HappyCMDB
#    - Host: postgres
#    - Port: 5432
#    - Database: cmdb
#    - Username: metabase_readonly (create this user)
#    - Password: from METABASE_READONLY_PASSWORD env var
```

### Step 8: Start All Services

```bash
# Start everything
docker-compose -f infrastructure/docker/docker-compose.yml up -d

# Verify all containers running
docker ps | grep cmdb

# Check logs for errors
docker-compose -f infrastructure/docker/docker-compose.yml logs -f --tail=50
```

### Step 9: Run Discovery

Trigger discovery to populate v3.0 attributes:

```bash
# Trigger discovery via API
curl -X POST http://localhost:3000/api/v1/discovery-definitions/{definition-id}/run \
  -H "Authorization: Bearer $TOKEN"

# Monitor discovery progress
curl -X GET http://localhost:3000/api/v1/jobs | jq
```

During discovery, CIs will be automatically enriched with:
- **ITIL attributes**: Configuration class, lifecycle status, baseline compliance
- **TBM attributes**: Capability tower, cost allocation, monthly/annual costs
- **BSM attributes**: Business criticality, service dependencies, impact tier

---

## Post-Migration Verification

### 1. Health Checks

```bash
# API health
curl http://localhost:3000/api/health

# Database connections
docker exec cmdb-postgres psql -U postgres -c "SELECT version();"
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "MATCH (n) RETURN count(n) LIMIT 1;"

# Redis connection
docker exec cmdb-redis redis-cli PING
```

### 2. Verify v3.0 Features

#### Check CI Enrichment

```bash
# Verify v3.0 attributes exist on CIs
curl "http://localhost:3000/api/v1/cis?limit=1" \
  -H "Authorization: Bearer $TOKEN" | jq '.[0] | {
    id,
    itil_attributes,
    tbm_attributes,
    bsm_attributes
  }'
```

Expected: All three attribute fields should be populated.

#### Check Dashboards

```bash
# Access dashboards
open http://localhost:3001/dashboards/executive
open http://localhost:3001/dashboards/finops
open http://localhost:3001/dashboards/itsm
```

Expected: Dashboards should load with real data (not mock data).

#### Check Credentials

```bash
# List credentials
curl "http://localhost:3000/api/v1/credentials" \
  -H "Authorization: Bearer $TOKEN" | jq '.data.credentials | length'
```

Expected: Should show count of migrated credentials.

### 3. Verify Data Integrity

```bash
# Check PostgreSQL data mart
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "
  SELECT
    COUNT(*) as total_cis,
    COUNT(itil_attributes) as cis_with_itil,
    COUNT(tbm_attributes) as cis_with_tbm,
    COUNT(bsm_attributes) as cis_with_bsm
  FROM dim_ci;
"
```

Expected: Most CIs should have all three attribute types.

### 4. Test Discovery

```bash
# Run a test discovery job
curl -X POST http://localhost:3000/api/v1/discovery-definitions/{definition-id}/run \
  -H "Authorization: Bearer $TOKEN"

# Check job status
curl "http://localhost:3000/api/v1/jobs/{job-id}" \
  -H "Authorization: Bearer $TOKEN" | jq '.status'
```

Expected: Job should complete successfully using new credentials.

---

## Rollback Procedure

If migration fails, roll back to v2.0:

### Quick Rollback (Recommended)

```bash
# 1. Stop all v3.0 services
docker-compose -f infrastructure/docker/docker-compose.yml down

# 2. Restore v2.0 configuration
cp .env.v2.0.backup .env

# 3. Checkout v2.0 code
git checkout v2.0-stable  # or your v2.0 branch

# 4. Restore databases from backup
./infrastructure/scripts/restore-postgres.sh --file /var/backups/happycmdb/postgres/latest.sql.gz
./infrastructure/scripts/restore-neo4j.sh --file /var/backups/happycmdb/neo4j/latest.dump.gz

# 5. Start v2.0 services
docker-compose up -d

# 6. Verify v2.0 is running
curl http://localhost:3000/api/health
```

### Partial Rollback (Keep Data, Revert Code)

If you want to keep discovered data but revert code:

```bash
# 1. Stop services
docker-compose down

# 2. Revert code only
git checkout v2.0-stable

# 3. Restore environment
cp .env.v2.0.backup .env

# 4. Restart with v2.0 code (databases keep v3.0 data)
docker-compose up -d
```

**Warning**: v2.0 code may not understand v3.0 schema changes.

---

## Troubleshooting

### Issue: "Credential not found" errors

**Cause**: Discovery definitions still reference old environment variables

**Solution**:
```bash
# List all discovery definitions
curl -X GET http://localhost:3000/api/v1/discovery-definitions \
  -H "Authorization: Bearer $TOKEN"

# Update each with new credential ID
# See Step 6.4 above
```

---

### Issue: Dashboards show no data

**Cause**: CIs not yet enriched with v3.0 attributes

**Solution**:
```bash
# Trigger full discovery to enrich all CIs
curl -X POST http://localhost:3000/api/v1/discovery-definitions/{id}/run \
  -H "Authorization: Bearer $TOKEN"

# Or manually trigger enrichment
# This will be added in future v3.0 update
```

---

### Issue: Metabase won't start

**Cause**: Database not initialized or encryption key missing

**Solution**:
```bash
# Check Metabase database exists
docker exec cmdb-postgres psql -U postgres -c "\l" | grep metabase

# If missing, run initialization
docker exec -i cmdb-postgres psql -U postgres < infrastructure/scripts/init-metabase-db.sql

# Check encryption key is set
grep METABASE_ENCRYPTION_KEY .env

# Must be exactly 32 characters
```

---

### Issue: Kafka topics not created

**Cause**: Kafka not fully ready when init script ran

**Solution**:
```bash
# Wait for Kafka to be ready
sleep 60

# Rerun topic initialization
./infrastructure/scripts/init-kafka.sh

# Verify topics
docker exec cmdb-kafka kafka-topics --list --bootstrap-server localhost:9092
```

---

### Issue: "Migration failed" during database migration

**Cause**: PostgreSQL version incompatibility or missing permissions

**Solution**:
```bash
# Check PostgreSQL version (need 15+)
docker exec cmdb-postgres psql -U postgres -c "SELECT version();"

# Check user permissions
docker exec cmdb-postgres psql -U postgres -c "
  SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
  WHERE grantee = 'cmdb_user';
"

# Grant missing permissions
docker exec cmdb-postgres psql -U postgres -c "
  GRANT ALL PRIVILEGES ON DATABASE cmdb TO cmdb_user;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cmdb_user;
"
```

---

## Migration Checklist

Use this checklist to track your migration progress:

- [ ] **Pre-Migration**
  - [ ] Backup Neo4j database
  - [ ] Backup PostgreSQL database
  - [ ] Document current credentials
  - [ ] Check disk space (>5GB free)
  - [ ] Schedule maintenance window
  - [ ] Notify stakeholders

- [ ] **Migration**
  - [ ] Stop all services
  - [ ] Pull v3.0 code
  - [ ] Update dependencies (npm install)
  - [ ] Build packages (npm run build)
  - [ ] Update .env file
  - [ ] Run PostgreSQL migrations
  - [ ] Initialize Metabase/Grafana databases
  - [ ] Migrate credentials to unified system
  - [ ] Update discovery definitions
  - [ ] (Optional) Set up Kafka
  - [ ] (Optional) Set up Metabase
  - [ ] Start all services

- [ ] **Verification**
  - [ ] Health checks pass
  - [ ] CIs have v3.0 attributes
  - [ ] Dashboards load with data
  - [ ] Credentials listed in API
  - [ ] Discovery jobs succeed
  - [ ] No errors in logs

- [ ] **Post-Migration**
  - [ ] Test all discovery definitions
  - [ ] Verify dashboards for each role
  - [ ] Train users on new features
  - [ ] Update runbooks/documentation
  - [ ] Monitor for 24 hours
  - [ ] Remove old environment variables from .env
  - [ ] Archive v2.0 backups

---

## Getting Help

If you encounter issues during migration:

1. **Check Logs**:
   ```bash
   docker-compose logs -f api-server
   docker-compose logs -f postgres
   docker-compose logs -f neo4j
   ```

2. **Review Documentation**:
   - [Configuration Guide](/configuration/environment-variables.md)
   - [Troubleshooting Guide](/operations/troubleshooting.md)
   - [API Reference](/api/overview.md)

3. **Community Support**:
   - GitHub Issues: https://github.com/happycmdb/happycmdb/issues
   - Discussions: https://github.com/happycmdb/happycmdb/discussions

4. **Emergency Rollback**: Follow [Rollback Procedure](#rollback-procedure)

---

## Next Steps

After successful migration:

1. **Explore New Features**:
   - [Executive Dashboard User Guide](/user-guides/executive-dashboard.md)
   - [FinOps Dashboard User Guide](/user-guides/finops-dashboard.md)
   - [ITSM Operations Guide](/user-guides/itsm-operations.md)

2. **Configure v3.0 Features**:
   - [Business Service Mapping](/components/bsm-impact-engine.md)
   - [Cost Management](/components/tbm-cost-engine.md)
   - [ITIL Service Management](/components/itil-service-manager.md)

3. **Optimize Configuration**:
   - Set up Kafka for real-time updates
   - Configure Metabase dashboards
   - Fine-tune cost allocation rules
   - Define business services

4. **Training**:
   - Train executives on Executive Dashboard
   - Train finance team on FinOps Dashboard
   - Train IT ops on ITSM Dashboard
   - Train service owners on Service Dashboard

---

## FAQ

### Q: Do I need to migrate immediately?

**A**: No. v2.0 will continue to be supported for 6 months after v3.0 release. Plan migration during a maintenance window.

### Q: Can I run v2.0 and v3.0 in parallel?

**A**: Not recommended. They share the same databases. Use separate environments if you need parallel operation.

### Q: Will my existing CIs be lost?

**A**: No. All CIs are preserved. They will be enriched with v3.0 attributes during next discovery.

### Q: Do I need Kafka and Metabase?

**A**: No, both are optional. Core v3.0 features work without them.

### Q: How long does credential migration take?

**A**: 5-10 minutes per cloud provider (manual API calls).

### Q: Can I automate credential migration?

**A**: Yes, you can script it using the API. See [Unified Credentials API](/api/rest/unified.md) for examples.

---

## Version Compatibility

| Component | v2.0 | v3.0 | Notes |
|-----------|------|------|-------|
| Neo4j | 5.x | 5.x | No upgrade needed |
| PostgreSQL | 15+ | 15+ | No upgrade needed |
| Redis | 7.x | 7.x | No upgrade needed |
| Node.js | 20 LTS | 20 LTS | No upgrade needed |
| Docker | 24+ | 24+ | No upgrade needed |
| Kubernetes | 1.27+ | 1.27+ | No upgrade needed |

---

## Estimated Costs

If enabling optional v3.0 features:

| Feature | CPU | Memory | Disk | Monthly Cloud Cost |
|---------|-----|--------|------|-------------------|
| Kafka + Zookeeper | 2 cores | 4GB | 20GB | ~$30-50 |
| Metabase | 1 core | 2GB | 5GB | ~$15-25 |
| **Total Additional** | **3 cores** | **6GB** | **25GB** | **~$45-75** |

On-premises: No additional cost (uses existing infrastructure).

---

**Migration Guide Version**: 1.0
**Last Updated**: November 2025
**Applies To**: HappyCMDB v2.0 → v3.0
