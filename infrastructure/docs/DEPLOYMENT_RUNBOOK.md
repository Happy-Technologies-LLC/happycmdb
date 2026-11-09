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

#### Replacing the live PostgreSQL database (`--replace-live-postgres`)

Without the flag, the rollback restores PostgreSQL only when the `cmdb` database does not exist. If it exists, the rollback refuses before Neo4j is touched, and nothing changes. To drop and replace the live database, pass the flag as the third argument and type both confirmations (`ROLLBACK`, then `REPLACE cmdb`). No environment variable enables this.

```bash
bash infrastructure/scripts/rollback.sh <BACKUP_TIMESTAMP> database-only --replace-live-postgres
```

Before Neo4j is touched, the rollback:
- runs the copy of `restore-postgres.sh` it saved in the safety snapshot before Step 4's `git checkout`. If that script prints no preflight result (it predates `--preflight`), the rollback refuses;
- stops `api-server` (database-only mode; full mode has already stopped it);
- refuses if any other client session is still connected to `cmdb` (nothing is terminated);
- writes and verifies a pre-restore backup at `<BACKUP_DIR>/safety-snapshot-<ts>/postgres-pre-restore-cmdb.sql.gz`. The check is `gzip -t` plus the pg_dump completion line (a trailing `\unrestrict` line from a newer pg_dump is accepted). Run on its own, `restore-postgres.sh` refuses a `--pre-restore-backup` path that already exists, or one that is the `--file` being restored.

Any refusal at this point exits 1 with Neo4j and PostgreSQL untouched, and `api-server` is restarted.

Next it restores Neo4j, re-checks the client sessions, and runs `DROP DATABASE` (no `FORCE`) and `CREATE DATABASE`. It loads the backup with `ON_ERROR_STOP=1 --single-transaction`, between `timescaledb_pre_restore()` and `timescaledb_post_restore()`. Last, it compares the row count of every table in the backup.

After a successful replace, the rollback summary says `Rollback complete - POST-RESTORE GRANTS PENDING`, and its first next step is the grant step below. The exit code is still 0.

| `restore-postgres.sh` exit | State | Action |
|---|---|---|
| 0 | Replaced and the row counts match. **Grants NOT restored.** | Run the post-restore grant step below. |
| 1 | Nothing changed. | Fix the cause it printed and rerun. |
| 3 | Dropped, then CREATE or the load failed: `cmdb` is absent or empty. | Keep the app stopped. Run the printed return command to load the pre-restore backup. |
| 4 | Loaded, but the row counts differ from the backup. | Keep the app stopped. Investigate, or run the printed return command. |

On exit 3 or 4 the rollback leaves `api-server` stopped. Neo4j has already been restored, so it no longer matches PostgreSQL. The return command reloads the pre-restore backup and takes a fresh backup first:
`restore-postgres.sh --database cmdb --replace-live --file <pre-restore-backup> --pre-restore-backup <new-file>`.

**Client versions:** the host `psql` and `pg_dump` must be at least as new as the `pg_dump` that wrote the backup. A psql older than a 16.10+ pg_dump fails on the dump's `\restrict` line, and it would fail after the DROP. `restore-postgres.sh` reads the backup's `Dumped by pg_dump version` header and refuses (exit 1, nothing changed) when the local psql is older.

#### Replacing the live Neo4j database (`--replace-live-neo4j`)

The deploy writes `<BACKUP_PATH>/neo4j-backup.dump.gz` (a `neo4j-admin database dump` of the `neo4j` database, gzipped) and, when the node and relationship counts were the same before and after the dump, `neo4j-backup.counts`. Neo4j Community Edition dumps and loads only a stopped DBMS, so the deploy stops the Neo4j container for the dump and starts it again. Step 2 takes `NEO4J_PASSWORD` from the environment or, if unset, from `.env.production`; when neither sets it, the deploy stops before Neo4j is touched. The backup also refuses (nothing stopped) when the running Neo4j rejects that login.

Community Edition has one database, `neo4j`, and it always exists, so restoring it always replaces the live database. Without `--replace-live-neo4j` the rollback refuses (exit 1, nothing changed) whenever the backup has a Neo4j dump. With it, type `ROLLBACK`, then `REPLACE neo4j` (and `REPLACE cmdb` if `--replace-live-postgres` is also given; the two flags go in any order). No environment variable enables this.

```bash
bash infrastructure/scripts/rollback.sh <BACKUP_TIMESTAMP> database-only --replace-live-neo4j
```

When the backup has a Neo4j dump, the rollback stops `api-server` first (as for `--replace-live-postgres`). Before anything is replaced, it runs `restore-neo4j.sh --preflight` from the safety snapshot: the dump is verified (`gzip -t`, then `neo4j-admin database load --info` reads it), Neo4j is running and accepts the cypher-shell login, and the pre-restore dump path `<BACKUP_DIR>/safety-snapshot-<ts>/neo4j-pre-restore.dump.gz` is new. Then `restore-neo4j.sh --replace-live` stops Neo4j, dumps the live database to the pre-restore dump and verifies it, loads the backup with `--overwrite-destination=true`, starts Neo4j, and compares the counts with `neo4j-backup.counts` (without that file it prints the counts and does not compare). If the script is interrupted (INT, TERM, HUP) before the load, it starts Neo4j again (if that start fails it prints `STOPPED` and the `docker start` command). If it is interrupted during the load, it leaves Neo4j STOPPED, prints the `--replace-stopped` command, and exits 3.

| `restore-neo4j.sh` exit | State | Action |
|---|---|---|
| 0 | Replaced; online, and the counts match. | None. |
| 1 | Nothing changed; Neo4j started again. | Fix the cause it printed and rerun. |
| 3 | The load failed or was interrupted: Neo4j is STOPPED and its store may be partly overwritten. | Keep the app stopped. Run the printed command: `restore-neo4j.sh --replace-stopped --file <pre-restore dump>`. |
| 4 | Loaded, but Neo4j is not online or the counts differ. | Keep the app stopped. Investigate, or run the printed command: it puts the pre-restore dump back (taking a fresh one first), or, when the container did not start and is STOPPED, it is the `--replace-stopped` command. |

On exit 3 or 4 (and 129/130/143, an interrupted restore, which the rollback treats as 3) the rollback leaves `api-server` stopped; on exit 1 it restarts it, and after a successful restore it starts it again. On any exit but 1 it also prints the pre-restore dump path, and on any exit but 1 or 4 the `--replace-stopped --file <pre-restore dump>` command, itself, so the command survives a Ctrl-C or hang-up that signals the whole process group (the rollback's `tee` ignores INT; the restore's EXIT trap ignores INT, TERM, HUP and PIPE and fixes its exit status before it writes anything). Any other exit means the Neo4j state is unknown: check `docker ps -a` before starting anything.

#### Post-restore grants (mandatory)

`backup-postgres.sh` dumps with `--no-acl`, so a restore never brings back GRANT/REVOKE. The restoring login (`cmdb_user`) owns every restored object. Until the grants are re-applied, other roles have no access: `cmdb_app` (045-048), `metabase_readonly` (032, 033, 039), and `cmdb_user` when it is not the restoring login. Functions are also back to PUBLIC EXECUTE.

After every successful restore, `restore-postgres.sh` prints a bash block from `# MANDATORY POST-RESTORE GRANT STEP` to `# END GRANT STEP`; it never runs it. Stop the API and every other client first: 046-048 take brief ACCESS EXCLUSIVE locks. Save the block to a file and run it with `bash` as `cmdb_user` (`PGPASSWORD` exported), from the root of a checkout of the commit the backup was taken at. Every command uses `psql -X -v ON_ERROR_STOP=1 --single-transaction`. The block stops at the first failure, prints `GRANT STEP FAILED at <step or migration file>` and exits 1. Grants are restored only when it prints `GRANT STEP COMPLETE`. In order, it:
1. Revokes PUBLIC EXECUTE on `cmdb.fn_business_service_health(uuid)`, `cmdb.fn_tbm_tower_summary(uuid)` and `discovery_definition_migrations_append_only()` (010, 033, 041). This runs before any step gives a non-owner login schema USAGE.
2. Re-runs the ACL migrations that `cmdb.schema_migrations` records, in order: 032, 033, 034, 039, 044, 045, then 046, 047 and 048 (guarded no-op migrations here, run for their grants). Three are special:
   - 032 grants `metabase_readonly` the cross-tenant `v_business_service_health`, which 033 revokes. The same transaction as 032 revokes it again, so a failing 033 cannot leave the BI role with it.
   - 033 refuses a SECURITY DEFINER health function, and the dump restored the DEFINER that 033 itself set. In the same transaction the block resets the function to INVOKER and then runs 033, which checks the owner and sets DEFINER again.
   - 034 refuses to run while its restored guard table `cmdb.hap668_acl_prior` exists, and that table must keep the original ACL snapshot. Only its `cmdb_user` grants are replayed; its PUBLIC revokes need nothing after a `--no-acl` restore.

Where `infrastructure/database/metabase-init.sql` created `metabase_readonly`, 032, 033 and 039 re-grant its view and function grants. Its schema USAGE and `get_fiscal_*` EXECUTE grants exist only in `metabase-init.sql`, which is not re-runnable (it creates the user), so BI may still lack them after a restore: re-apply those grants from that file by hand. The staging path (`deploy/build01-staging-app-login.sql` plus migrations) does not create that role, so there is nothing to restore there.

Then restart the services that log in as those roles. Until the block has printed `GRANT STEP COMPLETE`, do not treat the application as working.

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
docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j \
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
bash infrastructure/scripts/restore-neo4j.sh --file /var/backups/happycmdb/production/<TIMESTAMP>/neo4j-backup.dump.gz --check
gunzip -t /var/backups/happycmdb/production/<TIMESTAMP>/postgres-backup.sql.gz
```

**Solutions**:
1. **Backup corrupted**: Use previous backup
2. **Manual rollback**:
   ```bash
   # Restore Neo4j while its container exists (it stops and restarts it; see --replace-live-neo4j above)
   bash infrastructure/scripts/restore-neo4j.sh --file <BACKUP_PATH>/neo4j-backup.dump.gz \
     --replace-live --pre-restore-backup <NEW_FILE>.dump.gz

   # Stop containers
   docker-compose -f infrastructure/docker/docker-compose.yml down

   # Checkout previous git commit
   git checkout <PREVIOUS_COMMIT>

   # Manually restore PostgreSQL
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
│       ├── neo4j-backup.dump.gz
│       ├── postgres-backup.sql.gz
│       └── git-commit.txt
└── production/
    └── YYYYMMDD-HHMMSS/
        ├── neo4j-backup.dump.gz
        ├── neo4j-backup.counts
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
