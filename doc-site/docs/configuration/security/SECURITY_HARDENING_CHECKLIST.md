# HappyCMDB Security Hardening Checklist

**Version**: 2.0
**Last Updated**: 2025-10-19
**Owner**: Security Team

## Overview

This checklist provides a comprehensive security hardening guide for HappyCMDB production deployments. All items should be verified before deploying to production and regularly audited thereafter.

---

## 1. Docker Security

### 1.1 Container Hardening

- [ ] **Run containers as non-root users**
  - All Dockerfiles use `USER` directive with non-root UID
  - No containers run with `--privileged` flag
  - Verify: `docker inspect <container> | grep -i user`

- [ ] **Use read-only root filesystems**
  - Containers use `--read-only` flag where possible
  - Writable volumes explicitly mounted for necessary paths
  - Verify: `docker inspect <container> | grep ReadonlyRootfs`

- [ ] **Drop unnecessary Linux capabilities**
  - Default capabilities dropped with `--cap-drop=ALL`
  - Only required capabilities added back with `--cap-add`
  - No `CAP_SYS_ADMIN` or `CAP_NET_ADMIN` unless absolutely necessary

- [ ] **Use minimal base images**
  - Alpine Linux or distroless images preferred
  - No full OS distributions (Ubuntu/Debian) unless required
  - Multi-stage builds to minimize final image size

- [ ] **Scan images for vulnerabilities**
  - Automated scanning in CI/CD pipeline (Trivy, Grype, Snyk)
  - No HIGH or CRITICAL vulnerabilities in production images
  - Regular rescanning of existing images (weekly)

- [ ] **Sign and verify container images**
  - Docker Content Trust (DCT) enabled in production
  - Images signed with private keys
  - Only signed images allowed to run

### 1.2 Docker Daemon Security

- [ ] **Enable Docker daemon TLS authentication**
  - TLS certificates configured for daemon
  - Only authenticated clients can connect
  - Certificate rotation schedule established

- [ ] **Restrict Docker socket access**
  - Docker socket not mounted in containers
  - If required, use read-only mount
  - Consider Docker socket proxy (e.g., tecnativa/docker-socket-proxy)

- [ ] **Enable Docker daemon audit logging**
  - Audit logs capture all Docker API calls
  - Logs sent to centralized logging system
  - Retention policy: minimum 90 days

- [ ] **Resource limits enforced**
  - Memory limits (`--memory`, `--memory-swap`)
  - CPU limits (`--cpus`, `--cpu-shares`)
  - PID limits (`--pids-limit`)
  - Prevent resource exhaustion attacks

### 1.3 Docker Compose Security

- [ ] **Use specific image tags (not `latest`)**
  - All images pinned to SHA256 digests or semantic versions
  - No `latest` or `stable` tags in production

- [ ] **Secrets managed via Docker secrets or external vault**
  - No secrets in environment variables
  - No secrets in Dockerfile or docker-compose.yml
  - Secrets injected at runtime via secrets management system

- [ ] **Network isolation**
  - Services on isolated Docker networks
  - Only necessary ports exposed to host
  - No `--network=host` unless absolutely required

---

## 2. Network Security

### 2.1 Firewall Configuration

- [ ] **Host firewall enabled (iptables/firewalld/ufw)**
  - Only necessary ports open (3000, 5173, 7474, 7687, 5432, 6379)
  - Deny all by default, allow explicitly
  - Rate limiting rules for public-facing ports

- [ ] **Network segmentation**
  - Backend services (Neo4j, PostgreSQL, Redis) not accessible from public internet
  - Frontend (Web UI, API) in DMZ or separate network segment
  - Database network isolated from application network

- [ ] **DDoS protection**
  - Rate limiting at network level (fail2ban, CloudFlare, WAF)
  - SYN flood protection enabled
  - Connection limits per IP address

### 2.2 Service Isolation

- [ ] **Inter-service communication over private network**
  - Services communicate via Docker networks or VPC
  - No services exposed to public internet unless necessary

- [ ] **Load balancer/reverse proxy in front of services**
  - Nginx, Traefik, or HAProxy handling public traffic
  - TLS termination at proxy
  - Request filtering and validation

### 2.3 TLS/SSL Everywhere

- [ ] **All external communication encrypted**
  - HTTPS for Web UI (port 5173)
  - HTTPS for API server (port 3000)
  - TLS 1.2 minimum, TLS 1.3 preferred
  - Strong cipher suites only (no RC4, 3DES, MD5)

- [ ] **Database connections encrypted**
  - Neo4j: `bolt+s://` or `bolt+ssc://`
  - PostgreSQL: `sslmode=require` or `sslmode=verify-full`
  - Redis: TLS enabled with `tls-port` and certificates

- [ ] **Certificate management**
  - Valid certificates from trusted CA (Let's Encrypt, DigiCert)
  - Automated certificate renewal (certbot, ACME)
  - Certificate expiry monitoring and alerting

- [ ] **HSTS enabled**
  - Strict-Transport-Security header sent by all HTTPS endpoints
  - `max-age` of at least 31536000 (1 year)
  - `includeSubDomains` directive enabled

---

## 3. Database Security

### 3.1 Neo4j Security

- [ ] **Authentication enabled**
  - Native authentication configured
  - Strong password policy enforced (16+ chars, complexity)
  - Default `neo4j` password changed

- [ ] **Role-based access control (RBAC)**
  - Separate roles for read-only, read-write, admin
  - Application uses least-privilege service account
  - No shared credentials

- [ ] **Encrypted connections**
  - Bolt+S protocol used for all connections
  - Valid TLS certificates configured
  - Certificate verification enabled

- [ ] **Query logging and audit**
  - Query logging enabled (`dbms.logs.query.enabled=true`)
  - Slow query logging configured
  - Audit logs enabled for authentication events

- [ ] **Backup and recovery**
  - Automated daily backups
  - Backups encrypted at rest
  - Backup restoration tested monthly
  - Offsite backup storage (S3, Azure Blob)

- [ ] **Network isolation**
  - Neo4j not exposed to public internet
  - Firewall rules restrict access to application servers only
  - Bolt port (7687) and HTTP port (7474) access restricted

### 3.2 PostgreSQL Security

- [ ] **Authentication and authorization**
  - Strong passwords for all database users
  - Separate users for application, admin, backup
  - `pg_hba.conf` restricts connections by IP and method

- [ ] **Encrypted connections**
  - `ssl=on` in `postgresql.conf`
  - Valid SSL certificates configured
  - `sslmode=require` enforced for all connections

- [ ] **Database hardening**
  - `shared_preload_libraries = 'pg_stat_statements,auto_explain'`
  - Query logging enabled for debugging
  - Connection limits configured (`max_connections`)

- [ ] **Row-level security (RLS) where applicable**
  - Sensitive tables use RLS policies
  - Multi-tenant data isolated

- [ ] **Backup and recovery**
  - Automated daily backups (pg_dump, WAL archiving)
  - Point-in-time recovery (PITR) configured
  - Backups encrypted with GPG or cloud provider encryption
  - Restoration tested monthly

- [ ] **Vulnerability patching**
  - PostgreSQL version up-to-date (latest minor version)
  - Security patches applied within 7 days of release

### 3.3 Redis Security

- [ ] **Authentication required**
  - `requirepass` configured with strong password
  - Password rotated quarterly

- [ ] **Network isolation**
  - Redis bound to localhost or private network only
  - Firewall blocks external access to port 6379

- [ ] **Disable dangerous commands**
  - `rename-command FLUSHDB ""`, `rename-command FLUSHALL ""`
  - `rename-command CONFIG "CONFIG_ADMIN_ONLY"`

- [ ] **TLS encryption (if exposed over network)**
  - `tls-port` configured with certificates
  - Non-TLS port disabled (`port 0`)

- [ ] **Persistence and backup**
  - AOF or RDB persistence enabled
  - Backup files encrypted and stored offsite

---

## 4. API Security

### 4.1 Authentication

- [ ] **JWT authentication implemented**
  - Tokens signed with strong secret (256-bit minimum)
  - Short expiration time (15-60 minutes)
  - Refresh token mechanism for session extension

- [ ] **Secret management**
  - `JWT_SECRET` stored in environment variable or secrets manager
  - Secret rotated quarterly
  - Different secrets for dev/staging/production

- [ ] **Multi-factor authentication (MFA) for admin accounts**
  - TOTP or SMS-based 2FA
  - Backup codes provided
  - Enforcement for privileged operations

### 4.2 Authorization

- [ ] **Role-based access control (RBAC)**
  - User roles defined (viewer, editor, admin)
  - Middleware enforces permissions on all endpoints
  - Least privilege principle applied

- [ ] **API endpoint authorization**
  - Every endpoint checks user permissions
  - No public endpoints without explicit intent
  - Admin endpoints require admin role

- [ ] **Resource-level authorization**
  - Users can only access resources they own or have permission for
  - Cross-tenant data leakage prevented

### 4.3 Rate Limiting

- [ ] **Global rate limiting**
  - Max 100 requests per minute per IP
  - Burst allowance for legitimate traffic spikes
  - `429 Too Many Requests` response with `Retry-After` header

- [ ] **Endpoint-specific rate limiting**
  - Authentication endpoints: 10 requests per minute
  - Resource creation: 20 requests per minute
  - Query endpoints: 100 requests per minute

- [ ] **Distributed rate limiting (for multi-instance deployments)**
  - Redis-backed rate limiting
  - Shared state across API instances

### 4.4 Input Validation

- [ ] **Request body validation**
  - JSON schema validation on all POST/PUT/PATCH requests
  - Required fields enforced
  - Data type validation (string, number, boolean, enum)
  - Length limits enforced (max string length, array size)

- [ ] **Query parameter validation**
  - Whitelist of allowed parameters
  - Type and range validation
  - No raw user input in database queries

- [ ] **Path parameter validation**
  - UUID/ID format validation
  - No directory traversal characters (../, ..\)

- [ ] **File upload validation**
  - File type whitelist (magic number verification, not extension)
  - File size limits enforced
  - Virus scanning (ClamAV) on all uploads
  - Upload rate limiting

### 4.5 Output Encoding

- [ ] **XSS prevention**
  - All user-generated content HTML-escaped
  - Content-Type headers set correctly
  - No `eval()` or `innerHTML` with user data

- [ ] **JSON response validation**
  - Structured error responses (no stack traces in production)
  - Sensitive data filtered from responses

### 4.6 Security Headers

- [ ] **Content Security Policy (CSP)**
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';`
  - No `unsafe-eval` or `unsafe-inline` for scripts

- [ ] **X-Frame-Options**
  - `X-Frame-Options: DENY` or `SAMEORIGIN`
  - Prevents clickjacking attacks

- [ ] **X-Content-Type-Options**
  - `X-Content-Type-Options: nosniff`
  - Prevents MIME sniffing

- [ ] **Strict-Transport-Security (HSTS)**
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`

- [ ] **X-XSS-Protection**
  - `X-XSS-Protection: 1; mode=block`

- [ ] **Referrer-Policy**
  - `Referrer-Policy: strict-origin-when-cross-origin`

- [ ] **Permissions-Policy**
  - `Permissions-Policy: geolocation=(), microphone=(), camera=()`

### 4.7 CSRF Protection

- [ ] **CSRF tokens for state-changing operations**
  - Tokens generated and validated for POST/PUT/PATCH/DELETE
  - Tokens tied to user session
  - SameSite cookie attribute set (`SameSite=Strict`)

- [ ] **Cookie security**
  - `HttpOnly` flag set (prevents JavaScript access)
  - `Secure` flag set (HTTPS only)
  - `SameSite=Strict` or `Lax`

### 4.8 SQL/NoSQL Injection Prevention

- [ ] **Parameterized queries always used**
  - No string concatenation for queries
  - ORM/query builder used correctly
  - Neo4j Cypher queries use parameterization

- [ ] **Input sanitization**
  - Special characters escaped
  - User input never directly interpolated into queries

- [ ] **Database user permissions**
  - Application database user has minimal permissions
  - No `DROP`, `ALTER`, `CREATE` permissions for app user
  - Read-only user for reporting queries

---

## 5. Secret Management

### 5.1 Environment Variables

- [ ] **No secrets in source code**
  - `.env` file in `.gitignore`
  - No hardcoded passwords, API keys, or tokens
  - Secrets injected at runtime

- [ ] **Separate secrets per environment**
  - Dev, staging, production use different secrets
  - No shared credentials across environments

- [ ] **Secrets rotation schedule**
  - Database passwords: Quarterly
  - JWT secrets: Quarterly
  - API keys: Quarterly
  - TLS certificates: Automated renewal (Let's Encrypt)

### 5.2 Encrypted Storage

- [ ] **Database credentials encrypted**
  - Stored in HashiCorp Vault, AWS Secrets Manager, or Azure Key Vault
  - Encrypted at rest with KMS

- [ ] **Connector credentials encrypted**
  - Credentials table uses column-level encryption
  - `ENCRYPTION_KEY` environment variable protected
  - Key rotation procedure documented

### 5.3 Access Control

- [ ] **Principle of least privilege**
  - Only services that need secrets have access
  - Service accounts used (not personal accounts)
  - Audit logging for secret access

- [ ] **No secrets in logs**
  - Logging filters redact sensitive data
  - No passwords, tokens, or keys in debug output

---

## 6. Dependency Security

### 6.1 Vulnerability Scanning

- [ ] **Automated dependency scanning**
  - `npm audit` run in CI/CD pipeline
  - Fails build on HIGH or CRITICAL vulnerabilities
  - Snyk or GitHub Dependabot enabled

- [ ] **Regular dependency updates**
  - Dependencies updated monthly (minor/patch versions)
  - Security patches applied within 7 days
  - Major version upgrades tested in staging first

- [ ] **License compliance**
  - No GPL/AGPL dependencies in proprietary code
  - License scanning in CI/CD (license-checker, FOSSA)

### 6.2 Supply Chain Security

- [ ] **Package integrity verification**
  - `package-lock.json` committed to version control
  - Integrity hashes verified on install
  - No `--unsafe-perm` flag

- [ ] **Private npm registry (optional)**
  - Internal packages hosted on private registry
  - Registry authentication required

- [ ] **Dependency pinning**
  - Production dependencies pinned to exact versions
  - No `^` or `~` in production package.json

---

## 7. Logging and Monitoring

### 7.1 Audit Logging

- [ ] **Comprehensive audit logs**
  - All authentication events (login, logout, failed attempts)
  - All authorization failures
  - All data mutations (create, update, delete)
  - All configuration changes
  - All credential access

- [ ] **Log format and structure**
  - Structured logging (JSON format)
  - Timestamp, user ID, IP address, action, resource, outcome
  - Correlation IDs for request tracing

- [ ] **Log storage and retention**
  - Centralized logging system (ELK, Splunk, CloudWatch)
  - Minimum 90-day retention for audit logs
  - Immutable log storage (WORM, S3 Object Lock)

### 7.2 Security Event Monitoring

- [ ] **Failed authentication attempts**
  - Alert on >10 failed attempts in 5 minutes from same IP
  - Temporary account lockout after 5 failed attempts
  - CAPTCHA after 3 failed attempts

- [ ] **Rate limit violations**
  - Alert on >100 requests in 1 minute from same IP
  - Temporary IP block for persistent violators

- [ ] **Unauthorized access attempts**
  - Alert on 403 Forbidden responses
  - Alert on attempts to access admin endpoints by non-admins

- [ ] **Configuration changes**
  - Alert on any changes to security settings
  - Require multi-person approval for production config changes

- [ ] **Credential access patterns**
  - Alert on unusual credential access (time, volume, location)
  - Alert on credential exports or downloads

### 7.3 Performance and Availability Monitoring

- [ ] **Uptime monitoring**
  - Health check endpoints monitored (UptimeRobot, Pingdom)
  - Alert on downtime >2 minutes
  - Status page for external communication

- [ ] **Resource monitoring**
  - CPU, memory, disk usage tracked
  - Alert on >80% resource utilization
  - Autoscaling configured for cloud deployments

- [ ] **Database performance monitoring**
  - Slow query logging enabled
  - Connection pool monitoring
  - Alert on connection pool exhaustion

---

## 8. Incident Response

### 8.1 Incident Classification

- [ ] **Severity levels defined**
  - **CRITICAL**: Data breach, system compromise, service outage
  - **HIGH**: Vulnerability exploitation, unauthorized access
  - **MEDIUM**: Security misconfiguration, policy violation
  - **LOW**: Non-exploitable vulnerability, informational

- [ ] **Response time SLAs**
  - CRITICAL: <15 minutes
  - HIGH: <1 hour
  - MEDIUM: <4 hours
  - LOW: <24 hours

### 8.2 Response Procedures

- [ ] **Incident response team identified**
  - Primary responders: Security Lead, DevOps Lead, CTO
  - Backup responders identified
  - On-call rotation schedule

- [ ] **Incident response playbooks**
  - Data breach response
  - Ransomware response
  - DDoS attack response
  - Insider threat response

- [ ] **Communication plan**
  - Internal notification channels (Slack, PagerDuty)
  - External communication templates (customers, regulators)
  - Legal and PR team contacts

### 8.3 Post-Incident Review

- [ ] **Blameless postmortem process**
  - Root cause analysis within 48 hours
  - Timeline of events documented
  - Lessons learned and action items
  - Postmortem published internally

- [ ] **Continuous improvement**
  - Security controls updated based on findings
  - Runbooks and playbooks updated
  - Team training on new procedures

---

## 9. Compliance and Governance

### 9.1 Security Policies

- [ ] **Password policy**
  - Minimum 16 characters for human users
  - Minimum 32 characters for service accounts
  - Complexity requirements (upper, lower, number, special)
  - No password reuse (last 10 passwords)

- [ ] **Access control policy**
  - Least privilege principle
  - Regular access reviews (quarterly)
  - Offboarding checklist (revoke access within 1 hour)

- [ ] **Data classification policy**
  - Public, Internal, Confidential, Restricted
  - Handling requirements per classification
  - Encryption requirements per classification

### 9.2 Security Assessments

- [ ] **Penetration testing**
  - Annual third-party penetration test
  - Findings remediated within 30 days
  - Retest of critical findings

- [ ] **Vulnerability assessments**
  - Quarterly internal vulnerability scans
  - Monthly automated scans (Nessus, Qualys)
  - Findings tracked in ticketing system

- [ ] **Security audits**
  - Annual security audit by internal or external team
  - SOC 2 Type II compliance (if applicable)
  - ISO 27001 compliance (if applicable)

### 9.3 Training and Awareness

- [ ] **Security training for all employees**
  - Annual security awareness training
  - Phishing simulation exercises (quarterly)
  - Secure coding training for developers

- [ ] **Incident response drills**
  - Tabletop exercises (semi-annual)
  - Full incident response simulation (annual)

---

## 10. Production Deployment Checklist

### Pre-Deployment

- [ ] All HIGH and CRITICAL vulnerabilities resolved
- [ ] Security scanning passed (Docker images, dependencies, SAST)
- [ ] Secrets rotated for production environment
- [ ] TLS certificates valid and configured
- [ ] Firewall rules reviewed and tested
- [ ] Backup and recovery tested
- [ ] Incident response team briefed
- [ ] Rollback plan documented and tested

### Post-Deployment

- [ ] All services started successfully
- [ ] Health checks passing
- [ ] Security monitoring alerts configured
- [ ] Log aggregation working
- [ ] Access control verified
- [ ] Encryption verified (TLS, database)
- [ ] Performance baselines established
- [ ] Runbook updated with production details

---

## Security Score Calculation

**Methodology**: Each section weighted by criticality. Score out of 100.

| Section | Weight | Items | Score Formula |
|---------|--------|-------|---------------|
| Docker Security | 10% | 20 | (Completed / 20) × 10 |
| Network Security | 10% | 15 | (Completed / 15) × 10 |
| Database Security | 15% | 25 | (Completed / 25) × 15 |
| API Security | 20% | 30 | (Completed / 30) × 20 |
| Secret Management | 10% | 12 | (Completed / 12) × 10 |
| Dependency Security | 5% | 8 | (Completed / 8) × 5 |
| Logging and Monitoring | 15% | 20 | (Completed / 20) × 15 |
| Incident Response | 10% | 12 | (Completed / 12) × 10 |
| Compliance | 5% | 10 | (Completed / 10) × 5 |

**Total Score** = Sum of all weighted scores

**Grading**:
- **90-100**: Excellent - Production ready
- **80-89**: Good - Minor improvements needed
- **70-79**: Fair - Moderate hardening required
- **60-69**: Poor - Significant gaps exist
- **<60**: Critical - Not production ready

---

## Automated Checklist Validation

See `/infrastructure/scripts/security-audit.sh` for automated validation of this checklist.

---

## Contacts

**Security Lead**: security@happycmdb.io
**Incident Response**: incidents@happycmdb.io
**On-Call**: PagerDuty `happycmdb-security`

---

## References

- OWASP Top 10: https://owasp.org/www-project-top-ten/
- CIS Docker Benchmark: https://www.cisecurity.org/benchmark/docker
- NIST Cybersecurity Framework: https://www.nist.gov/cyberframework
- Docker Security Best Practices: https://docs.docker.com/engine/security/
