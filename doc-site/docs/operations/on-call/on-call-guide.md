# On-Call Engineer Guide

## Welcome to On-Call

This guide will help you prepare for and succeed during your on-call rotation for HappyCMDB production systems.

## On-Call Schedule

**Rotation Length**: 1 week (Monday 9am to Monday 9am)
**Rotation Type**: 24/7 coverage with primary and secondary rotation

**Schedule**: https://company.pagerduty.com/schedules/oncall

### Current Rotation

| Week | Primary On-Call | Secondary On-Call |
|------|----------------|-------------------|
| This Week | [Engineer Name] | [Engineer Name] |
| Next Week | [Engineer Name] | [Engineer Name] |
| Week After | [Engineer Name] | [Engineer Name] |

## Responsibilities

### Primary On-Call Engineer

**Your Role**:
- Monitor alerts and respond to incidents
- Acknowledge all alerts within 15 minutes
- Investigate and resolve issues using runbooks
- Escalate when necessary
- Document all actions taken
- Update stakeholders regularly

**Response Time SLAs**:
- Critical (P1): 15 minutes
- High (P2): 30 minutes
- Medium (P3): 2 hours
- Low (P4): Next business day

**Availability**:
- Must be able to respond within 15 minutes
- Must have reliable internet access
- Must have laptop/access to production systems
- Must be available for duration of shift

### Secondary On-Call Engineer

**Your Role**:
- Backup for primary on-call
- Respond if primary doesn't acknowledge within 30 minutes
- Assist with complex incidents requiring multiple responders
- Take over if primary needs relief during long incidents

**When to Step In**:
- Primary hasn't acknowledged alert in 30 minutes
- Primary requests assistance
- Incident requires multiple responders
- Primary is dealing with another incident

## Pre-Shift Checklist

### 1 Week Before Your Shift

- [ ] Confirm on-call schedule in PagerDuty
- [ ] Verify your contact information is up to date
- [ ] Block calendar for on-call week
- [ ] Review recent incidents and post-mortems
- [ ] Test PagerDuty notifications
- [ ] Ensure laptop is in good working order

### Day Before Your Shift

- [ ] Review monitoring dashboards
- [ ] Read recent incident reports
- [ ] Check for any ongoing issues or maintenance
- [ ] Review runbooks for common issues
- [ ] Test VPN access
- [ ] Test SSH access to production systems
- [ ] Verify you have all necessary credentials
- [ ] Charge laptop and phone
- [ ] Plan to be available (avoid travel, alcohol, etc.)

### Handoff Meeting (Start of Shift)

Meet with previous on-call engineer (15-30 minutes):

- [ ] Review any ongoing incidents
- [ ] Discuss recent alerts and trends
- [ ] Review any known issues or upcoming changes
- [ ] Note any quirks or tips
- [ ] Exchange contact information
- [ ] Confirm you're ready to take over

**Handoff Template**:
```
HAPPYCMDB ON-CALL HANDOFF
Week of: [Date]
From: [Previous On-Call]
To: [New On-Call]

ONGOING ISSUES
--------------
- [Issue 1 - status]
- [Issue 2 - status]

RECENT INCIDENTS (Last 7 Days)
------------------------------
- INC-[ID]: [Brief description - resolution]
- INC-[ID]: [Brief description - resolution]

ALERT TRENDS
------------
- [Alert type]: [Frequency/Pattern]
- [Alert type]: [Frequency/Pattern]

SCHEDULED MAINTENANCE
---------------------
- [Date/Time]: [Description]

KNOWN ISSUES
------------
- [Issue 1 - workaround]
- [Issue 2 - workaround]

TIPS & NOTES
------------
- [Tip 1]
- [Tip 2]

FOLLOW-UP NEEDED
----------------
- [Item 1]
- [Item 2]

Questions? Contact me at: [Contact info]
```

## Tools and Access

### Required Access

- [ ] PagerDuty account configured
- [ ] VPN access
- [ ] SSH access to production servers
- [ ] AWS Console access (read-only minimum)
- [ ] Azure Portal access (if applicable)
- [ ] GCP Console access (if applicable)
- [ ] Grafana dashboard access
- [ ] Prometheus access
- [ ] Slack workspace (#incidents, #engineering)
- [ ] Status page admin access
- [ ] Database clients (Neo4j, PostgreSQL)
- [ ] Documentation (runbooks, architecture docs)

### Essential Bookmarks

**Monitoring & Alerting**:
- Grafana: http://localhost:3001
- Prometheus: http://localhost:9090
- PagerDuty: https://company.pagerduty.com

**Documentation**:
- Runbooks: /docs/operations/runbooks/
- Architecture Docs: http://localhost:8080
- Escalation Matrix: /docs/operations/incident-response/escalation-matrix.md

**Systems**:
- Status Page: https://status.happycmdb.com (admin)
- AWS Console: https://console.aws.amazon.com
- Production API: https://api.happycmdb.com/health

**Communication**:
- Slack: https://company.slack.com
- Support Portal: https://support.happycmdb.com

### Key Commands

```bash
# SSH to API server
ssh -i ~/.ssh/production.pem ubuntu@api-server-1.happycmdb.com

# Check service health
curl http://localhost:3000/health | jq

# View logs
docker logs cmdb-api-server --follow --tail=100

# Check Prometheus alerts
curl http://localhost:9090/api/v1/alerts | jq

# Database status
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1;"
docker exec cmdb-postgres pg_isready -U cmdb_user

# System resources
docker stats --no-stream
```

## Handling Alerts

### When an Alert Fires

1. **Acknowledge Immediately** (within 15 minutes)
   - In PagerDuty or monitoring system
   - This stops alert escalation

2. **Assess Severity**
   - Review alert details
   - Check impact on users
   - Classify: Critical/High/Medium/Low

3. **Check Current Status**
   - Is service actually down or degraded?
   - False alarm?
   - How many users affected?

4. **Find the Runbook**
   - Alert should link to runbook
   - Runbooks in `/docs/operations/runbooks/`
   - If no runbook, start with general troubleshooting

5. **Follow the Runbook**
   - Execute diagnosis steps
   - Try resolution steps
   - Document what you try

6. **Create Incident** (if real issue)
   - Create #incident-[id] Slack channel
   - Post initial status
   - Begin incident response

7. **Communicate**
   - Update Slack channel every 15-30 min
   - Update status page if user-facing
   - Escalate if needed

8. **Resolve and Document**
   - Verify resolution
   - Update monitoring
   - Complete incident report

### False Alarms

If alert is false positive:

1. Acknowledge and note it's false alarm
2. Document why it triggered
3. If recurring, create ticket to fix alert
4. Consider temporarily disabling noisy alerts

### Escalation Decision

Escalate to Tier 2 if:

- [ ] Issue not resolved within time limit (30 min Critical, 1 hour High)
- [ ] Root cause unclear
- [ ] Fix requires code changes or deployment
- [ ] Multiple systems affected
- [ ] You need assistance or expertise
- [ ] You're unsure how to proceed

**Don't hesitate to escalate!** It's better to escalate early than struggle alone.

## Common Scenarios

### Scenario 1: API Server Down (Critical)

**Alert**: `APIServerDown`
**Impact**: Complete service outage
**Runbook**: [api-server-down.md](/docs/operations/runbooks/api-server-down.md)

**Quick Actions**:
1. Acknowledge alert immediately
2. Verify API is actually down: `curl http://localhost:3000/health`
3. Check if container is running: `docker ps | grep cmdb-api-server`
4. Check logs: `docker logs cmdb-api-server --tail=100`
5. Try restart: `docker restart cmdb-api-server`
6. If restart doesn't work, escalate to Senior Engineer
7. Update status page
8. Communicate in #incidents

**Expected Time to Resolution**: 5-15 minutes

### Scenario 2: High Memory Usage (Warning)

**Alert**: `HighMemoryUsage`
**Impact**: Performance degradation, potential OOM
**Runbook**: [high-memory-usage.md](/docs/operations/runbooks/high-memory-usage.md)

**Quick Actions**:
1. Acknowledge alert
2. Check which container: `docker stats --no-stream`
3. Check if threshold is actually breached
4. Monitor for 10 minutes to see if it's growing
5. If critical, restart problematic container
6. If recurring, escalate to Senior Engineer
7. Create ticket for investigation

**Expected Time to Resolution**: 15-30 minutes

### Scenario 3: Discovery Jobs Failing (Warning)

**Alert**: `HighDiscoveryJobFailureRate`
**Impact**: CI data becoming stale
**Runbook**: [discovery-jobs-failing.md](/docs/operations/runbooks/discovery-jobs-failing.md)

**Quick Actions**:
1. Acknowledge alert
2. Check discovery engine logs: `docker logs cmdb-discovery-engine --tail=50`
3. Check which connectors failing: Query database or check metrics
4. Common causes: Expired credentials, rate limiting, network issues
5. If credential issue, update credentials
6. If rate limiting, reduce frequency temporarily
7. Retry failed jobs
8. Monitor for next hour

**Expected Time to Resolution**: 30-60 minutes

### Scenario 4: Database Connection Issues (Critical)

**Alert**: `Neo4jDown` or `PostgreSQLDown`
**Impact**: Complete service degradation
**Runbook**: [database-connection-issues.md](/docs/operations/runbooks/database-connection-issues.md)

**Quick Actions**:
1. Acknowledge alert immediately
2. Verify database is down: `docker ps | grep neo4j|postgres`
3. Check logs: `docker logs cmdb-neo4j --tail=100`
4. Try restart: `docker restart cmdb-neo4j`
5. If data corruption suspected, DO NOT RESTART - escalate immediately
6. Update status page
7. Escalate to Database Administrator if not resolved in 15 minutes

**Expected Time to Resolution**: 5-30 minutes

## Do's and Don'ts

### DO

✅ **Acknowledge alerts promptly** - Even if you're investigating, acknowledge to stop escalation
✅ **Use runbooks** - They're there for a reason, tested procedures
✅ **Document everything** - Commands run, changes made, observations
✅ **Communicate regularly** - Update every 15-30 minutes during active incident
✅ **Ask for help** - Escalate when needed, don't struggle alone
✅ **Take breaks** - For long incidents, get relief from secondary on-call
✅ **Update status page** - For user-facing issues
✅ **Follow up** - Complete incident reports, close loops

### DON'T

❌ **Don't ignore alerts** - Even if you think they're false alarms
❌ **Don't make risky changes** - Especially to production databases
❌ **Don't skip documentation** - Future you (or others) will need it
❌ **Don't go silent** - Keep communicating even if no progress
❌ **Don't blame** - Focus on fixing, not finding fault
❌ **Don't guess credentials** - Use proper credential management
❌ **Don't delete data** - Without multiple confirmations and backups
❌ **Don't deploy code** - Unless absolutely necessary and approved

## Communication Templates

### Initial Alert Acknowledgment (Slack)

```
:eyes: Alert acknowledged - investigating

Alert: [Alert name]
Time: [HH:MM UTC]
Status: Investigating

Will provide update in 15 minutes.
```

### Status Update

```
:information_source: Update - [INC-ID]

Status: [Investigating/Fixing/Monitoring]
Root Cause: [What we found]
Action: [What we're doing]

Next update: [Time]
```

### Resolution

```
:white_check_mark: Resolved - [INC-ID]

Issue: [Brief description]
Fix: [What was done]
Duration: [HH:MM]

Services back to normal. Monitoring for 30 min.
```

## Self-Care During On-Call

### Physical Health

- Get adequate sleep before your shift
- Stay hydrated
- Eat regular meals
- Take breaks during long incidents
- Exercise when possible
- Limit caffeine late at night

### Mental Health

- It's okay to feel stressed - incidents are stressful
- Ask for help when overwhelmed
- Take relief during long incidents (>4 hours)
- Debrief after major incidents
- Don't blame yourself for incidents
- Talk to manager if on-call is affecting wellbeing

### Work-Life Balance

- Plan activities knowing you might be interrupted
- Have backup plans for personal commitments
- Communicate with family/friends about on-call
- Use do-not-disturb for non-critical hours (if policy allows)
- Take comp time after intense on-call weeks

## After Your Shift

### Handoff Meeting (End of Shift)

Meet with next on-call engineer:

- [ ] Review any ongoing incidents
- [ ] Discuss alert trends during your shift
- [ ] Note any new issues or quirks discovered
- [ ] Share tips learned during your week
- [ ] Ensure all incidents documented
- [ ] Transfer any follow-up items

### Post-Shift Actions

- [ ] Complete any pending incident reports
- [ ] File tickets for issues discovered
- [ ] Update runbooks if you found gaps
- [ ] Provide feedback on alerts (too noisy? missed issues?)
- [ ] Rest and recover!

### Reflection

Take a few minutes to reflect:

- What went well?
- What was challenging?
- What could be improved?
- What did you learn?
- What runbooks need updating?

Share feedback with team lead.

## Tips from Experienced On-Call Engineers

### Before Your Shift

- **Review recent post-mortems** - Learn from past incidents
- **Know your runbooks** - Read them before you need them
- **Test your setup** - Don't wait for an alert to find out VPN is broken
- **Have backup plans** - Backup phone, backup internet, backup laptop charger

### During Incidents

- **Stay calm** - Panic doesn't help
- **Use runbooks** - Even if you think you know the fix
- **Document as you go** - Don't rely on memory later
- **Ask questions** - Better to clarify than assume
- **Take breaks** - 5 minute breaks during long incidents help

### Communication

- **Overcommunicate** - More updates are better than fewer
- **Be honest** - If you don't know, say so
- **Set expectations** - Tell people when next update will be
- **Use threads** - Keep Slack organized

### Learning

- **Every incident teaches** - Make notes of what you learned
- **Update runbooks** - If you struggled, others will too
- **Share knowledge** - Tell the team about issues you encountered
- **Ask for feedback** - How did you handle that incident?

## Resources

### Documentation

- **Runbooks**: `/docs/operations/runbooks/`
- **Architecture Docs**: `http://localhost:8080`
- **Escalation Matrix**: `/docs/operations/incident-response/escalation-matrix.md`
- **Communication Templates**: `/docs/operations/incident-response/communication-templates.md`

### Monitoring

- **Grafana**: http://localhost:3001 - Dashboards and metrics
- **Prometheus**: http://localhost:9090 - Metrics and alerts
- **Logs**: Docker logs via SSH or logging dashboard

### Support

- **Primary Escalation**: [Senior Engineer Name] - [Phone]
- **Secondary Escalation**: [Manager Name] - [Phone]
- **Database Issues**: [DBA Name] - [Phone]
- **Security Issues**: [Security Engineer Name] - [Phone]

### Tools

- **PagerDuty**: https://company.pagerduty.com
- **Slack**: #incidents, #engineering
- **Status Page**: https://status.happycmdb.com

## FAQ

**Q: What if I get an alert I don't understand?**
A: Acknowledge it, investigate what you can, and escalate if you can't determine the issue within 15-30 minutes.

**Q: Can I make changes to production during on-call?**
A: Only changes documented in runbooks or approved by senior engineer. No experimental changes.

**Q: What if I'm away from computer when alert fires?**
A: You must be able to respond within 15 minutes. If you can't, arrange coverage with secondary on-call.

**Q: How do I know if I should escalate?**
A: See escalation criteria in runbooks. When in doubt, escalate. It's better to escalate unnecessarily than to struggle alone.

**Q: What if multiple alerts fire at once?**
A: Triage by severity. Handle Critical first. Request assistance from secondary on-call if needed.

**Q: Can I silence noisy alerts?**
A: Only if they're confirmed false positives and you create a ticket to fix the alert. Don't silence real issues.

**Q: What if I make a mistake during incident response?**
A: It happens. Document what happened, fix if possible, escalate if needed, and learn from it. No blame culture.

**Q: How do I handle non-urgent requests during on-call?**
A: Direct them to create support tickets. On-call is for urgent production issues only.

## On-Call Improvements

If you have ideas to improve on-call experience:

- Better runbooks
- Better alerts (less noise, better signal)
- Better tooling
- Better documentation
- Process improvements

Please share with your manager or in team retrospectives.

---

**Remember**: You're not expected to know everything. Use runbooks, ask for help, escalate when needed. The goal is to keep services running, not to be a hero.

**Good luck on your on-call shift!** 🚀
