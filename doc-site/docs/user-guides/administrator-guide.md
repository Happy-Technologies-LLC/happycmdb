# Administrator Guide

Complete guide for HappyCMDB system administrators managing users, security, backups, and system maintenance.

## Overview

As a System Administrator, you're responsible for the operational health, security, and availability of the HappyCMDB platform. This guide covers day-to-day administration tasks.

**Target Audience**: System Administrators, DevOps Engineers, IT Operations

**Admin Panel**: http://localhost:3001/admin

**Role Required**: `admin`

---

## Quick Reference

| Task | Command/Location | Frequency |
|------|------------------|-----------|
| User Management | Admin Panel → Users | As needed |
| Backup Database | `./infrastructure/scripts/backup-all.sh` | Daily (automated) |
| Check System Health | `curl http://localhost:3000/api/health` | Continuous |
| View Logs | `docker-compose logs -f api-server` | As needed |
| Update Credentials | Admin Panel → Credentials | As needed |
| Run Discovery | Admin Panel → Discovery → Run Job | Scheduled |
| Check Job Queue | Admin Panel → Jobs | Daily |

---

## User Management

### Creating Users

**Via Admin Panel**:
1. Navigate to Admin Panel → Users
2. Click "Create User"
3. Fill in details:
   - Username
   - Email
   - Password (min 8 chars, complexity required)
   - Role (viewer, operator, admin)
4. Click "Create"

**Via API**:
```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "john.doe",
    "email": "john.doe@example.com",
    "password": "SecurePass123!",
    "role": "operator"
  }'
```

---

### Managing Roles

**Role Permissions**:

| Role | Permissions | Use Case |
|------|-------------|----------|
| `viewer` | Read-only access | Auditors, stakeholders |
| `operator` | Read + discovery + CI updates | DevOps, engineers |
| `admin` | Full access including user mgmt | System administrators |
| `service-owner` | Manage specific services | Product owners |

**Changing User Role**:
```bash
curl -X PATCH http://localhost:3000/api/v1/users/{user-id} \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'
```

---

### Disabling/Enabling Users

**Disable User** (soft delete):
```bash
curl -X PATCH http://localhost:3000/api/v1/users/{user-id} \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

**Best Practice**: Disable users instead of deleting to preserve audit trails.

---

## Credential Management

### Adding Cloud Provider Credentials

**AWS**:
```bash
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "_name": "AWS Production",
    "_protocol": "aws_iam",
    "_scope": "cloud_provider",
    "_credentials": {
      "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
      "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCY...",
      "region": "us-east-1"
    }
  }'
```

---

### Rotating Credentials

**Quarterly rotation recommended**:

1. Create new credential in cloud provider
2. Add new credential to HappyCMDB
3. Test discovery with new credential
4. Delete old credential from HappyCMDB
5. Revoke old credential in cloud provider

---

## Backup & Restore

### Manual Backup

**Backup All Databases**:
```bash
cd /path/to/happycmdb
./infrastructure/scripts/backup-all.sh
```

**Backup Neo4j Only**:
```bash
./infrastructure/scripts/backup-neo4j.sh
```

**Backup PostgreSQL Only**:
```bash
./infrastructure/scripts/backup-postgres.sh
```

**Backup Location**: `/var/backups/happycmdb/`

---

### Automated Backups

**Set up cron** (recommended):
```bash
# Daily backup at 2 AM
0 2 * * * /path/to/happycmdb/infrastructure/scripts/backup-all.sh

# Weekly backup health check
0 3 * * 0 /path/to/happycmdb/infrastructure/scripts/backup-health-check.sh
```

---

### Restore from Backup

**PostgreSQL**:
```bash
./infrastructure/scripts/restore-postgres.sh \
  --file /var/backups/happycmdb/postgres/daily/backup-2025-11-15.sql.gz \
  --drop \
  --verify
```

**Neo4j**:
```bash
./infrastructure/scripts/restore-neo4j.sh \
  --file /var/backups/happycmdb/neo4j/daily/backup-2025-11-15.dump.gz \
  --force \
  --verify
```

**See**: [Backup & Restore Guide](/operations/backup-restore.md) for detailed instructions.

---

## Discovery Management

### Configuring Discovery Definitions

**Create Discovery Definition**:
1. Admin Panel → Discovery → Create Definition
2. Select connector type (AWS, Azure, SSH, etc.)
3. Select credential
4. Configure schedule (cron expression)
5. Set discovery scope (regions, tags, filters)
6. Save and test

**Example - AWS Discovery**:
```json
{
  "name": "AWS Production Discovery",
  "connector": "aws",
  "credential_id": "cred-aws-prod-001",
  "schedule": "0 */6 * * *",
  "config": {
    "regions": ["us-east-1", "us-west-2"],
    "services": ["ec2", "rds", "s3", "lambda"],
    "tags": {
      "Environment": "production"
    }
  }
}
```

---

### Monitoring Discovery Jobs

**Check Job Status**:
```bash
curl http://localhost:3000/api/v1/jobs | jq
```

**View Failed Jobs**:
```bash
curl 'http://localhost:3000/api/v1/jobs?status=failed' | jq
```

**Retry Failed Job**:
```bash
curl -X POST http://localhost:3000/api/v1/jobs/{job-id}/retry \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## System Health Monitoring

### Health Check Endpoints

**API Server**:
```bash
curl http://localhost:3000/api/health
```

**Expected Response**:
```json
{
  "status": "healthy",
  "version": "3.0.0",
  "uptime": 86400,
  "checks": {
    "neo4j": "healthy",
    "postgres": "healthy",
    "redis": "healthy"
  }
}
```

---

### Database Health

**Neo4j**:
```bash
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "MATCH (n) RETURN count(n) LIMIT 1;"
```

**PostgreSQL**:
```bash
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SELECT COUNT(*) FROM dim_ci;"
```

**Redis**:
```bash
docker exec cmdb-redis redis-cli PING
```

---

### Log Management

**View Recent Logs**:
```bash
# API Server
docker-compose logs --tail=100 -f api-server

# All Services
docker-compose logs --tail=50 -f

# Specific time range
docker-compose logs --since 2025-11-15T10:00:00

# Search logs
docker-compose logs api-server | grep ERROR
```

**Log Rotation** (configured in Docker Compose):
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

---

## Performance Tuning

### Database Optimization

**Neo4j - Create Indexes**:
```cypher
# Via cypher-shell
CREATE INDEX ci_id IF NOT EXISTS FOR (c:CI) ON (c._id);
CREATE INDEX ci_type IF NOT EXISTS FOR (c:CI) ON (c._type);
CREATE INDEX ci_name IF NOT EXISTS FOR (c:CI) ON (c._name);
```

**PostgreSQL - Analyze Tables**:
```bash
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "ANALYZE dim_ci; ANALYZE fact_cost; ANALYZE fact_incidents;"
```

---

### Resource Scaling

**Increase API Server Replicas**:
```yaml
# docker-compose.yml
api-server:
  deploy:
    replicas: 3
```

**Increase Database Connections**:
```bash
# .env
POSTGRES_MAX_CONNECTIONS=50
NEO4J_MAX_CONNECTION_POOL_SIZE=100
```

---

## Security Management

### SSL/TLS Configuration

**Enable SSL for Nginx** (Web UI):
```bash
# .env
SSL_ENABLED=true
NGINX_SSL_CERT_PATH=/etc/nginx/ssl/cert.pem
NGINX_SSL_KEY_PATH=/etc/nginx/ssl/key.pem
```

**See**: [SSL Migration Guide](/configuration/security/SSL_MIGRATION_GUIDE.md)

---

### Security Audits

**Run Security Audit**:
```bash
./infrastructure/scripts/security-audit.sh
```

**Scan Dependencies**:
```bash
./infrastructure/scripts/security-scan-dependencies.sh
```

**Scan Docker Images**:
```bash
./infrastructure/scripts/security-scan-docker.sh
```

---

### Secrets Management

**DO**:
- Store secrets in `.env` file (git-ignored)
- Use environment variables
- Rotate secrets quarterly
- Use strong passwords (min 32 chars for encryption keys)

**DON'T**:
- Commit secrets to git
- Share secrets via email/Slack
- Reuse passwords across environments
- Use default/example passwords in production

**Secret Rotation Script**:
```bash
./infrastructure/scripts/secret-rotation.sh
```

---

## Maintenance Tasks

### Daily

- [ ] Check system health (`/api/health`)
- [ ] Review failed jobs
- [ ] Check disk space (`df -h`)
- [ ] Scan error logs

### Weekly

- [ ] Review backup health
- [ ] Check database performance
- [ ] Review security alerts
- [ ] Update discovery schedules if needed

### Monthly

- [ ] Update dependencies (`npm audit fix`)
- [ ] Review user access (disable inactive users)
- [ ] Database maintenance (VACUUM, ANALYZE)
- [ ] Review system capacity

### Quarterly

- [ ] Rotate credentials
- [ ] Security audit
- [ ] Disaster recovery test
- [ ] Performance review

---

## Troubleshooting

### Common Issues

**Issue: API Server Won't Start**
```bash
# Check logs
docker-compose logs api-server

# Common causes:
# 1. Database not ready
# 2. Invalid .env configuration
# 3. Port 3000 already in use

# Solutions:
docker-compose restart postgres neo4j redis
# Wait 30 seconds
docker-compose up -d api-server
```

**Issue: Discovery Jobs Failing**
```bash
# Check job logs
curl http://localhost:3000/api/v1/jobs/{job-id} | jq '.error'

# Common causes:
# 1. Invalid credentials
# 2. Network connectivity
# 3. Cloud provider API rate limits

# Test credential
curl -X POST http://localhost:3000/api/v1/credentials/{cred-id}/validate
```

**Issue: High Memory Usage**
```bash
# Check container stats
docker stats

# If Neo4j using too much memory:
# Edit docker-compose.yml
environment:
  NEO4J_dbms_memory_heap_initial__size: 2G
  NEO4J_dbms_memory_heap_max__size: 4G
```

---

## Upgrading HappyCMDB

**See**: [Migrating to v3.0](/getting-started/migrating-to-v3.md) for upgrade procedures.

**Quick Upgrade Steps**:
1. Backup all databases
2. Pull latest code
3. Update dependencies (`npm install`)
4. Run migrations (`npm run db:migrate`)
5. Restart services
6. Verify health

---

## Disaster Recovery

### Recovery Time Objective (RTO)

**Target**: System restored within 4 hours

**Steps**:
1. Provision infrastructure (1 hour)
2. Restore databases (1 hour)
3. Deploy application (30 min)
4. Verify functionality (1.5 hours)

### Recovery Point Objective (RPO)

**Target**: Max 24 hours data loss

**Method**: Daily backups retained for 7 days

**See**: [Disaster Recovery Plan](/operations/backup/disaster-recovery.md)

---

## Monitoring & Alerting

### Key Metrics to Monitor

**System**:
- CPU usage > 80%
- Memory usage > 85%
- Disk usage > 90%

**Application**:
- API response time > 500ms (P95)
- Error rate > 1%
- Discovery job failure rate > 5%

**Database**:
- Connection pool exhaustion
- Slow query count
- Replication lag (if configured)

### Alert Configuration

**See**: [Monitoring Setup](/operations/MONITORING_SETUP_SUMMARY.md)

**Grafana Dashboards**: http://localhost:3001

---

## Best Practices

1. **Automation**: Automate backups, monitoring, and routine tasks
2. **Documentation**: Document all configuration changes
3. **Testing**: Test backups and disaster recovery quarterly
4. **Security**: Follow least privilege principle
5. **Monitoring**: Set up alerts before issues occur
6. **Capacity**: Plan capacity 6 months ahead
7. **Updates**: Keep dependencies up-to-date

---

## See Also

- [Operations Guide](/operations/daily-operations.md) - Daily operational tasks
- [Troubleshooting](/operations/troubleshooting.md) - Detailed troubleshooting
- [Configuration](/configuration/environment-variables.md) - Configuration reference
- [Security](/configuration/security/README.md) - Security hardening

---

**Guide Version**: 3.0
**Last Updated**: November 2025
**Audience**: System Administrators, DevOps Engineers
