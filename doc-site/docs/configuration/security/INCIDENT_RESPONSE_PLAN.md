# Security Incident Response Plan

**Version**: 1.0
**Last Updated**: 2025-10-19
**Owner**: Security Team

## Purpose

This document defines HappyCMDB's security incident response procedures to ensure rapid, coordinated, and effective response to security incidents.

---

## 1. Incident Classification

### Severity Levels

| Severity | Definition | Examples | Response Time SLA |
|----------|------------|----------|-------------------|
| **CRITICAL** | Active data breach, system compromise, or service outage affecting production | - Confirmed data breach<br>- Ransomware attack<br>- Production system compromised<br>- Complete service outage | < 15 minutes |
| **HIGH** | Exploitation attempt, unauthorized access, or significant security vulnerability | - Active exploitation attempt<br>- Unauthorized admin access<br>- Critical vulnerability discovered<br>- DDoS attack in progress | < 1 hour |
| **MEDIUM** | Security misconfiguration, policy violation, or potential vulnerability | - Security misconfiguration discovered<br>- Failed access attempts from suspicious source<br>- Medium severity vulnerability<br>- Data exposure without confirmed access | < 4 hours |
| **LOW** | Non-exploitable vulnerability, informational finding | - Low severity vulnerability<br>- Security audit finding<br>- Minor policy violation | < 24 hours |

---

## 2. Incident Response Team

### Core Team

| Role | Responsibilities | Primary Contact | Backup Contact |
|------|------------------|-----------------|----------------|
| **Incident Commander** | Overall incident coordination, decision-making, stakeholder communication | Security Lead | CTO |
| **Technical Lead** | Technical investigation, containment, remediation | DevOps Lead | Senior Backend Engineer |
| **Communications Lead** | Internal/external communications, customer notifications | Product Manager | CEO |
| **Legal Counsel** | Legal compliance, regulatory notifications, law enforcement liaison | General Counsel | Outside Legal Firm |

### On-Call Rotation

- **Primary On-Call**: Rotates weekly (Monday 00:00 - Sunday 23:59)
- **Backup On-Call**: Always available as secondary responder
- **PagerDuty**: `happycmdb-security` schedule
- **Slack Channel**: `#security-incidents` (private)

### Escalation Path

1. Security Engineer (on-call) → 2. Security Lead → 3. CTO → 4. CEO

---

## 3. Incident Response Phases

### Phase 1: Detection and Triage (0-15 minutes)

**Objective**: Detect incident, assess severity, activate response team

**Actions**:

1. **Alert Receipt**
   - Security monitoring system generates alert
   - On-call engineer receives PagerDuty notification
   - Engineer acknowledges alert within 5 minutes

2. **Initial Assessment**
   - Review alert details and supporting data
   - Determine if this is a security incident or false positive
   - If false positive: Document reason, close alert
   - If incident: Proceed to classification

3. **Incident Classification**
   - Assign severity level (CRITICAL, HIGH, MEDIUM, LOW)
   - Create incident ticket in tracking system
   - Assign unique incident ID: `INC-YYYYMMDD-NNNN`

4. **Team Activation**
   - **CRITICAL/HIGH**: Page entire incident response team immediately
   - **MEDIUM**: Notify Security Lead and Technical Lead
   - **LOW**: Assign to on-call engineer, notify Security Lead

5. **Communication**
   - Post initial notification in `#security-incidents` Slack channel
   - Include: Incident ID, severity, brief description, assigned responders
   - Set up incident bridge call for CRITICAL/HIGH incidents

**Deliverables**:
- Incident ticket created
- Severity assigned
- Team activated
- Communication channel established

---

### Phase 2: Containment (15 minutes - 4 hours)

**Objective**: Stop the incident from spreading, limit damage

**Actions**:

1. **Immediate Containment** (CRITICAL incidents)
   - Isolate affected systems from network
   - Disable compromised user accounts
   - Block malicious IP addresses at firewall
   - Take database snapshots before changes
   - Preserve evidence (logs, memory dumps, disk images)

2. **Short-Term Containment**
   - Apply temporary patches or workarounds
   - Enable additional monitoring and logging
   - Implement rate limiting or WAF rules
   - Restrict access to affected systems (whitelist only)

3. **Evidence Collection**
   - Capture system logs (auth, access, error, audit)
   - Document timeline of events
   - Screenshot suspicious activity
   - Collect network traffic captures (PCAP)
   - Hash files for integrity verification

4. **Stakeholder Notification** (CRITICAL/HIGH only)
   - Notify executive team (CTO, CEO)
   - Prepare customer communication draft (do not send yet)
   - Contact legal counsel for regulatory requirements
   - Brief customer success team (for potential inquiries)

**Containment Strategies by Incident Type**:

| Incident Type | Containment Actions |
|---------------|---------------------|
| **Data Breach** | - Revoke exposed credentials<br>- Block unauthorized access<br>- Isolate affected database |
| **Ransomware** | - Isolate infected systems<br>- Disable file shares<br>- Shut down affected services |
| **DDoS Attack** | - Enable rate limiting<br>- Contact ISP/CDN for mitigation<br>- Implement WAF rules |
| **Account Compromise** | - Force password reset<br>- Revoke API tokens<br>- Enable MFA enforcement |
| **Vulnerability Exploitation** | - Apply emergency patch<br>- Disable vulnerable feature<br>- Add WAF rule to block exploit |

**Deliverables**:
- Incident contained (spread stopped)
- Evidence preserved
- Stakeholders notified
- Containment actions documented

---

### Phase 3: Eradication (4 hours - 48 hours)

**Objective**: Eliminate root cause, remove attacker access

**Actions**:

1. **Root Cause Analysis**
   - Identify initial attack vector
   - Map full attack timeline and lateral movement
   - Determine scope of compromise (systems, data, accounts)
   - Identify vulnerabilities exploited

2. **Threat Removal**
   - Remove malware, backdoors, persistence mechanisms
   - Delete unauthorized user accounts or API keys
   - Patch vulnerabilities that were exploited
   - Update firewall rules and access controls

3. **System Hardening**
   - Apply all pending security patches
   - Review and tighten security configurations
   - Implement additional monitoring for similar attacks
   - Update detection rules to catch this attack pattern

4. **Verification**
   - Scan systems for residual threats (malware, backdoors)
   - Verify all attacker access has been removed
   - Test systems for normal operation
   - Confirm monitoring is capturing relevant events

**Deliverables**:
- Root cause identified
- All threats removed
- Systems hardened
- Verification complete

---

### Phase 4: Recovery (48 hours - 1 week)

**Objective**: Restore systems to normal operation, validate security

**Actions**:

1. **System Restoration**
   - Restore systems from clean backups (if needed)
   - Re-enable services in controlled manner
   - Restore user access with new credentials
   - Migrate to patched/hardened systems

2. **Security Validation**
   - Conduct vulnerability scan
   - Penetration test for exploited vulnerability
   - Review all access logs for 30 days prior
   - Verify no unauthorized access remains

3. **Monitoring Enhancement**
   - Deploy additional monitoring for attack indicators
   - Set up alerts for similar attack patterns
   - Increase log retention for affected systems
   - Implement honeypots or canaries (if applicable)

4. **Communication**
   - Send all-clear notification to stakeholders
   - Notify customers (if applicable)
   - File regulatory notifications (if required)
   - Update status page

**Customer Notification Requirements**:

Notify customers within 72 hours if:
- Personal data (PII) was accessed or stolen
- Service availability was impacted >4 hours
- Customer credentials may be compromised
- Regulatory requirements mandate disclosure

**Deliverables**:
- Systems fully restored and operational
- Security validated
- Monitoring enhanced
- Customers notified (if required)

---

### Phase 5: Post-Incident Analysis (1-2 weeks after resolution)

**Objective**: Learn from incident, improve defenses, prevent recurrence

**Actions**:

1. **Post-Incident Review Meeting** (within 48 hours of resolution)
   - Blameless postmortem discussion
   - Review timeline of events
   - Identify what went well and what didn't
   - Document lessons learned

2. **Root Cause Documentation**
   - Write detailed incident report
   - Include timeline, impact assessment, root cause
   - Document containment and remediation steps
   - List all affected systems and data

3. **Action Items**
   - Identify security improvements needed
   - Assign owners and due dates for action items
   - Update runbooks and incident response procedures
   - Schedule follow-up security training

4. **Prevention Measures**
   - Implement technical controls to prevent recurrence
   - Update security policies or procedures
   - Enhance detection capabilities
   - Conduct security awareness training

5. **Reporting**
   - File incident report with senior leadership
   - Update board of directors (for CRITICAL incidents)
   - Report to regulators (if required by law)
   - Archive incident documentation for 7 years

**Deliverables**:
- Post-incident report published
- Action items assigned and tracked
- Prevention measures implemented
- Stakeholder reporting complete

---

## 4. Communication Templates

### Internal Notification (Slack)

```
🚨 SECURITY INCIDENT - [SEVERITY]

Incident ID: INC-20251019-0001
Severity: CRITICAL / HIGH / MEDIUM / LOW
Detected: 2025-10-19 14:30 UTC
Status: Containment in progress

Summary: [Brief description of incident]

Affected Systems: [List of systems]

Incident Commander: @security-lead
Technical Lead: @devops-lead

Bridge Call: [Zoom link]
Incident Channel: #incident-20251019-0001
```

### Customer Notification (Email)

**Subject**: Important Security Update - [Date]

**Body**:

```
Dear [Customer Name],

We are writing to inform you of a security incident that may have affected your account.

What Happened:
On [DATE], we detected [BRIEF DESCRIPTION]. We immediately activated our incident response procedures and have taken the following actions: [CONTAINMENT ACTIONS].

What Information Was Affected:
[SPECIFIC DATA TYPES - be precise and transparent]

What We're Doing:
- [ACTION 1]
- [ACTION 2]
- [ACTION 3]

What You Should Do:
- [CUSTOMER ACTION 1]
- [CUSTOMER ACTION 2]

We take the security of your data very seriously. This incident has been fully contained, and we have implemented additional safeguards to prevent similar incidents.

If you have any questions or concerns, please contact our security team at security@happycmdb.io.

Sincerely,
HappyCMDB Security Team
```

### Regulatory Notification

**For GDPR (EU customers) - 72-hour deadline**:

- Notify data protection authority within 72 hours of awareness
- Include nature of breach, affected individuals, consequences, measures taken
- Contact: [EU Data Protection Authority]

**For CCPA (California customers) - Without unreasonable delay**:

- Notify affected California residents
- Include specific data elements compromised
- Contact: California Attorney General (if >500 residents affected)

---

## 5. Incident Types and Specific Procedures

### Data Breach

**Indicators**:
- Unusual database queries or exports
- Large data downloads by user
- Access from unauthorized IP addresses
- Exposed API keys or credentials in public repositories

**Response**:
1. Identify scope: What data? How many records? When accessed?
2. Revoke access: Disable compromised credentials, close backdoors
3. Forensics: Review access logs for full timeline
4. Notification: Determine if customer/regulatory notification required
5. Remediation: Encrypt data at rest, implement DLP, review access controls

### Ransomware Attack

**Indicators**:
- Files encrypted with unusual extensions (.locked, .encrypted)
- Ransom note left on system
- Suspicious process encrypting files
- Lateral movement detected on network

**Response**:
1. **DO NOT PAY RANSOM** (company policy)
2. Isolate infected systems immediately
3. Shut down network file shares
4. Identify ransomware variant (for decryption tools)
5. Restore from backups (ensure backups not compromised)
6. Report to law enforcement (FBI IC3)

### DDoS Attack

**Indicators**:
- Sudden spike in traffic from multiple IPs
- Service degradation or timeout errors
- Unusual geographic distribution of requests
- High rate of connections to specific endpoint

**Response**:
1. Enable rate limiting at load balancer
2. Contact ISP or CDN for upstream mitigation
3. Implement GeoIP blocking (if attack from specific country)
4. Add WAF rules to filter malicious requests
5. Scale infrastructure (if volumetric attack)

### Insider Threat

**Indicators**:
- Unusual access patterns (time, volume, resources)
- Access to data outside normal job function
- Downloading large amounts of data
- Circumventing security controls

**Response**:
1. **Discretion critical** - do not alert suspect
2. Preserve evidence (logs, communications, files)
3. Coordinate with HR and Legal
4. Monitor suspect's activities closely
5. Disable access at predetermined time
6. Conduct exit interview (if termination)

### Account Compromise

**Indicators**:
- Login from unusual location or device
- Multiple failed login attempts followed by success
- Unusual API usage patterns
- Password reset requests user didn't initiate

**Response**:
1. Force logout of all sessions
2. Lock account temporarily
3. Contact user via secondary channel (phone, secondary email)
4. Force password reset with MFA verification
5. Review account activity for unauthorized actions
6. Revoke and rotate API keys

---

## 6. Tooling and Resources

### Incident Tracking

- **Primary**: Jira Security Project (`SEC`)
- **Incident Template**: `INC-YYYYMMDD-NNNN`
- **Fields**: Severity, Type, Affected Systems, Timeline, Actions Taken

### Communication Channels

- **Slack**: `#security-incidents` (private, incident response team only)
- **PagerDuty**: `happycmdb-security` escalation policy
- **Zoom**: Security incident bridge (always-on URL)
- **Email**: security@happycmdb.io (monitored 24/7)

### Forensics Tools

- **Log Analysis**: ELK Stack (Elasticsearch, Logstash, Kibana)
- **Network Traffic**: Wireshark, tcpdump
- **File Integrity**: AIDE, Tripwire
- **Malware Analysis**: VirusTotal, Hybrid Analysis
- **Memory Forensics**: Volatility Framework

### External Resources

- **Law Enforcement**: FBI IC3 (https://www.ic3.gov/), local FBI field office
- **CERT**: US-CERT (https://www.cisa.gov/uscert/)
- **Threat Intelligence**: MISP, STIX/TAXII feeds
- **Legal Counsel**: [Law Firm Name], emergency hotline: [PHONE]

---

## 7. Drills and Training

### Tabletop Exercises (Semi-Annual)

Scenario-based discussions to practice incident response:

- **Scenario 1**: Database breach with customer PII exposed
- **Scenario 2**: Ransomware attack on production systems
- **Scenario 3**: DDoS attack during peak usage
- **Scenario 4**: Insider threat with data exfiltration

### Full Incident Simulation (Annual)

Live simulation with:
- Simulated attack launched against staging environment
- Real-time incident response using production procedures
- Post-exercise debrief and improvement plan

### Security Awareness Training (Quarterly)

All employees complete training on:
- Phishing recognition
- Password security
- Data handling best practices
- Incident reporting procedures

---

## 8. Metrics and KPIs

Track and report monthly:

| Metric | Target | Current |
|--------|--------|---------|
| Mean Time to Detect (MTTD) | < 15 minutes | TBD |
| Mean Time to Respond (MTTR) | < 1 hour | TBD |
| Mean Time to Contain (MTTC) | < 4 hours | TBD |
| Mean Time to Recover (MTTRec) | < 24 hours | TBD |
| False Positive Rate | < 10% | TBD |
| Incidents Detected by Automated Tools | > 80% | TBD |
| Employee Phishing Test Pass Rate | > 90% | TBD |

---

## 9. Post-Incident Report Template

```markdown
# Incident Report: [INCIDENT ID]

**Incident ID**: INC-YYYYMMDD-NNNN
**Severity**: CRITICAL / HIGH / MEDIUM / LOW
**Incident Commander**: [Name]
**Date of Incident**: YYYY-MM-DD
**Date of Report**: YYYY-MM-DD

## Executive Summary

[2-3 sentence summary of what happened]

## Timeline

| Time (UTC) | Event |
|------------|-------|
| YYYY-MM-DD HH:MM | Initial detection |
| YYYY-MM-DD HH:MM | Team activated |
| YYYY-MM-DD HH:MM | Containment implemented |
| YYYY-MM-DD HH:MM | Root cause identified |
| YYYY-MM-DD HH:MM | Systems restored |

## Impact Assessment

**Affected Systems**: [List]
**Data Compromised**: [Yes/No - Details]
**Users Affected**: [Count]
**Downtime**: [Duration]
**Financial Impact**: [$Amount]

## Root Cause

[Detailed explanation of how incident occurred]

## Response Actions

**Containment**: [What was done to stop the spread]
**Eradication**: [What was done to remove the threat]
**Recovery**: [How systems were restored]

## Lessons Learned

**What Went Well**:
- [Item 1]
- [Item 2]

**What Could Be Improved**:
- [Item 1]
- [Item 2]

## Action Items

| Action Item | Owner | Due Date | Status |
|-------------|-------|----------|--------|
| [Action 1] | [Name] | YYYY-MM-DD | Open |
| [Action 2] | [Name] | YYYY-MM-DD | Open |

## Recommendations

[Long-term improvements to prevent recurrence]
```

---

## 10. Legal and Compliance

### Regulatory Notification Deadlines

| Regulation | Jurisdiction | Notification Deadline | Authority |
|------------|--------------|----------------------|-----------|
| GDPR | EU | 72 hours | Data Protection Authority |
| CCPA | California, USA | Without unreasonable delay | Attorney General (if >500) |
| HIPAA | USA (healthcare) | 60 days | HHS Office for Civil Rights |
| PCI DSS | Worldwide (payment cards) | Immediately | Card brands, acquirer |

### Data Breach Notification Laws by State (USA)

All 50 US states have data breach notification laws. Consult legal counsel for specific requirements.

**General Requirements**:
- Notify affected residents "without unreasonable delay"
- Provide clear description of breach and compromised data
- Offer credit monitoring (if SSN compromised)
- Notify Attorney General (if threshold met, typically 500-1000)

---

## 11. Document Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-10-19 | Security Team | Initial version |

---

## Appendix A: Incident Response Checklist

**Phase 1: Detection and Triage**
- [ ] Alert acknowledged within 5 minutes
- [ ] Incident classified by severity
- [ ] Incident ticket created
- [ ] Response team activated
- [ ] Communication channel established

**Phase 2: Containment**
- [ ] Affected systems isolated
- [ ] Compromised accounts disabled
- [ ] Evidence preserved
- [ ] Temporary patches applied
- [ ] Stakeholders notified

**Phase 3: Eradication**
- [ ] Root cause identified
- [ ] Threats removed
- [ ] Systems patched
- [ ] Security configurations hardened
- [ ] Verification scans complete

**Phase 4: Recovery**
- [ ] Systems restored
- [ ] Security validated
- [ ] Monitoring enhanced
- [ ] Customers notified (if required)

**Phase 5: Post-Incident**
- [ ] Post-mortem meeting held
- [ ] Incident report published
- [ ] Action items assigned
- [ ] Prevention measures implemented
- [ ] Regulatory reporting complete

---

**For Emergencies**: Call Security Hotline at [PHONE NUMBER] or email security@happycmdb.io
