# Service Owner Guide

Complete guide for business service owners managing their services in HappyCMDB v3.0.

## Overview

As a Service Owner, you're responsible for the health, availability, cost, and evolution of your business service. This guide helps you use HappyCMDB to monitor, manage, and optimize your service.

**Target Audience**: Product Owners, Service Managers, Business Application Owners

**Your Dashboard**: http://localhost:3001/dashboards/business-service/{your-service-id}

**Role Required**: `service-owner` or `operator`

---

## What is a Business Service?

A **Business Service** is a customer-facing or business-critical capability delivered by IT infrastructure and applications.

**Examples**:
- E-Commerce Platform
- Customer Support Portal
- Payment Processing System
- Order Management System
- HR Self-Service Portal

**Your Service Includes**:
- **Application Components**: Frontend, backend, APIs
- **Infrastructure**: Servers, databases, load balancers
- **Dependencies**: Third-party services, internal APIs
- **Data**: Databases, caches, file storage

---

## Your Responsibilities

As Service Owner, you:

1. **Monitor service health** - Ensure availability and performance
2. **Manage incidents** - Coordinate response to outages
3. **Plan capacity** - Ensure resources meet demand
4. **Control costs** - Optimize spending without compromising service
5. **Manage changes** - Approve updates and deployments
6. **Define SLAs** - Set and track service level agreements
7. **Communicate status** - Keep stakeholders informed

---

## Service Dashboard Overview

### Dashboard Sections

1. **Service Health** - Real-time status and availability
2. **Service Map** - Dependency visualization
3. **Performance Metrics** - Response times, throughput
4. **Incident History** - Recent outages and issues
5. **Cost Breakdown** - Service-specific spending
6. **Capacity Planning** - Resource utilization and forecasts
7. **Change History** - Recent deployments and changes
8. **SLA Compliance** - Service level achievement

---

## Section 1: Service Health

### Real-Time Service Status

**What it shows**: Current health of your service and all components.

**Example - E-Commerce Platform**:
```
Service: E-Commerce Platform
Status: Healthy ✅
Availability (24h): 99.95%
Active Users: 2,450

Component Health:
┌─────────────────────────────────────────┐
│ Web Frontend        [████████████] 100% │
│ API Backend         [████████████] 100% │
│ Product Database    [███████████░]  92% │ ⚠
│ Payment Gateway     [████████████] 100% │
│ Image CDN           [████████████] 100% │
│ Search Service      [████████████] 100% │
│ Cache Layer         [████████████] 100% │
└─────────────────────────────────────────┘

Warning: Product Database showing slow queries
```

**Component Statuses**:
- **100%**: Healthy, all systems operational
- **90-99%**: Degraded, some performance issues
- **<90%**: Critical, requires immediate attention

---

### Service Availability Trends

**What it shows**: Historical availability over time.

**30-Day Availability**:
```
Week 1:  99.98% ✅
Week 2:  99.92% ⚠ (2 incidents)
Week 3:  99.96% ✅
Week 4:  99.95% ✅

Monthly Average: 99.95%
SLA Target: 99.9%
Status: Exceeding SLA ✅

Downtime This Month: 21 minutes
  - Nov 10: 15 min (database failover)
  - Nov 3:  6 min (deployment issue)
```

**Availability Chart**:
- Shows uptime percentage by day
- Highlights incidents with annotations
- Compares to SLA target line

**Actions**:
- Click incident to see details
- Export report for stakeholders
- Review trends for patterns

---

## Section 2: Service Map

### Dependency Visualization

**What it shows**: Interactive map of your service's dependencies.

**Example Service Map**:
```
                    ┌──────────────┐
                    │ Load Balancer│
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼─────┐    ┌─────▼─────┐   ┌─────▼─────┐
    │  Web App  │    │  Web App  │   │  Web App  │
    │  Server 1 │    │  Server 2 │   │  Server 3 │
    └─────┬─────┘    └─────┬─────┘   └─────┬─────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                    ┌──────▼───────┐
                    │  API Gateway │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼─────┐    ┌─────▼─────┐   ┌─────▼─────┐
    │ Product   │    │ User      │   │ Payment   │
    │ Service   │    │ Service   │   │ Service   │
    └─────┬─────┘    └─────┬─────┘   └─────┬─────┘
          │                │                │
    ┌─────▼─────┐    ┌─────▼─────┐   ┌─────▼─────┐
    │ Product DB│    │ User DB   │   │ Payment   │
    │           │    │           │   │ Gateway   │
    └───────────┘    └───────────┘   └───────────┘
```

**Node Colors**:
- **Green**: Healthy
- **Yellow**: Degraded
- **Red**: Failed/Down
- **Gray**: Unknown status

**Dependency Types**:
- **Direct**: Services you own
- **Shared**: Services shared with other teams
- **External**: Third-party dependencies

---

### Critical Path Analysis

**What it shows**: Single points of failure in your service.

**Critical Dependencies**:
```
Component          Type      Impact if Down    Mitigation
Payment Gateway    External  Total outage      None (SPoF) 🔴
Product Database   Direct    Total outage      Add read replica ⚠
API Gateway        Shared    Total outage      Redundant instance ⚠
User Service       Shared    Degraded          Cache fallback ✅

SPoF (Single Points of Failure): 1 critical
High Risk Dependencies: 2
```

**Actions**:
- **Payment Gateway**: Negotiate SLA with vendor, implement retry logic
- **Product Database**: Plan database clustering
- **API Gateway**: Request redundant deployment

---

## Section 3: Performance Metrics

### Response Time SLAs

**What it shows**: How fast your service responds to requests.

**Response Time Targets**:
```
Endpoint              P50    P95    P99    SLA     Status
Homepage              45ms   120ms  250ms  300ms   ✅
Product Search        80ms   200ms  400ms  500ms   ✅
Checkout Process      100ms  250ms  600ms  500ms   🔴
User Profile          30ms   100ms  180ms  200ms   ✅

Overall SLA: 75% compliance (Target: 95%)
```

**Checkout Process Details**:
```
Step                 P50    P95    P99    Bottleneck
Cart Review          20ms   60ms   100ms  ✅
Payment Processing   50ms   150ms  450ms  ⚠
Order Confirmation   30ms   80ms   150ms  ✅

Bottleneck: Payment gateway API calls
Recommendation: Implement async payment processing
```

---

### Throughput and Load

**What it shows**: Traffic volume and capacity utilization.

**Traffic Metrics**:
```
Metric                  Current    Peak (24h)   Capacity    Headroom
Requests/sec            450        1,200        2,000       40%
Concurrent Users        2,450      5,800        10,000      42%
Database Queries/sec    1,500      3,200        5,000       36%
Data Transfer (Mbps)    120        280          500         44%

Overall Capacity: 58% utilized (Safe) ✅
```

**Peak Traffic Patterns**:
```
Time Window      Avg RPS    Peak RPS    Notes
9am-12pm         350        800         Morning spike
12pm-2pm         450        1,200       Lunch peak 🔔
2pm-6pm          400        900         Afternoon steady
6pm-9pm          300        650         Evening decline
9pm-12am         150        300         Late night
```

**Actions**:
- **Lunch peak** (12-2pm): Ensure auto-scaling configured
- Monitor capacity during seasonal events (Black Friday, etc.)

---

## Section 4: Incident History

### Recent Incidents

**What it shows**: All incidents affecting your service.

**Last 30 Days**:
```
Date       Severity  Duration  Impact              Root Cause
Nov 10     P1        15 min    Total outage        DB failover delay
Nov 3      P3        6 min     Slow checkout       Cache miss
Oct 28     P2        45 min    Degraded search     Index corruption
Oct 15     P4        2 min     UI glitch           CSS deploy

Total Incidents: 4
P1 (Critical): 1
Avg Resolution Time: 17 minutes
```

**Incident Details - Nov 10**:
```
Incident: INC-2024-1110-001
Severity: P1 (Critical)
Duration: 15 minutes
Impact: E-Commerce Platform total outage

Timeline:
12:30 - Database primary failed
12:32 - Auto-failover initiated
12:35 - Failover stuck, manual intervention required
12:40 - Engineering team engaged
12:45 - Service restored via manual failover

Root Cause: Database clustering configuration error
Fix: Updated cluster configuration, tested failover
Prevention: Quarterly failover testing now scheduled

Customer Impact:
- 150 lost transactions (~$7,500 revenue)
- 2,450 users unable to checkout
- 12 customer complaints

Post-Mortem: See INC-2024-1110-001-postmortem.pdf
```

---

### Incident Trends

**What it shows**: Incident patterns over time.

**6-Month Trend**:
```
Month      Total    P1    P2    P3-P4    MTBF (hours)
June       5        0     2     3        144
July       3        1     1     1        240
August     6        1     2     3        120
September  4        0     2     2        180
October    4        1     1     2        180
November   4        1     2     1        180

Trend: Stable (not improving) ⚠
Recommendation: Implement chaos engineering
```

---

## Section 5: Cost Breakdown

### Service Cost Allocation

**What it shows**: Total cost of running your service.

**Monthly Cost Summary**:
```
E-Commerce Platform - November 2025

Direct Costs:               $12,450
  - Compute (Web servers):  $5,000
  - Database:               $3,500
  - CDN/Network:            $2,000
  - Storage:                $1,200
  - Other:                  $750

Shared Costs (Allocated):   $3,200
  - API Gateway:            $1,500
  - Monitoring:             $800
  - Security:               $600
  - Backup:                 $300

Total Monthly Cost:         $15,650
Annual Run Rate:            $187,800

Cost per User:              $6.39
Cost per Transaction:       $0.18
```

---

### Cost Optimization Opportunities

**What it shows**: Ways to reduce service costs.

**Recommendations**:
```
Opportunity                Savings/Month    Effort    Impact
Right-size web servers     $1,200          Low       None
Reserved instances (DB)    $1,000          Low       None
CDN optimization           $400            Medium    None
Archive old images         $300            Low       None
Consolidate environments   $800            High      Test env

Total Potential: $3,700/month ($44,400/year)
Recommended: Implement first 3 items ($2,600/mo savings)
```

---

### Cost Trends

**What it shows**: How service costs are changing over time.

**6-Month Cost Trend**:
```
Month      Total Cost    Change    Driver
June       $14,200       -         Baseline
July       $14,500       +2%       Traffic growth
August     $15,100       +4%       Black Friday prep
September  $15,400       +2%       Continued growth
October    $15,800       +3%       New features
November   $15,650       -1%       Optimization

Trend: +10% over 6 months (aligned with traffic growth ✅)
```

---

## Section 6: Capacity Planning

### Resource Utilization

**What it shows**: How fully resources are being used.

**Current Utilization**:
```
Resource        Current    Threshold    Status      Action
Web Servers     65%        80%          OK          Monitor
Database CPU    82%        85%          Warning ⚠   Scale up soon
Database Memory 88%        90%          Critical 🔴 Scale up now
CDN Bandwidth   45%        75%          OK          OK
Storage         68%        80%          OK          Monitor

Critical Resources: 1 (Database Memory)
```

**Actions**:
- **Immediate**: Increase database memory from 32GB to 64GB
- **This Quarter**: Add database read replica

---

### Growth Projections

**What it shows**: Forecasted resource needs based on growth.

**Traffic Growth Forecast**:
```
Current Traffic: 450 req/sec average
Growth Rate: 8% per month
Projected Traffic (6 months): 715 req/sec

Resource Capacity Runway:
- Web Servers:     12 months (auto-scaling configured ✅)
- Database:        3 months (needs upgrade ⚠)
- Storage:         8 months (monitor)
- Network:         18 months (OK)

Action Required: Database upgrade by February 2026
Budget Impact: $1,500/month additional cost
```

---

## Section 7: Change History

### Recent Deployments

**What it shows**: Changes made to your service.

**Last 30 Days**:
```
Date       Type      Description              Status    Impact
Nov 12     Standard  Security patches         Success   None
Nov 8      Normal    New checkout flow        Success   +5% conversion ✅
Nov 1      Emergency Fix payment timeout      Success   Resolved P2
Oct 28     Normal    Database upgrade         Failed    Rolled back 🔴
Oct 20     Standard  UI improvements          Success   None

Total Changes: 5
Success Rate: 80% (Target: 95%) ⚠
```

**Failed Change - Oct 28**:
```
Change: Database upgrade from v12 to v14
Status: Failed, rolled back after 30 minutes
Impact: 30 minutes degraded performance during rollback

Reason for Failure:
- Incompatible query syntax in v14
- Insufficient testing in staging

Lessons Learned:
- Perform extended testing in staging (48 hours minimum)
- Create compatibility testing checklist
- Always have rollback plan ready

Next Attempt: Scheduled for Dec 5 with extended testing
```

---

### Upcoming Changes

**What it shows**: Planned changes to your service.

**Change Calendar**:
```
Date       Type      Description                 Risk    Your Approval
Nov 20     Normal    Add payment method          Medium  Pending ⏳
Nov 25     Standard  Performance optimization    Low     Approved ✅
Dec 1      Normal    Black Friday prep           High    Pending ⏳
Dec 10     Standard  Security update             Low     Auto-approved
```

**Actions**:
- Review pending changes
- Approve/reject via change management system
- Request additional testing if needed

---

## Section 8: SLA Compliance

### Service Level Agreements

**What it shows**: Your commitments to customers/business.

**Your SLAs**:
```
SLA Metric              Target    Actual    Status
Availability            99.9%     99.95%    ✅ Exceeding
Response Time (P95)     300ms     250ms     ✅ Exceeding
Response Time (P99)     500ms     600ms     🔴 Missing
Data Loss (RPO)         0 min     0 min     ✅ Meeting
Recovery Time (RTO)     15 min    12 min    ✅ Exceeding

Overall SLA: 80% compliance (4/5 met)
```

**SLA Breach - Response Time P99**:
```
Target: 500ms
Actual: 600ms
Breach: 20% over target

Root Cause: Database slow queries during peak load
Action Plan:
1. Add database indexes (1 week)
2. Implement query caching (2 weeks)
3. Upgrade database instance (3 weeks)

Expected Resolution: Dec 15
```

---

### Business Impact

**What it shows**: How service performance affects business metrics.

**Business KPIs**:
```
Metric                  Target        Actual        Status
Conversion Rate         3.5%          3.8%          ✅ +8%
Cart Abandonment        25%           22%           ✅ -12%
Revenue per User        $45           $48           ✅ +6%
Customer Satisfaction   4.5/5         4.7/5         ✅ +4%
Support Tickets         <50/week      35/week       ✅ -30%

Business Health: Excellent ✅
```

**Correlation with IT Metrics**:
- **Improved response times** → Lower cart abandonment
- **Higher availability** → Increased revenue per user
- **Fewer incidents** → Fewer support tickets

---

## Common Service Owner Tasks

### Daily: Morning Service Check (10 min)

1. Open your Service Dashboard
2. Check **Service Health** - All green?
3. Review **Overnight Incidents** - Any issues?
4. Check **Performance Metrics** - Within SLA?
5. Note any concerns for team standup

---

### Weekly: Service Review (30 min)

1. Review **Incident History** - Any patterns?
2. Check **Cost Trends** - On budget?
3. Review **Capacity Metrics** - Any warnings?
4. Approve **Pending Changes**
5. Update stakeholders on service health

---

### Monthly: Business Review (2 hours)

1. Prepare **SLA Compliance Report**
2. Review **Cost vs Budget**
3. Analyze **Business KPIs**
4. Plan **Capacity Upgrades**
5. Update **Service Documentation**
6. Present to business stakeholders

---

### Quarterly: Strategic Planning (4 hours)

1. Review **Service Roadmap**
2. Plan **Major Improvements**
3. Budget for **Capacity Expansion**
4. Evaluate **Technology Upgrades**
5. Set **Next Quarter SLAs**

---

## Incident Response Playbook

### When You Get Paged

**Step-by-Step**:

1. **Acknowledge** (1 min)
   - Acknowledge page/alert
   - Open Service Dashboard
   - Check Service Health section

2. **Assess** (2-5 min)
   - What's impacted? (All users or subset?)
   - How bad? (Total outage or degraded?)
   - Check Service Map for failing components

3. **Communicate** (5 min)
   - Update status page
   - Notify stakeholders
   - Post in incident channel

4. **Engage Team** (5-10 min)
   - Page on-call engineer if needed
   - Notify service team
   - Escalate to management if P1

5. **Monitor Resolution**
   - Track progress in incident ticket
   - Update stakeholders every 30 min (P1) or 2 hours (P2)
   - Verify service restoration

6. **Post-Incident** (Within 24 hours)
   - Schedule post-mortem
   - Document lessons learned
   - Create action items

---

### Escalation Criteria

**When to Escalate**:

- **Immediate**: Total service outage (P1)
- **Immediate**: Data loss or security breach
- **15 minutes**: No progress on P1 incident
- **1 hour**: No progress on P2 incident
- **Projected SLA breach**: If incident will miss SLA target

**Who to Escalate To**:
- **Engineering Manager**: Technical issues
- **CTO/CIO**: Business-critical outages
- **Product Manager**: Customer-facing impact
- **Communications**: External customer notification needed

---

## Best Practices

### 1. Know Your Service Inside Out

- Review service architecture quarterly
- Understand all dependencies
- Know your critical paths
- Document runbooks for common issues

### 2. Set Realistic SLAs

- Base on historical performance
- Include buffer for unexpected issues
- Align with business requirements
- Review and adjust quarterly

### 3. Proactive Monitoring

- Set up alerts before thresholds hit
- Monitor trends, not just current state
- Create dashboards for your team
- Review metrics weekly

### 4. Cost Consciousness

- Review costs monthly
- Look for optimization opportunities
- Right-size resources
- Use reserved instances for stable workloads

### 5. Change Management Discipline

- Always test changes in staging first
- Have rollback plans ready
- Schedule changes during low-traffic windows
- Communicate changes to stakeholders

### 6. Document Everything

- Maintain runbooks
- Document incidents and resolutions
- Keep architecture diagrams current
- Share knowledge with team

---

## Troubleshooting

### Service showing degraded but no incidents

**Check**:
1. Performance metrics - slow queries?
2. Capacity utilization - resources maxed out?
3. Dependencies - third-party API slow?

**Solution**: Investigate root cause before users notice

---

### Cost spike unexpected

**Check**:
1. Traffic increase - viral marketing campaign?
2. New features deployed - more resource intensive?
3. Auto-scaling triggered - temporary load spike?

**Solution**: Review cost breakdown by component

---

### SLA compliance dropped

**Possible causes**:
1. More incidents than usual
2. Performance degradation
3. Capacity constraints

**Solution**: Review incident trends, performance metrics

---

## See Also

- [Executive Dashboard](/user-guides/executive-dashboard.md) - High-level service visibility
- [ITSM Operations](/user-guides/itsm-operations.md) - Incident management workflows
- [FinOps Dashboard](/user-guides/finops-dashboard.md) - Cost optimization
- [BSM Impact Engine](/components/bsm-impact-engine.md) - Service mapping architecture

---

**Guide Version**: 3.0
**Last Updated**: November 2025
**Audience**: Service Owners, Product Managers, Application Owners
