# ITSM Operations User Guide

Complete guide to IT Service Management (ITSM) operations using HappyCMDB's ITIL v4-aligned dashboards and workflows.

## Overview

The ITSM Dashboard provides real-time visibility into IT operations, incident management, change control, and service health. Designed for IT operations teams, service desk managers, and DevOps engineers.

**Access**: http://localhost:3001/dashboards/itsm

**Refresh Rate**: Real-time

**Role Required**: `operator` or `admin`

---

## Dashboard Layout

The ITSM Dashboard is organized into 7 key sections:

1. **Incident Management** - Open incidents and resolution tracking
2. **Change Management** - Changes in progress and risk assessment
3. **CI Status Overview** - Configuration Item health and availability
4. **Service Level Metrics** - SLA compliance and performance
5. **Baseline Compliance** - Configuration drift detection
6. **Problem Management** - Root cause analysis and known errors
7. **Service Request Management** - Request fulfillment tracking

---

## Section 1: Incident Management

### Open Incidents

**What it shows**: All active incidents grouped by priority and status.

**Incident Priorities**:
- **P1 (Critical)**: Service down, major business impact
- **P2 (High)**: Service degraded, significant impact
- **P3 (Medium)**: Minor issue, workaround available
- **P4 (Low)**: Cosmetic issue, no business impact

**Example Incident List**:
```
ID      Priority  Status        Service              Opened         Assigned To
INC001  P1        In Progress   Customer Portal      2h 15m ago     John Doe
INC002  P2        Investigating Payment Gateway      45m ago        Jane Smith
INC003  P3        Pending       Email System         1d 3h ago      DevOps Team
INC004  P4        New           Admin Dashboard      3h ago         Unassigned
```

**Incident Metrics**:
```
Open Incidents:         24
  P1 (Critical):        2   🔴
  P2 (High):            5   🟠
  P3 (Medium):          12  🟡
  P4 (Low):             5   🟢

Incidents Opened Today: 8
Incidents Closed Today: 12
Net Change:             -4  (Improving)
```

**Actions**:
- Click incident ID to view details
- Filter by service, priority, or assignee
- Create new incident via "+ New Incident" button
- Export incident list for reporting

---

### Incident Details View

**What it includes**:
- **Description**: Issue summary and impact
- **Timeline**: Status changes and updates
- **Affected CIs**: Infrastructure components involved
- **Root Cause**: Initial analysis
- **Resolution**: Fix applied and verification
- **Communication**: Customer updates sent

**Example Incident**:
```
Incident: INC001
Priority: P1 (Critical)
Status: In Progress
Service: Customer Portal
Opened: 2025-11-15 08:30 UTC
Assigned: John Doe (Senior Engineer)

Description:
Customer Portal returning HTTP 500 errors for all users.
100% of traffic affected. Revenue impact estimated at $5,000/hour.

Affected CIs:
- prod-web-01 (Application Server) - Status: Degraded
- prod-db-01 (Database) - Status: Healthy
- prod-lb-01 (Load Balancer) - Status: Healthy

Timeline:
08:30 - Incident opened (auto-detected by monitoring)
08:35 - P1 escalation, on-call engineer paged
08:40 - Engineer investigating application logs
08:50 - Root cause identified: Memory leak in v2.5.3
09:00 - Rollback initiated to v2.5.2
09:15 - Service restored, monitoring recovery
10:30 - Incident resolved, post-mortem scheduled

Resolution:
Rolled back deployment from v2.5.3 to v2.5.2.
Memory leak bug logged as BUG-4523 for fix in v2.5.4.
```

---

### Incident SLA Tracking

**What it shows**: Time to respond and resolve against SLA targets.

**SLA Targets**:
```
Priority    Time to Respond    Time to Resolve    Escalation
P1          15 minutes         4 hours            30 min to CTO
P2          30 minutes         8 hours            2 hours to Manager
P3          2 hours            24 hours           N/A
P4          4 hours            72 hours           N/A
```

**SLA Compliance**:
```
Priority    SLA Met    SLA Breached    Compliance %
P1          15         2               88.2%
P2          45         8               84.9%
P3          120        15              88.9%
P4          85         5               94.4%

Overall SLA Compliance: 89.1%  (Target: 95%)
```

**Breach Analysis**:
- Most breaches occur overnight (staffing issue)
- P1 breaches: 2 due to delayed escalation
- Recommendation: Implement 24/7 on-call rotation

---

## Section 2: Change Management

### Changes in Progress

**What it shows**: All planned and ongoing changes to IT infrastructure.

**Change Types**:
- **Standard**: Pre-approved, low-risk (e.g., patch deployment)
- **Normal**: Requires CAB approval (e.g., database upgrade)
- **Emergency**: Urgent fix, expedited approval (e.g., security patch)

**Example Change List**:
```
ID      Type        Description              Risk    Scheduled       Status
CHG001  Emergency   Security Patch           Medium  2025-11-15 22:00 Approved
CHG002  Normal      Database Upgrade         High    2025-11-20 02:00 Planning
CHG003  Standard    Log Rotation Config      Low     2025-11-16 10:00 Implementing
CHG004  Normal      Load Balancer Migration  Medium  2025-11-25 18:00 Pending CAB
```

**Change Metrics**:
```
Changes This Week:          15
  Approved:                 12
  Pending:                  2
  Rejected:                 1

Change Success Rate:        92.3%  (Target: 95%)
Failed Changes (30 days):   3
Rolled Back Changes:        5
```

---

### Change Advisory Board (CAB)

**What it shows**: Changes awaiting CAB review and approval.

**CAB Schedule**:
- **Frequency**: Weekly (Tuesdays, 2:00 PM)
- **Members**: IT Manager, Engineering Lead, Security Lead, Business Owner
- **Quorum**: 3 of 4 members required

**Pending CAB Approval**:
```
ID      Description                  Requestor      Impact      Risk    Vote
CHG004  Load Balancer Migration      DevOps Team    High        Medium  0/4
CHG005  SSL Certificate Renewal      Security Team  Low         Low     3/4 ✓
CHG006  API Rate Limit Increase      Product Team   Medium      Low     2/4
```

**CAB Approval Criteria**:
1. **Business justification**: Clear benefit
2. **Risk assessment**: Documented and mitigated
3. **Rollback plan**: Tested and ready
4. **Communication plan**: Stakeholders notified
5. **Testing evidence**: QA sign-off

---

### Change Risk Assessment

**What it shows**: Risk matrix for changes by impact and probability.

**Risk Matrix**:
```
High Impact    │  CHG002  │  CHG001  │
               │  (Plan)  │  (Emerg) │
               ├──────────┼──────────┤
Low Impact     │  CHG003  │  CHG005  │
               │  (Std)   │  (Norm)  │
               └──────────┴──────────┘
                 Low        High
               Probability
```

**Risk Mitigation**:
- **High/High** (CHG001): Requires senior approval, rollback tested
- **High/Low** (CHG002): Extensive QA, maintenance window
- **Low/High** (CHG003): Standard procedure, auto-rollback
- **Low/Low** (CHG005): Routine, minimal oversight

---

## Section 3: CI Status Overview

### Configuration Item Health

**What it shows**: Health status of all managed CIs.

**CI Status Distribution**:
```
Status              Count    Percentage
Active              342      85.5%  ████████████████████
Inactive            35        8.8%  ███
Maintenance         15        3.8%  █
Decommissioned      8         2.0%  ▌

Total CIs:          400
```

**CI Health by Type**:
```
Type                Total    Healthy    Degraded    Failed
Servers             150      145        4           1
Virtual Machines    80       78         2           0
Containers          60       60         0           0
Databases           25       24         1           0
Network Devices     40       38         2           0
Load Balancers      10       10         0           0
Storage             35       33         2           0
```

**Actions**:
- Click status to filter CIs
- View degraded CIs for investigation
- Schedule maintenance for unhealthy CIs

---

### Top Failing CIs

**What it shows**: CIs with most incident associations.

**Failing CIs List**:
```
CI Name                Type        Incidents    MTBF*      Last Failure
prod-db-01             Database    12           168h       2 days ago
app-server-pool-03     VM          8            312h       5 hours ago
lb-prod-external       LB          5            720h       1 week ago
storage-array-02       Storage     4            1440h      3 days ago

*MTBF = Mean Time Between Failures
```

**Root Cause Patterns**:
- **prod-db-01**: Undersized for load, recommend upgrade
- **app-server-pool-03**: Memory leaks in application v2.5.x
- **lb-prod-external**: Network saturation during peak hours
- **storage-array-02**: Aging hardware, reaching EOL

**Actions**:
- Click CI to see incident history
- Schedule capacity upgrades
- Plan hardware replacement
- Implement monitoring alerts

---

## Section 4: Service Level Metrics

### SLA Compliance

**What it shows**: Service level agreement compliance across all services.

**Service-Level Targets**:
```
Service              Tier    SLA Target    Actual    Status
Customer Portal      1       99.9%         99.95%    ✅ Exceeds
Payment Gateway      1       99.9%         99.87%    ⚠ Below
Admin Dashboard      2       99.0%         99.5%     ✅ Exceeds
Email System         2       99.0%         98.8%     ⚠ Below
Internal Wiki        3       95.0%         97.2%     ✅ Exceeds
```

**SLA Breach Analysis**:
- **Payment Gateway**: 2 incidents totaling 1.87 hours downtime
  - Oct 15: 45 min (database failover)
  - Nov 1: 1 hour 7 min (network outage)
- **Email System**: 3 incidents totaling 3.2 hours downtime
  - Mostly maintenance windows, no customer impact

---

### Response Time Metrics

**What it shows**: Average response times for critical services.

**Response Time SLAs**:
```
Service              P50        P95        P99        SLA     Status
API Gateway          45ms       120ms      350ms      500ms   ✅
Database Queries     12ms       50ms       150ms      200ms   ✅
Page Load Time       800ms      2.1s       4.5s       3.0s    ⚠
Background Jobs      5s         30s        90s        60s     ⚠
```

**Optimization Needed**:
- **Page Load**: Investigate P99 latency (4.5s > 3.0s target)
- **Background Jobs**: P99 exceeding target, consider scaling workers

---

## Section 5: Baseline Compliance

### Configuration Drift Detection

**What it shows**: CIs deviating from approved baselines.

**Drift Status**:
```
Total CIs with Baselines: 250
Compliant:                 235  (94.0%)
Drifted:                   12   (4.8%)
Unknown:                   3    (1.2%)
```

**Drifted CIs**:
```
CI Name              Type      Drift Type           Severity    Age
prod-web-01          Server    Unauthorized pkg     High        2 days
db-replica-02        Database  Config change        Medium      5 hours
firewall-dmz-01      Network   Rule modification    Critical    30 min
app-server-15        VM        OS patch missing     Low         1 week
```

**Drift Categories**:
- **Software**: Unauthorized packages installed
- **Configuration**: Settings changed without change request
- **Security**: Firewall rules, user permissions modified
- **Patching**: Missing security updates

**Actions**:
- Review drifted CIs for security risk
- Correlate with change records
- Remediate unauthorized changes
- Update baseline if drift is approved

---

### Compliance Scanning

**What it shows**: Automated compliance checks against policies.

**Compliance Policies**:
```
Policy                      CIs Scanned    Passed    Failed    Compliance %
Password Policy             150            142       8         94.7%
Encryption at Rest          100            98        2         98.0%
TLS 1.2+ Required           80             76        4         95.0%
Antivirus Up-to-Date        150            145       5         96.7%
Firewall Rules              40             38        2         95.0%
```

**Failed Compliance Items**:
- Investigate and remediate failing CIs
- Update policies if obsolete
- Schedule re-scan after remediation

---

## Section 6: Problem Management

### Open Problems

**What it shows**: Ongoing root cause investigations.

**Problem Status**:
```
ID      Summary                  Related Incidents    Status          Priority
PRB001  Memory Leak v2.5.x       15                   Root Cause      P1
PRB002  Network Latency Spikes   8                    Investigating   P2
PRB003  Database Deadlocks       5                    Workaround      P3
```

**Problem Lifecycle**:
1. **New**: Problem identified from incident pattern
2. **Investigating**: Root cause analysis in progress
3. **Root Cause**: Cause identified, fix being developed
4. **Workaround**: Temporary fix deployed
5. **Resolved**: Permanent fix deployed
6. **Closed**: Verified no recurrence

---

### Known Errors

**What it shows**: Documented issues with workarounds.

**Known Error Database**:
```
ID      Description              Workaround                      Status
KE001   Memory leak in v2.5.3    Restart service every 6 hours   Active
KE002   SSL cert renewal bug     Manual renewal required         Active
KE003   Backup job timeout       Increase timeout to 120 min     Resolved
```

**Using Known Errors**:
- Search before creating new incidents
- Apply documented workarounds
- Track fix progress
- Close when permanent fix deployed

---

## Section 7: Service Request Management

### Service Request Queue

**What it shows**: User requests for standard services.

**Request Types**:
- **Access Request**: System/application access
- **Resource Request**: VM, storage, database provisioning
- **Information Request**: Documentation, reports
- **Consultation**: Architecture guidance

**Request Queue**:
```
ID      Type              Description                Status      SLA    Assignee
SR001   Access Request    GitLab access              Approved    2h     Auto
SR002   Resource Request  New Dev VM                 Provisioning 4h    DevOps
SR003   Information       Backup report Oct 2025     Completed   24h    Ops
SR004   Consultation      Architecture review        Scheduled   48h    Architect
```

**Fulfillment SLAs**:
```
Request Type          Target SLA    Actual Avg    Compliance
Access Request        2 hours       1.5 hours     95.2%
Resource Request      4 hours       3.2 hours     92.1%
Information           24 hours      18 hours      96.8%
Consultation          48 hours      36 hours      94.5%
```

---

## Common ITSM Workflows

### Incident Response (P1 Critical)

**Step-by-Step Process**:

1. **Detection** (0-5 min)
   - Monitoring alert triggers
   - Auto-create incident ticket
   - Page on-call engineer

2. **Initial Response** (5-15 min)
   - Engineer acknowledges page
   - Update incident status to "Investigating"
   - Notify stakeholders via status page

3. **Diagnosis** (15-30 min)
   - Review logs, metrics, recent changes
   - Identify affected CIs
   - Determine root cause

4. **Resolution** (30 min - 4 hours)
   - Apply fix (rollback, restart, failover)
   - Monitor recovery
   - Update incident with actions taken

5. **Verification** (varies)
   - Confirm service restored
   - Monitor for recurrence
   - Update status page (service operational)

6. **Closure** (within 24 hours)
   - Document resolution
   - Create problem ticket for root cause analysis
   - Schedule post-mortem

---

### Change Management Workflow

**Normal Change Process**:

1. **Request** (Day 1)
   - Engineer submits change request
   - Include: Description, justification, risk, rollback plan
   - Attach: Test results, technical design

2. **Review** (Day 1-2)
   - CAB reviews change
   - Assess risk and impact
   - Request additional information if needed

3. **Approval** (CAB Meeting)
   - Present change to CAB
   - Answer questions
   - Vote: Approve, Reject, or Defer

4. **Scheduling** (Post-Approval)
   - Coordinate maintenance window
   - Notify stakeholders
   - Prepare rollback plan

5. **Implementation** (Maintenance Window)
   - Execute change steps
   - Monitor for issues
   - Rollback if problems occur

6. **Verification** (Post-Change)
   - Verify change successful
   - Update CMDB with new configuration
   - Close change ticket

7. **Review** (Within 7 days)
   - Post-implementation review
   - Document lessons learned
   - Update standard procedures

---

### Problem Investigation Workflow

**Root Cause Analysis**:

1. **Problem Identification**
   - Pattern of similar incidents (3+ in 30 days)
   - Create problem ticket from incident
   - Assign to engineering team

2. **Data Collection**
   - Gather incident reports
   - Collect logs, metrics, traces
   - Interview incident responders

3. **Analysis**
   - Use 5 Whys technique
   - Fishbone diagram (Ishikawa)
   - Timeline analysis

4. **Root Cause Determination**
   - Identify contributing factors
   - Document root cause
   - Assess impact and frequency

5. **Solution Development**
   - Design permanent fix
   - Develop workaround if fix delayed
   - Test solution thoroughly

6. **Implementation**
   - Create change request for fix
   - Deploy via change management
   - Monitor for recurrence

7. **Closure**
   - Verify no recurrence (30 days)
   - Document in knowledge base
   - Close problem ticket

---

## Best Practices

### 1. Incident Categorization

**Use standard categories**:
- **Hardware**: Server, network, storage failures
- **Software**: Application bugs, crashes
- **Network**: Connectivity, performance issues
- **Security**: Unauthorized access, malware
- **User Error**: Training issue, incorrect usage

**Benefits**:
- Faster routing to correct team
- Better trend analysis
- Improved reporting

---

### 2. Documentation Standards

**Required fields for incidents**:
- Clear description (what, when, who affected)
- Impact assessment (users, revenue)
- Steps taken (investigation, resolution)
- Root cause (if known)
- Prevention (how to avoid recurrence)

---

### 3. Escalation Procedures

**Escalation Criteria**:
```
Tier 1 (Service Desk):
- Can resolve: Password resets, access requests
- Escalate if: >15 min without progress

Tier 2 (Operations):
- Can resolve: Service restarts, config changes
- Escalate if: >30 min without progress (P1), >1 hour (P2)

Tier 3 (Engineering):
- Can resolve: Code bugs, architecture issues
- Escalate if: >1 hour without progress (P1)

Management:
- Escalate immediately: Multi-service outage, security breach
```

---

### 4. Communication

**Stakeholder Updates**:
- **P1**: Every 30 minutes until resolved
- **P2**: Every 2 hours
- **P3**: Daily summary
- **P4**: Weekly summary

**Channels**:
- Status page (public)
- Slack #incidents channel (internal)
- Email to affected users
- Executive brief (P1 only)

---

### 5. Post-Mortem Process

**When to conduct**:
- All P1 incidents
- P2 incidents with SLA breach
- Repeated incidents (3+ occurrences)
- Customer-facing outages

**Post-Mortem Template**:
1. **Summary**: What happened?
2. **Timeline**: Detailed sequence of events
3. **Root Cause**: Why did it happen?
4. **Impact**: Who/what was affected?
5. **Resolution**: How was it fixed?
6. **Action Items**: How to prevent recurrence?
7. **Lessons Learned**: What did we learn?

---

## Metrics and KPIs

### Key Performance Indicators

**Incident Management**:
- **MTTR** (Mean Time To Resolve): Target <4 hours (P1)
- **MTBF** (Mean Time Between Failures): Target >720 hours
- **Incident Volume**: Trend should be decreasing
- **SLA Compliance**: Target >95%

**Change Management**:
- **Change Success Rate**: Target >95%
- **Emergency Changes**: Target <10% of total
- **Rollback Rate**: Target <5%

**Service Availability**:
- **Uptime**: Target 99.9% (Tier 1 services)
- **Planned Downtime**: <4 hours/month
- **Unplanned Downtime**: <1 hour/month

---

## Troubleshooting

### Incident ticket not creating automatically

**Check**:
1. Monitoring alerts configured correctly
2. Webhook integration to ITSM enabled
3. API credentials valid

**Solution**: Manually create ticket, investigate automation

---

### SLA breaches not alerting

**Check**:
1. SLA targets configured per service
2. Alert rules enabled
3. Notification channels set up

**Solution**: Review alert configuration

---

### Change approvals delayed

**Possible causes**:
1. CAB members not notified
2. Insufficient information in change request
3. High-risk changes require additional review

**Solution**: Follow up with CAB members, provide requested details

---

## See Also

- [Executive Dashboard User Guide](/user-guides/executive-dashboard.md) - High-level service health
- [ITIL Service Manager](/components/itil-service-manager.md) - ITIL architecture
- [Operations Guide](/operations/daily-operations.md) - Daily operations procedures
- [Troubleshooting Guide](/operations/troubleshooting.md) - Issue resolution

---

**Dashboard Version**: 3.0
**Last Updated**: November 2025
**Audience**: IT operations, service desk, DevOps engineers
