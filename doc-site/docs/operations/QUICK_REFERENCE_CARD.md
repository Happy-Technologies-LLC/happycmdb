# HappyCMDB Production Monitoring - Quick Reference Card

**Print this page and keep it handy during on-call shifts!**

---

## 🚨 Emergency Contacts

| Role | Name | Phone | Slack |
|------|------|-------|-------|
| **Primary On-Call** | [Name] | +1-XXX-XXX-XXXX | @name |
| **Secondary On-Call** | [Name] | +1-XXX-XXX-XXXX | @name |
| **Senior Engineer** | [Name] | +1-XXX-XXX-XXXX | @name |
| **Manager** | [Name] | +1-XXX-XXX-XXXX | @name |

**PagerDuty**: https://company.pagerduty.com

---

## 🔗 Essential Links

| System | URL |
|--------|-----|
| **Grafana Dashboards** | http://localhost:3001 |
| **Prometheus Alerts** | http://localhost:9090/alerts |
| **API Health Check** | http://localhost:3000/health |
| **Status Page Admin** | https://status.happycmdb.com |
| **Runbooks** | /docs/operations/runbooks/ |

---

## ⏱️ Response Time SLAs

| Severity | Response Time | Escalate After |
|----------|---------------|----------------|
| **Critical (P1)** | 15 minutes | 30 minutes |
| **High (P2)** | 30 minutes | 1 hour |
| **Medium (P3)** | 2 hours | 4 hours |
| **Low (P4)** | 1 business day | N/A |

---

## 📊 Key Metrics (Healthy Values)

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| **API p95 Response Time** | <500ms | >1s | >3s |
| **API Error Rate** | <1% | >5% | >20% |
| **CPU Usage** | <70% | >80% | >95% |
| **Memory Usage** | <75% | >85% | >95% |
| **Disk Usage** | <80% | >80% | >90% |
| **Discovery Success Rate** | >95% | <90% | <80% |
| **System Uptime** | 99.9%+ | | |

---

## 🎯 Top 10 Common Alerts

| Alert | Severity | Runbook | Quick Action |
|-------|----------|---------|--------------|
| APIServerDown | Critical | api-server-down.md | `docker restart cmdb-api-server` |
| Neo4jDown | Critical | database-connection-issues.md | `docker restart cmdb-neo4j` |
| HighMemoryUsage | Warning | high-memory-usage.md | Check `docker stats`, restart if >90% |
| DiscoveryJobsFailing | Warning | discovery-jobs-failing.md | Check logs, verify credentials |
| RateLimitViolations | Warning | rate-limiting-issues.md | Check top clients, adjust limits |
| PostgreSQLDown | Critical | database-connection-issues.md | `docker restart cmdb-postgres` |
| APIResponseTimeSlow | Warning | performance-degradation.md | Check database, restart API if needed |
| DatabaseBackupFailed | Critical | backup-failure.md | Run manual backup immediately |
| SSLCertificateExpiring | Warning | ssl-certificate-renewal.md | Renew certificate ASAP |
| HighCPUUsage | Warning | performance-degradation.md | Check `top`, identify process |

---

## 🛠️ Quick Commands

```bash
# Check service health
curl http://localhost:3000/health

# View all containers
docker ps

# Check logs
docker logs cmdb-api-server --tail=100 --follow

# Check resource usage
docker stats --no-stream

# Restart API server
docker restart cmdb-api-server

# Database health checks
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1;"
docker exec cmdb-postgres pg_isready -U cmdb_user

# Check active alerts
curl -s http://localhost:9090/api/v1/alerts | jq '.data.alerts[] | select(.state=="firing")'
```

---

## 📱 Incident Response Checklist

### When Alert Fires

- [ ] **1. Acknowledge** alert in PagerDuty (within 15 min)
- [ ] **2. Assess** severity and user impact
- [ ] **3. Find** runbook (alert has link)
- [ ] **4. Diagnose** using runbook steps
- [ ] **5. Create** #incident-YYYY-MM-DD-NNN Slack channel
- [ ] **6. Communicate** initial status update
- [ ] **7. Resolve** following runbook procedures
- [ ] **8. Verify** service restored
- [ ] **9. Document** incident report
- [ ] **10. Update** Slack channel - incident resolved

### Escalation Triggers

Escalate to **Tier 2** (Senior Engineer) if:
- Not resolved in 30 min (Critical) or 1 hour (High)
- Root cause unclear
- Need code changes or deployment
- Multiple systems affected

Escalate to **Tier 3** (Manager) if:
- Outage >4 hours
- Data loss suspected
- Major customer escalation
- Security incident

---

## 💬 Quick Communication Templates

### Slack - Initial Alert
```
@here 🚨 INCIDENT - INC-YYYY-MM-DD-NNN
Severity: [Critical/High]
Impact: [Description]
Status: Investigating
IC: @yourname
War Room: #incident-[id]
Update in 15 min
```

### Slack - Update
```
📊 Update - INC-[ID]
Status: [Investigating/Fixing]
Action: [What we're doing]
Next update: [Time]
```

### Slack - Resolved
```
✅ RESOLVED - INC-[ID]
Duration: [HH:MM]
Fix: [What was done]
All services normal
```

---

## 🎓 Runbook Quick Reference

| Incident Type | Runbook File | Avg Resolution |
|---------------|--------------|----------------|
| API down | api-server-down.md | 5-15 min |
| DB connection | database-connection-issues.md | 5-30 min |
| High memory | high-memory-usage.md | 15-30 min |
| Discovery failing | discovery-jobs-failing.md | 30-60 min |
| Rate limiting | rate-limiting-issues.md | 15-30 min |
| SSL cert | ssl-certificate-renewal.md | 1-4 hours |
| Backup failure | backup-failure.md | 1-2 hours |
| Performance | performance-degradation.md | 30-60 min |

**Runbook Location**: `/docs/operations/runbooks/`

---

## ✅ Do's and ❌ Don'ts

### ✅ DO
- Acknowledge alerts promptly
- Follow runbooks
- Document everything
- Communicate regularly (every 15-30 min)
- Ask for help / escalate when needed
- Update status page for user-facing issues

### ❌ DON'T
- Ignore alerts (even if suspected false alarm)
- Make risky changes without approval
- Skip documentation
- Go silent during incidents
- Delete data without confirmation
- Deploy code unless critical and approved

---

## 🔍 Diagnosis Quick Steps

### Service Down
1. `docker ps` - Is container running?
2. `docker logs <container> --tail=100` - Check logs
3. `curl http://localhost:3000/health` - Test endpoint
4. Try `docker restart <container>`
5. Escalate if restart doesn't work

### Performance Issues
1. Check Grafana overview dashboard
2. `docker stats` - Check CPU/memory
3. Check database performance panels
4. Look for slow queries in logs
5. Consider restart if resource exhaustion

### Discovery Failures
1. Check discovery engine logs
2. Check which connectors failing (database or metrics)
3. Common: credentials expired, rate limiting
4. Retry failed jobs
5. Update credentials or reduce frequency

---

## 📞 War Room Procedures

### Creating War Room
1. Create Slack channel: `#incident-YYYY-MM-DD-NNN`
2. Post initial status
3. Invite: IC, responders, manager (P1/P2)
4. Set topic: Incident ID, severity, description
5. Pin dashboard/runbook links

### War Room Roles
- **Incident Commander** (you): Lead, coordinate, decide
- **Technical Lead**: Investigate, implement fixes
- **Communications**: Customer/status updates
- **Manager**: Resources, escalation

---

## 🎯 Remember

**You don't need to know everything!**

- Use runbooks (they're tested)
- Escalate when stuck (not a failure!)
- Document as you go
- Communicate regularly
- Ask for help

**Goal**: Keep services running, not be a hero.

---

## 📋 Handoff Checklist

When taking over on-call:
- [ ] Review ongoing incidents
- [ ] Check recent alerts (last 24h)
- [ ] Note any known issues
- [ ] Verify access to all tools
- [ ] Test PagerDuty notifications
- [ ] Review recent post-mortems

When handing off:
- [ ] Document ongoing issues
- [ ] Share lessons learned
- [ ] Note follow-up items
- [ ] Answer questions

---

**Good luck on your shift! You've got this! 🚀**

---

*Print this page and keep it next to your workspace for quick reference during incidents.*

*Full documentation: /docs/operations/*
