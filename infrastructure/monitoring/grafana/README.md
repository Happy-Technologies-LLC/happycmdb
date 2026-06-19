# HappyCMDB - Grafana Dashboards

This directory contains Grafana dashboards and provisioning configurations for visualizing HappyCMDB's CMDB data mart (PostgreSQL/TimescaleDB).

## Overview

HappyCMDB provides **4 comprehensive dashboards** that query the TimescaleDB data mart:

1. **CMDB Overview Dashboard** - High-level inventory and metrics
2. **CMDB Discovery Operations** - Connector execution and performance
3. **CMDB Relationship Analytics** - Graph topology and dependencies
4. **CMDB Change Tracking** - CI change history and audit logs

All dashboards use **PostgreSQL queries** against the `cmdb` schema tables (dimensional model).

---

## Quick Start

### 1. Start Grafana with Docker Compose

```bash
# From project root
cd /Users/nczitzer/WebstormProjects/happycmdb

# Start all services (including Grafana)
docker-compose -f infrastructure/docker/docker-compose.yml up -d grafana

# Or use the deployment script
./deploy.sh
```

### 2. Access Grafana

- **URL**: http://localhost:3001
- **Default Username**: `admin`
- **Default Password**: Set in `.env` file (see `GRAFANA_ADMIN_PASSWORD`)

### 3. Dashboards Auto-Load

Dashboards are **automatically provisioned** on startup. No manual import needed!

Navigate to: **Home → Dashboards → HappyCMDB** folder

---

## Dashboard Details

### 1. CMDB Overview Dashboard

**Purpose**: High-level CMDB inventory and health metrics

**Key Panels**:
- **Total CIs by Type** (Pie Chart) - Distribution of CI types
- **CI Creation Rate** (Time Series) - New CIs discovered over time
- **CI Changes Per Day** (Bar Chart) - Change activity trends
- **Discovery Success Rate** (Gauge) - Connector health indicator
- **Total Active CIs** (Stat) - Current inventory count
- **Total Relationships** (Stat) - Active relationship count
- **Top 10 Most Connected CIs** (Table) - Dependency hotspots
- **CI Distribution by Environment** (Bar Chart) - Production vs. staging vs. dev
- **CI Status Distribution** (Pie Chart) - Active, inactive, maintenance, decommissioned

**Refresh Rate**: 5 minutes
**Default Time Range**: Last 30 days

---

### 2. CMDB Discovery Operations

**Purpose**: Monitor connector execution, success rates, and performance

**Key Panels**:
- **Discovery Jobs - Total/Completed/Failed/Running** (Stat Panels) - Job status counts
- **Discovery Duration Trends** (Time Series) - Connector execution times
- **Connector Success Rates** (Bar Chart) - % success rate per connector (last 7 days)
- **Failed Discoveries by Connector** (Table) - Error analysis with last error message
- **Average CIs Discovered Per Job** (Stat) - Efficiency metric
- **Total CIs Discovered** (Stat) - 7-day discovery total
- **Discovery Job Status Over Time** (Stacked Bars) - Completed vs. failed trends
- **Connector Performance Comparison** (Table) - Multi-metric comparison (runs, success rate, duration, CIs)

**Refresh Rate**: 1 minute
**Default Time Range**: Last 24 hours

**Use Cases**:
- Identify failing connectors
- Optimize connector performance
- Monitor discovery job queues
- Track CI ingestion rates

---

### 3. CMDB Relationship Analytics

**Purpose**: Analyze CI relationships, dependencies, and graph topology

**Key Panels**:
- **Relationship Types Distribution** (Pie Chart) - DEPENDS_ON, HOSTS, CONNECTS_TO, etc.
- **Total Active Relationships** (Stat) - Current relationship count
- **Orphaned CIs** (Stat) - CIs with no relationships (data quality indicator)
- **Average Connections Per CI** (Stat) - Graph density metric
- **Max Connections (Single CI)** (Stat) - Identify highly connected nodes
- **Most Dependent CIs** (Table) - CIs with highest incoming/outgoing dependencies
- **Relationship Growth Over Time** (Time Series) - New vs. cumulative relationships
- **Relationships by CI Type Pairs** (Table) - Common relationship patterns (e.g., Server → Application)
- **Orphaned CIs by Type** (Bar Chart) - Identify isolated CI types
- **Relationship Strength Distribution** (Histogram) - Confidence score analysis
- **Recently Verified Relationships** (Table) - Latest relationship updates

**Refresh Rate**: 5 minutes
**Default Time Range**: Last 30 days

**Use Cases**:
- Identify critical infrastructure nodes
- Find orphaned CIs (data quality issues)
- Analyze dependency patterns
- Detect single points of failure

---

### 4. CMDB Change Tracking

**Purpose**: Monitor CI changes, change velocity, and audit activity

**Key Panels**:
- **CI Changes by Type** (Bar Chart) - CREATE, UPDATE, DELETE, etc.
- **Total Changes (24h/7d)** (Stat Panels) - Change counts
- **Change Velocity** (Stat Panels) - Changes per hour/day
- **Change Rate Over Time** (Time Series) - Hourly change activity (7 days)
- **Most Frequently Changed CIs** (Table) - High-churn CIs with change counts
- **Changes by Source** (Pie Chart) - Discovery vs. API vs. manual changes
- **Change Impact Heat Map** (Heatmap) - CI type vs. day of week
- **Recent Changes with Field Details** (Table) - Last 100 changes with old/new values
- **Change Types Distribution** (Pie Chart) - 30-day change breakdown
- **Top Changed Fields** (Bar Chart) - Most frequently modified attributes
- **Change Activity by Hour of Day** (Bar Chart) - Identify change windows

**Refresh Rate**: 1 minute
**Default Time Range**: Last 7 days

**Use Cases**:
- Track configuration drift
- Identify change patterns
- Audit trail for compliance
- Detect unexpected changes
- Optimize change windows

---

## Architecture

### Data Flow

```
Neo4j (Graph DB)
       ↓
  ETL Processor
       ↓
PostgreSQL/TimescaleDB (Data Mart)
       ↓
    Grafana Dashboards
```

HappyCMDB uses a **dual-database architecture**:
- **Neo4j**: Source of truth for CI relationships (graph queries)
- **PostgreSQL/TimescaleDB**: Optimized data mart for analytics (SQL queries)

### Schema

Dashboards query these main tables:

**Dimensional Tables**:
- `cmdb.dim_ci` - Configuration Items (SCD Type 2)
- `cmdb.dim_time` - Time dimension (pre-populated)
- `cmdb.dim_location` - Cloud regions and data centers
- `cmdb.dim_owner` - Teams and cost centers

**Fact Tables**:
- `cmdb.fact_discovery` - Discovery events (TimescaleDB hypertable)
- `cmdb.fact_ci_changes` - Change tracking
- `cmdb.fact_ci_relationships` - Relationship history

**Operational Tables**:
- `connector_run_history` - Connector execution logs
- `connector_configurations` - Connector instances
- `installed_connectors` - Connector registry

**Views**:
- `cmdb.v_current_ci_inventory` - Current CI snapshot
- `cmdb.v_ci_discovery_summary` - Discovery metrics
- `cmdb.v_ci_change_history` - Aggregated change history
- `cmdb.v_ci_relationships` - Active relationships

---

## Configuration

### Directory Structure

```
infrastructure/monitoring/grafana/
├── README.md                                    # This file
├── dashboards/                                  # Dashboard JSON files
│   ├── cmdb-overview.json                       # CMDB Overview
│   ├── cmdb-discovery-operations.json           # Discovery Operations
│   ├── cmdb-relationship-analytics.json         # Relationship Analytics
│   ├── cmdb-change-tracking.json                # Change Tracking
│   ├── application-overview.json                # Legacy (Prometheus)
│   ├── database-health.json                     # Legacy (Prometheus)
│   ├── discovery-operations.json                # Legacy (Prometheus)
│   ├── etl-operations.json                      # Legacy (Prometheus)
│   └── queue-health.json                        # Legacy (Prometheus)
└── provisioning/                                # Auto-provisioning configs
    ├── datasources/
    │   └── postgres.yml                         # PostgreSQL datasource
    └── dashboards/
        └── cmdb-dashboards.yml                  # Dashboard loader
```

### Environment Variables

Configure in `.env` file:

```bash
# Grafana Configuration
GRAFANA_PORT=3001
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=your-secure-password
GRAFANA_ROOT_URL=http://localhost:3001
GRAFANA_DOMAIN=localhost

# Database for Grafana persistence
GRAFANA_DATABASE=grafana

# Anonymous access (demo only - set to false in production)
GRAFANA_ANONYMOUS_ENABLED=false
GRAFANA_ANONYMOUS_ROLE=Viewer

# PostgreSQL (data source)
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DATABASE=cmdb
POSTGRES_USER=cmdb_user
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_SSL_MODE=prefer
```

### Datasource Provisioning

Datasource is **auto-configured** via `/provisioning/datasources/postgres.yml`:

```yaml
datasources:
  - name: HappyCMDB
    type: postgres
    url: postgres:5432
    database: cmdb
    user: cmdb_user
    jsonData:
      postgresVersion: 1600
      timescaledb: true
```

No manual datasource configuration needed!

---

## Customization

### Editing Dashboards

1. **Via Grafana UI** (easiest):
   - Open dashboard → Click settings icon → Make changes → Save
   - Changes persist in `grafana_data` volume

2. **Via JSON Files** (version-controlled):
   - Edit JSON files in `/dashboards/` directory
   - Restart Grafana to reload: `docker-compose restart grafana`

### Adding Custom Panels

Example PostgreSQL query for custom panel:

```sql
-- Total CIs by environment
SELECT
  COALESCE(environment, 'unassigned') AS metric,
  COUNT(*) AS value
FROM cmdb.dim_ci
WHERE is_current = TRUE
GROUP BY COALESCE(environment, 'unassigned')
ORDER BY value DESC;
```

**Panel Type**: Bar Chart / Pie Chart / Table
**Format**: Table
**Datasource**: HappyCMDB

### Creating New Dashboards

1. Create dashboard via Grafana UI
2. Export JSON: Dashboard Settings → JSON Model → Copy
3. Save to `/dashboards/your-dashboard.json`
4. Add `"overwrite": true` to JSON root
5. Restart Grafana to auto-provision

---

## Troubleshooting

### Dashboard Not Loading

**Symptom**: Dashboard shows "Dashboard not found"

**Solution**:
```bash
# Check Grafana logs
docker logs cmdb-grafana

# Verify provisioning volumes
docker inspect cmdb-grafana | grep -A 10 Mounts

# Restart Grafana
docker-compose -f infrastructure/docker/docker-compose.yml restart grafana
```

### No Data in Panels

**Symptom**: Panels show "No data"

**Possible Causes**:

1. **PostgreSQL not populated**:
   ```bash
   # Check if tables exist
   docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "\dt cmdb.*"

   # Check row counts
   docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SELECT COUNT(*) FROM cmdb.dim_ci;"
   ```

2. **ETL not running**:
   ```bash
   # Verify ETL processor is syncing Neo4j → PostgreSQL
   docker logs cmdb-api-server | grep -i etl
   ```

3. **Datasource connection failed**:
   - Check Grafana logs: `docker logs cmdb-grafana | grep -i postgres`
   - Verify `.env` file has correct `POSTGRES_PASSWORD`

4. **Time range too narrow**:
   - Adjust dashboard time range (top-right corner)
   - Try "Last 30 days" or "Last 90 days"

### Query Errors

**Symptom**: Panel shows SQL error

**Solution**:
```bash
# Test query directly in PostgreSQL
docker exec -it cmdb-postgres psql -U cmdb_user -d cmdb

# Run dashboard query
SELECT ci_type, COUNT(*) FROM cmdb.dim_ci WHERE is_current = TRUE GROUP BY ci_type;
```

### Slow Dashboard Performance

**Optimization Tips**:

1. **Add indexes** (already included in schema):
   ```sql
   -- Check existing indexes
   SELECT schemaname, tablename, indexname
   FROM pg_indexes
   WHERE schemaname = 'cmdb';
   ```

2. **Reduce time range**: Use shorter intervals for real-time dashboards

3. **Increase PostgreSQL resources** in `docker-compose.yml`:
   ```yaml
   postgres:
     command: >
       postgres
       -c shared_buffers=512MB
       -c effective_cache_size=1GB
   ```

---

## Performance Tuning

### PostgreSQL Optimization

TimescaleDB is optimized for time-series queries. Key settings:

```sql
-- Compression policy (automatic)
SELECT add_compression_policy('cmdb.fact_discovery', INTERVAL '7 days');

-- Retention policy (automatic)
SELECT add_retention_policy('cmdb.fact_discovery', INTERVAL '1 year');

-- Continuous aggregates (pre-compute metrics)
CREATE MATERIALIZED VIEW cmdb.discovery_daily_stats
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', discovered_at) AS day,
  ci_key,
  COUNT(*) AS discovery_count
FROM cmdb.fact_discovery
GROUP BY day, ci_key;
```

### Grafana Caching

Enable query caching in Grafana:

```ini
# In grafana.ini or via environment variables
[caching]
enabled = true
ttl = 300  # 5 minutes
```

---

## Security Considerations

### Production Deployment

1. **Change default password**:
   ```bash
   GRAFANA_ADMIN_PASSWORD=<strong-password>
   ```

2. **Disable anonymous access**:
   ```bash
   GRAFANA_ANONYMOUS_ENABLED=false
   ```

3. **Enable HTTPS**:
   ```yaml
   grafana:
     environment:
       - GF_SERVER_PROTOCOL=https
       - GF_SERVER_CERT_FILE=/etc/grafana/ssl/cert.pem
       - GF_SERVER_CERT_KEY=/etc/grafana/ssl/key.pem
   ```

4. **PostgreSQL read-only user** (recommended):
   ```sql
   -- Create read-only user for Grafana
   CREATE USER grafana_viewer WITH PASSWORD 'secure-password';
   GRANT USAGE ON SCHEMA cmdb TO grafana_viewer;
   GRANT SELECT ON ALL TABLES IN SCHEMA cmdb TO grafana_viewer;
   GRANT SELECT ON ALL SEQUENCES IN SCHEMA cmdb TO grafana_viewer;
   ```

   Update datasource config:
   ```yaml
   user: grafana_viewer
   password: secure-password
   ```

---

## Integration with Other Tools

### Export Dashboards as PDF

1. Install Grafana Image Renderer plugin:
   ```yaml
   grafana:
     environment:
       - GF_INSTALL_PLUGINS=grafana-image-renderer
   ```

2. Use share button → Export as PDF

### Prometheus Integration

Legacy dashboards in `/dashboards/` use Prometheus metrics:
- `application-overview.json`
- `database-health.json`
- `discovery-operations.json` (Prometheus version)
- `etl-operations.json`
- `queue-health.json`

These require Prometheus datasource (not included by default).

---

## Maintenance

### Backup Dashboards

```bash
# Backup Grafana volume
docker run --rm -v cmdb_grafana_data:/data -v $(pwd):/backup \
  alpine tar -czf /backup/grafana-backup-$(date +%Y%m%d).tar.gz /data
```

### Update Dashboards

```bash
# 1. Edit JSON files
# 2. Restart Grafana to reload
docker-compose -f infrastructure/docker/docker-compose.yml restart grafana

# 3. Verify changes
curl -s http://localhost:3001/api/health
```

### Monitor Grafana Health

```bash
# Health check endpoint
curl http://localhost:3001/api/health

# Database connection
curl -u admin:password http://localhost:3001/api/datasources

# Active sessions
docker exec cmdb-grafana grafana-cli admin stats
```

---

## Resources

### Official Documentation

- **Grafana**: https://grafana.com/docs/grafana/latest/
- **PostgreSQL Datasource**: https://grafana.com/docs/grafana/latest/datasources/postgres/
- **TimescaleDB**: https://docs.timescale.com/
- **HappyCMDB Docs**: http://localhost:8080 (when services are running)

### Query Examples

See `/packages/database/src/postgres/migrations/001_complete_schema.sql` for:
- Table schemas
- Indexes
- Views
- Functions

### Support

- **GitHub Issues**: https://github.com/your-org/happycmdb/issues
- **Documentation**: http://localhost:8080/operations/monitoring

---

## Dashboard Summary

| Dashboard | Panels | Refresh | Time Range | Use Case |
|-----------|--------|---------|------------|----------|
| CMDB Overview | 9 | 5m | 30d | Executive summary, inventory health |
| Discovery Operations | 11 | 1m | 24h | Connector monitoring, troubleshooting |
| Relationship Analytics | 11 | 5m | 30d | Dependency analysis, topology |
| Change Tracking | 13 | 1m | 7d | Audit, compliance, change management |

**Total Panels**: 44 comprehensive visualizations across 4 dashboards

---

**Last Updated**: 2025-10-18
**HappyCMDB Version**: v2.0
**Grafana Version**: 10.2.0
