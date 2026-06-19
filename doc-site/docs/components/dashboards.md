---
title: Multi-Stakeholder Dashboards
description: Executive, CIO, ITSM, FinOps, and Business Service dashboards for HappyCMDB v3.0
---

# Multi-Stakeholder Dashboards

HappyCMDB v3.0 provides five specialized dashboards designed for different organizational personas, each tailored to specific decision-making needs and operational workflows. These dashboards integrate data from ITIL Service Management, TBM Cost Engine, and BSM Impact Engine to provide comprehensive, role-specific insights.

## Overview

The multi-stakeholder dashboard system is designed to serve five key personas:

| Dashboard | Primary Users | Focus Area | Update Frequency |
|-----------|---------------|------------|------------------|
| **Executive** | CEO, CFO, VP | Strategic IT investment, business value, risk | 1 hour |
| **CIO** | CIO, IT Director | Service quality, capacity planning, budget | 30 minutes |
| **ITSM** | Service Manager, Operations | Incidents, changes, configuration management | 10 seconds (real-time) |
| **FinOps** | Finance, FinOps Team | Cloud costs, optimization, TCO | 1 hour |
| **Business Service** | Service Owners, Product Managers | Service health, customer impact, compliance | 5 minutes |

### Key Features

All dashboards share common capabilities:

- **Auto-Refresh**: Configurable refresh intervals (10s to 1h)
- **Time Range Selection**: 7d, 30d, 90d, 1y views
- **Export Options**: PDF and Excel export for reporting
- **Responsive Design**: Works on desktop, tablet, and mobile
- **Dark Mode**: Full dark mode support
- **Real-Time Updates**: WebSocket subscriptions for live data
- **Interactive Charts**: Drill-down capabilities with Recharts
- **Accessibility**: WCAG 2.1 AA compliant

---

## Executive Dashboard

**Persona**: CEO, CFO, VP of Engineering
**Purpose**: Strategic overview of IT investment and business value
**Navigation**: Dashboard → Executive

### Features

#### 1. KPI Summary Cards

Four high-level metrics at the top of the dashboard:

- **Total IT Spend**: Aggregate cost across all infrastructure and services
- **Overall Health Score**: Weighted average health across service tiers
- **High Risk Services**: Count of critical services with high risk
- **Average ROI**: Return on IT investment across business services

::: tip Time Range Selection
Executives typically view 1-year trends for strategic planning. Use the time range selector to switch between 30d, 90d, and 1y views.
:::

#### 2. Cost Breakdown Treemap

**Interactive treemap** showing IT spend by business capability:

- **Hierarchical View**: Drill down from capability → business services
- **Color Coding**: Visual identification of highest cost areas
- **Click to Drill**: Click any capability to see constituent services
- **Tooltip Details**: Hover for exact cost values

```typescript
// Example data structure
{
  name: "Customer Experience",
  value: 1250000,  // Total cost
  children: [
    { name: "E-commerce Platform", value: 750000 },
    { name: "Customer Portal", value: 350000 },
    { name: "Mobile App", value: 150000 }
  ]
}
```

#### 3. Cost Trends Chart

**Line chart** showing monthly IT spend over time:

- **Budget Line**: Compare actual vs. budgeted spend
- **Trend Analysis**: Identify cost increases/decreases
- **Forecast**: Projected spend based on historical trends (optional)

#### 4. Service Health by Tier

**Bar chart** showing average health scores by service tier:

- **Tier 0**: Mission-critical (99.99% SLA target)
- **Tier 1**: Business-critical (99.9% SLA target)
- **Tier 2**: Important (99.5% SLA target)
- **Tier 3**: Standard (99% SLA target)

Health scores aggregate:
- Service availability
- Incident frequency
- Change success rate
- Configuration accuracy

#### 5. Risk Exposure Matrix

**Scatter plot** showing services by criticality vs. risk level:

- **X-axis**: Business criticality (Tier 0-4)
- **Y-axis**: Risk level (critical/high/medium/low)
- **Bubble Size**: Monthly cost
- **Color**: Health score (green/yellow/red)

::: warning High Risk Services
Services in the top-right quadrant (high criticality + high risk) require immediate attention. Click on any bubble to view remediation plan.
:::

#### 6. Top 5 Cost Drivers

**Horizontal bar chart** with drill-down list:

Shows the five services with highest monthly cost:
- Service name and cost
- Trend indicator (↑ up, ↓ down)
- Percentage change from previous period
- Click to view detailed cost breakdown

#### 7. Value Scorecard

**Data table** showing business value metrics:

| Service | Annual Revenue | Monthly Cost | ROI | Customers |
|---------|----------------|--------------|-----|-----------|
| E-commerce Platform | $15.2M | $75K | 1,520% | 125,000 |
| API Gateway | $8.5M | $32K | 2,031% | 85,000 |

**ROI Calculation**:
```
ROI = ((Annual Revenue - Annual Cost) / Annual Cost) × 100
```

**Color Coding**:
- Green badge: ROI ≥ 100%
- Grey badge: ROI < 100%

### Use Cases

1. **Board Meeting Preparation**: Export executive summary to PDF for board presentations
2. **Budget Planning**: Use cost trends and ROI to justify IT investment requests
3. **Risk Review**: Identify high-risk services requiring leadership attention
4. **Strategic Planning**: Compare cost vs. value to prioritize initiatives

### Customization

Executives can customize:
- Default time range (90d or 1y recommended)
- KPI thresholds (e.g., "high risk" threshold)
- Excluded business units (e.g., R&D)

### Export Options

**PDF Export**:
- Single-page executive summary
- Includes all charts and KPIs
- Branded with company logo

**Excel Export**:
- Multiple sheets: KPIs, Cost Breakdown, Value Scorecard
- Raw data for further analysis
- Pivot table ready

---

## CIO Dashboard

**Persona**: CIO, IT Director, Head of Operations
**Purpose**: IT operations monitoring, service quality, and capacity planning
**Navigation**: Dashboard → CIO

### Features

#### 1. KPI Summary Cards

Four operational metrics:

- **Average Availability**: Across all service tiers (target: 99.9%+)
- **Change Success Rate**: Percentage of successful changes (target: 85%+)
- **Configuration Accuracy**: CMDB accuracy percentage (target: 95%+)
- **Total IT Budget**: Allocated budget across business capabilities

::: tip Color Coding
KPI cards use traffic light colors:
- Green: Meeting or exceeding targets
- Yellow: Within 5% of target
- Red: Below target threshold
:::

#### 2. Service Availability by Tier

**Grouped bar chart** comparing actual availability vs. SLA target:

```typescript
// Example data
{
  tier: "Tier 0 - Mission Critical",
  averageAvailability: 99.97,
  slaTarget: 99.99,
  complianceStatus: "compliant"  // or "breach"
}
```

**Compliance Status**:
- ✅ Green badge: Within SLA
- 🚨 Red badge: Below SLA (requires explanation)

**List View**: Below the chart, each tier shows:
- Actual availability percentage
- Number of services in tier
- Compliance status
- Breach count (if any)

#### 3. Change Success Rates

**Pie chart** showing change outcomes:

- **Successful**: Changes completed without issues (green)
- **Failed**: Changes that failed and required rollback (red)
- **Rollbacks**: Planned rollbacks due to issues (orange)

**Metrics Display**:
- Total change count for time period
- Success rate percentage
- Comparison to previous period

#### 4. Incident Response Times (MTTR)

**Bar chart** showing Mean Time to Resolution by priority:

| Priority | MTTR Target | Actual MTTR | Status |
|----------|-------------|-------------|--------|
| P1 - Critical | 1h | 0.8h | ✅ On Target |
| P2 - High | 4h | 5.2h | 🚨 Over Target |
| P3 - Medium | 24h | 18h | ✅ On Target |
| P4 - Low | 72h | 48h | ✅ On Target |

**MTTR Calculation**:
```
MTTR = Total Resolution Time / Number of Incidents
```

::: warning MTTR Breach
P2 incidents exceeding MTTR target may indicate:
- Insufficient staffing
- Complex root cause
- Inadequate automation
- Knowledge gaps
:::

#### 5. Configuration Accuracy

**Progress bar** with detailed breakdown:

- **Overall Accuracy**: Percentage of CIs with accurate configuration
- **Total CIs**: Count of all configuration items
- **Accurate CIs**: CIs matching baseline
- **Drift Detected**: CIs with configuration drift
- **Last Audit Date**: Timestamp of most recent audit

**Grid Display**:
```
┌────────────────────────────────────┐
│  Configuration Accuracy: 96.3%     │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░            │
└────────────────────────────────────┘

   Total CIs        Accurate CIs      Drift Detected
      15,243           14,680              563
```

#### 6. Cost by Business Capability

**Horizontal bar chart** comparing actual spend vs. budget:

- **Budget Allocated**: Planned budget (green bars)
- **Actual Spend**: Current spend (blue bars)
- **Variance**: Percentage over/under budget

**Variance Badges**:
- Green: Under budget
- Red: Over budget
- Amount and percentage displayed

#### 7. Capacity Planning

**Multi-line chart** showing resource utilization trends:

Three trend lines:
- **Compute Utilization**: CPU/memory usage across infrastructure
- **Storage Utilization**: Disk space consumption
- **Network Utilization**: Bandwidth usage

**Forecast**: Projected utilization for next 3-6 months based on trends

::: danger Capacity Alert
When any resource exceeds 80% utilization, consider:
- Scaling up existing resources
- Adding additional capacity
- Optimizing resource usage
- Migrating workloads
:::

### Use Cases

1. **Daily Standup**: Review ITSM metrics and capacity trends
2. **Change Advisory Board (CAB)**: Analyze change success rates and risk
3. **Budget Review**: Compare actual vs. planned spending by capability
4. **Capacity Planning**: Forecast infrastructure needs for next quarter
5. **Service Review**: Assess availability compliance and improvement trends

### Customization

CIOs can customize:
- MTTR targets per priority
- SLA targets per tier
- Capacity utilization thresholds
- Budget variance alert thresholds

### Export Options

**PDF Export**:
- Operational summary report
- All charts and metrics
- Trend analysis commentary

**Excel Export**:
- Multiple sheets: Availability, Changes, Incidents, Capacity
- Pivot tables for custom analysis
- Variance calculations

---

## ITSM Dashboard

**Persona**: Service Manager, Operations Team, Support Engineers
**Purpose**: Real-time incident and change management
**Navigation**: Dashboard → ITSM

### Features

#### 1. KPI Summary Cards

Four operational metrics:

- **Open Incidents**: Count of currently open incidents
- **In Progress**: Incidents actively being worked
- **Active CIs**: Configuration items in active status
- **Changes in Progress**: Active change requests

**Color Coding**:
- Green: Normal operations (< 5 open incidents)
- Yellow: Elevated (5-10 open incidents)
- Red: Critical (> 10 open incidents)

#### 2. Open Incidents Table

**Real-time table** with filtering and sorting:

Columns:
- **ID**: Incident number (clickable link)
- **Priority**: P1 (Critical) to P4 (Low)
- **Status**: Open, In Progress, Resolved
- **Title**: Brief description
- **Affected CI**: Primary configuration item
- **Assigned To**: Assigned engineer
- **Age**: Time since incident opened
- **MTTR Target**: Time remaining until target breach

**Filtering**:
- By priority (P1, P2, P3, P4)
- By status (Open, In Progress)
- By assigned engineer
- By affected service

**Sorting**:
- By priority (default)
- By age (oldest first)
- By time to MTTR breach

::: tip Real-Time Updates
The ITSM dashboard refreshes every 10 seconds via WebSocket subscriptions. New incidents appear instantly without page reload.
:::

#### 3. Changes in Progress (Kanban View)

**Kanban board** with four columns:

**Column 1: Scheduled**
- Changes approved and scheduled
- Scheduled date/time displayed
- Risk level badge (high/medium/low)
- Change type (standard/normal/emergency)

**Column 2: In Progress**
- Currently executing changes
- Blue border for visibility
- Assigned engineer
- Progress indicator

**Column 3: Rollback**
- Failed changes requiring rollback
- Red border for urgency
- Failure reason displayed
- Count displayed as red badge

**Column 4: Completed**
- Successfully completed changes (last 5)
- Green border
- Completion timestamp
- Green checkmark icon

**Drag and Drop** (optional): Drag cards between columns to update status

```typescript
// Example change card
{
  id: "CHG0001234",
  title: "Upgrade PostgreSQL to v15.3",
  type: "standard",
  riskLevel: "medium",
  status: "in-progress",
  scheduledDate: "2025-11-06T22:00:00Z",
  assignedTo: "ops-team@example.com"
}
```

#### 4. CI Status Overview

**Grid display** showing configuration items by status:

```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│   Active    │  Inactive   │ Maintenance │Decommissioned│
│   12,450    │    2,130    │     425     │     238     │
│   Active    │  Inactive   │ Maintenance │Decommissioned│
└─────────────┴─────────────┴─────────────┴─────────────┘
```

Click any status to filter CI inventory by that status.

#### 5. Top Failing CIs

**Data table** showing CIs with most incidents in last 30 days:

| CI Name | Type | Incident Count | MTTR | Last Failure | Recommendation |
|---------|------|----------------|------|--------------|----------------|
| db-prod-01 | Database | 8 | 2.3h | 2025-11-05 | Upgrade to latest patch |
| api-gateway-02 | Application | 6 | 1.8h | 2025-11-04 | Increase memory allocation |
| lb-prod-01 | Load Balancer | 5 | 0.9h | 2025-11-03 | Review health check config |

**Incident Count Badge**: Red badge showing number of incidents

**Recommendations**: AI-generated or rule-based suggestions:
- "Upgrade to latest patch"
- "Increase memory allocation"
- "Review configuration baseline"
- "Consider replacement"

::: warning Chronic Failures
CIs appearing in this list repeatedly may require:
- Root cause analysis (RCA)
- Configuration baseline update
- Hardware replacement
- Architecture redesign
:::

#### 6. SLA Compliance

**Progress bars** showing compliance by priority:

Each priority (P1, P2, P3, P4) shows:
- **Compliance Percentage**: % of incidents resolved within SLA
- **Count**: "X of Y within SLA"
- **Target**: Target compliance percentage
- **Progress Bar**: Visual indicator (red if below target)

```typescript
// Example SLA data
{
  priority: "P1",
  withinSLA: 45,
  total: 48,
  compliancePercentage: 93.8,
  target: 95.0
}
```

#### 7. Configuration Baseline Compliance

**Data table** showing CIs with detected drift:

| CI Name | Type | Severity | Drift Details | Status | Last Checked |
|---------|------|----------|---------------|--------|--------------|
| web-prod-01 | Server | High | SSL cert expired | Remediation pending | 2h ago |
| app-prod-05 | Application | Medium | Config file modified | Under review | 30m ago |
| db-staging-02 | Database | Low | Log level changed | Approved drift | 1h ago |

**Severity Levels**:
- **High**: Security or compliance issues (red)
- **Medium**: Configuration best practices (yellow)
- **Low**: Minor deviations (blue)

**Remediation Status**:
- "Pending": Awaiting approval
- "Under review": Being investigated
- "Approved drift": Intentional change
- "Remediated": Fixed and verified

### Use Cases

1. **Incident Response**: Monitor open incidents and assign to engineers
2. **Change Management**: Track change execution in real-time
3. **Configuration Audits**: Identify and remediate drift
4. **SLA Monitoring**: Ensure compliance with service level agreements
5. **Problem Management**: Identify chronic failing CIs for RCA

### Customization

Service Managers can customize:
- Incident table columns
- SLA targets per priority
- Drift severity thresholds
- Refresh interval (default: 10s)

### Real-Time Features

The ITSM dashboard uses **WebSocket subscriptions** for real-time updates:

```typescript
// WebSocket topics
subscription {
  incidentCreated { id, priority, title, status }
  incidentUpdated { id, status, assignedTo }
  changeStatusChanged { id, status, riskLevel }
  driftDetected { ciId, severity, details }
}
```

**Benefits**:
- No page refresh required
- Instant notifications
- Live status updates
- Collaborative workflows

### Export Options

**PDF Export**:
- Current snapshot of all metrics
- Open incidents list
- Changes in progress
- SLA compliance report

**Excel Export**:
- Incident details (all fields)
- Change request details
- CI drift report
- SLA compliance data

---

## FinOps Dashboard

**Persona**: Finance Team, FinOps Engineers, Cost Analysts
**Purpose**: Cloud cost management and optimization
**Navigation**: Dashboard → FinOps

### Features

#### 1. KPI Summary Cards

Four cost metrics:

- **Total Cloud Spend**: Aggregate cloud cost (AWS + Azure + GCP)
- **Monthly Average**: Average monthly cloud spend
- **Total IT Cost**: On-premise + cloud combined
- **Potential Savings**: Sum of all optimization opportunities

**Trend Indicators**:
- ↑ Red: Cost increasing (% change)
- ↓ Green: Cost decreasing (% change)

#### 2. Cloud Spend by Provider

**Stacked area chart** showing monthly cloud costs:

Three layers:
- **AWS**: Blue area
- **Azure**: Purple area
- **GCP**: Green area

**Breakdown by Service** (on hover):
- EC2/Compute instances
- Storage (S3, Blob, Cloud Storage)
- Databases (RDS, SQL Database, Cloud SQL)
- Networking (data transfer, load balancers)
- Other services

```typescript
// Example monthly data
{
  month: "Oct 2025",
  aws: 450000,
  azure: 280000,
  gcp: 120000,
  total: 850000
}
```

#### 3. On-Premise vs. Cloud Comparison

**Pie chart** showing cost distribution:

- **On-Premise**: 45% ($2.8M)
- **Cloud**: 55% ($3.4M)

**TCO Comparison Table**:

| Category | On-Premise | Cloud | Delta |
|----------|------------|-------|-------|
| Compute | $1.2M | $1.8M | +50% |
| Storage | $800K | $900K | +13% |
| Networking | $400K | $350K | -13% |
| Licensing | $300K | $250K | -17% |
| Labor | $100K | $100K | 0% |

**Total Cost of Ownership (TCO)** includes:
- Hardware/infrastructure costs
- Software licensing
- Labor (operations, support)
- Facility costs (power, cooling, space)
- Depreciation

::: tip TCO Analysis
When comparing on-prem vs. cloud, consider:
- **Initial Investment**: On-prem requires large upfront capital
- **Operational Costs**: Cloud has higher monthly OpEx
- **Scalability**: Cloud scales more easily
- **Maintenance**: Cloud reduces maintenance burden
:::

#### 4. Cost Allocation by Resource Tower

**Treemap** showing hierarchical cost breakdown:

**Top Level**: 11 TBM v5.0.1 Resource Towers
1. Compute
2. Storage
3. IT Management
4. Network
5. Facilities
6. Other
7. Applications
8. Databases
9. End User
10. Middleware
11. Platform

**Drill Down**: Click any tower to see sub-towers and services

```typescript
// Example treemap data
{
  name: "Compute",
  value: 1800000,
  children: [
    { name: "EC2 Instances", value: 950000 },
    { name: "Lambda Functions", value: 350000 },
    { name: "ECS/Fargate", value: 300000 },
    { name: "EKS Clusters", value: 200000 }
  ]
}
```

#### 5. Budget Variance by Capability

**Horizontal bar chart** comparing budget vs. actual spend:

Each business capability shows:
- **Budget Allocated**: Green bar (planned)
- **Actual Spend**: Blue bar (current)
- **Variance**: Badge showing % over/under

**List View** below chart:
```
Customer Experience    $750K / $825K    +10.0% 🔴
Data & Analytics       $520K / $480K     -7.7% 🟢
Internal Tools         $340K / $365K     +7.4% 🟡
```

**Color Coding**:
- Green: Under budget (savings)
- Yellow: Within 5% of budget
- Red: Over budget (requires explanation)

#### 6. Unit Economics

**Metric cards** showing cost per unit:

Common unit economics metrics:
- **Cost per User**: Total IT cost / active users
- **Cost per Transaction**: Total IT cost / monthly transactions
- **Cost per API Call**: API infrastructure cost / total API calls
- **Cost per GB Stored**: Storage cost / total GB
- **Cost per Compute Hour**: Compute cost / total compute hours

Each card shows:
- Current value
- Trend (↑ up, ↓ down)
- % change from previous period
- Unit label

```typescript
// Example unit economics
{
  metric: "Cost per User",
  value: 8.45,      // $8.45
  unit: "$ / user / month",
  trend: "down",
  changePercent: -5.2
}
```

::: tip Unit Economics Best Practices
Track unit economics to:
- Identify cost inefficiencies
- Set pricing strategies
- Forecast future costs
- Compare against industry benchmarks
- Optimize resource allocation
:::

#### 7. Cost Optimization Recommendations

**Card list** showing optimization opportunities:

Each recommendation card includes:
- **Type**: Badge (Reserved Instances, Rightsizing, Storage Optimization, etc.)
- **Priority**: High/Medium/Low badge
- **Resource**: Specific resource name
- **Description**: What to do
- **Current Cost**: Monthly cost
- **Potential Savings**: Monthly savings amount

**Example Recommendations**:

1. **Reserved Instances** | High Priority
   `EC2 Instance: i-0abc123456def7890`
   Purchase 1-year RI for consistent workload
   Current: $1,250/mo → **Save $475/mo**

2. **Rightsizing** | Medium Priority
   `RDS Database: prod-mysql-01`
   Downsize from db.r5.2xlarge to db.r5.xlarge
   Current: $680/mo → **Save $340/mo**

3. **Storage Optimization** | Medium Priority
   `S3 Bucket: logs-archive-bucket`
   Migrate to S3 Glacier for cold storage
   Current: $230/mo → **Save $195/mo**

**Total Potential Savings**: Sum of all recommendations

**Action Buttons**: "Implement" or "Dismiss" for each recommendation

### Use Cases

1. **Monthly Financial Review**: Compare actual vs. budgeted spend
2. **Cost Optimization**: Review and implement savings recommendations
3. **Budget Planning**: Use trends to forecast next quarter/year
4. **Chargeback/Showback**: Allocate costs to business units
5. **Vendor Negotiations**: Use spend data to negotiate better pricing
6. **Unit Economics Analysis**: Track cost efficiency over time

### Customization

FinOps teams can customize:
- Time ranges (default: 90d for cost analysis)
- Budget variance thresholds
- Unit economics metrics (custom formulas)
- Cost allocation rules (tower mapping)
- Optimization priorities (auto-implement low-risk items)

### TBM Integration

The FinOps dashboard integrates with **TBM Cost Engine**:

**Cost Allocation Methods**:
1. **Direct Attribution**: Costs directly assigned to services
2. **Usage-Based**: Costs allocated by utilization metrics
3. **Equal Split**: Shared costs divided equally

**Data Sources**:
- **AWS Cost Explorer**: Daily sync via API
- **Azure Cost Management**: Daily sync via API
- **GCP Billing BigQuery**: Daily sync via API
- **On-Premise Costs**: Manual entry or GL integration
- **Depreciation Schedule**: Asset management system

### Export Options

**PDF Export**:
- Executive cost summary
- Budget variance report
- Optimization recommendations
- Trend analysis

**Excel Export**:
- Detailed cost breakdown (all services)
- Budget variance by capability
- Optimization recommendations (sortable)
- Unit economics time series
- TCO comparison

---

## Business Service Dashboard

**Persona**: Service Owners, Product Managers, Business Unit Leaders
**Purpose**: Service health, customer impact, and business value
**Navigation**: Dashboard → Business Service

### Features

#### 1. Service Health Heat Map

**Interactive grid** showing all business services by business unit:

**Layout**:
- Rows: Business units (Engineering, Sales, Marketing, Finance, Operations)
- Columns: Business services within each unit
- Cells: Color-coded by health score

**Color Coding**:
```
Green:  Health ≥ 80% (Healthy)
Yellow: Health 60-79% (Warning)
Red:    Health < 60% (Critical)
```

**Cell Content**:
- Service name (truncated)
- Health score percentage
- Hover: Full service name and details

**Interaction**:
- Click any service to load detailed metrics below
- Selected service has blue ring highlight

```typescript
// Example service data
{
  businessUnit: "engineering",
  businessServices: [
    { serviceId: "svc-001", serviceName: "E-commerce Platform", healthScore: 94 },
    { serviceId: "svc-002", serviceName: "API Gateway", healthScore: 78 },
    { serviceId: "svc-003", serviceName: "Payment Service", healthScore: 56 }
  ]
}
```

::: tip Health Score Calculation
Business service health score aggregates:
- **Technical Health** (40%): Availability, performance, errors
- **Operational Health** (30%): Incident count, change success rate
- **Configuration Health** (20%): Drift, accuracy, baseline compliance
- **Business Health** (10%): Customer satisfaction, SLA compliance
:::

#### 2. Service-Specific KPIs

**Four KPI cards** (displayed only when service is selected):

**Revenue at Risk**
- Dollar amount of revenue at risk from incidents
- Percentage of total annual revenue
- Color: Red if > 10%, Green otherwise

**Customers Impacted**
- Count of customers affected by incidents
- Total customer count for context
- Color: Red if > 0, Green otherwise

**Estimated User Impact**
- Number of end users affected
- Based on customer count × avg users per customer
- Color: Red if > 0, Green otherwise

**Compliance Score**
- Fraction: "3/4" (3 frameworks compliant out of 4)
- Frameworks: PCI, HIPAA, SOX, GDPR
- Color: Green if all compliant, Yellow otherwise

#### 3. Revenue at Risk Details

**Card list** showing incidents affecting revenue:

Each incident shows:
- Incident ID (clickable)
- Priority badge (P1/P2)
- Estimated revenue impact
- Status (open/in-progress/resolved)

**Revenue Impact Calculation**:
```typescript
// Annual revenue / 365 days / 24 hours = revenue per hour
// Impact = revenue per hour × downtime hours × customer impact %

const revenuePerHour = annualRevenue / 365 / 24;
const impact = revenuePerHour * downtimeHours * (customersImpacted / totalCustomers);
```

**Example**:
```
Incident INC0001234  [P1]
API Gateway failure causing checkout errors
$45,000 at risk (3 hours × $15K/hour × 100% customer impact)
```

::: danger Revenue at Risk Alert
When revenue at risk exceeds thresholds:
- **> $10K**: Notify service owner
- **> $50K**: Escalate to VP
- **> $100K**: Escalate to executive team
:::

#### 4. Compliance Status

**Grid display** showing compliance framework status:

**Four Frameworks**:
1. **PCI-DSS**: Payment Card Industry Data Security Standard
2. **HIPAA**: Health Insurance Portability and Accountability Act
3. **SOX**: Sarbanes-Oxley Act
4. **GDPR**: General Data Protection Regulation

Each framework shows:
- Checkmark icon (green) or X icon (red)
- "Compliant" or "Non-Compliant" badge
- Last audit date

**Non-Compliant Items List**:

If non-compliant, shows table with:
- **Requirement**: Specific compliance requirement
- **Status**: Current status (e.g., "Missing encryption")
- **Remediation**: Recommended action

```typescript
// Example non-compliant item
{
  requirement: "PCI-DSS 3.4: Encrypt cardholder data in transit",
  status: "TLS 1.0 in use (deprecated)",
  remediation: "Upgrade to TLS 1.2+ by Q1 2026"
}
```

#### 5. Value Stream Health

**Sequential flow diagram** showing stages in the value stream:

**Example Stages**:
1. Backlog → Planning → Development → Testing → Deployment → Production

Each stage shows:
- **Stage Name**: "Development", "Testing", etc.
- **Health Score**: 0-100%
- **Throughput**: Items per day
- **Bottleneck**: Red badge if bottleneck detected
- **Progress Bar**: Visual health indicator

**Metrics**:
- **Flow Rate**: Total requests/day through entire stream
- **Cycle Time**: Average hours from start to finish

**Bottleneck Detection**:
- Stage with lowest throughput
- Stage with highest wait time
- Highlighted with red "Bottleneck" badge

```typescript
// Example value stream stage
{
  name: "Testing",
  healthScore: 65,
  throughput: 12,  // items per day
  bottleneck: true,
  waitTime: 48     // hours
}
```

::: tip Value Stream Optimization
To improve value stream health:
- **Reduce Bottlenecks**: Add capacity to slowest stage
- **Automate**: Reduce manual handoffs
- **Balance Load**: Even distribution across stages
- **Reduce Wait Time**: Eliminate queues between stages
:::

#### 6. Service Dependency Map

**Interactive graph** showing service dependencies:

**Visualization**: Cytoscape.js graph with three layers:
1. **Business Layer**: Diamond shapes (blue)
2. **Application Layer**: Rounded rectangles (purple)
3. **Infrastructure Layer**: Circles (green)

**Node Properties**:
- **Color**: Health score-based (green/yellow/red)
- **Size**: Proportional to importance
- **Label**: Service name
- **On Click**: Show service details

**Edge Properties**:
- **Direction**: Arrow showing dependency flow
- **Label**: Relationship type ("DEPENDS_ON", "HOSTS", "USES")
- **Color**: Red if high health impact, grey otherwise
- **Thickness**: Thicker for critical dependencies

**Layout**: Breadthfirst (top-down hierarchy)

```typescript
// Example graph elements
{
  nodes: [
    { id: "bs-001", label: "E-commerce", type: "business", healthScore: 94, layer: "business" },
    { id: "app-001", label: "Web App", type: "application", healthScore: 92, layer: "application" },
    { id: "db-001", label: "PostgreSQL", type: "database", healthScore: 98, layer: "infrastructure" }
  ],
  edges: [
    { from: "bs-001", to: "app-001", type: "DEPENDS_ON", healthImpact: "high" },
    { from: "app-001", to: "db-001", type: "USES", healthImpact: "high" }
  ]
}
```

**Interaction**:
- **Zoom**: Mouse wheel to zoom in/out
- **Pan**: Drag to move graph
- **Click Node**: Highlight dependencies
- **Hover Edge**: Show relationship details

**Legend**:
- 🟢 Healthy (> 80%)
- 🟡 Warning (60-80%)
- 🔴 Critical (< 60%)

### Use Cases

1. **Service Health Monitoring**: Quickly identify unhealthy services
2. **Incident Impact Analysis**: Understand customer and revenue impact
3. **Compliance Audits**: Verify compliance status before audits
4. **Dependency Analysis**: Identify upstream/downstream dependencies
5. **Value Stream Optimization**: Find and eliminate bottlenecks
6. **Business Reviews**: Report service health to stakeholders

### Customization

Service owners can customize:
- Business unit filter (show only my services)
- Compliance frameworks to track
- Revenue calculation method
- Dependency graph layout (breadthfirst/circle/grid)
- Health score weightings

### BSM Integration

The Business Service Dashboard integrates with **BSM Impact Engine**:

**Criticality Tiers**:
- **Tier 0**: Revenue-generating (critical)
- **Tier 1**: Customer-facing (high)
- **Tier 2**: Internal critical (medium)
- **Tier 3**: Internal standard (low)
- **Tier 4**: Development/test (minimal)

**Impact Scoring** (0-100 scale):
- Revenue impact: 40 points
- Customer impact: 30 points
- Compliance impact: 20 points
- Operational impact: 10 points

**Blast Radius Analysis**:
- Dependency graph traversal
- Cascade failure prediction
- Downstream service impact

### Export Options

**PDF Export**:
- Service health summary
- Compliance report card
- Dependency map (PNG image)
- Revenue at risk report

**Excel Export**:
- Service health by business unit
- Compliance status matrix
- Value stream metrics
- Dependency list (source → target)

---

## Common Features

All five dashboards share these capabilities:

### 1. Auto-Refresh

**Refresh Intervals**:
- **ITSM Dashboard**: 10 seconds (real-time)
- **CIO Dashboard**: 30 seconds
- **Business Service Dashboard**: 5 minutes
- **Executive Dashboard**: 1 hour
- **FinOps Dashboard**: 1 hour

**Manual Refresh**: Click "Refresh" button to update immediately

**WebSocket Support**: ITSM dashboard uses WebSocket for instant updates

### 2. Time Range Selection

**Standard Ranges**:
- 7 days (last week)
- 30 days (last month)
- 90 days (last quarter)
- 1 year (last year)
- Custom (date picker)

**Default Ranges by Dashboard**:
| Dashboard | Default | Rationale |
|-----------|---------|-----------|
| Executive | 1 year | Long-term strategic trends |
| CIO | 30 days | Operational monthly cycles |
| ITSM | N/A | Real-time (no range) |
| FinOps | 90 days | Quarterly budget cycles |
| Business Service | 30 days | Service health trends |

### 3. Export Functionality

**PDF Export**:
- Single-page summary (A4/Letter)
- All charts rendered as images
- Data tables included
- Company branding (logo, colors)
- Timestamp and user info
- Export time: 3-5 seconds

**Excel Export**:
- Multiple sheets (one per section)
- Raw data tables (no charts)
- Formulas for calculations
- Pivot table ready
- CSV alternative available
- Export time: 1-2 seconds

**Export Limits**:
- Max 100,000 rows per Excel sheet
- Max 10 charts per PDF
- Max file size: 25 MB

### 4. Responsive Design

**Breakpoints**:
- **Desktop**: 1920px+ (4-column grid)
- **Laptop**: 1366px - 1919px (3-column grid)
- **Tablet**: 768px - 1365px (2-column grid)
- **Mobile**: < 768px (1-column stack)

**Mobile Optimizations**:
- Simplified charts (fewer data points)
- Collapsible sections
- Swipe gestures for tables
- Bottom navigation bar
- Touch-friendly buttons (44px min)

### 5. Dark Mode

**Theme Toggle**: Top-right corner (sun/moon icon)

**Color Palette**:

**Light Mode**:
- Background: #ffffff
- Text: #1f2937
- Border: #e5e7eb
- Primary: #3b82f6
- Success: #10b981
- Warning: #f59e0b
- Error: #ef4444

**Dark Mode**:
- Background: #1f2937
- Text: #f9fafb
- Border: #374151
- Primary: #60a5fa
- Success: #34d399
- Warning: #fbbf24
- Error: #f87171

**Persisted**: Theme choice saved to localStorage

### 6. Interactive Charts

**Library**: Recharts (React wrapper for D3)

**Common Interactions**:
- **Hover**: Show tooltip with exact values
- **Click**: Drill down to details
- **Zoom**: Mouse wheel or pinch gesture
- **Pan**: Drag to move viewport
- **Legend Toggle**: Click legend to show/hide series

**Chart Types**:
- Line chart (trends over time)
- Bar chart (comparisons)
- Pie chart (proportions)
- Treemap (hierarchical data)
- Scatter plot (correlations)
- Heat map (matrix data)

### 7. Accessibility

**WCAG 2.1 AA Compliant**:
- ✅ Keyboard navigation (Tab, Enter, Arrow keys)
- ✅ Screen reader support (ARIA labels)
- ✅ Color contrast ratio ≥ 4.5:1
- ✅ Focus indicators
- ✅ Alternative text for images
- ✅ Semantic HTML

**Keyboard Shortcuts**:
- `R`: Refresh dashboard
- `E`: Export to PDF
- `T`: Toggle theme (light/dark)
- `F`: Open filters
- `?`: Show keyboard shortcuts

---

## Access & Permissions

Dashboard access is controlled by **Role-Based Access Control (RBAC)**:

### Role Mappings

| Role | Dashboards Accessible |
|------|----------------------|
| **Executive** | Executive |
| **CIO / IT Director** | Executive, CIO |
| **Service Manager** | CIO, ITSM, Business Service |
| **Finance / FinOps** | Executive, FinOps |
| **Service Owner** | Business Service |
| **Support Engineer** | ITSM |
| **Read-Only Viewer** | All (view only, no export) |

### Permission Levels

**View**:
- See dashboard data
- Interact with filters
- View details

**Export**:
- Download PDF/Excel
- Share reports

**Admin**:
- Configure dashboard settings
- Customize KPI thresholds
- Manage user access

### Data Filtering

Users see data based on their scope:

**Business Unit Filter**:
- Service owners see only their business unit
- Executives see all business units
- CIO sees all IT services

**Service Tier Filter**:
- Support engineers see all tiers
- Service managers see Tier 0-2 (critical services)

**Cost Data Filter**:
- Finance sees all cost data
- Service owners see only their service costs
- Executives see aggregated costs

---

## Customization Guide

### Dashboard Settings

Each dashboard has a "Settings" menu (⚙️ icon):

**Available Settings**:
1. **Default Time Range**: Set preferred default (7d, 30d, 90d, 1y)
2. **Auto-Refresh**: Enable/disable and set interval
3. **Theme**: Light, Dark, or Auto (system preference)
4. **Export Format**: PDF or Excel default
5. **KPI Thresholds**: Customize color thresholds (green/yellow/red)

**Example Settings JSON**:
```json
{
  "dashboard": "executive",
  "defaultTimeRange": "90d",
  "autoRefresh": true,
  "refreshInterval": 3600,
  "theme": "auto",
  "exportFormat": "pdf",
  "thresholds": {
    "healthScore": { "good": 80, "warning": 60 },
    "riskCount": { "low": 5, "high": 10 }
  }
}
```

### Custom KPIs

**Add Custom KPI Card**:

1. Navigate to dashboard settings
2. Click "Add Custom KPI"
3. Configure:
   - **Title**: KPI name
   - **Data Source**: API endpoint or GraphQL query
   - **Calculation**: Formula or aggregation
   - **Thresholds**: Good/warning/critical values
   - **Color**: Primary color for card
   - **Icon**: Icon name (Lucide icons)

**Example Custom KPI**:
```typescript
{
  title: "API Error Rate",
  dataSource: "/api/v1/metrics/api-error-rate",
  calculation: "(errors / total_requests) * 100",
  thresholds: {
    good: 0.5,    // < 0.5% error rate
    warning: 2.0, // 0.5% - 2%
    critical: 5.0 // > 2%
  },
  icon: "AlertTriangle",
  color: "orange"
}
```

### Custom Charts

**Add Custom Chart**:

1. Navigate to dashboard settings
2. Click "Add Custom Chart"
3. Configure:
   - **Chart Type**: Line, Bar, Pie, Scatter, etc.
   - **Data Source**: API endpoint or GraphQL query
   - **X-Axis**: Data field for X-axis
   - **Y-Axis**: Data field for Y-axis
   - **Series**: Multiple series for multi-line charts
   - **Filters**: Optional filters (date range, service, etc.)

**Example Custom Chart**:
```typescript
{
  type: "line",
  title: "API Response Time Trend",
  dataSource: "/api/v1/metrics/api-response-time",
  xAxis: "timestamp",
  yAxis: "response_time_ms",
  series: ["p50", "p95", "p99"],
  filters: {
    service: "api-gateway",
    timeRange: "7d"
  }
}
```

### Widget Layout

**Drag and Drop** (optional feature):

1. Click "Edit Layout" button
2. Drag widgets to reorder
3. Resize widgets by dragging corners
4. Click "Save Layout" to persist

**Grid System**:
- 12-column grid
- Min width: 1 column
- Max width: 12 columns
- Responsive breakpoints adjust automatically

---

## Advanced Features

### 1. Real-Time Subscriptions

**WebSocket Connection**:

The ITSM dashboard uses WebSocket for real-time updates:

```typescript
// Client-side subscription
const ws = new WebSocket('wss://happycmdb.example.com/ws');

ws.on('incident.created', (incident) => {
  // Add new incident to table
  addIncidentToTable(incident);
  showNotification(`New ${incident.priority} incident: ${incident.title}`);
});

ws.on('incident.updated', (incident) => {
  // Update existing incident
  updateIncidentInTable(incident);
});

ws.on('change.status_changed', (change) => {
  // Move change card to new column
  updateChangeStatus(change);
});
```

**Topics**:
- `incident.created`: New incident opened
- `incident.updated`: Incident status/assignment changed
- `incident.resolved`: Incident closed
- `change.status_changed`: Change moved to different stage
- `ci.drift_detected`: Configuration drift detected

### 2. Interactive Drill-Down

**Click to Drill Down**:

Most charts support drill-down:

**Example**: Cost Breakdown Treemap
1. **Top Level**: Shows business capabilities
2. **Click "Customer Experience"**: Drill down to business services
3. **Click "E-commerce Platform"**: Drill down to technical services
4. **Click "API Gateway"**: Show detailed cost breakdown (compute, storage, network)

**Breadcrumb Navigation**: Shows current level and allows navigation back

```
All Capabilities > Customer Experience > E-commerce Platform > API Gateway
```

### 3. Saved Views

**Save Current View**:

1. Configure dashboard (filters, time range, etc.)
2. Click "Save View" button
3. Name your view (e.g., "Monthly Executive Review")
4. View saved to your profile

**Load Saved View**:

1. Click "Views" dropdown
2. Select saved view name
3. Dashboard reloads with saved settings

**Share Views**:
- Export view config as JSON
- Share with team members
- Import view from JSON

### 4. Scheduled Reports

**Email Reports**:

1. Navigate to dashboard settings
2. Click "Schedule Report"
3. Configure:
   - **Frequency**: Daily, Weekly, Monthly
   - **Day**: Monday, Tuesday, etc.
   - **Time**: 8:00 AM, 9:00 AM, etc.
   - **Recipients**: Email addresses
   - **Format**: PDF or Excel
   - **Include**: Charts, data tables, or both

**Example Schedule**:
```json
{
  "dashboard": "executive",
  "frequency": "weekly",
  "dayOfWeek": "monday",
  "time": "08:00",
  "timezone": "America/New_York",
  "recipients": ["ceo@example.com", "cfo@example.com"],
  "format": "pdf",
  "include": ["charts", "tables"]
}
```

**Report Delivery**:
- Sent via email with attachment
- Subject: "[HappyCMDB] Executive Dashboard - Week of Nov 4, 2025"
- Body: Brief summary with key highlights

### 5. Alerts & Notifications

**Configure Alerts**:

1. Navigate to dashboard settings
2. Click "Alerts"
3. Add new alert rule:
   - **Metric**: Health score, cost, incident count, etc.
   - **Condition**: >, <, =, ≥, ≤
   - **Threshold**: Numeric value
   - **Action**: Email, Slack, PagerDuty
   - **Recipients**: Who to notify

**Example Alerts**:

```json
[
  {
    "metric": "open_incidents",
    "condition": ">",
    "threshold": 10,
    "action": "email",
    "recipients": ["ops-team@example.com"]
  },
  {
    "metric": "revenue_at_risk",
    "condition": ">",
    "threshold": 50000,
    "action": "pagerduty",
    "recipients": ["exec-oncall"]
  }
]
```

---

## API Reference

### REST Endpoints

**Executive Dashboard Data**:
```http
GET /api/v1/dashboards/executive
Query Parameters:
  - timeRange: 30d | 90d | 1y
  - businessUnit: string (optional)
Response: ExecutiveDashboardData
```

**CIO Dashboard Data**:
```http
GET /api/v1/dashboards/cio
Query Parameters:
  - timeRange: 7d | 30d | 90d
Response: CIODashboardData
```

**ITSM Dashboard Data**:
```http
GET /api/v1/dashboards/itsm
Query Parameters:
  - priority: P1 | P2 | P3 | P4 (optional)
Response: ITSMDashboardData
```

**FinOps Dashboard Data**:
```http
GET /api/v1/dashboards/finops
Query Parameters:
  - timeRange: 30d | 90d | 1y
  - provider: aws | azure | gcp (optional)
Response: FinOpsDashboardData
```

**Business Service Dashboard Data**:
```http
GET /api/v1/dashboards/business-service
Query Parameters:
  - serviceId: string (optional)
  - businessUnit: string (optional)
Response: BusinessServiceDashboardData
```

### GraphQL Queries

**Executive Dashboard Query**:
```graphql
query ExecutiveDashboard($timeRange: TimeRangeInput!) {
  executiveDashboard(timeRange: $timeRange) {
    totalITSpend
    costTrends {
      month
      cost
      budget
    }
    serviceHealthByTier {
      tier
      averageHealthScore
      trend
    }
    riskMatrix {
      services {
        serviceId
        serviceName
        criticality
        riskLevel
        healthScore
        monthlyCost
      }
    }
    topCostDrivers {
      serviceId
      serviceName
      monthlyCost
      trend
      changePercent
    }
    valueScorecard {
      serviceId
      serviceName
      annualRevenue
      monthlyCost
      roi
      customers
    }
  }
}
```

**ITSM Dashboard Subscription** (Real-Time):
```graphql
subscription ITSMRealTime {
  incidentUpdates {
    id
    priority
    status
    title
    affectedCI
    assignedTo
    createdAt
  }
  changeUpdates {
    id
    status
    riskLevel
    title
    scheduledDate
  }
  driftDetected {
    ciId
    ciName
    severity
    driftDetails
  }
}
```

---

## Troubleshooting

### Common Issues

#### 1. Dashboard Not Loading

**Problem**: Dashboard shows loading spinner indefinitely

**Possible Causes**:
- API server down or unreachable
- Network connectivity issues
- Authentication token expired
- Browser cache issues

**Solution**:
```bash
# Check API server status
curl http://localhost:3001/health

# Clear browser cache
- Press Ctrl+Shift+Delete (Chrome/Firefox)
- Select "Cached images and files"
- Click "Clear data"

# Check authentication token
localStorage.getItem('auth_token')
# If expired, log out and log back in
```

#### 2. Charts Not Displaying

**Problem**: Charts show empty state or error message

**Possible Causes**:
- No data available for selected time range
- Data source API error
- Invalid chart configuration

**Solution**:
```typescript
// Check console for errors
console.error(...);

// Verify data format
// Expected: [{ month: "Oct 2025", value: 100 }, ...]
// Check API response matches chart component props

// Try different time range
// Some charts need minimum data points (e.g., 30 days for trends)
```

#### 3. Export Failed

**Problem**: PDF/Excel export fails or downloads corrupt file

**Possible Causes**:
- Too much data (exceeds limits)
- Export service timeout
- Browser popup blocker

**Solution**:
```bash
# Check export limits
# PDF: Max 10 charts, 25 MB file size
# Excel: Max 100K rows per sheet

# Reduce data:
# - Shorten time range
# - Filter by business unit
# - Export specific sections only

# Check popup blocker:
# - Allow popups from happycmdb.example.com
# - Or right-click export button → "Save link as"
```

#### 4. Real-Time Updates Not Working (ITSM)

**Problem**: ITSM dashboard not showing new incidents instantly

**Possible Causes**:
- WebSocket connection failed
- Firewall blocking WebSocket traffic
- Browser doesn't support WebSockets

**Solution**:
```typescript
// Check WebSocket connection in browser console
const ws = new WebSocket('wss://happycmdb.example.com/ws');
ws.onopen = () => console.log('✅ WebSocket connected');
ws.onerror = (err) => console.error('❌ WebSocket error:', err);

// Check firewall/proxy settings
// Allow WebSocket traffic on port 443 (wss://)

// Fallback to polling
// If WebSocket fails, dashboard automatically falls back to 10s polling
```

#### 5. Slow Performance

**Problem**: Dashboard takes long time to load or interact

**Possible Causes**:
- Large dataset (thousands of services)
- Complex charts (treemap with many nodes)
- Browser resource constraints

**Solution**:
```bash
# Optimize data:
# - Filter by business unit
# - Reduce time range
# - Limit number of rows/series

# Browser optimization:
# - Close unused tabs
# - Disable browser extensions
# - Use Chrome/Firefox (best performance)

# Server-side pagination:
# - Enable pagination for large tables
# - Set page size to 25-50 rows
```

---

## Performance Considerations

### Data Loading Strategy

**Lazy Loading**:
- Charts load data only when visible
- Scroll-triggered data fetch for tables
- Pagination for large datasets (25-50 rows per page)

**Caching**:
- API responses cached for 5 minutes (default)
- LocalStorage for user preferences
- Redis cache on server-side

**Optimization**:
- Use time-series aggregation (hourly, daily, monthly)
- Pre-compute expensive metrics (health scores, ROI)
- Use database indexes for fast queries

### Recommended Limits

| Metric | Recommended | Maximum |
|--------|-------------|---------|
| Time range | 90 days | 1 year |
| Services displayed | 50 | 200 |
| Chart data points | 90 | 365 |
| Table rows per page | 25 | 100 |
| Export file size | 5 MB | 25 MB |
| WebSocket subscriptions | 5 | 10 |

---

## Related Resources

- [Web UI Overview](./web-ui.md) - React application structure
- [ITIL Service Manager](./itil-service-manager.md) - Incident and change management
- [TBM Cost Engine](./tbm-cost-engine.md) - Cost allocation and optimization
- [BSM Impact Engine](./bsm-impact-engine.md) - Business service mapping (coming soon)
- [API Reference](/api/rest-api.md) - Dashboard REST endpoints
- [GraphQL API](/api/graphql.md) - Dashboard GraphQL queries

---

## Next Steps

1. **Access Dashboards**: Navigate to http://localhost:3000/dashboards
2. **Configure Roles**: Set up RBAC permissions for your team
3. **Customize KPIs**: Add custom metrics relevant to your organization
4. **Schedule Reports**: Set up weekly/monthly email reports
5. **Configure Alerts**: Set up thresholds for critical metrics

---

**Last Updated**: November 6, 2025
**Version**: 3.0
**Maintainer**: HappyCMDB Team
