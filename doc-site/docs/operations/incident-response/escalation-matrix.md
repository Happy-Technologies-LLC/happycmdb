# Escalation Matrix

## Overview

This document defines escalation paths, contact information, and procedures for incident response in HappyCMDB production environment.

## Severity Definitions

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|-----------|
| **Critical (P1)** | Complete service outage or severe degradation affecting all users | 15 minutes | API server down, database inaccessible, complete auth failure |
| **High (P2)** | Significant functionality impaired, affecting many users | 30 minutes | Discovery jobs failing, major performance degradation, partial outage |
| **Medium (P3)** | Minor functionality impaired, affecting some users | 2 hours | Single connector failing, minor UI bugs, non-critical feature down |
| **Low (P4)** | Minimal impact, cosmetic issues, or affecting very few users | 1 business day | Documentation errors, minor UI inconsistencies, enhancement requests |

## Escalation Tiers

### Tier 1: On-Call Engineer (First Responder)

**Responsibilities**:
- Acknowledge incident within response time SLA
- Initial triage and diagnosis
- Implement fixes for known issues using runbooks
- Escalate if unable to resolve within time limits

**Escalation Criteria**:
- Issue not resolved within 30 minutes (Critical) or 1 hour (High)
- Root cause unclear after initial investigation
- Fix requires architectural changes or code deployment
- Multiple systems affected

**Time to Escalate**:
- Critical: 30 minutes
- High: 1 hour
- Medium: 4 hours
- Low: 1 business day

### Tier 2: Senior Engineer / Team Lead

**Responsibilities**:
- Deep technical troubleshooting
- Code analysis and emergency patches
- Coordination with other teams
- Architecture-level decisions
- Database performance tuning

**Escalation Criteria**:
- Issue requires vendor support engagement
- Data loss or corruption suspected
- Security incident suspected
- Fix requires significant code changes
- Impact exceeds 4 hours

**Time to Escalate**:
- Critical: 1 hour
- High: 4 hours
- Medium: 1 business day

### Tier 3: Engineering Manager / Director

**Responsibilities**:
- Resource allocation decisions
- Vendor escalation approval
- Customer communication (major accounts)
- External communication approval
- Business continuity decisions

**Escalation Criteria**:
- Outage >4 hours
- SLA breach with financial impact
- Major customer escalation
- Data breach or security incident
- Requires emergency budget approval
- PR/media attention

### Tier 4: VP Engineering / CTO

**Responsibilities**:
- Strategic decisions
- Major vendor negotiations
- Executive customer communication
- Board/investor communication
- Emergency resource allocation

**Escalation Criteria**:
- Outage >8 hours
- Catastrophic data loss
- Major security breach
- Regulatory compliance impact
- Significant financial impact (>$100K)
- Requires C-level decision

## Contact Information

### On-Call Rotation

| Week | Primary On-Call | Secondary On-Call |
|------|----------------|-------------------|
| Week 1 | [Engineer 1] | [Engineer 2] |
| Week 2 | [Engineer 3] | [Engineer 4] |
| Week 3 | [Engineer 5] | [Engineer 6] |
| Week 4 | [Engineer 2] | [Engineer 1] |

**On-Call Schedule**: https://company.pagerduty.com/schedules/oncall

### Contact List

#### Tier 1: On-Call Engineers

| Name | Role | Phone | Email | Slack |
|------|------|-------|-------|-------|
| [Engineer 1] | Backend Engineer | +1-XXX-XXX-XX01 | engineer1@example.com | @engineer1 |
| [Engineer 2] | DevOps Engineer | +1-XXX-XXX-XX02 | engineer2@example.com | @engineer2 |
| [Engineer 3] | Full-Stack Engineer | +1-XXX-XXX-XX03 | engineer3@example.com | @engineer3 |
| [Engineer 4] | Backend Engineer | +1-XXX-XXX-XX04 | engineer4@example.com | @engineer4 |
| [Engineer 5] | Infrastructure Engineer | +1-XXX-XXX-XX05 | engineer5@example.com | @engineer5 |
| [Engineer 6] | Backend Engineer | +1-XXX-XXX-XX06 | engineer6@example.com | @engineer6 |

#### Tier 2: Senior Engineers / Team Leads

| Name | Role | Specialty | Phone | Email | Slack |
|------|------|-----------|-------|-------|-------|
| [Senior 1] | Senior Backend Engineer | API, Discovery Engine | +1-XXX-XXX-XX11 | senior1@example.com | @senior1 |
| [Senior 2] | Database Administrator | Neo4j, PostgreSQL | +1-XXX-XXX-XX12 | senior2@example.com | @senior2 |
| [Senior 3] | DevOps Lead | Infrastructure, K8s | +1-XXX-XXX-XX13 | senior3@example.com | @senior3 |
| [Senior 4] | Security Engineer | Auth, Security | +1-XXX-XXX-XX14 | senior4@example.com | @senior4 |

#### Tier 3: Management

| Name | Role | Phone | Email | Slack |
|------|------|-------|-------|-------|
| [Manager 1] | Engineering Manager | +1-XXX-XXX-XX21 | manager1@example.com | @manager1 |
| [Director 1] | Director of Engineering | +1-XXX-XXX-XX22 | director1@example.com | @director1 |

#### Tier 4: Executive

| Name | Role | Phone | Email |
|------|------|-------|-------|
| [VP] | VP Engineering | +1-XXX-XXX-XX31 | vp@example.com |
| [CTO] | Chief Technology Officer | +1-XXX-XXX-XX32 | cto@example.com |

### External Contacts

#### Vendor Support

| Vendor | Service | Support Level | Contact | Phone | Portal |
|--------|---------|---------------|---------|-------|--------|
| Neo4j | Database | Enterprise | support@neo4j.com | +1-XXX-XXX-XXXX | https://support.neo4j.com |
| AWS | Cloud Infrastructure | Business | - | - | https://console.aws.amazon.com/support |
| Azure | Cloud Infrastructure | Professional | - | - | https://portal.azure.com/#blade/Microsoft_Azure_Support |
| HashiCorp | Vault | Enterprise | support@hashicorp.com | +1-XXX-XXX-XXXX | https://support.hashicorp.com |
| Datadog | Monitoring | Pro | support@datadoghq.com | - | https://help.datadoghq.com |

#### Customer Success

| Name | Role | Phone | Email |
|------|------|-------|-------|
| [CSM 1] | VP Customer Success | +1-XXX-XXX-XX41 | csm1@example.com |
| [CSM 2] | Customer Success Manager | +1-XXX-XXX-XX42 | csm2@example.com |

## Escalation Procedures

### How to Escalate

1. **Assess Severity**: Use severity definitions above
2. **Check Time Limits**: Reference escalation criteria for your tier
3. **Gather Information**: Prepare escalation brief (see template below)
4. **Contact Next Tier**: Use contact list above
5. **Hand Off Context**: Provide complete situation summary
6. **Remain Available**: Stay engaged to assist

### Escalation Brief Template

```
ESCALATION REQUEST - INC-[ID]

SEVERITY: [Critical/High/Medium/Low]
ELAPSED TIME: [Duration since incident start]
TIER: [Current tier number]

SITUATION
---------
[Brief description of what's happening]

IMPACT
------
- Users Affected: [Number/Percentage]
- Services Down: [List]
- Duration: [Time]
- Business Impact: [Revenue/SLA/Customer]

ACTIONS TAKEN
-------------
1. [Action 1 - Outcome]
2. [Action 2 - Outcome]
3. [Action 3 - Outcome]

CURRENT DIAGNOSIS
-----------------
[What you believe is the root cause]

ESCALATION REASON
-----------------
[Why you need to escalate - what's blocking resolution]

ASSISTANCE NEEDED
-----------------
[Specific help required]

WAR ROOM: #incident-[id]
GRAFANA: [Dashboard link]
LOGS: [Log link]
```

## Escalation Paths by Issue Type

### Database Issues

1. On-Call Engineer → Diagnose using runbook
2. Database Administrator (Tier 2) → If >30 min or complex
3. Engineering Manager (Tier 3) → If data loss suspected
4. VP Engineering (Tier 4) → If catastrophic data loss

**Vendor Escalation**: Engage vendor support immediately for Critical severity

### Security Incidents

1. On-Call Engineer → Acknowledge and contain
2. Security Engineer (Tier 2) → Immediately (parallel to step 1)
3. Engineering Manager + Legal (Tier 3) → Within 15 min
4. CTO + CEO (Tier 4) → If data breach confirmed

**Special**: Security incidents follow separate security incident response plan

### API/Application Issues

1. On-Call Engineer → Restart, quick fixes
2. Senior Backend Engineer (Tier 2) → If >30 min
3. Engineering Manager (Tier 3) → If >4 hours or requires rollback
4. VP Engineering (Tier 4) → If >8 hours

### Infrastructure Issues

1. On-Call Engineer → Basic troubleshooting
2. DevOps Lead (Tier 2) → If infrastructure-specific
3. Engineering Manager (Tier 3) → If vendor engagement needed
4. VP Engineering (Tier 4) → If major cloud outage

### Discovery/Connector Issues

1. On-Call Engineer → Check credentials, restart jobs
2. Senior Backend Engineer (Tier 2) → If connector code issue
3. Engineering Manager (Tier 3) → If multiple connectors affected
4. VP Engineering (Tier 4) → If compliance/audit impact

## After-Hours Escalation

### Weekend/Holiday Escalation

- **Critical (P1)**: Follow normal escalation path - call until you reach someone
- **High (P2)**: Page on-call, escalate to Tier 2 if >1 hour
- **Medium (P3)**: Create ticket, address during business hours
- **Low (P4)**: Create ticket, address during business hours

### Escalation Methods by Time

| Time | Method | Expected Response |
|------|--------|-------------------|
| Business Hours (9am-6pm local) | Slack + Email | 15 minutes |
| Extended Hours (6pm-10pm local) | Slack + Phone Call | 30 minutes |
| Night (10pm-6am local) | PagerDuty + Phone Call | 15 minutes (Critical only) |
| Weekend | PagerDuty + Phone Call | 30 minutes (Critical/High only) |

## War Room Procedures

### When to Establish War Room

- All Critical (P1) incidents
- High (P2) incidents lasting >1 hour
- Any incident requiring coordination of >2 people

### War Room Setup

1. **Create Slack Channel**: `#incident-YYYY-MM-DD-NNN`
2. **Post Initial Status**: Use communication template
3. **Invite Participants**:
   - Incident Commander
   - Technical Responders
   - Manager (for P1/P2)
   - Customer Success (if customer impact)
4. **Set Channel Topic**: Incident ID, severity, brief description
5. **Pin Important Messages**: Dashboard links, runbook links

### War Room Roles

| Role | Responsibilities |
|------|------------------|
| **Incident Commander** | Lead response, coordinate team, make decisions, communicate |
| **Technical Lead** | Deep technical investigation, implement fixes |
| **Communications Lead** | Customer updates, status page, internal comms |
| **Scribe** | Document timeline, actions taken, decisions made |
| **Manager** | Resource allocation, escalation decisions, stakeholder management |

### War Room Etiquette

- ✅ Use thread replies for discussions
- ✅ Post important updates as main messages
- ✅ Use clear, concise language
- ✅ Include timestamps (UTC)
- ✅ Document all actions taken
- ❌ Don't use for troubleshooting - use separate tech channel if needed
- ❌ Don't direct message responders
- ❌ Don't speculate about root cause publicly

## Escalation Metrics

Track and review:

- Time to first response
- Time to escalation (by tier)
- Number of escalations (by tier)
- Escalation reasons
- False escalations
- After-hours escalations

**Goal**: 95% of incidents resolved at Tier 1, <5% reach Tier 3+

## Escalation Review

### When Escalation is NOT Needed

- Issue is well-documented in runbooks
- Root cause is clear and fix is known
- Impact is minimal despite severity classification
- Responder has necessary skills and access

### When to Escalate Immediately (Skip Tiers)

- Security breach confirmed → Tier 2 + Tier 3 immediately
- Data loss affecting customers → Tier 3 immediately
- Media/social media attention → Tier 3 immediately
- Legal/compliance implications → Tier 3 + Legal immediately
- Complete authentication failure → Tier 2 immediately

## Updates and Maintenance

**Review Frequency**: Quarterly
**Owner**: Engineering Manager
**Last Updated**: 2025-10-19
**Next Review**: 2026-01-19

**Change History**:
- 2025-10-19: Initial version
- [Date]: [Change description]

---

## Quick Reference Card

Print and keep this handy:

```
╔═══════════════════════════════════════════════════════════╗
║           HAPPYCMDB ESCALATION QUICK REFERENCE            ║
╠═══════════════════════════════════════════════════════════╣
║ PRIMARY ON-CALL:  [Name]     [Phone]                     ║
║ SECONDARY:        [Name]     [Phone]                     ║
║ MANAGER:          [Name]     [Phone]                     ║
║ PAGERDUTY:        https://company.pagerduty.com          ║
╠═══════════════════════════════════════════════════════════╣
║ ESCALATION TIMEOUTS                                       ║
║ • Critical: 30 min to Tier 2, 1 hour to Tier 3          ║
║ • High: 1 hour to Tier 2, 4 hours to Tier 3             ║
║ • Security: Immediate to Tier 2 + Tier 3                 ║
╠═══════════════════════════════════════════════════════════╣
║ WAR ROOM: #incident-YYYY-MM-DD-NNN                       ║
║ RUNBOOKS: /docs/operations/runbooks/                     ║
║ STATUS PAGE: https://status.happycmdb.com              ║
╚═══════════════════════════════════════════════════════════╝
```
