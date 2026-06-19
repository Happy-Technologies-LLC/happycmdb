# HappyCMDB - Deployment Runbook

**Version**: 2.0
**Last Updated**: 2025-10-19
**Owner**: Platform Engineering Team

---

## Table of Contents

1. [Overview](#overview)
2. [Deployment Architecture](#deployment-architecture)
3. [Pre-Deployment Checklist](#pre-deployment-checklist)
4. [Staging Deployment](#staging-deployment)
5. [Production Deployment](#production-deployment)
6. [Rollback Procedures](#rollback-procedures)
7. [Post-Deployment Validation](#post-deployment-validation)
8. [Common Issues and Solutions](#common-issues-and-solutions)
9. [Emergency Contacts](#emergency-contacts)

---

## Overview

HappyCMDB uses a multi-stage deployment pipeline with automated validation, blue-green deployment for zero downtime, and comprehensive rollback capabilities.

### Deployment Environments

| Environment | Purpose | Deployment Frequency | Approval Required |
|------------|---------|---------------------|-------------------|
| **Development** | Feature development | Continuous (on commit) | No |
| **Staging** | Integration testing | Daily | Team Lead |
| **Production** | Live system | Weekly | Product Owner + Ops Lead |

### Deployment Strategy

- **Staging**: Rolling deployment with health checks
- **Production**: Blue-green deployment with gradual traffic shift
- **Rollback**: Automated with database recovery

---

## Deployment Architecture

### Blue-Green Deployment (Production)

```
┌─────────────────┐
│  Load Balancer  │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌──────┐  ┌──────┐
│ BLUE │  │GREEN │
│(v1.0)│  │(v2.0)│
└──────┘  └──────┘
   │         │
   └────┬────┘
        ▼
┌──────────────┐
│  Databases   │
│ Neo4j + PG   │
└──────────────┘
```

**Traffic Shift Steps**: 0% → 20% → 40% → 60% → 80% → 100%

### Container Architecture

```
HappyCMDB Stack:
  ├── cmdb-api-server      (Port 3000)
  ├── cmdb-web-ui          (Port 3001)
  ├── cmdb-neo4j           (Port 7474, 7687)
  ├── cmdb-postgres        (Port 5433)
  ├── cmdb-redis           (Port 6379)
  ├── cmdb-kafka           (Port 9092, optional)
  └── cmdb-zookeeper       (Port 2181, optional)
```

---

## Pre-Deployment Checklist

### Automated Checks

Run the pre-deployment validation script:

```bash
bash infrastructure/scripts/pre-deploy-checklist.sh <staging|production>
```

### Manual Verification

#### For Staging Deployments

- [ ] All unit tests passing
- [ ] Feature branch merged to `develop`
- [ ] Database migration scripts reviewed
- [ ] Configuration changes documented

#### For Production Deployments

- [ ] Staging deployment successful and tested
- [ ] All integration tests passing
- [ ] Performance tests completed
- [ ] Security scan completed (no critical vulnerabilities)
- [ ] Database backup verified (<24h old)
- [ ] SSL certificates valid (>30 days remaining)
- [ ] Change request approved
- [ ] Stakeholders notified
- [ ] Rollback plan reviewed
- [ ] On-call engineer identified

### Pre-Deployment Backup

**CRITICAL**: Always create a backup before production deployment.

```bash
# Run backup script
bash infrastructure/scripts/backup-all.sh

# Verify backups
bash infrastructure/scripts/backup-health-check.sh
```

Backups are stored in: `/var/backups/happycmdb/<environment>/`

---

## Staging Deployment

### Step-by-Step Process

#### 1. Pre-Deployment Validation

```bash
cd /path/to/happycmdb
bash infrastructure/scripts/pre-deploy-checklist.sh staging
```

**Expected Result**: All checks pass or warnings only.

#### 2. Run Staging Deployment

```bash
bash infrastructure/scripts/deploy-staging.sh
```

This script will:
- ✅ Validate pre-deployment checks
- ✅ Create database backup
- ✅ Pull latest code from `develop` branch
- ✅ Install dependencies
- ✅ Build TypeScript packages
- ✅ Run database migrations
- ✅ Build Docker images (no cache)
- ✅ Stop current containers
- ✅ Start new containers
- ✅ Run health checks
- ✅ Execute smoke tests
- ✅ Run post-deployment validation

**Duration**: ~10-15 minutes

#### 3. Monitor Deployment

```bash
# Watch logs in real-time
tail -f logs/deployment-staging-*.log

# Check container status
docker-compose -f infrastructure/docker/docker-compose.yml ps

# View API server logs
docker logs -f cmdb-api-server
```

#### 4. Verify Deployment

```bash
# Run post-deployment validation
bash infrastructure/scripts/post-deploy-validation.sh staging
```

**Success Criteria**:
- All containers running and healthy
- API responding (HTTP 200)
- Web UI accessible
- Database connections working
- No errors in logs (last 5 minutes)

#### 5. Notify QA Team

Send notification to QA team with staging environment URL:
- **Web UI**: http://staging.happycmdb.local:3001
- **API**: http://staging.happycmdb.local:3000/api/v1
- **GraphQL**: http://staging.happycmdb.local:3000/graphql

---

## Production Deployment

### Overview

Production deployments use **blue-green strategy** with zero downtime and gradual traffic shift.

**Time Requirements**:
- Deployment window: 1-2 hours
- Monitoring period: 1 hour post-deployment
- Total: 2-3 hours

### Step-by-Step Process

#### 1. Final Pre-Deployment Checks

```bash
# Run production validation
bash infrastructure/scripts/pre-deploy-checklist.sh production
```

**All checks MUST pass** - no warnings allowed for production.

#### 2. Notify Stakeholders

**30 minutes before deployment**:
- Email all stakeholders
- Post in #happycmdb-deployments Slack channel
- Update status page (if applicable)

**Template**:
```
Subject: [HappyCMDB] Production Deployment Starting

Production deployment will begin at: <TIME>
Expected duration: 1-2 hours
Impact: None (zero downtime deployment)
Rollback plan: Available
Contact: <ON-CALL ENGINEER>
```

#### 3. Create Production Backup

```bash
# Create comprehensive backup
bash infrastructure/scripts/backup-all.sh

# Verify backup integrity
bash infrastructure/scripts/backup-health-check.sh
```

**CRITICAL**: Do not proceed if backup fails.

#### 4. Run Production Deployment

```bash
bash infrastructure/scripts/deploy-production.sh
```

**Manual Approvals Required**:

The script will pause at these checkpoints:

1. **Initial Confirmation**: Type `DEPLOY-TO-PRODUCTION`
2. **Pre-Deployment Validation**: Type `PROCEED`
3. **Database Migration**: Type `PROCEED`
4. **Green Environment Ready**: Type `PROCEED`
5. **Traffic Shift Steps**: Type `PROCEED` after each step (20%, 40%, 60%, 80%)
6. **Final Validation**: Type `PROCEED`

#### 5. Monitor During Deployment

Open multiple terminal windows:

**Terminal 1 - Deployment Progress**:
```bash
tail -f logs/deployment-production-*.log
```

**Terminal 2 - API Server Logs**:
```bash
docker logs -f cmdb-api-server
```

**Terminal 3 - Error Monitoring**:
```bash
docker logs -f cmdb-api-server 2>&1 | grep -i error
```

**Terminal 4 - Performance Monitoring**:
```bash
watch -n 5 'docker stats --no-stream cmdb-api-server cmdb-neo4j cmdb-postgres'
```

#### 6. Traffic Shift Monitoring

During each traffic shift step (20%, 40%, 60%, 80%, 100%):

- **Monitor error rates**: Should not increase
- **Check response times**: Should remain stable
- **Review logs**: No new errors
- **Verify health checks**: Green environment stays healthy

**Red Flags** (initiate rollback immediately):
- ❌ Error rate increases >5%
- ❌ Response time >2x baseline
- ❌ Health checks failing
- ❌ Database connection errors
- ❌ Memory/CPU spikes

#### 7. Post-Deployment Validation

After 100% traffic shift:

```bash
# Comprehensive validation
bash infrastructure/scripts/post-deploy-validation.sh production
```

**All checks MUST pass**.

#### 8. Decommission Blue Environment

The script will:
- Stop blue containers (but keep for 24h as safety rollback)
- Promote green environment to primary
- Tag release in git

#### 9. Post-Deployment Monitoring

Monitor for **1 hour** after deployment:

```bash
# Watch for errors
docker logs -f cmdb-api-server | grep -i error

# Monitor performance
docker stats cmdb-api-server cmdb-neo4j cmdb-postgres
```

**Success Criteria**:
- No increase in error rate
- Response times within normal range
- All integrations working
- No user-reported issues

#### 10. Notify Stakeholders

**Template**:
```
Subject: [HappyCMDB] Production Deployment Complete

Production deployment completed successfully at: <TIME>
Version: <GIT TAG>
Downtime: 0 seconds (blue-green deployment)
Issues: None
Rollback: Available for 24 hours

Release Notes: <LINK>
```

---

## Rollback Procedures

### When to Rollback

**Immediate Rollback** if any of these occur:
- Critical functionality broken
- Database corruption detected
- Error rate >10% above baseline
- Security vulnerability introduced
- Data loss occurring
- Service completely unavailable

**Planned Rollback** if:
- Non-critical bugs discovered
- Performance degradation <50%
- Minor functionality issues

### Automated Rollback

```bash
# List available backups
ls -lh /var/backups/happycmdb/production/

# Full rollback (containers + databases)
bash infrastructure/scripts/rollback.sh <BACKUP_TIMESTAMP> full

# Containers only (keep current database)
bash infrastructure/scripts/rollback.sh <BACKUP_TIMESTAMP> containers-only

# Database only (keep current containers)
bash infrastructure/scripts/rollback.sh <BACKUP_TIMESTAMP> database-only
```

**Example**:
```bash
bash infrastructure/scripts/rollback.sh 20251019-143000 full
```

### Rollback Process

The rollback script will:

1. ✅ Verify backup integrity
2. ✅ Create safety snapshot of current state
3. ✅ Stop current containers
4. ✅ Restore git state (previous commit)
5. ✅ Restore database backups (Neo4j + PostgreSQL)
6. ✅ Rebuild application containers
7. ✅ Start containers
8. ✅ Verify system health
9. ✅ Run post-rollback validation

**Duration**: ~15-20 minutes

### Post-Rollback Actions

1. **Verify System Health**:
   ```bash
   bash infrastructure/scripts/post-deploy-validation.sh production
   ```

2. **Monitor for 30 minutes**: Ensure stability

3. **Root Cause Analysis**:
   - Review deployment logs
   - Analyze error logs
   - Identify failure point

4. **Notify Stakeholders**:
   ```
   Subject: [HappyCMDB] Production Rollback Executed

   Production deployment was rolled back at: <TIME>
   Reason: <DESCRIPTION>
   Current status: System stable on previous version
   Impact: <DESCRIPTION>
   Next steps: Root cause analysis in progress
   ```

5. **Document Incident**: Create post-mortem document

---

## Post-Deployment Validation

### Automated Validation

```bash
bash infrastructure/scripts/post-deploy-validation.sh <staging|production>
```

### Manual Validation

#### Critical User Workflows

Test these workflows manually:

**1. CI Discovery**:
- [ ] Create discovery definition
- [ ] Run discovery job
- [ ] Verify CIs discovered
- [ ] Check relationships created

**2. CI Management**:
- [ ] View CI list
- [ ] View CI details
- [ ] Update CI attributes
- [ ] Delete test CI

**3. Relationship Graph**:
- [ ] View dependency graph
- [ ] Navigate relationships
- [ ] Filter by CI type
- [ ] Export graph data

**4. Search and Filter**:
- [ ] Search CIs by name
- [ ] Filter by environment
- [ ] Filter by status
- [ ] Advanced search

**5. Connector Management**:
- [ ] View connector registry
- [ ] View connector details
- [ ] Install connector
- [ ] Configure connector credentials

#### Performance Testing

```bash
# API response time (should be <200ms)
curl -w "%{time_total}\n" -o /dev/null -s http://localhost:3000/api/v1/health

# GraphQL query time
time curl -X POST http://localhost:3000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ cis(limit: 100) { id ci_name ci_type } }"}'

# Database query performance
docker exec cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD> \
  "PROFILE MATCH (n:CI) RETURN count(n)"
```

**Acceptable Thresholds**:
- API health check: <100ms
- GraphQL query (100 CIs): <500ms
- Neo4j CI count query: <200ms

---

## Common Issues and Solutions

### Issue 1: Health Check Fails After Deployment

**Symptoms**:
- API health endpoint returns 503
- Container running but not responding

**Diagnosis**:
```bash
# Check container logs
docker logs cmdb-api-server --tail 100

# Check container resources
docker stats cmdb-api-server

# Test database connections
docker exec cmdb-api-server npm run db:test
```

**Solutions**:
1. Wait longer (containers may still be initializing)
2. Check database connectivity
3. Verify environment variables loaded correctly
4. Restart container: `docker restart cmdb-api-server`

### Issue 2: Database Migration Fails

**Symptoms**:
- Deployment stops at migration step
- Error: "Migration already applied" or "Schema mismatch"

**Diagnosis**:
```bash
# Check migration status
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 10"
```

**Solutions**:
1. **If migration already applied**: Skip migration and continue
2. **If schema mismatch**:
   - Rollback to previous version
   - Investigate schema differences
   - Fix migration script
3. **If migration stuck**:
   - Check for database locks: `SELECT * FROM pg_locks`
   - Kill blocking queries if safe

### Issue 3: Build Fails - TypeScript Errors

**Symptoms**:
- Deployment fails during package build
- TypeScript compilation errors

**Diagnosis**:
```bash
# Check build logs
cat logs/deployment-*.log | grep -A 10 "error TS"

# Try manual build
cd packages/api-server
npm run build
```

**Solutions**:
1. **Type errors**: Fix TypeScript errors in code
2. **Missing dependencies**: Run `npm install`
3. **Stale build cache**:
   ```bash
   find packages -name "tsconfig.tsbuildinfo" -delete
   npm run build
   ```

### Issue 4: Docker Image Build Fails

**Symptoms**:
- Docker build command fails
- "No space left on device" error

**Diagnosis**:
```bash
# Check disk space
df -h

# Check Docker disk usage
docker system df
```

**Solutions**:
1. **Insufficient disk space**:
   ```bash
   # Clean Docker cache
   docker system prune -a -f

   # Remove old images
   docker images | grep happycmdb | awk '{print $3}' | xargs docker rmi -f
   ```

2. **Build context too large**: Check `.dockerignore` file

### Issue 5: Rollback Fails

**Symptoms**:
- Rollback script fails
- Backup restoration errors

**Diagnosis**:
```bash
# Verify backup integrity
tar -tzf /var/backups/happycmdb/production/<TIMESTAMP>/neo4j-backup.tar.gz
gunzip -t /var/backups/happycmdb/production/<TIMESTAMP>/postgres-backup.sql.gz
```

**Solutions**:
1. **Backup corrupted**: Use previous backup
2. **Manual rollback**:
   ```bash
   # Stop containers
   docker-compose -f infrastructure/docker/docker-compose.yml down

   # Checkout previous git commit
   git checkout <PREVIOUS_COMMIT>

   # Manually restore databases
   bash infrastructure/scripts/restore-neo4j.sh <BACKUP_FILE>
   bash infrastructure/scripts/restore-postgres.sh <BACKUP_FILE>

   # Rebuild and start
   ./deploy.sh --clean
   ```

### Issue 6: High Memory Usage After Deployment

**Symptoms**:
- API server using >2GB RAM
- Neo4j OOM errors

**Diagnosis**:
```bash
# Check memory usage
docker stats --no-stream

# Check for memory leaks
docker exec cmdb-api-server node --expose-gc -e "console.log(process.memoryUsage())"
```

**Solutions**:
1. **Increase container memory limits** in `docker-compose.yml`
2. **Tune Neo4j heap size**: Set `NEO4J_dbms_memory_heap_max__size`
3. **Check for memory leaks**: Review code for unclosed connections
4. **Restart containers**: `docker restart cmdb-api-server`

### Issue 7: SSL Certificate Issues

**Symptoms**:
- HTTPS not working
- Certificate expired warnings

**Diagnosis**:
```bash
# Check certificate expiration
openssl x509 -enddate -noout -in /path/to/cert.pem

# Test SSL connection
openssl s_client -connect happycmdb.example.com:443
```

**Solutions**:
1. **Certificate expired**: Renew certificate (Let's Encrypt or CA)
2. **Wrong certificate path**: Verify `NGINX_SSL_CERT_PATH` in `.env`
3. **Certificate chain incomplete**: Add intermediate certificates

---

## Emergency Contacts

### On-Call Rotation

| Role | Primary | Secondary | Phone |
|------|---------|-----------|-------|
| **Platform Engineer** | John Doe | Jane Smith | +1-555-0100 |
| **Database Admin** | Bob Johnson | Alice Williams | +1-555-0200 |
| **DevOps Lead** | Charlie Brown | Diana Prince | +1-555-0300 |
| **Product Owner** | Eve Davis | Frank Miller | +1-555-0400 |

### Escalation Path

1. **Level 1** (0-15 min): On-call Platform Engineer
2. **Level 2** (15-30 min): DevOps Lead + Database Admin
3. **Level 3** (30-60 min): Product Owner + CTO

### Communication Channels

- **Slack**: `#happycmdb-deployments`
- **Slack (Incidents)**: `#happycmdb-incidents`
- **PagerDuty**: HappyCMDB Production Service
- **Email**: happycmdb-ops@example.com

---

## Deployment Schedule

### Regular Deployments

| Environment | Day | Time (UTC) | Duration |
|------------|-----|-----------|----------|
| **Staging** | Monday-Friday | 10:00 AM | 30 min |
| **Production** | Wednesday | 2:00 PM | 2 hours |

### Maintenance Windows

| Type | Day | Time (UTC) | Frequency |
|------|-----|-----------|-----------|
| **Planned Maintenance** | Sunday | 2:00 AM - 6:00 AM | Monthly |
| **Emergency Maintenance** | As needed | Communicated 1h before | As needed |

### Deployment Freeze Periods

- Week before major holidays
- End-of-quarter (last week)
- During major industry events
- Company-wide freeze periods

---

## Appendix

### A. Environment Variables Reference

See `.env.example` for complete list.

**Critical Production Variables**:
```bash
NODE_ENV=production
LOG_LEVEL=warn
SSL_ENABLED=true
JWT_SECRET=<SECURE_SECRET>
ENCRYPTION_KEY=<SECURE_KEY>
```

### B. Deployment Logs Location

```
logs/
├── deployment-staging-YYYYMMDD-HHMMSS.log
├── deployment-production-YYYYMMDD-HHMMSS.log
└── rollback-YYYYMMDD-HHMMSS.log
```

### C. Backup Locations

```
/var/backups/happycmdb/
├── staging/
│   └── YYYYMMDD-HHMMSS/
│       ├── neo4j-backup.tar.gz
│       ├── postgres-backup.sql.gz
│       └── git-commit.txt
└── production/
    └── YYYYMMDD-HHMMSS/
        ├── neo4j-backup.tar.gz
        ├── postgres-backup.sql.gz
        ├── docker-compose-state.yml
        └── git-commit.txt
```

### D. Useful Commands

```bash
# View all containers
docker-compose -f infrastructure/docker/docker-compose.yml ps

# Follow all logs
docker-compose -f infrastructure/docker/docker-compose.yml logs -f

# Restart specific service
docker restart cmdb-api-server

# Execute command in container
docker exec -it cmdb-api-server bash

# View Neo4j browser
open http://localhost:7474

# Check API health
curl http://localhost:3000/api/v1/health | jq

# View deployment history
cat DEPLOYMENT_HISTORY.txt

# List git tags (releases)
git tag --sort=-creatordate | head -10
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 2.0 | 2025-10-19 | Platform Team | Initial runbook for v2.0 deployment automation |

---

**Questions or Issues?**
Contact: happycmdb-ops@example.com
Documentation: http://localhost:8080
