# Executive Dashboard User Guide

Complete guide to the Executive Dashboard for C-level executives and senior leadership.

## Overview

The Executive Dashboard provides a high-level view of IT operations, costs, risks, and business value. Designed for CEOs, CFOs, and Board members who need strategic IT insights without technical details.

**Access**: http://localhost:3001/dashboards/executive

**Refresh Rate**: Real-time with live data updates

**Role Required**: `viewer` or higher

---

## Dashboard Layout

The Executive Dashboard is organized into 6 key sections:

1. **IT Investment Summary** - Total IT spend and cost trends
2. **Cost Distribution** - Spend by capability tower and environment
3. **Service Health Overview** - Business service health by tier
4. **Risk & Compliance** - Risk matrix and compliance posture
5. **Value Scorecard** - Business value metrics and ROI
6. **Top Cost Drivers** - Highest-cost infrastructure items

---

## Section 1: IT Investment Summary

### Total IT Spend

**What it shows**: Aggregate monthly and annual IT costs across all infrastructure.

**Displayed Metrics**:
- **Monthly IT Spend**: Current month's total costs
- **Annual Run Rate**: Projected annual spend (monthly × 12)
- **Month-over-Month Change**: Percentage change from previous month
- **Year-over-Year Change**: Percentage change from same month last year

**Example**:
```
Monthly IT Spend:    $125,450
Annual Run Rate:     $1,505,400
MoM Change:          +3.2% ↑
YoY Change:          +12.8% ↑
```

**How to interpret**:
- **Green** (↓): Costs decreasing - good cost optimization
- **Yellow** (→): Costs flat - stable operations
- **Red** (↑): Costs increasing - investigate drivers

**Actions**:
- **Increasing costs**: Click "View Details" to see cost breakdown
- **Unexpected changes**: Review Top Cost Drivers section below

---

### Cost Trends Chart

**What it shows**: 12-month historical view of IT spending by category.

**Chart Type**: Stacked area chart

**Categories**:
- **Cloud (AWS, Azure, GCP)**: Public cloud services
- **On-Premises**: Data center and owned infrastructure
- **Licenses**: Software subscriptions
- **Labor**: IT staff costs (if configured)

**How to interpret**:
- **Steady growth**: Normal business expansion
- **Sudden spikes**: Investigate via FinOps Dashboard
- **Declining trends**: Cost optimization working
- **Seasonality**: Expected patterns (e.g., year-end spending)

**Actions**:
- Hover over chart to see exact values
- Click on legend to hide/show categories
- Click "Export" to download CSV for presentations

---

## Section 2: Cost Distribution

### Cost by Capability Tower

**What it shows**: IT spend grouped by TBM Framework v5.0.1 capability towers.

**11 Capability Towers**:
1. **Compute** - Servers, VMs, containers
2. **Storage** - Storage arrays, backup systems
3. **Network** - Networking infrastructure
4. **Data** - Databases and data platforms
5. **Security** - Security tools and systems
6. **End User** - Desktop, laptop, mobile devices
7. **Facilities** - Data center space, power, cooling
8. **Risk & Compliance** - GRC tools
9. **IoT** - Internet of Things infrastructure
10. **Blockchain** - Blockchain infrastructure
11. **Quantum** - Quantum computing resources

**Example**:
```
Compute:        $45,000  (35.8%)  ███████████
Storage:        $25,000  (19.9%)  ██████
Network:        $15,000  (12.0%)  ████
Data:           $20,450  (16.3%)  █████
Security:       $10,000   (8.0%)  ███
Other:          $10,000   (8.0%)  ███
```

**How to interpret**:
- **Compute dominance**: Normal for most organizations (30-40%)
- **Storage growth**: Monitor data retention policies
- **Security spend**: Should be 5-15% of total IT budget
- **Imbalanced distribution**: May indicate inefficiencies

**Actions**:
- Click on tower to drill down to specific resources
- Use "Compare to Industry" to see benchmarks
- Export data for board presentations

---

### Cost by Environment

**What it shows**: Spend distribution across environments.

**Environments**:
- **Production**: Customer-facing services
- **Staging**: Pre-production testing
- **Development**: Development and testing
- **DR (Disaster Recovery)**: Business continuity

**Typical Distribution**:
```
Production:     70-80%  (should be majority)
Staging:        10-15%  (reasonable buffer)
Development:     5-10%  (keep lean)
DR:              5-10%  (insurance cost)
```

**Red Flags**:
- **Dev > 20%**: Investigate idle resources
- **Staging > 20%**: Consider reducing test environment size
- **DR < 5%**: May not have adequate business continuity

**Actions**:
- Click "Optimize Dev/Test" for rightsizing recommendations
- Review DR coverage with FinOps team

---

## Section 3: Service Health Overview

### Service Health by Tier

**What it shows**: Health status of business services grouped by criticality tier.

**Tiers**:
- **Tier 1**: Mission-critical services (customer-facing revenue generators)
- **Tier 2**: Important services (internal operations, support)
- **Tier 3**: Non-critical services (development tools, low-priority)

**Health Statuses**:
- **Healthy** (Green): All systems operational
- **Warning** (Yellow): Minor issues, no customer impact
- **Critical** (Red): Outages or severe degradation
- **Unknown** (Gray): Insufficient monitoring data

**Example**:
```
Tier 1 Services:  15 Healthy  |  2 Warning  |  0 Critical
Tier 2 Services:  25 Healthy  |  3 Warning  |  1 Critical
Tier 3 Services:  10 Healthy  |  0 Warning  |  0 Critical
```

**How to interpret**:
- **Tier 1 Critical**: Immediate executive escalation needed
- **Tier 2 Critical**: Operational issue, monitor closely
- **Tier 3 Critical**: Low priority, normal IT operations

**Actions**:
- Click on "Critical" to see affected services
- Review incident details with CTO/VP Engineering
- Request post-mortem for Tier 1 outages

---

### Service Dependency Map

**What it shows**: Visual representation of critical service dependencies.

**Map Type**: Interactive node graph

**Elements**:
- **Circles**: Business services
- **Lines**: Dependencies between services
- **Color**: Health status
- **Size**: Business criticality

**How to interpret**:
- **Central nodes**: High-dependency services (potential single points of failure)
- **Isolated nodes**: Independent services (lower risk)
- **Red connections**: Unhealthy dependencies affecting multiple services

**Actions**:
- Click on service node to see details
- Identify single points of failure
- Request redundancy for critical dependencies

---

## Section 4: Risk & Compliance

### Risk Matrix

**What it shows**: Distribution of IT assets by risk level and business impact.

**Matrix**:
```
High Impact    │  [3]   │  [12] │
               │  Medium│  High │
               │  Risk  │  Risk │
               ├────────┼───────┤
Low Impact     │  [45]  │  [8]  │
               │  Low   │ Medium│
               │  Risk  │  Risk │
               └────────┴───────┘
                 Low      High
               Probability
```

**Risk Categories**:
- **High Risk / High Impact**: Requires immediate attention
- **High Risk / Low Impact**: Monitor and mitigate
- **Low Risk / High Impact**: Business critical, maintain vigilance
- **Low Risk / Low Impact**: Routine monitoring

**How to interpret**:
- **Top-right quadrant** (High/High): Unacceptable risk level
- **Bottom-left quadrant** (Low/Low): Acceptable risk
- **Trend over time**: Risk should be decreasing

**Actions**:
- Click quadrant to see specific systems
- Request risk mitigation plan from CIO
- Add high-risk items to board meeting agenda

---

### Compliance Posture

**What it shows**: Compliance status across regulatory frameworks.

**Frameworks Tracked**:
- **SOC 2** - Service organization controls
- **ISO 27001** - Information security management
- **GDPR** - Data privacy (EU)
- **HIPAA** - Healthcare data (if applicable)
- **PCI DSS** - Payment card data (if applicable)

**Status Indicators**:
- **Compliant** (Green): All controls passed
- **At Risk** (Yellow): Some controls failing
- **Non-Compliant** (Red): Critical control failures

**Example**:
```
SOC 2:      98% Compliant  ✓
ISO 27001:  95% Compliant  ⚠
GDPR:      100% Compliant  ✓
HIPAA:      92% At Risk    ⚠
```

**Actions**:
- Click "View Gaps" to see failing controls
- Request remediation timeline from CISO
- Include compliance updates in board reporting

---

## Section 5: Value Scorecard

### Business Value Metrics

**What it shows**: IT's contribution to business outcomes.

**Key Metrics**:

1. **Service Availability**
   - Target: 99.9% (Tier 1 services)
   - Actual: Displayed as percentage
   - Impact: Downtime cost per hour

2. **Customer-Facing Service Health**
   - Count of healthy customer services
   - Revenue at risk from unhealthy services

3. **Innovation Index**
   - Percentage of budget on new initiatives vs. "keep lights on"
   - Target: 20-30% on innovation

4. **Time to Market**
   - Average time from idea to production
   - Target: < 90 days for new features

5. **Cost per User/Transaction**
   - Unit economics for IT services
   - Trend: Should be decreasing over time

**Example Scorecard**:
```
Availability:           99.95%  ✓ Exceeds Target
Customer Services:      28/30   ⚠ 2 Degraded
Innovation Budget:      18%     ⚠ Below Target
Time to Market:         75 days ✓ Meets Target
Cost per User:          $25.50  ✓ Improving
```

**How to interpret**:
- **Green checkmark**: Meeting or exceeding target
- **Yellow warning**: Below target, needs attention
- **Red X**: Significantly below target

**Actions**:
- Use metrics in earnings calls
- Include in quarterly business reviews
- Benchmark against industry standards

---

### ROI Calculator

**What it shows**: Return on investment for IT initiatives.

**Calculation**:
```
ROI = (Financial Benefit - IT Cost) / IT Cost × 100%
```

**Example**:
```
Cloud Migration Project:
  Investment:  $500,000
  Annual Savings: $200,000
  ROI: 40% per year
  Payback Period: 2.5 years
```

**Actions**:
- Click "View Projects" to see all initiatives
- Use for capital allocation decisions
- Include in budget planning

---

## Section 6: Top Cost Drivers

### Highest-Cost Infrastructure

**What it shows**: Top 10 most expensive IT resources.

**Columns**:
- **Rank**: Cost ranking
- **Resource**: Name and type
- **Environment**: Prod, staging, dev
- **Monthly Cost**: Current month spend
- **Trend**: Cost direction (↑ ↓ →)
- **Optimization Potential**: Savings opportunity

**Example**:
```
#  Resource                    Env     Cost      Trend  Savings
1  Production Database Cluster Prod    $15,000   ↑ +5%  $2,500
2  Main Application Servers    Prod    $12,500   → 0%   $1,000
3  Storage Array (Primary)     Prod    $10,000   ↑ +8%  $3,000
4  Dev/Test Environment        Dev      $8,500   ↓ -2%  $4,000
5  Backup Infrastructure       Prod     $7,000   → 0%   $500
```

**How to interpret**:
- **High dev/test costs**: Potential waste (rank #4 example)
- **Increasing trends** (↑): Investigate capacity planning
- **High savings potential**: Quick wins for cost optimization

**Actions**:
- Click resource to see detailed breakdown
- Request optimization plan from FinOps team
- Prioritize high-savings items

---

## Common Workflows

### Morning Executive Briefing (5 minutes)

1. Open Executive Dashboard
2. Check **IT Investment Summary** - Any unexpected cost changes?
3. Review **Service Health by Tier** - Any Tier 1 critical issues?
4. Scan **Risk Matrix** - Any new high-risk items?
5. Note action items for leadership team

---

### Monthly Board Meeting Prep (15 minutes)

1. Export **Cost Trends** chart (PDF)
2. Screenshot **Risk Matrix**
3. Copy **Value Scorecard** metrics to presentation
4. Download **Top Cost Drivers** table (CSV)
5. Prepare talking points on:
   - Cost trajectory
   - Risk posture
   - Business value delivered

---

### Quarterly Business Review (30 minutes)

1. Compare current quarter to previous quarters
2. Analyze **Cost by Capability Tower** - Any shifts?
3. Review **Innovation Index** - Hitting targets?
4. Check **Compliance Posture** - Any gaps?
5. Review **ROI Calculator** - Which projects delivered value?
6. Set targets for next quarter

---

### Budget Planning (Annual)

1. Review 12-month **Cost Trends**
2. Identify cost growth rate
3. Review **Top Cost Drivers** for optimization opportunities
4. Project next year's spend based on trends
5. Allocate budget by capability tower
6. Set **Value Scorecard** targets for next year

---

## Dashboard Customization

### Filtering

**Available Filters** (top-right corner):
- **Time Period**: Last 30/90/365 days
- **Environment**: Production only, All environments
- **Business Unit**: Filter by org structure
- **Cost Center**: Filter by financial accounting

**How to use**:
1. Click "Filters" button
2. Select desired filters
3. Click "Apply"
4. Dashboard updates in real-time

---

### Alerts

**Set up email alerts** for executive-level issues:

1. Click "Alerts" → "Configure"
2. Enable desired alert types:
   - [ ] Monthly spend exceeds budget by >10%
   - [ ] Tier 1 service becomes critical
   - [ ] Compliance posture drops below 95%
   - [ ] Top cost driver increases by >20%
3. Enter email addresses
4. Set alert frequency (real-time, daily digest, weekly summary)

---

### Exporting Data

**Export Options**:
- **PDF**: Full dashboard screenshot (for presentations)
- **CSV**: Raw data tables (for analysis)
- **PowerPoint**: Pre-formatted slides (for board meetings)

**How to export**:
1. Click "Export" button (top-right)
2. Select format
3. Choose sections to include
4. Click "Download"

---

## Interpreting Trends

### Healthy IT Organization

**Characteristics**:
- Monthly costs stable or decreasing
- 95%+ Tier 1 service health
- >95% compliance across all frameworks
- Innovation budget >20%
- Cost per user/transaction decreasing
- Low risk in Tier 1 services

### Warning Signs

**Red flags requiring attention**:
- Monthly costs increasing >10% MoM
- Any Tier 1 services in critical state
- Compliance <90% on any framework
- Innovation budget <15%
- Multiple high-risk / high-impact items in risk matrix
- Top cost driver increasing >25% without explanation

### Escalation Criteria

**When to escalate to full board**:
1. **Critical outage** of Tier 1 revenue-generating service
2. **Compliance failure** on regulated framework (SOC 2, HIPAA, PCI)
3. **Cost overrun** >20% of approved IT budget
4. **Security incident** with potential data breach
5. **Major project failure** affecting business timeline

---

## Best Practices

### Daily Review (5 min/day)

- Check dashboard first thing in the morning
- Review overnight alerts
- Scan for critical service health issues
- Note any unexpected cost changes

### Weekly Review (15 min/week)

- Review week-over-week cost trends
- Check risk matrix for new items
- Review top cost drivers
- Follow up on previous action items

### Monthly Review (30 min/month)

- Prepare board presentation
- Analyze month-over-month changes
- Review value scorecard metrics
- Update budget forecasts

### Quarterly Review (1 hour/quarter)

- Deep dive into all sections
- Compare to previous quarters
- Benchmark against industry
- Set targets for next quarter
- Review IT strategy alignment

---

## Glossary

**Capability Tower**: TBM Framework category for IT resources (compute, storage, etc.)

**Tier 1 Service**: Mission-critical business service directly impacting revenue

**Risk Matrix**: 2x2 grid showing risk by impact and probability

**ROI**: Return on Investment = (Benefit - Cost) / Cost × 100%

**Unit Economics**: Cost per user, transaction, or other business metric

**Innovation Budget**: Spending on new initiatives vs. maintaining existing systems

**Compliance Posture**: Overall status of regulatory compliance across frameworks

---

## Troubleshooting

### Dashboard not loading

**Check**:
1. API server is running: `curl http://localhost:3000/api/v1/cmdb-health`
2. You're logged in (JWT token not expired)
3. Your user has `viewer` role or higher

**Solution**: Refresh page or re-login

---

### Data looks incorrect

**Possible causes**:
1. Discovery hasn't run recently (data stale)
2. Cost sync from cloud providers failed
3. Business services not configured

**Solution**: Contact IT operations to verify data pipeline

---

### Charts not displaying

**Check browser console** for errors:
- Press F12 to open developer tools
- Look for JavaScript errors

**Solution**: Try different browser (Chrome, Firefox, Safari)

---

## See Also

- [CIO Dashboard User Guide](/user-guides/cio-dashboard.md) - Technical IT metrics
- [FinOps Dashboard User Guide](/user-guides/finops-dashboard.md) - Detailed cost management
- [Financial Management API](/api/rest/financial.md) - Programmatic data access
- [TBM Cost Engine](/components/tbm-cost-engine.md) - Cost calculation architecture

---

**Dashboard Version**: 3.0
**Last Updated**: November 2025
**Audience**: C-level executives, board members
