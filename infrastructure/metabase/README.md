# Metabase Business Intelligence for HappyCMDB v3.0

## Overview

Metabase provides advanced business intelligence and ad-hoc reporting capabilities for HappyCMDB v3.0. It complements the React dashboards by offering:

- **Executive Dashboards**: High-level IT spend, service health, and risk metrics
- **FinOps Analysis**: Cloud cost optimization, unit economics, and budget variance
- **ITIL Metrics**: Incident management, change management, and SLA compliance
- **Business Impact**: Revenue at risk, compliance tracking, and customer impact analysis
- **Ad-Hoc Queries**: Self-service SQL editor for custom analysis

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Pre-Built Dashboards](#pre-built-dashboards)
- [Database Views](#database-views)
- [Common Questions Library](#common-questions-library)
- [Creating Custom Dashboards](#creating-custom-dashboards)
- [Scheduling Reports](#scheduling-reports)
- [User Access Management](#user-access-management)
- [Troubleshooting](#troubleshooting)

## Quick Start

### 1. Deploy Metabase

Metabase is included in the main `docker-compose.yml`:

```bash
# Start all services (including Metabase)
cd /home/user/happycmdb
./deploy.sh

# Or start Metabase specifically
docker-compose -f infrastructure/docker/docker-compose.yml up -d metabase
```

Metabase will be available at: **http://localhost:3002**

### 2. Run Setup Automation

The setup script automates initial configuration:

```bash
./infrastructure/scripts/setup-metabase.sh
```

This script will:
- Wait for Metabase to start
- Create admin user
- Connect to HappyCMDB database
- Create optimized BI views
- Set up collections
- Sync database schema

### 3. Login and Explore

**Default Credentials:**
- Email: `admin@happycmdb.local`
- Password: `admin_password_change_me`

**⚠️ IMPORTANT:** Change the admin password immediately after first login!

## Architecture

### Components

1. **Metabase Application**
   - Docker container: `cmdb-metabase`
   - Port: `3002` (default)
   - Application DB: PostgreSQL (`metabase` database)

2. **Data Source**
   - Database: PostgreSQL `cmdb` database
   - User: `metabase_readonly` (read-only access)
   - Schema: `public` and `cmdb` schemas

3. **Pre-Built Assets**
   - 24+ optimized database views
   - 3 comprehensive dashboards
   - 15+ pre-configured SQL questions
   - 7 collections for organization

### Data Flow

```
HappyCMDB (PostgreSQL)
    ↓
Optimized BI Views (cost-analysis.sql, itil-analysis.sql, bsm-analysis.sql)
    ↓
Metabase (read-only connection)
    ↓
Dashboards, Questions, Reports
```

## Pre-Built Dashboards

### 1. Executive Dashboard

**Purpose:** High-level overview for executive leadership

**Metrics:**
- Total IT spend (annual)
- Cost breakdown by business capability
- Cost trends (12 months)
- Service health by criticality tier
- Revenue at risk
- Top cost drivers
- Compliance status by framework
- Open incidents by priority

**Target Audience:** CEO, CFO, CIO

**Access:** Navigate to "Executive Reports" collection

---

### 2. FinOps Dashboard - Cost Optimization

**Purpose:** Cloud spend analysis and cost optimization

**Metrics:**
- Cloud vs on-premises cost comparison
- Cost by TBM tower
- Unit economics (cost per transaction/customer)
- Budget variance by cost center
- Cost trends by environment
- Asset depreciation summary
- Cost optimization opportunities
- Cost distribution by CI type

**Target Audience:** FinOps team, Finance, Platform Engineering

**Access:** Navigate to "FinOps" collection

---

### 3. ITIL Service Management Dashboard

**Purpose:** Operational excellence and service quality

**Metrics:**
- Open incidents by priority
- Incident trends (90 days)
- Change success rates
- Upcoming changes
- Configuration accuracy
- SLA compliance by service
- Service health scorecard
- MTTR analysis
- Incident resolution time
- Configuration baseline drift

**Target Audience:** IT Operations, Service Desk, Change Managers

**Access:** Navigate to "ITIL Service Management" collection

---

## Database Views

All views are created in the `public` schema for easy access. They are optimized for performance with appropriate indexes.

### Cost Analysis Views

| View Name | Description | Key Metrics |
|-----------|-------------|-------------|
| `v_executive_cost_summary` | Cost by capability and service | Monthly/annual cost, unit economics |
| `v_cost_by_tower` | TBM tower breakdown | Cost by tower, pool, type |
| `v_cost_trends` | Monthly cost trends | Cost over time by tower |
| `v_unit_economics` | Cost per transaction/customer | Revenue ratio, efficiency |
| `v_cloud_vs_onprem_costs` | Deployment model comparison | Cloud vs on-prem costs |
| `v_cost_allocation_summary` | Budget variance | Actual vs budget by cost center |
| `v_depreciation_summary` | Asset depreciation | Book value, remaining life |
| `v_top_cost_drivers` | Top 20 cost drivers | Highest cost CIs |

### ITIL Service Management Views

| View Name | Description | Key Metrics |
|-----------|-------------|-------------|
| `v_incident_summary` | Incident statistics | Count, MTTR, business impact |
| `v_incident_trends` | Monthly incident trends | Trends by priority/category |
| `v_change_success_rates` | Change management KPIs | Success rate, risk, impact |
| `v_change_calendar` | Upcoming changes | Scheduled changes with risk |
| `v_configuration_accuracy` | CI audit compliance | Compliance rate by type |
| `v_sla_compliance` | SLA metrics by service | Availability, incidents |
| `v_service_health_scorecard` | Service health scores | Health score (0-100) |
| `v_mttr_mtbf_analysis` | Reliability metrics | MTTR, MTBF by service |
| `v_baseline_drift_detection` | Configuration drift | Baseline compliance |

### Business Service Mapping (BSM) Views

| View Name | Description | Key Metrics |
|-----------|-------------|-------------|
| `v_criticality_distribution` | CIs by criticality tier | Count, cost by tier |
| `v_revenue_at_risk` | Revenue impact analysis | Revenue at risk from incidents |
| `v_compliance_summary` | Compliance by framework | Compliance rate, service count |
| `v_sox_pci_inventory` | SOX/PCI scope | In-scope services, compliance |
| `v_disaster_recovery_tiers` | DR tier allocation | RTO/RPO metrics |
| `v_business_capability_health` | Capability scorecard | Financial, operational metrics |
| `v_service_dependency_map` | Service relationships | Dependency analysis |
| `v_customer_impact_analysis` | Customer-facing metrics | Impact score, cost per customer |

## Common Questions Library

The `questions/common-questions.sql` file contains 15 pre-configured SQL queries organized by category:

### Cost Analysis (5 questions)
1. Top 10 cost drivers
2. Underutilized resources (<50%)
3. Month-over-month cost trends
4. Cost per customer by service
5. Cost centers over budget

### Incident Management (3 questions)
6. Services with most incidents
7. Incident resolution performance
8. Incidents breaching SLA

### Change Management (2 questions)
9. Change success rate
10. Changes scheduled this week

### Compliance & Risk (2 questions)
11. SOX/PCI in-scope services
12. Compliance status by framework

### Business Impact (3 questions)
13. Revenue at risk
14. Services needing immediate attention
15. Disaster recovery allocations

### Using Pre-Configured Questions

1. Navigate to **SQL Questions** in Metabase
2. Click **+ New** → **SQL Query**
3. Copy a query from `infrastructure/metabase/questions/common-questions.sql`
4. Run the query
5. Save to appropriate collection
6. Optionally add to dashboard

## Creating Custom Dashboards

### Dashboard Best Practices

1. **Keep it focused**: One dashboard per audience/purpose
2. **Limit visualizations**: 6-10 cards per dashboard
3. **Use filters**: Add date range, environment, criticality filters
4. **Consistent sizing**: Use grid layout for alignment
5. **Performance**: Test with production data volumes

### Step-by-Step Dashboard Creation

1. **Create a new dashboard**
   ```
   Home → Dashboards → + New dashboard
   ```

2. **Add questions**
   - Click "+" button
   - Select existing saved question OR
   - Create new question inline

3. **Arrange cards**
   - Drag and resize cards on grid
   - Typical layouts:
     - 2x2 grid for 4 cards
     - Full width for tables
     - Half width for charts

4. **Add filters**
   ```
   Click "Filter" → Add parameter
   - Date Range: "Created At"
   - Environment: "Environment"
   - Business Criticality: "Criticality"
   ```

5. **Save and share**
   - Save to appropriate collection
   - Set access permissions
   - Add to email subscription

### Recommended Dashboard Layouts

**Executive (1-page summary):**
```
┌─────────┬─────────┐
│ Metric  │ Metric  │  <- Key numbers (scalars)
├─────────┴─────────┤
│   Cost Trend      │  <- Line chart (full width)
├─────────┬─────────┤
│  Table  │  Chart  │  <- Details
└─────────┴─────────┘
```

**Operational (detailed analysis):**
```
┌──────────────────┐
│ Filters (top)    │  <- Date, environment, etc.
├─────────┬────────┤
│ Summary │ Trend  │  <- Key metrics
├─────────┴────────┤
│ Detailed Table   │  <- Full width table
└──────────────────┘
```

## Scheduling Reports

Metabase supports scheduled email delivery of dashboards and questions.

### Setup Email (SMTP)

Configure in `infrastructure/docker/docker-compose.yml`:

```yaml
environment:
  MB_EMAIL_SMTP_HOST: smtp.gmail.com
  MB_EMAIL_SMTP_PORT: 587
  MB_EMAIL_SMTP_USERNAME: your-email@gmail.com
  MB_EMAIL_SMTP_PASSWORD: your-app-password
  MB_EMAIL_FROM_ADDRESS: noreply@happycmdb.local
```

### Create Scheduled Report

1. **Open a dashboard or question**
2. **Click the subscription icon** (bell icon in top right)
3. **Configure schedule:**
   - **Frequency**: Daily, Weekly, Monthly
   - **Day/Time**: e.g., "Monday 8 AM"
   - **Recipients**: Email addresses
   - **Format**: PDF, Excel, CSV

4. **Save subscription**

### Recommended Schedules

| Report | Frequency | Recipients | Format |
|--------|-----------|------------|--------|
| Executive Summary | Weekly (Monday 8 AM) | CEO, CFO, CIO | PDF |
| FinOps Cost Report | Monthly (1st, 9 AM) | FinOps, Finance | Excel |
| ITIL Metrics | Weekly (Friday 5 PM) | IT Ops, Service Desk | PDF |
| Compliance Report | Monthly (5th, 9 AM) | Compliance, Audit | PDF |
| SLA Compliance | Weekly (Monday 9 AM) | Service Owners | PDF |

## User Access Management

### Access Levels

Metabase has 3 permission levels:

1. **Administrator**: Full access, manage users, configure settings
2. **Analyst**: Create/edit questions, dashboards
3. **Viewer**: View-only access to assigned collections

### Creating Users

1. **Navigate to Admin → People**
2. **Click "Invite someone"**
3. **Enter email and select group**
4. **User receives email invite**

### Collections & Permissions

Best practice: Organize by team/function

**Recommended Structure:**
```
├── Executive Reports (CEO, CFO, CIO - Viewer)
├── IT Operations (IT Ops - Analyst)
├── FinOps (Finance - Analyst)
├── Compliance (Compliance - Analyst)
├── Service Management (Service Desk - Viewer)
└── Ad-Hoc Analysis (All - Analyst)
```

**Setting Permissions:**
1. Admin → Collections
2. Click collection → Permissions
3. Set group access (View/Edit/Curate)

## Troubleshooting

### Metabase won't start

**Symptoms**: Container exits or health check fails

**Solutions:**
1. Check logs:
   ```bash
   docker logs cmdb-metabase
   ```

2. Verify database connection:
   ```bash
   docker exec cmdb-postgres psql -U postgres -c "SELECT datname FROM pg_database WHERE datname = 'metabase';"
   ```

3. Check environment variables in `docker-compose.yml`

4. Increase Java heap size if OOM:
   ```yaml
   environment:
     JAVA_OPTS: "-Xmx4g"  # Increase from 2g
   ```

### Cannot connect to CMDB database

**Symptoms**: "Database connection failed" error

**Solutions:**
1. Verify `metabase_readonly` user exists:
   ```bash
   docker exec cmdb-postgres psql -U postgres -c "\du metabase_readonly"
   ```

2. Check user permissions:
   ```sql
   \c cmdb
   SELECT grantee, privilege_type
   FROM information_schema.table_privileges
   WHERE grantee = 'metabase_readonly';
   ```

3. Re-run initialization script:
   ```bash
   docker exec -i cmdb-postgres psql -U postgres < infrastructure/database/metabase-init.sql
   ```

### Views not appearing

**Symptoms**: Views missing in database schema browser

**Solutions:**
1. Trigger schema sync:
   ```
   Admin → Databases → HappyCMDB → Sync database schema now
   ```

2. Check view permissions:
   ```sql
   \c cmdb
   SELECT table_name FROM information_schema.table_privileges
   WHERE grantee = 'metabase_readonly' AND table_schema = 'public';
   ```

3. Re-create views:
   ```bash
   psql -h localhost -p 5433 -U cmdb_user -d cmdb -f infrastructure/database/views/cost-analysis.sql
   psql -h localhost -p 5433 -U cmdb_user -d cmdb -f infrastructure/database/views/itil-analysis.sql
   psql -h localhost -p 5433 -U cmdb_user -d cmdb -f infrastructure/database/views/bsm-analysis.sql
   ```

### Slow query performance

**Symptoms**: Dashboards take >10 seconds to load

**Solutions:**
1. **Enable query caching**:
   - Admin → Settings → Caching
   - Set cache TTL: 1 hour (3600 seconds)

2. **Optimize queries**:
   - Use views instead of complex joins
   - Add WHERE clauses to limit data
   - Use date range filters

3. **Add database indexes** (if needed):
   ```sql
   -- Example: Index on frequently filtered columns
   CREATE INDEX idx_custom ON cmdb.dim_ci(ci_type, environment);
   ```

4. **Materialize views** (for very large datasets):
   ```sql
   -- Convert view to materialized view
   CREATE MATERIALIZED VIEW mv_cost_summary AS
   SELECT * FROM v_executive_cost_summary;

   -- Refresh periodically (e.g., via cron)
   REFRESH MATERIALIZED VIEW mv_cost_summary;
   ```

### Email reports not sending

**Symptoms**: Subscriptions fail to deliver

**Solutions:**
1. **Verify SMTP settings**:
   - Admin → Settings → Email
   - Click "Send test email"

2. **Check common SMTP issues**:
   - Gmail: Enable "Less secure app access" OR use App Password
   - Office 365: Use modern authentication
   - Corporate SMTP: Check firewall rules

3. **Check Metabase logs**:
   ```bash
   docker logs cmdb-metabase | grep -i email
   ```

## Performance Tuning

### Database Connection Pooling

Default settings are optimized for ~100 concurrent users. For larger deployments:

```yaml
environment:
  MB_DB_CONNECTION_POOL_SIZE: 30
  MB_DB_CONNECTION_POOL_TIMEOUT: 30000
```

### Java Memory Tuning

Adjust based on available memory:

```yaml
environment:
  JAVA_OPTS: "-Xmx4g -XX:+UseG1GC -XX:MaxGCPauseMillis=200"
```

**Recommendations:**
- Small deployment (<100 users): 2GB heap
- Medium deployment (100-500 users): 4GB heap
- Large deployment (>500 users): 8GB heap

### Query Optimization

1. **Use aggregations at database level** (views)
2. **Limit result sets** (WHERE clauses)
3. **Cache expensive queries** (Admin → Caching)
4. **Schedule dashboard refreshes** during off-peak hours

## Security Best Practices

1. **Change default passwords** immediately
2. **Use strong passwords** (16+ characters)
3. **Enable SSL/TLS** for production:
   ```yaml
   MB_DB_SSL: true
   ```
4. **Restrict database user** to read-only (`metabase_readonly`)
5. **Regular backups** of Metabase application database
6. **Audit user access** monthly (Admin → Audit Log)
7. **Review collections permissions** quarterly

## Additional Resources

- **Official Documentation**: https://www.metabase.com/docs/latest/
- **SQL Best Practices**: https://www.metabase.com/learn/sql-questions/
- **Dashboard Design**: https://www.metabase.com/learn/dashboards/
- **HappyCMDB Docs**: http://localhost:8080 (when running)

## Support

For HappyCMDB-specific Metabase issues:
1. Check this README
2. Review HappyCMDB documentation
3. Check Metabase logs: `docker logs cmdb-metabase`
4. Open an issue on the HappyCMDB repository

---

**Version:** HappyCMDB v3.0
**Last Updated:** 2025-11-06
**Maintained By:** HappyCMDB Development Team
