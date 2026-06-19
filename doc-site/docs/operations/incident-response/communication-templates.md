# Incident Communication Templates

## 1. Internal Communication Templates

### 1.1 Slack - Incident Declaration

```
@here :rotating_light: **INCIDENT DECLARED** :rotating_light:

**Severity**: [Critical/High/Medium/Low]
**Incident ID**: INC-YYYY-MM-DD-NNN
**Status**: Investigating

**Summary**: [One-line description]

**Impact**:
- Services Affected: [API/UI/Discovery/Database]
- User Impact: [Complete Outage/Degraded Performance/Limited Impact]
- Estimated Users Affected: [Number/All/Percentage]

**Incident Commander**: @[name]
**War Room**: #incident-[id] (join for updates)

**Next Update**: [Time] (every 15-30 min during active incident)

:point_right: Please do NOT direct message responders. Use #incident-[id] for all communication.
```

### 1.2 Slack - Status Update

```
:information_source: **Incident Update** - INC-YYYY-MM-DD-NNN

**Status**: [Investigating/Identified/Fixing/Monitoring/Resolved]
**Time Elapsed**: [HH:MM]

**Update**:
[Brief description of current status and actions being taken]

**Impact**: [Any change to impact? Better/Worse/Same]

**Next Steps**:
1. [Action 1]
2. [Action 2]

**Next Update**: [Time]

Thread :thread: for discussion
```

### 1.3 Slack - Incident Resolved

```
:white_check_mark: **INCIDENT RESOLVED** - INC-YYYY-MM-DD-NNN

**Resolution Time**: [HH:MM]
**Total Duration**: [HH:MM]

**Root Cause**: [Brief explanation]

**Fix Applied**: [What was done to resolve]

**Verification**:
- [x] Services restored
- [x] Monitoring shows healthy metrics
- [x] User reports confirm resolution

**Follow-up**:
- Post-mortem scheduled: [Date/Time]
- Action items tracked in: [Link]

Thank you to everyone who helped resolve this incident! :tada:

Full incident report: [Link]
```

### 1.4 Email - Critical Incident Notification

```
Subject: [CRITICAL] HappyCMDB Incident - [Brief Description]

Team,

We are experiencing a critical incident affecting HappyCMDB production environment.

INCIDENT DETAILS
-----------------
Incident ID: INC-YYYY-MM-DD-NNN
Severity: Critical
Started: YYYY-MM-DD HH:MM UTC
Status: Investigating

IMPACT
------
Services Affected: [List]
User Impact: [Description]
Estimated Users Affected: [Number/Percentage]

CURRENT SITUATION
-----------------
[Brief description of what is happening and what we're doing about it]

RESPONSE TEAM
-------------
Incident Commander: [Name]
Technical Lead: [Name]
On-Call Engineers: [Names]

War Room: #incident-[id] on Slack

COMMUNICATION
-------------
Updates will be provided every 30 minutes until resolved.
Next update expected: [Time]

Questions? Please use #incident-[id] on Slack.

[Incident Commander Name]
HappyCMDB Operations Team
```

## 2. External Communication Templates

### 2.1 Status Page - Investigating

```
Title: Investigating - [Service] Performance Issues

We are currently investigating reports of [description of issue] affecting [affected services].

Our team is actively working to identify the root cause and restore full service.

Users may experience:
- [Symptom 1]
- [Symptom 2]
- [Symptom 3]

We will provide an update within 30 minutes.

Posted: YYYY-MM-DD HH:MM UTC
```

### 2.2 Status Page - Identified

```
Title: Identified - [Service] Performance Issues

We have identified the root cause of the [service] issues reported at [time].

Issue: [Brief description of the problem]

Impact:
- [Specific impact 1]
- [Specific impact 2]

Our team is implementing a fix and we expect to have services fully restored by [estimated time].

Workaround (if applicable):
[Any workaround users can use while we fix the issue]

Next update: [Time]

Posted: YYYY-MM-DD HH:MM UTC
Updated: YYYY-MM-DD HH:MM UTC
```

### 2.3 Status Page - Monitoring

```
Title: Monitoring - [Service] Issues

We have implemented a fix for the [service] issues and are monitoring the situation.

Resolution: [Brief description of fix applied]

Current Status:
- All services have been restored
- Monitoring shows normal operations
- No further user reports of issues

We will continue to monitor the situation for the next [X hours] to ensure stability.

If you continue to experience issues, please contact support@example.com

Posted: YYYY-MM-DD HH:MM UTC
Updated: YYYY-MM-DD HH:MM UTC
```

### 2.4 Status Page - Resolved

```
Title: Resolved - [Service] Issues

This incident has been resolved.

Summary:
Between [start time] and [end time] UTC, users experienced [description of impact].

Root Cause:
[Brief, non-technical explanation of what caused the issue]

Resolution:
[What we did to fix it]

Prevention:
We are implementing the following measures to prevent recurrence:
- [Measure 1]
- [Measure 2]

We apologize for any inconvenience this may have caused.

If you have any questions or continue to experience issues, please contact support@example.com

Posted: YYYY-MM-DD HH:MM UTC
Resolved: YYYY-MM-DD HH:MM UTC
Total Duration: [HH:MM]
```

### 2.5 Customer Email - Service Disruption

```
Subject: HappyCMDB Service Disruption - [Date]

Dear Valued Customer,

We are writing to inform you about a service disruption that occurred on [date] affecting HappyCMDB services.

WHAT HAPPENED
-------------
Between [start time] and [end time] UTC on [date], users experienced [brief description of impact].

IMPACT TO YOUR ACCOUNT
-----------------------
[Specific impact to this customer, if known]
OR
[General impact statement if customer-specific impact unknown]

RESOLUTION
----------
Our team identified and resolved the issue at [time] UTC. The root cause was [brief explanation].

PREVENTION
----------
To prevent similar incidents in the future, we are implementing:
- [Improvement 1]
- [Improvement 2]
- [Improvement 3]

YOUR DATA
---------
[Reassurance about data safety, e.g.:]
We want to assure you that no data was lost during this incident. All your configuration items and relationships remain intact and accurate.

WE'RE SORRY
-----------
We sincerely apologize for any inconvenience this disruption may have caused to your operations. We understand that you rely on HappyCMDB for critical infrastructure management, and we take our responsibility seriously.

QUESTIONS?
----------
If you have any questions or concerns, please don't hesitate to contact our support team:
- Email: support@example.com
- Phone: +1-XXX-XXX-XXXX
- Support Portal: https://support.example.com

Thank you for your patience and continued trust in HappyCMDB.

Sincerely,

[Name]
[Title]
HappyCMDB Operations Team
```

### 2.6 Social Media - Service Issue

```
🔧 We're aware of an issue affecting HappyCMDB API performance. Our team is investigating and we'll post updates here and on our status page: https://status.happycmdb.com

We apologize for any inconvenience.

#HappyCMDBStatus
```

### 2.7 Social Media - Service Restored

```
✅ The HappyCMDB API issue has been resolved. All services are operating normally.

Thanks for your patience! Full details: https://status.happycmdb.com/incidents/[id]

#HappyCMDBStatus
```

## 3. Escalation Communication

### 3.1 Escalation to Senior Engineer

```
Hi [Name],

I need to escalate the current incident [INC-ID] to you.

SITUATION
---------
- Issue: [Brief description]
- Severity: [Critical/High]
- Duration: [Time since start]
- Impact: [User/system impact]

WHAT I'VE TRIED
---------------
1. [Action 1 - Outcome]
2. [Action 2 - Outcome]
3. [Action 3 - Outcome]

CURRENT STATUS
--------------
[What's happening right now]

DIAGNOSTICS
-----------
- Logs: [Link]
- Metrics: [Link]
- Errors: [Summary]

ASSISTANCE NEEDED
-----------------
[What specifically you need help with]

War Room: #incident-[id]

Thanks,
[Your Name]
```

### 3.2 Escalation to Management

```
Subject: URGENT: Critical Incident Escalation - [Service]

[Manager Name],

I am escalating a critical incident that requires management awareness.

INCIDENT SUMMARY
----------------
Incident ID: INC-YYYY-MM-DD-NNN
Severity: Critical
Started: [Time] ([Duration] ago)
Status: [Current status]

BUSINESS IMPACT
---------------
- Services Down: [List]
- Users Affected: [Number/Percentage]
- Estimated Revenue Impact: $[Amount]
- SLA Breach: [Yes/No - If yes, details]
- Customer Escalations: [Number]

TECHNICAL SUMMARY
-----------------
[Brief non-technical explanation of what's wrong]

RESPONSE STATUS
---------------
- Incident Commander: [Name]
- Engineers Engaged: [Number]
- Vendor Support: [Engaged/Not engaged]
- ETA for Resolution: [Time or "Unknown"]

ESCALATION REASON
-----------------
[Why this needs management attention - e.g., prolonged outage, customer impact, potential PR issue]

MANAGEMENT ACTION NEEDED
------------------------
[What you need from management - e.g., approval for emergency vendor support, customer communication, resource allocation]

I will provide updates every [frequency].

War Room: #incident-[id]

[Your Name]
Incident Commander
```

## 4. Support Ticket Response Templates

### 4.1 Acknowledging User-Reported Issue

```
Hello [Customer Name],

Thank you for reporting this issue. We have created incident INC-YYYY-MM-DD-NNN to track this problem.

We are currently [investigating/working on a fix] and will keep you updated on progress.

Our team is treating this as a [priority level] issue.

Estimated Time to Resolution: [Time or "Under investigation"]

We appreciate your patience.

Best regards,
HappyCMDB Support Team

Ticket #[Number]
```

### 4.2 Providing Workaround

```
Hello [Customer Name],

While we work on a permanent fix for the issue you reported, here is a workaround you can use:

WORKAROUND STEPS
----------------
1. [Step 1]
2. [Step 2]
3. [Step 3]

LIMITATIONS
-----------
[Any limitations of the workaround]

We expect to have a permanent fix deployed by [estimated time].

Please let us know if you have any questions about this workaround.

Best regards,
HappyCMDB Support Team

Ticket #[Number]
```

## 5. Communication Cadence Guidelines

### During Active Incident

| Severity | Internal Updates | External Updates | Stakeholder Briefing |
|----------|-----------------|------------------|---------------------|
| Critical | Every 15-30 min | Every 30-60 min | Immediately + hourly |
| High | Every 30-60 min | Every 1-2 hours | At start + when resolved |
| Medium | Every 1-2 hours | Daily | Daily summary |
| Low | Daily | As needed | Weekly summary |

### Communication Channels by Severity

| Severity | Slack | Email | Status Page | Customer Direct | Social Media |
|----------|-------|-------|-------------|-----------------|--------------|
| Critical | ✅ | ✅ | ✅ | ✅ | ✅ |
| High | ✅ | ✅ | ✅ | If requested | If public-facing |
| Medium | ✅ | If prolonged | If prolonged | If requested | No |
| Low | ✅ | No | No | No | No |

## 6. Post-Incident Communication

### 6.1 Post-Mortem Summary (Internal)

```
Subject: Post-Mortem Summary - INC-YYYY-MM-DD-NNN

Team,

We have completed the post-mortem for incident INC-YYYY-MM-DD-NNN.

INCIDENT SUMMARY
----------------
What: [Brief description]
When: [Date and duration]
Impact: [User and system impact]

ROOT CAUSE
----------
[Clear explanation of what caused the incident]

ACTION ITEMS
------------
To prevent recurrence, we will:
1. [Action 1] - Owner: [Name] - Due: [Date]
2. [Action 2] - Owner: [Name] - Due: [Date]
3. [Action 3] - Owner: [Name] - Due: [Date]

Full post-mortem document: [Link]

Thanks to everyone who helped resolve this incident and participated in the post-mortem.

[Name]
```

### 6.2 Lessons Learned (Team Share)

```
Subject: Lessons Learned - [Incident Type] Incident

Team,

Following our recent [incident type] incident, here are key lessons learned:

WHAT WORKED WELL
----------------
✅ [Thing 1]
✅ [Thing 2]
✅ [Thing 3]

WHAT TO IMPROVE
---------------
❌ [Gap 1] → Action: [Solution]
❌ [Gap 2] → Action: [Solution]
❌ [Gap 3] → Action: [Solution]

KNOWLEDGE SHARING
-----------------
[New knowledge or procedures discovered during incident response]

Updated documentation:
- [Doc 1 link]
- [Doc 2 link]

Please review and let me know if you have questions.

[Name]
```

---

## Template Usage Guidelines

1. **Customize templates** for your specific incident - don't just copy/paste
2. **Be honest and transparent** - especially with external communications
3. **Avoid technical jargon** in customer-facing communications
4. **Include specific times** and use UTC timezone
5. **Proofread** before sending - especially external communications
6. **Update regularly** - stick to your promised update cadence
7. **Show empathy** - acknowledge the impact on users
8. **Be clear about next steps** - set expectations

## Communication DOs and DON'Ts

### DO
- ✅ Communicate early and often
- ✅ Be transparent about what you know and don't know
- ✅ Set expectations for next update
- ✅ Use clear, simple language
- ✅ Acknowledge impact on users
- ✅ Provide workarounds when possible
- ✅ Thank responders and users for patience

### DON'T
- ❌ Promise timelines you can't meet
- ❌ Blame individuals or vendors publicly
- ❌ Use technical jargon with non-technical audiences
- ❌ Go silent - keep updating even if no progress
- ❌ Minimize the impact
- ❌ Rush to conclusions about root cause
- ❌ Forget to close the loop when resolved
