# On-Call Handoff Checklist

## Overview

Use this checklist for weekly on-call handoffs to ensure smooth transitions and knowledge transfer.

## Handoff Meeting

**When**: Monday 9:00 AM (or agreed time)
**Duration**: 15-30 minutes
**Attendees**: Outgoing on-call, Incoming on-call
**Optional**: Team lead (for complex situations)

## Pre-Handoff (Outgoing On-Call)

Before the handoff meeting, outgoing on-call should prepare:

- [ ] Review all incidents from your shift
- [ ] Complete all incident reports
- [ ] Identify any ongoing issues
- [ ] Note alert trends or patterns
- [ ] Document any quirks or tips discovered
- [ ] List follow-up items
- [ ] Prepare handoff notes (use template below)

## Handoff Checklist

### 1. Ongoing Incidents

- [ ] **No ongoing incidents?** → Confirm all clear
- [ ] **Ongoing incidents?** → For each:
  - [ ] Incident ID and severity
  - [ ] Current status and next steps
  - [ ] Who to contact for questions
  - [ ] Estimated resolution time
  - [ ] Any dependencies or blockers

**Notes**:
```
Ongoing Incidents:
- INC-YYYY-MM-DD-001: [Description] - Status: [Status] - Next: [Action]
- INC-YYYY-MM-DD-002: [Description] - Status: [Status] - Next: [Action]
```

### 2. Recent Incidents (Last 7 Days)

- [ ] Review each incident from past week
- [ ] Share lessons learned
- [ ] Note any recurring issues
- [ ] Identify patterns or trends

**Notes**:
```
Recent Incidents:
- [Day]: INC-XXX - [Brief description] - [Resolution]
- [Day]: INC-XXX - [Brief description] - [Resolution]

Recurring Issues:
- [Issue 1]: Happened [X] times, typically [pattern]
- [Issue 2]: [Description]
```

### 3. Alert Trends

- [ ] High-frequency alerts
- [ ] New types of alerts
- [ ] False positive alerts
- [ ] Alerts that need tuning

**Notes**:
```
Alert Trends:
- [Alert Name]: Fired [X] times, [Pattern], [Action taken]
- [Alert Name]: False positives - ticket created to fix
- [Alert Name]: New alert - seems useful/noisy
```

### 4. System Status

- [ ] All services healthy?
- [ ] Any degraded performance?
- [ ] Recent deployments or changes
- [ ] Upcoming deployments or maintenance

**Notes**:
```
System Status:
- API Server: [Healthy/Issues]
- Discovery Engine: [Healthy/Issues]
- Databases: [Healthy/Issues]
- Recent Changes: [Deployment on DATE - impact]
- Upcoming Maintenance: [Scheduled work on DATE]
```

### 5. Known Issues

- [ ] Non-critical issues being tracked
- [ ] Workarounds in place
- [ ] Tickets created
- [ ] Expected resolution dates

**Notes**:
```
Known Issues:
- [Issue 1]: [Description] - Workaround: [Steps] - Ticket: JIRA-XXX
- [Issue 2]: [Description] - Expected fix: [Date]
```

### 6. Rate Limiting / Throttling

- [ ] Any connectors being rate limited?
- [ ] Cloud provider quota issues?
- [ ] API rate limit violations?
- [ ] Actions taken or needed

**Notes**:
```
Rate Limiting:
- [Connector/Service]: [Issue] - [Action taken]
```

### 7. Discovery Jobs

- [ ] Discovery jobs running normally?
- [ ] Any persistent failures?
- [ ] Credential issues?
- [ ] New connectors added?

**Notes**:
```
Discovery Status:
- Overall Success Rate: [X]%
- Failing Connectors: [List]
- Credential Renewals Needed: [List]
```

### 8. Database Health

- [ ] Neo4j performance normal?
- [ ] PostgreSQL performance normal?
- [ ] Redis functioning properly?
- [ ] Backup status (last successful backup)
- [ ] Any long-running queries?

**Notes**:
```
Database Health:
- Neo4j: [Status] - Last Backup: [Date]
- PostgreSQL: [Status] - Last Backup: [Date]
- Redis: [Status]
- Issues: [Description]
```

### 9. Customer Issues

- [ ] Any customer escalations?
- [ ] VIP customer issues?
- [ ] Support tickets requiring attention?
- [ ] Customer communication needed?

**Notes**:
```
Customer Issues:
- [Customer Name]: [Issue] - Status: [Status] - Ticket: [Number]
```

### 10. Vendor/External Issues

- [ ] Cloud provider incidents affecting us?
- [ ] Third-party service degradations?
- [ ] Vendor support tickets open?
- [ ] External dependencies status?

**Notes**:
```
External Issues:
- [Vendor]: [Issue] - Impact: [Description] - Ticket: [Number]
```

### 11. Tips & Tricks

- [ ] Share useful commands or queries
- [ ] Shortcuts or tools that helped
- [ ] Runbook improvements made
- [ ] Common pitfalls to avoid

**Notes**:
```
Tips:
- [Tip 1]
- [Tip 2]
- Runbook Updates: [What was updated and why]
```

### 12. Follow-Up Items

- [ ] Action items for incoming on-call
- [ ] Items to hand off to team
- [ ] Escalations in progress
- [ ] Pending decisions

**Notes**:
```
Follow-Up Items:
- [ ] [Action item 1] - Due: [Date] - Owner: [If not incoming on-call]
- [ ] [Action item 2] - Due: [Date]
- [ ] [Action item 3] - Due: [Date]
```

### 13. Access & Tools Verification

- [ ] Incoming on-call has all necessary access
- [ ] PagerDuty notifications working
- [ ] VPN access confirmed
- [ ] SSH keys working
- [ ] Database access verified
- [ ] Monitoring dashboards accessible

**Verification Steps** (Incoming on-call tests):
```bash
# Test PagerDuty
# Send test notification from PagerDuty

# Test VPN
vpn-cli status

# Test SSH
ssh production-api-server-1

# Test database access
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1;"
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SELECT 1;"

# Test monitoring access
curl http://localhost:9090/api/v1/alerts
```

### 14. Schedule Review

- [ ] Confirm incoming on-call availability for full week
- [ ] Note any planned absences or limitations
- [ ] Confirm secondary on-call knows their role
- [ ] Review escalation contacts

**Notes**:
```
Availability:
- Incoming On-Call: Available [Days/Times], Limited: [Days/Times]
- Secondary On-Call: [Name] - Contact: [Phone]
- Escalation: [Senior Engineer Name] - [Phone]
```

### 15. Questions & Clarifications

- [ ] Incoming on-call asks questions
- [ ] Clarify any unclear points
- [ ] Review runbooks for common issues
- [ ] Share confidence level

**Questions for Incoming On-Call**:
- Do you feel prepared for this shift?
- Any concerns or areas you want to review?
- Understand escalation procedures?
- Know where to find runbooks?
- Comfortable with the tools?

## Handoff Template

Use this template for handoff notes:

```
═══════════════════════════════════════════════════════════
HAPPYCMDB ON-CALL HANDOFF
═══════════════════════════════════════════════════════════
Week of: [Start Date] to [End Date]
From: [Outgoing On-Call Name]
To: [Incoming On-Call Name]
Date: [Handoff Date] [Time]

───────────────────────────────────────────────────────────
1. ONGOING INCIDENTS
───────────────────────────────────────────────────────────
[X] No ongoing incidents
[ ] Active incidents (list below):

INC-ID | Severity | Status | Next Steps | ETA
-------|----------|--------|------------|----
       |          |        |            |

───────────────────────────────────────────────────────────
2. RECENT INCIDENTS (Last 7 Days)
───────────────────────────────────────────────────────────
Total Incidents: [Number]
Critical/High: [Number]
Resolution Rate: [X]%

Date  | INC-ID | Severity | Description | Resolution
------|--------|----------|-------------|------------
      |        |          |             |

Recurring Issues:
- [Issue 1]: [Pattern]
- [Issue 2]: [Pattern]

───────────────────────────────────────────────────────────
3. ALERT TRENDS
───────────────────────────────────────────────────────────
Top 5 Alerts:
1. [Alert Name] - Fired [X] times - [Pattern]
2. [Alert Name] - Fired [X] times - [Pattern]
3. [Alert Name] - Fired [X] times - [Pattern]
4. [Alert Name] - Fired [X] times - [Pattern]
5. [Alert Name] - Fired [X] times - [Pattern]

False Positives:
- [Alert Name] - [Action taken]

New Alerts:
- [Alert Name] - [Notes]

───────────────────────────────────────────────────────────
4. SYSTEM STATUS
───────────────────────────────────────────────────────────
[X] All systems healthy
[ ] Issues or degradations:

Component | Status | Notes
----------|--------|------
API Server | [✓/⚠/✗] |
Discovery Engine | [✓/⚠/✗] |
Neo4j | [✓/⚠/✗] |
PostgreSQL | [✓/⚠/✗] |
Redis | [✓/⚠/✗] |
Web UI | [✓/⚠/✗] |

Recent Changes:
- [Date]: [Deployment/Change] - [Impact]

Upcoming Maintenance:
- [Date/Time]: [Scheduled work]

───────────────────────────────────────────────────────────
5. KNOWN ISSUES (Non-Critical)
───────────────────────────────────────────────────────────
[X] No known issues
[ ] Issues (list below):

Issue | Impact | Workaround | Ticket | ETA
------|--------|------------|--------|----
      |        |            |        |

───────────────────────────────────────────────────────────
6. DISCOVERY STATUS
───────────────────────────────────────────────────────────
Overall Success Rate: [X]%
Jobs Run: [Number]
Jobs Failed: [Number]

Failing Connectors:
- [Connector Name]: [Reason] - [Action taken]

Credential Issues:
- [Credential]: [Expiring on DATE] - [Action needed]

Rate Limiting:
- [Service]: [Description]

───────────────────────────────────────────────────────────
7. DATABASE HEALTH
───────────────────────────────────────────────────────────
Neo4j:
- Status: [Healthy/Issues]
- Last Backup: [Date/Time]
- Performance: [Normal/Degraded]
- Notes: [Any issues]

PostgreSQL:
- Status: [Healthy/Issues]
- Last Backup: [Date/Time]
- Performance: [Normal/Degraded]
- Notes: [Any issues]

Redis:
- Status: [Healthy/Issues]
- Memory Usage: [X]%
- Notes: [Any issues]

───────────────────────────────────────────────────────────
8. CUSTOMER ISSUES
───────────────────────────────────────────────────────────
[X] No customer escalations
[ ] Active customer issues:

Customer | Issue | Severity | Status | Ticket
---------|-------|----------|--------|-------
         |       |          |        |

───────────────────────────────────────────────────────────
9. VENDOR/EXTERNAL ISSUES
───────────────────────────────────────────────────────────
[X] No external issues
[ ] Active external issues:

Vendor | Issue | Impact | Status | Ticket
-------|-------|--------|--------|-------
       |       |        |        |

───────────────────────────────────────────────────────────
10. TIPS & TRICKS
───────────────────────────────────────────────────────────
Useful Tips:
- [Tip 1]
- [Tip 2]

Common Issues:
- [Issue]: [Quick fix]

Runbook Updates:
- [What was updated]

───────────────────────────────────────────────────────────
11. FOLLOW-UP ITEMS
───────────────────────────────────────────────────────────
[ ] [Action item 1] - Due: [Date] - Owner: [Name]
[ ] [Action item 2] - Due: [Date] - Owner: [Name]
[ ] [Action item 3] - Due: [Date] - Owner: [Name]

───────────────────────────────────────────────────────────
12. CONTACT INFORMATION
───────────────────────────────────────────────────────────
Outgoing On-Call: [Name] - [Phone] - [Email]
Available for questions until: [Date/Time]

Secondary On-Call: [Name] - [Phone]
Escalation (Senior): [Name] - [Phone]
Escalation (Manager): [Name] - [Phone]

───────────────────────────────────────────────────────────
13. HANDOFF CONFIRMATION
───────────────────────────────────────────────────────────
[ ] Incoming on-call has reviewed all sections
[ ] All questions answered
[ ] Access verified
[ ] PagerDuty notifications tested
[ ] Incoming on-call feels prepared
[ ] Handoff complete

Outgoing On-Call Signature: _________________ Date: _______
Incoming On-Call Signature: _________________ Date: _______

═══════════════════════════════════════════════════════════
```

## Post-Handoff (Incoming On-Call)

After handoff meeting:

- [ ] Review handoff notes thoroughly
- [ ] Test all access and tools
- [ ] Verify PagerDuty notifications
- [ ] Bookmark key dashboards and runbooks
- [ ] Review runbooks for known issues
- [ ] Ensure laptop/phone charged
- [ ] Plan to be available for first few hours

## Post-Handoff (Outgoing On-Call)

After handoff meeting:

- [ ] Save handoff notes to shared folder
- [ ] Complete any outstanding incident reports
- [ ] File tickets for improvements identified
- [ ] Update runbooks if gaps found
- [ ] Be available for questions (first 24 hours)
- [ ] Rest and recover!

## Escalation During Handoff Period

If incident occurs during handoff:

- **If before handoff meeting**: Outgoing handles, briefs incoming
- **If during handoff meeting**: Both respond together
- **If after handoff meeting**: Incoming handles, can consult outgoing

## Documentation

Save handoff notes to:
- **Location**: `/docs/operations/on-call/handoffs/YYYY-MM-DD-handoff.md`
- **Retention**: Keep for 90 days
- **Access**: Team members only

## Continuous Improvement

After each handoff, consider:

- Was anything unclear?
- What information was missing?
- What could make handoffs smoother?
- Should this checklist be updated?

Share feedback with team lead.

---

**Remember**: A good handoff sets up the incoming on-call for success. Take the time to do it properly!
