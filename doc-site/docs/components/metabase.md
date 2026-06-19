# Metabase Business Intelligence Integration

## Overview

Metabase provides advanced business intelligence and ad-hoc reporting capabilities for HappyCMDB v3.0, complementing the built-in React dashboards with powerful SQL-based analytics and customizable reporting.

### Key Features

**Self-Service Analytics**
- Intuitive visual query builder for non-technical users
- Advanced SQL editor for power users
- 24+ pre-built optimized database views
- 15+ pre-configured SQL questions
- Real-time data refresh from HappyCMDB

**Pre-Built Dashboards**
- **Executive Dashboard**: High-level IT spend, service health, and risk metrics for CEO/CFO/CIO
- **FinOps Dashboard**: Cloud cost optimization, unit economics, and budget variance for Finance teams
- **ITIL Dashboard**: Incident management, change management, and SLA compliance for IT Operations

**Enterprise Features**
- Scheduled email reports (PDF, Excel, CSV)
- User role-based access control (Admin, Analyst, Viewer)
- Collection-based permission management
- Query caching for performance optimization
- SQL question library with common queries

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    HappyCMDB                         │
│                                                             │
│  ┌──────────────┐     ┌──────────────┐    ┌─────────────┐ │
│  │   Neo4j      │────▶│  PostgreSQL  │───▶│  Metabase   │ │
│  │   (Graph)    │     │  (Data Mart) │    │   (Port     │ │
│  │              │     │              │    │    3002)    │ │
│  └──────────────┘     └──────────────┘    └─────────────┘ │
│                            ▲                      │         │
│                            │                      │         │
│                            │                      ▼         │
│                       ┌────────────┐       ┌──────────────┐│
│                       │ 24 BI Views│       │  Dashboards  ││
│                       │  (Cost,    │       │  Reports     ││
│                       │   ITIL,    │       │  Questions   ││
│                       │   BSM)     │       └──────────────┘│
│                       └────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

**Data Flow**:
1. Discovery processes populate Neo4j graph database
2. ETL pipeline syncs data to PostgreSQL data mart
3. Optimized BI views aggregate data for reporting
4. Metabase queries views via read-only connection
5. Users access dashboards, questions, and custom reports

---

## Deployment

### Docker Compose Deployment

Metabase is included in the main HappyCMDB docker-compose configuration.

#### 1. Start All Services

```bash
cd /home/user/happycmdb
./deploy.sh
```

This automatically deploys:
- Metabase application container (`cmdb-metabase`)
- PostgreSQL with CMDB data mart
- Required database views (cost, ITIL, BSM)
- Read-only database user (`metabase_readonly`)

#### 2. Access Metabase

Once deployed, Metabase is available at:

**URL**: `http://localhost:3002`

**Default Credentials** (change immediately after first login):
- Email: `admin@happycmdb.local`
- Password: `admin_password_change_me`

#### 3. Automated Setup

Run the setup automation script to configure Metabase:

```bash
./infrastructure/scripts/setup-metabase.sh
```

This script performs:
- Wait for Metabase startup
- Create admin user
- Connect to HappyCMDB database
- Import pre-built dashboards
- Set up collections
- Sync database schema

### Kubernetes Deployment

For production Kubernetes deployment, Metabase is deployed as a StatefulSet with persistent storage.

#### Helm Chart Configuration

```yaml
# values.yaml
metabase:
  replicaCount: 2
  image:
    repository: metabase/metabase
    tag: v0.47.0

  resources:
    requests:
      memory: "2Gi"
      cpu: "1000m"
    limits:
      memory: "4Gi"
      cpu: "2000m"

  persistence:
    enabled: true
    size: 10Gi

  database:
    type: postgres
    host: cmdb-postgres
    port: 5432
    name: metabase
    username: metabase_admin
    existingSecret: metabase-db-secret

  env:
    MB_DB_TYPE: postgres
    MB_DB_CONNECTION_POOL_SIZE: 30
    JAVA_OPTS: "-Xmx4g -XX:+UseG1GC"
```

#### Deploy with Helm

```bash
cd infrastructure/kubernetes/helm
helm install metabase ./metabase -f values.yaml
```

#### Verify Deployment

```bash
kubectl get pods -l app=metabase
kubectl logs -f metabase-0
```

---

## Database Views

HappyCMDB v3.0 provides 24 optimized PostgreSQL views organized into three categories: **Cost Analysis**, **ITIL Service Management**, and **Business Service Mapping (BSM)**.

### Cost Analysis Views (8 views)

These views power TBM (Technology Business Management) cost allocation and FinOps analysis.

#### v_executive_cost_summary

**Purpose**: High-level cost summary by business capability and service

**Key Columns**:
- `business_capability` - Business capability name
- `business_service` - Business service name
- `monthly_cost` - Total monthly cost in USD
- `annual_cost` - Total annual cost (monthly × 12)
- `annual_revenue_supported` - Annual revenue supported by service
- `customer_count` - Number of customers served
- `cost_per_customer` - Monthly cost divided by customer count
- `cost_per_transaction` - Monthly cost divided by daily transactions
- `business_criticality` - Business criticality tier (tier_0 to tier_4)

**Use Cases**:
- Executive reporting on IT spend
- Business capability cost allocation
- Unit economics analysis

**Sample Query**:
```sql
SELECT business_capability, business_service, annual_cost, cost_per_customer
FROM v_executive_cost_summary
WHERE business_criticality IN ('tier_0', 'tier_1')
ORDER BY annual_cost DESC
LIMIT 10;
```

---

#### v_cost_by_tower

**Purpose**: TBM cost breakdown by resource tower and cost pool

**Key Columns**:
- `tbm_resource_tower` - TBM tower (compute, storage, network, etc.)
- `tbm_cost_pool` - Cost pool within tower
- `ci_type` - Configuration item type
- `environment` - Environment (production, staging, development)
- `ci_count` - Number of CIs in this category
- `total_monthly_cost` - Aggregated monthly cost
- `avg_monthly_cost` - Average cost per CI
- `pct_of_total_cost` - Percentage of total IT spend

**Use Cases**:
- Resource tower cost allocation
- Environment cost comparison
- Cost distribution analysis

**Sample Query**:
```sql
SELECT tbm_resource_tower, SUM(total_monthly_cost) AS tower_cost
FROM v_cost_by_tower
WHERE environment = 'production'
GROUP BY tbm_resource_tower
ORDER BY tower_cost DESC;
```

---

#### v_cost_trends

**Purpose**: Monthly cost trends over time by tower and CI type

**Key Columns**:
- `month` - Month (date truncated to first day)
- `tbm_resource_tower` - TBM resource tower
- `ci_type` - CI type
- `environment` - Environment
- `monthly_cost` - Total cost for the month
- `ci_count` - Number of CIs contributing to cost

**Use Cases**:
- Cost trend analysis
- Month-over-month cost change tracking
- Budget forecasting

**Sample Query**:
```sql
SELECT month, tbm_resource_tower, monthly_cost
FROM v_cost_trends
WHERE month >= NOW() - INTERVAL '12 months'
ORDER BY month, monthly_cost DESC;
```

---

#### v_unit_economics

**Purpose**: Unit economics by business service

**Key Columns**:
- `business_service` - Service name
- `monthly_cost` - Monthly service cost
- `annual_revenue` - Annual revenue supported
- `customer_count` - Customer count
- `daily_transaction_volume` - Daily transaction count
- `cost_per_transaction` - Cost per transaction
- `cost_per_customer` - Cost per customer
- `revenue_ratio` - Revenue to cost ratio
- `business_criticality` - Criticality tier

**Use Cases**:
- Service profitability analysis
- Cost efficiency benchmarking
- Pricing model validation

**Sample Query**:
```sql
SELECT business_service, cost_per_customer, revenue_ratio
FROM v_unit_economics
WHERE customer_count > 0
ORDER BY revenue_ratio DESC;
```

---

#### v_cloud_vs_onprem_costs

**Purpose**: Cost comparison between cloud and on-premises infrastructure

**Key Columns**:
- `deployment_model` - Cloud provider or "on-premises"
- `ci_count` - Number of CIs
- `monthly_cost` - Total monthly cost
- `avg_cost_per_ci` - Average cost per CI
- `pct_of_total` - Percentage of total infrastructure cost

**Use Cases**:
- Cloud vs on-prem TCO analysis
- Multi-cloud cost comparison
- Migration ROI calculation

**Sample Query**:
```sql
SELECT deployment_model, monthly_cost, pct_of_total
FROM v_cloud_vs_onprem_costs
ORDER BY monthly_cost DESC;
```

---

#### v_cost_allocation_summary

**Purpose**: Budget variance by cost center and cost pool

**Key Columns**:
- `cost_center` - Cost center identifier
- `business_unit` - Business unit name
- `cost_pool_name` - Cost pool name
- `monthly_budget` - Allocated budget
- `actual_monthly_cost` - Actual spend
- `monthly_variance` - Budget variance (negative = over budget)
- `variance_pct` - Variance as percentage

**Use Cases**:
- Budget tracking
- Cost center accountability
- Variance reporting

**Sample Query**:
```sql
SELECT cost_center, monthly_budget, actual_monthly_cost, variance_pct
FROM v_cost_allocation_summary
WHERE monthly_variance < 0  -- Over budget
ORDER BY ABS(variance_pct) DESC;
```

---

#### v_depreciation_summary

**Purpose**: Asset depreciation tracking with remaining book value

**Key Columns**:
- `ci_name` - Asset name
- `ci_type` - Asset type
- `acquisition_cost` - Original purchase cost
- `current_book_value` - Current value after depreciation
- `monthly_depreciation` - Monthly depreciation amount
- `remaining_months` - Remaining useful life
- `depreciation_pct` - Percentage depreciated
- `fully_depreciated` - Boolean flag

**Use Cases**:
- Asset lifecycle management
- Depreciation expense tracking
- Hardware refresh planning

**Sample Query**:
```sql
SELECT ci_name, acquisition_cost, current_book_value, remaining_months
FROM v_depreciation_summary
WHERE fully_depreciated = FALSE AND remaining_months < 12
ORDER BY current_book_value DESC;
```

---

#### v_top_cost_drivers

**Purpose**: Top 20 configuration items by monthly cost

**Key Columns**:
- `ci_name` - CI name
- `ci_type` - CI type
- `tbm_resource_tower` - Resource tower
- `environment` - Environment
- `monthly_cost` - Monthly cost
- `annual_cost` - Annualized cost
- `business_criticality` - Criticality tier

**Use Cases**:
- Cost driver identification
- Optimization opportunity discovery
- Executive cost reporting

**Sample Query**:
```sql
SELECT ci_name, ci_type, monthly_cost, annual_cost
FROM v_top_cost_drivers
LIMIT 10;
```

---

### ITIL Service Management Views (9 views)

These views provide insights into incident management, change management, configuration accuracy, and SLA compliance.

#### v_incident_summary

**Purpose**: Incident statistics by priority and status

**Key Columns**:
- `priority` - Incident priority (1-5)
- `status` - Incident status
- `incident_count` - Number of incidents
- `avg_resolution_minutes` - Average resolution time
- `total_revenue_impact` - Total revenue impact
- `mttr_hours` - Mean Time To Repair (hours)

**Use Cases**:
- Incident volume tracking
- SLA performance monitoring
- Business impact assessment

---

#### v_incident_trends

**Purpose**: Monthly incident trends by priority and category

**Key Columns**:
- `month` - Month
- `priority` - Priority level
- `category` - Incident category
- `incident_count` - Incident count
- `trend` - Trend indicator (increasing/decreasing)

**Use Cases**:
- Trend analysis
- Capacity planning
- Service improvement identification

---

#### v_change_success_rates

**Purpose**: Change management KPIs by change type

**Key Columns**:
- `month` - Month
- `change_type` - Change type (standard/normal/emergency)
- `total_changes` - Total change count
- `successful_changes` - Successful count
- `failed_changes` - Failed count
- `success_rate` - Success rate percentage

**Use Cases**:
- Change quality tracking
- CAB performance assessment
- Change type risk analysis

---

#### v_change_calendar

**Purpose**: Upcoming scheduled changes with risk assessment

**Key Columns**:
- `change_number` - Change ticket number
- `title` - Change title
- `change_type` - Type
- `scheduled_start` - Start date/time
- `scheduled_end` - End date/time
- `risk_level` - Risk level (low/medium/high/critical)
- `affected_service_count` - Count of affected services

**Use Cases**:
- Change planning
- Maintenance window scheduling
- Stakeholder communication

---

#### v_configuration_accuracy

**Purpose**: Configuration item audit compliance by CI class

**Key Columns**:
- `itil_ci_class` - ITIL CI class
- `ci_count` - Total CI count
- `compliant_count` - Compliant CIs
- `non_compliant_count` - Non-compliant CIs
- `compliance_rate` - Compliance percentage

**Use Cases**:
- CMDB quality tracking
- Audit readiness
- Data quality improvement

---

#### v_sla_compliance

**Purpose**: SLA metrics by business service

**Key Columns**:
- `business_service_name` - Service name
- `sla_target_availability` - Target availability percentage
- `actual_availability_30d` - Actual 30-day availability
- `sla_met` - Boolean SLA compliance flag
- `recent_incident_count` - Recent incident count

**Use Cases**:
- SLA monitoring
- Service quality reporting
- Contract compliance

---

#### v_service_health_scorecard

**Purpose**: Comprehensive service health scores

**Key Columns**:
- `business_service_name` - Service name
- `operational_status` - Status (operational/degraded/down)
- `health_score` - Health score (0-100)
- `availability_30d` - 30-day availability
- `incident_count_30d` - 30-day incident count
- `business_criticality` - Criticality tier

**Use Cases**:
- Service dashboard
- Health monitoring
- Proactive issue detection

---

#### v_mttr_mtbf_analysis

**Purpose**: Reliability metrics by business service

**Key Columns**:
- `business_service_name` - Service name
- `mttr_hours` - Mean Time To Repair
- `mtbf_hours` - Mean Time Between Failures
- `incident_count_90d` - 90-day incident count
- `total_downtime_hours` - Total downtime

**Use Cases**:
- Reliability engineering
- Service improvement planning
- Capacity planning

---

#### v_baseline_drift_detection

**Purpose**: Configuration baseline compliance status

**Key Columns**:
- `baseline_name` - Baseline name
- `baseline_type` - Type (golden/standard/custom)
- `matching_ci_count` - CIs matching baseline
- `compliant_ci_count` - Compliant CIs
- `drift_detected` - Boolean drift flag
- `approved_at` - Baseline approval date

**Use Cases**:
- Configuration drift monitoring
- Compliance validation
- Change audit

---

### Business Service Mapping (BSM) Views (8 views)

These views provide business impact analysis, compliance tracking, and disaster recovery planning.

#### v_criticality_distribution

**Purpose**: Configuration items by business criticality tier

**Key Columns**:
- `business_criticality` - Tier (tier_0 to tier_4)
- `ci_count` - CI count
- `total_monthly_cost` - Total cost
- `pct_of_total` - Percentage of total

**Use Cases**:
- Criticality distribution analysis
- Investment prioritization
- Risk assessment

---

#### v_revenue_at_risk

**Purpose**: Revenue impact analysis from open incidents

**Key Columns**:
- `business_service` - Service name
- `business_criticality` - Criticality tier
- `open_incidents` - Open incident count
- `annual_revenue` - Annual revenue supported
- `total_revenue_at_risk` - Estimated revenue at risk
- `pct_revenue_at_risk` - Percentage of annual revenue

**Use Cases**:
- Business impact assessment
- Executive escalation
- Incident prioritization

---

#### v_compliance_summary

**Purpose**: Compliance status by regulatory framework

**Key Columns**:
- `compliance_framework` - Framework (SOX, PCI, HIPAA, etc.)
- `service_count` - Total services
- `compliant_services` - Compliant count
- `non_compliant_services` - Non-compliant count
- `compliance_rate` - Compliance percentage

**Use Cases**:
- Regulatory compliance tracking
- Audit preparation
- Risk management

---

#### v_sox_pci_inventory

**Purpose**: SOX and PCI in-scope service inventory

**Key Columns**:
- `business_service_name` - Service name
- `sox_scope` - Boolean SOX flag
- `pci_scope` - Boolean PCI flag
- `data_sensitivity` - Data classification
- `compliant_ci_count` - Compliant CI count
- `total_ci_count` - Total CI count

**Use Cases**:
- Audit scope definition
- Compliance reporting
- Risk assessment

---

#### v_disaster_recovery_tiers

**Purpose**: DR tier allocation by business criticality

**Key Columns**:
- `dr_tier` - DR tier (hot/warm/cold)
- `business_criticality` - Criticality
- `service_count` - Service count
- `avg_rto_minutes` - Average Recovery Time Objective
- `avg_rpo_minutes` - Average Recovery Point Objective
- `total_revenue_supported` - Total revenue

**Use Cases**:
- DR planning
- RTO/RPO validation
- DR investment justification

---

#### v_business_capability_health

**Purpose**: Business capability health scorecard

**Key Columns**:
- `business_capability` - Capability name
- `service_count` - Number of services
- `health_score` - Average health score
- `total_monthly_cost` - Total cost
- `total_revenue` - Total revenue supported

**Use Cases**:
- Capability management
- Business alignment
- Investment prioritization

---

#### v_service_dependency_map

**Purpose**: Service dependency relationship analysis

**Key Columns**:
- `source_service` - Source service name
- `target_service` - Target service name
- `dependency_type` - Relationship type
- `dependency_strength` - Strength score

**Use Cases**:
- Dependency mapping
- Impact analysis
- Change planning

---

#### v_customer_impact_analysis

**Purpose**: Customer-facing service metrics

**Key Columns**:
- `business_service` - Service name
- `customer_count` - Customer count
- `impact_score` - Business impact score (0-100)
- `cost_per_customer` - Cost per customer
- `avg_transaction_volume` - Transaction volume

**Use Cases**:
- Customer impact assessment
- Service prioritization
- Resource allocation

---

## Pre-Built Dashboards

HappyCMDB v3.0 includes three comprehensive dashboards optimized for different stakeholders.

### 1. Executive Dashboard

**Target Audience**: CEO, CFO, CIO, Executive Leadership

**Purpose**: High-level overview of IT spend, service health, risk, and compliance

**8 Dashboard Cards**:

1. **Total IT Spend (Annual)** - Scalar metric
   - Total annual IT spend across all active CIs
   - Real-time calculation from cost data

2. **IT Spend by Business Capability** - Bar chart
   - Annual cost breakdown by capability
   - Top 10 capabilities by spend

3. **Cost Trends (12 Months)** - Line chart
   - Monthly cost trends by TBM tower
   - 12-month historical view

4. **Service Health by Criticality Tier** - Row chart
   - Average health score by tier
   - Focus on tier_0 and tier_1 services

5. **Revenue at Risk** - Table
   - Top 5 services with revenue exposure
   - Open incident count and financial impact

6. **Top Cost Drivers** - Table
   - Top 10 CIs by monthly cost
   - CI type and annualized cost

7. **Compliance Status** - Bar chart
   - Compliance rate by framework
   - Identifies compliance gaps

8. **Open Incidents by Priority** - Pie chart
   - Current incident distribution
   - Priority breakdown

**Dashboard Layout**:
```
┌──────────────┬────────────────────────────┐
│ Total IT     │  IT Spend by Capability    │
│ Spend        │                            │
├──────────────┴────────────────────────────┤
│         Cost Trends (12 Months)           │
│                                           │
├───────────────────────┬───────────────────┤
│ Service Health by     │ Open Incidents    │
│ Criticality Tier      │ by Priority       │
├───────────────────────┴───────────────────┤
│         Revenue at Risk (Table)           │
│                                           │
├───────────────────────┬───────────────────┤
│ Top Cost Drivers      │ Compliance Status │
│ (Table)               │ (Bar Chart)       │
└───────────────────────┴───────────────────┘
```

**Access**: Navigate to "Executive Reports" collection in Metabase

---

### 2. FinOps Dashboard - Cost Optimization

**Target Audience**: FinOps Team, Finance, Platform Engineering

**Purpose**: Cloud spend analysis, cost optimization, and budget management

**10 Dashboard Cards**:

1. **Cloud vs On-Prem Costs** - Pie chart
   - Cost comparison by deployment model
   - Percentage of total spend

2. **Cost by TBM Tower** - Bar chart
   - Monthly cost breakdown by tower
   - Infrastructure investment distribution

3. **Unit Economics - Top Services** - Table
   - Cost per transaction and cost per customer
   - Revenue ratio for profitability analysis

4. **Budget Variance by Cost Center** - Table
   - Budget vs actual comparison
   - Variance percentage highlighting overruns

5. **Cost Trends by Environment** - Line chart
   - 6-month cost trends
   - Production/staging/development breakdown

6. **Depreciation Summary** - Table
   - Assets with remaining book value
   - Remaining useful life in months

7. **Cost Optimization Opportunities** - Table
   - Underutilized resources (<50% utilization)
   - Potential savings calculations

8. **Cost Distribution by CI Type** - Pie chart
   - Cost allocation by CI type
   - Top 8 types visualized

9. **Total Cloud Spend (YTD)** - Scalar metric
   - Year-to-date cloud costs
   - All cloud providers aggregated

10. **Highest Cost Increase (MoM)** - Scalar metric
    - Service with highest month-over-month increase
    - Percentage change

**Dashboard Layout**:
```
┌──────────────┬──────────────────────────┐
│ Cloud vs     │ Cost Distribution        │
│ On-Prem      │ by CI Type               │
├──────────────┴──────────────────────────┤
│       Cost by TBM Tower (Bar)           │
│                                         │
├─────────────────────────────────────────┤
│     Unit Economics - Top Services       │
│             (Table)                     │
├─────────────────────────────────────────┤
│   Budget Variance by Cost Center        │
│             (Table)                     │
├─────────────────────────────────────────┤
│    Cost Trends by Environment           │
│           (Line Chart)                  │
├──────────────┬──────────────────────────┤
│ Depreciation │ Cost Optimization        │
│ Summary      │ Opportunities            │
└──────────────┴──────────────────────────┘
```

**Access**: Navigate to "FinOps" collection in Metabase

---

### 3. ITIL Service Management Dashboard

**Target Audience**: IT Operations, Service Desk, Change Managers

**Purpose**: Operational excellence and service quality monitoring

**10 Dashboard Cards**:

1. **Open Incidents by Priority** - Bar chart
   - Current open incident counts
   - Priority distribution

2. **Incident Trends (90 Days)** - Line chart
   - Incident count trends
   - 90-day rolling window

3. **Change Success Rates** - Table
   - 6-month change statistics
   - Success rate by change type

4. **Upcoming Changes** - Table
   - Next 30 days scheduled changes
   - Risk level and affected services

5. **Configuration Accuracy** - Table
   - CI audit compliance by class
   - Compliance rate percentage

6. **SLA Compliance** - Table
   - Last 30 days SLA metrics
   - Services with SLA breaches

7. **Service Health Scorecard** - Table
   - Bottom 10 services by health score
   - Availability and incident metrics

8. **MTTR Analysis** - Bar chart
   - Mean Time To Repair by service
   - Top 10 services

9. **Incident Resolution Time** - Table
   - Average resolution by priority
   - Revenue impact totals

10. **Configuration Baseline Drift** - Table
    - Baseline compliance status
    - Latest 5 baselines

**Dashboard Layout**:
```
┌──────────────┬──────────────────────────┐
│ Open         │ MTTR Analysis            │
│ Incidents    │ (Bar Chart)              │
├──────────────┴──────────────────────────┤
│      Incident Trends (90 Days)          │
│           (Line Chart)                  │
├─────────────────────────────────────────┤
│      Change Success Rates (Table)       │
│                                         │
├─────────────────────────────────────────┤
│      Upcoming Changes (Table)           │
│                                         │
├──────────────┬──────────────────────────┤
│ Config       │ SLA Compliance           │
│ Accuracy     │ (Table)                  │
├──────────────┴──────────────────────────┤
│      Service Health Scorecard           │
│             (Table)                     │
├─────────────────────────────────────────┤
│   Incident Resolution Time (Table)      │
│                                         │
├──────────────┬──────────────────────────┤
│ MTTR (Bar)   │ Baseline Drift (Table)   │
└──────────────┴──────────────────────────┘
```

**Access**: Navigate to "ITIL Service Management" collection in Metabase

---

## Pre-Configured Questions

HappyCMDB provides 15 pre-configured SQL questions organized into 5 categories. These questions are ready to use and can be added to custom dashboards.

### Cost Analysis Questions (5)

**Q1: What are our top 10 cost drivers?**
- Identifies highest-cost CIs
- Shows monthly and annual costs
- Includes resource tower and criticality

**Q2: Which resources are underutilized (<50% utilization)?**
- Finds optimization opportunities
- Calculates potential savings
- Prioritizes by savings amount

**Q3: What is our month-over-month cost trend?**
- Tracks cost changes over 12 months
- Shows MoM variance by tower
- Highlights cost increases/decreases

**Q4: What is the cost per customer for each service?**
- Calculates unit economics
- Shows customer count and monthly cost
- Filters customer-facing services

**Q5: Which cost centers are over budget?**
- Identifies budget overruns
- Shows variance percentage
- Prioritizes by variance magnitude

---

### Incident Management Questions (3)

**Q6: Which business services have the most incidents?**
- 90-day incident volume by service
- Total revenue impact
- Average resolution time

**Q7: What is our incident resolution performance by priority?**
- Average acknowledgment and resolution times
- P95 resolution times
- Revenue impact by priority

**Q8: Which incidents are currently breaching SLA?**
- Open incidents past SLA target
- Breach time calculation
- Revenue impact assessment

---

### Change Management Questions (2)

**Q9: What is our change success rate?**
- 6-month change statistics
- Success/fail/rollback counts
- Success rate by change type

**Q10: What changes are scheduled for this week?**
- Weekly change calendar
- Risk level and duration
- Affected service count

---

### Compliance & Risk Questions (2)

**Q11: Which services are in SOX or PCI scope?**
- In-scope service inventory
- Data sensitivity classification
- CI compliance rates

**Q12: What is our compliance status by framework?**
- Compliance rate by framework
- Service counts
- Revenue supported

---

### Business Impact Questions (3)

**Q13: What revenue is at risk right now?**
- Open incident revenue impact
- Percentage of annual revenue
- User impact counts

**Q14: Which services need immediate attention?**
- Critical services with health score <70
- Tier 0/Tier 1 focus
- Incident and availability metrics

**Q15: What are our disaster recovery tier allocations?**
- DR tier distribution
- RTO/RPO metrics
- Revenue and customer counts

---

## Custom Question Creation Guide

Metabase supports two query modes: Visual Query Builder (no SQL required) and SQL Editor (for advanced users).

### Visual Query Builder

Best for non-technical users and simple queries.

#### Step 1: Create New Question

1. Click **+ New** in top navigation
2. Select **Question**
3. Choose **HappyCMDB** database

#### Step 2: Select Data Source

1. Click **Pick your starting data**
2. Select a view (e.g., `v_cost_by_tower`)
3. Metabase displays available columns

#### Step 3: Filter Data

1. Click **Filter** button
2. Add filter (e.g., Environment is "production")
3. Multiple filters supported (AND logic)

#### Step 4: Summarize

1. Click **Summarize** button
2. Choose metric (Sum, Average, Count, etc.)
3. Group by dimension (e.g., TBM Resource Tower)

#### Step 5: Visualize

1. Click visualization type (bar, line, pie, etc.)
2. Configure axes and labels
3. Adjust colors and formatting

#### Step 6: Save

1. Click **Save** button
2. Enter question name and description
3. Select collection

---

### SQL Editor

Best for power users and complex queries.

#### Step 1: Create SQL Question

1. Click **+ New** → **SQL Query**
2. Select **HappyCMDB** database
3. SQL editor opens

#### Step 2: Write Query

Example: Find services with high cost and low availability

```sql
SELECT
    bs.name AS business_service,
    bs.operational_status,
    COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) AS monthly_cost,
    COALESCE((bs.itil_attributes->>'availability_target')::DECIMAL, 0) AS sla_target,
    100.0 - COALESCE((bs.itil_attributes->>'availability_current')::DECIMAL, 0) AS availability_gap
FROM business_services bs
WHERE COALESCE((bs.tbm_attributes->>'total_monthly_cost')::DECIMAL, 0) > 10000
  AND 100.0 - COALESCE((bs.itil_attributes->>'availability_current')::DECIMAL, 0) > 5
ORDER BY monthly_cost DESC, availability_gap DESC;
```

#### Step 3: Add Parameters (Optional)

Make queries reusable with parameters:

```sql
SELECT *
FROM v_cost_by_tower
WHERE environment = {{environment}}  -- Parameter
  AND monthly_cost > {{min_cost}}    -- Parameter
ORDER BY monthly_cost DESC;
```

**Parameter Types**:
- `{{date}}` - Date picker
- `{{text}}` - Text input
- `{{number}}` - Number input
- `{{environment}}` - Dropdown (define values)

#### Step 4: Test Query

1. Click **Run** button (or Cmd/Ctrl + Enter)
2. Verify results
3. Adjust query as needed

#### Step 5: Visualize & Save

1. Select visualization type
2. Configure display settings
3. Save to collection

---

### Query Best Practices

**Performance**:
- Use views instead of joining raw tables
- Add `LIMIT` clause for large result sets
- Filter early with `WHERE` clauses
- Use indexes on frequently filtered columns

**Readability**:
- Use meaningful column aliases
- Add comments to complex queries
- Format SQL consistently (indentation, line breaks)
- Use CTEs for complex logic

**Parameterization**:
- Use parameters for date ranges
- Parameterize environment filters
- Create reusable templates

---

## User Management

Metabase supports role-based access control with three permission levels.

### User Roles

#### 1. Administrator

**Permissions**:
- Full system access
- User management
- Database configuration
- Settings management
- Collection permissions
- Dashboard editing

**Recommended For**:
- CMDB administrators
- IT leadership
- Platform engineers

#### 2. Analyst

**Permissions**:
- Create and edit questions
- Create and edit dashboards
- Save to assigned collections
- Schedule reports
- No user management
- No system settings

**Recommended For**:
- Data analysts
- FinOps team
- Service managers
- Business analysts

#### 3. Viewer

**Permissions**:
- View dashboards
- View questions
- No editing capabilities
- No saving capabilities
- Collection-specific access

**Recommended For**:
- Executives
- Service desk
- Read-only users
- External stakeholders

---

### Creating Users

#### Via Metabase UI

1. Navigate to **Admin** → **People**
2. Click **Invite someone**
3. Enter email address
4. Select group (Admin, Analyst, Viewer)
5. User receives invitation email
6. User sets password on first login

#### Via API (Bulk Creation)

```bash
curl -X POST http://localhost:3002/api/user \
  -H "X-Metabase-Session: $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Jane",
    "last_name": "Doe",
    "email": "jane.doe@company.com",
    "password": "TemporaryPassword123!",
    "group_ids": [2]
  }'
```

---

### Collections & Permissions

**Collections** organize content and define access boundaries.

#### Recommended Collection Structure

```
HappyCMDB Metabase
├── Executive Reports (CEO, CFO, CIO - Viewer access)
│   ├── Executive Dashboard
│   └── Board Reports
├── IT Operations (IT Ops - Analyst access)
│   ├── ITIL Dashboard
│   └── Incident Reports
├── FinOps (Finance - Analyst access)
│   ├── FinOps Dashboard
│   └── Cost Reports
├── Compliance (Compliance team - Analyst access)
│   ├── Compliance Dashboard
│   └── Audit Reports
├── Service Management (Service Desk - Viewer access)
│   └── Service Health Dashboard
└── Ad-Hoc Analysis (All analysts - Analyst access)
```

#### Setting Collection Permissions

1. Navigate to **Admin** → **Permissions**
2. Click **Collections** tab
3. Select collection
4. Set group permissions:
   - **No access** - Cannot see collection
   - **View** - Read-only access
   - **Curate** - View + edit content
5. Click **Save Changes**

---

## Scheduled Reports & Exports

Metabase supports automated report delivery via email.

### Email Configuration

#### SMTP Setup

Configure in `docker-compose.yml`:

```yaml
environment:
  MB_EMAIL_SMTP_HOST: smtp.gmail.com
  MB_EMAIL_SMTP_PORT: 587
  MB_EMAIL_SMTP_USERNAME: noreply@company.com
  MB_EMAIL_SMTP_PASSWORD: ${SMTP_PASSWORD}
  MB_EMAIL_SMTP_SECURITY: tls
  MB_EMAIL_FROM_ADDRESS: noreply@happycmdb.local
```

#### Test Email

1. Navigate to **Admin** → **Settings** → **Email**
2. Verify SMTP settings
3. Click **Send test email**

---

### Creating Scheduled Reports

#### Dashboard Subscription

1. Open dashboard
2. Click **subscription icon** (bell) in top right
3. Configure schedule:
   - **Frequency**: Daily, Weekly, Monthly, Custom
   - **Day/Time**: Specific day and time
   - **Recipients**: Email addresses (comma-separated)
   - **Format**: PDF, PNG, or attached Excel
4. Click **Create Subscription**

#### Question Subscription

1. Open saved question
2. Click **subscription icon**
3. Configure schedule (same as dashboard)
4. Format: PDF, Excel, CSV, or JSON

---

### Recommended Report Schedules

| Report | Frequency | Time | Recipients | Format |
|--------|-----------|------|------------|--------|
| Executive Summary | Weekly | Monday 8 AM | CEO, CFO, CIO | PDF |
| FinOps Cost Report | Monthly | 1st @ 9 AM | FinOps team, Finance | Excel |
| ITIL Weekly Metrics | Weekly | Friday 5 PM | IT Ops, Service Desk | PDF |
| Compliance Report | Monthly | 5th @ 9 AM | Compliance team, Audit | PDF |
| SLA Compliance | Weekly | Monday 9 AM | Service Owners | PDF |
| Budget Variance | Monthly | 1st @ 10 AM | Finance, Cost Centers | Excel |
| Incident Summary | Daily | 6 AM | IT Operations | PDF |

---

### Export Formats

**PDF**:
- Best for dashboards
- Executive presentations
- Archive/compliance

**Excel (.xlsx)**:
- Best for data analysis
- Financial reporting
- Pivot tables in Excel

**CSV**:
- Best for data import
- Raw data sharing
- System integration

**JSON**:
- Best for API integration
- System-to-system transfer

---

## Operations

### Backup & Recovery

#### Backing Up Metabase Application Database

Metabase stores its own metadata in PostgreSQL (`metabase` database).

```bash
# Backup Metabase metadata
docker exec cmdb-postgres pg_dump -U postgres metabase > metabase_backup_$(date +%Y%m%d).sql

# Restore from backup
docker exec -i cmdb-postgres psql -U postgres metabase < metabase_backup_20251106.sql
```

#### Backing Up CMDB Data

HappyCMDB data is in separate `cmdb` database:

```bash
# Backup CMDB database
docker exec cmdb-postgres pg_dump -U postgres cmdb > cmdb_backup_$(date +%Y%m%d).sql
```

#### Automated Backup Script

```bash
#!/bin/bash
# /infrastructure/scripts/backup-metabase.sh

BACKUP_DIR="/backups/metabase"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup Metabase metadata
docker exec cmdb-postgres pg_dump -U postgres metabase | gzip > $BACKUP_DIR/metabase_$DATE.sql.gz

# Backup dashboards (JSON export via API)
curl -X GET http://localhost:3002/api/dashboard \
  -H "X-Metabase-Session: $SESSION_TOKEN" \
  -o $BACKUP_DIR/dashboards_$DATE.json

# Keep only last 30 days
find $BACKUP_DIR -name "*.sql.gz" -mtime +30 -delete
```

---

### Upgrading Metabase

#### Docker Compose Upgrade

1. **Check current version**:
   ```bash
   docker exec cmdb-metabase java -jar /app/metabase.jar version
   ```

2. **Update docker-compose.yml**:
   ```yaml
   metabase:
     image: metabase/metabase:v0.48.0  # Update version
   ```

3. **Backup before upgrade**:
   ```bash
   ./infrastructure/scripts/backup-metabase.sh
   ```

4. **Pull new image**:
   ```bash
   docker-compose -f infrastructure/docker/docker-compose.yml pull metabase
   ```

5. **Recreate container**:
   ```bash
   docker stop cmdb-metabase
   docker rm cmdb-metabase
   docker-compose -f infrastructure/docker/docker-compose.yml up -d metabase
   ```

6. **Verify upgrade**:
   ```bash
   docker logs -f cmdb-metabase
   ```

---

### Monitoring

#### Health Check

```bash
# Check Metabase container health
docker ps | grep metabase

# Check application health endpoint
curl http://localhost:3002/api/health
```

#### Performance Monitoring

**Key Metrics**:
- Query execution time
- Cache hit rate
- Active user sessions
- Database connection pool usage

**View Metrics**:
1. Navigate to **Admin** → **Troubleshooting**
2. View **Performance** tab
3. Check slow queries

#### Log Monitoring

```bash
# View Metabase logs
docker logs cmdb-metabase -f

# Search for errors
docker logs cmdb-metabase | grep ERROR

# Export logs
docker logs cmdb-metabase > metabase_logs_$(date +%Y%m%d).log
```

---

### Troubleshooting

#### Metabase Won't Start

**Symptoms**: Container exits or restarts continuously

**Solutions**:
1. Check logs:
   ```bash
   docker logs cmdb-metabase
   ```

2. Verify database connection:
   ```bash
   docker exec cmdb-postgres psql -U postgres -c "SELECT datname FROM pg_database WHERE datname = 'metabase';"
   ```

3. Increase Java heap size:
   ```yaml
   environment:
     JAVA_OPTS: "-Xmx4g"  # Increase from default 2g
   ```

---

#### Cannot Connect to CMDB Database

**Symptoms**: "Database connection failed" error

**Solutions**:
1. Verify `metabase_readonly` user:
   ```bash
   docker exec cmdb-postgres psql -U postgres -c "\du metabase_readonly"
   ```

2. Check permissions:
   ```sql
   \c cmdb
   SELECT grantee, privilege_type
   FROM information_schema.table_privileges
   WHERE grantee = 'metabase_readonly' LIMIT 10;
   ```

3. Re-create user:
   ```bash
   docker exec -i cmdb-postgres psql -U postgres < infrastructure/database/metabase-init.sql
   ```

---

#### Views Not Appearing

**Symptoms**: Database views missing in schema browser

**Solutions**:
1. Sync database schema:
   - Admin → Databases → HappyCMDB
   - Click **Sync database schema now**

2. Re-create views:
   ```bash
   docker exec -i cmdb-postgres psql -U postgres -d cmdb < infrastructure/database/views/cost-analysis.sql
   docker exec -i cmdb-postgres psql -U postgres -d cmdb < infrastructure/database/views/itil-analysis.sql
   docker exec -i cmdb-postgres psql -U postgres -d cmdb < infrastructure/database/views/bsm-analysis.sql
   ```

---

#### Slow Query Performance

**Symptoms**: Dashboards take >10 seconds to load

**Solutions**:
1. **Enable query caching**:
   - Admin → Settings → Caching
   - Set TTL: 3600 seconds (1 hour)

2. **Optimize queries**:
   - Use views instead of complex joins
   - Add WHERE clauses
   - Use date range filters

3. **Add database indexes**:
   ```sql
   CREATE INDEX idx_ci_type_env ON cmdb.dim_ci(ci_type, environment);
   CREATE INDEX idx_incident_date ON itil_incidents(reported_at);
   ```

4. **Materialize expensive views**:
   ```sql
   CREATE MATERIALIZED VIEW mv_cost_summary AS
   SELECT * FROM v_executive_cost_summary;

   REFRESH MATERIALIZED VIEW mv_cost_summary;  -- Run periodically
   ```

---

#### Email Reports Not Sending

**Symptoms**: Scheduled subscriptions fail

**Solutions**:
1. Test SMTP settings:
   - Admin → Settings → Email
   - Click **Send test email**

2. Check logs:
   ```bash
   docker logs cmdb-metabase | grep -i email
   ```

3. Verify firewall rules allow SMTP port (587 or 465)

---

## Security Best Practices

1. **Change default passwords immediately** after first login
2. **Use strong passwords** (16+ characters, mixed case, numbers, symbols)
3. **Enable SSL/TLS** for production deployments
4. **Restrict database user** to read-only (`metabase_readonly`)
5. **Regular backups** of Metabase application database
6. **Audit user access** monthly (Admin → Audit Log)
7. **Review collection permissions** quarterly
8. **Rotate SMTP credentials** annually
9. **Monitor query performance** for abuse
10. **Use SSO/SAML** for enterprise authentication (Metabase Enterprise)

---

## Additional Resources

- **Official Documentation**: [https://www.metabase.com/docs/latest/](https://www.metabase.com/docs/latest/)
- **SQL Best Practices**: [https://www.metabase.com/learn/sql-questions/](https://www.metabase.com/learn/sql-questions/)
- **Dashboard Design Guide**: [https://www.metabase.com/learn/dashboards/](https://www.metabase.com/learn/dashboards/)
- **HappyCMDB Documentation**: [http://localhost:8080](http://localhost:8080) (when running)
- **Metabase Community**: [https://discourse.metabase.com/](https://discourse.metabase.com/)

---

## Summary

Metabase provides HappyCMDB v3.0 with enterprise-grade business intelligence capabilities:

- **24 optimized database views** for Cost Analysis, ITIL, and BSM
- **3 pre-built dashboards** for Executive, FinOps, and ITIL stakeholders
- **15 pre-configured questions** for common analysis scenarios
- **Self-service analytics** with visual query builder and SQL editor
- **Scheduled reports** with PDF, Excel, and CSV exports
- **Role-based access control** with collection-level permissions

For implementation assistance or customization, consult the HappyCMDB documentation or open an issue on the repository.

---

**Version**: HappyCMDB v3.0
**Last Updated**: November 6, 2025
**Maintained By**: HappyCMDB Development Team
