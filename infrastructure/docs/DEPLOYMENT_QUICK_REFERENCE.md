# HappyCMDB Deployment - Quick Reference

**TL;DR**: Fast reference guide for common deployment tasks.

---

## Deployment Commands

### Staging Deployment

```bash
# Full staging deployment (automated)
bash infrastructure/scripts/deploy-staging.sh

# With pre-validation
bash infrastructure/scripts/pre-deploy-checklist.sh staging && \
bash infrastructure/scripts/deploy-staging.sh
```

**Duration**: ~10-15 minutes

### Production Deployment

```bash
# Full production deployment (blue-green)
bash infrastructure/scripts/deploy-production.sh

# Manual steps required - you will be prompted for approval at:
# 1. Initial confirmation
# 2. Database migration
# 3. Green environment validation
# 4. Traffic shift steps (20%, 40%, 60%, 80%)
# 5. Final validation
```

**Duration**: ~1-2 hours (including monitoring)

---

## Pre-Flight Checks

```bash
# Quick validation
bash infrastructure/scripts/pre-deploy-checklist.sh <staging|production>

# Check test status
npm test

# Verify backups exist
ls -lh /var/backups/happycmdb/production/

# Check disk space
df -h /

# Verify SSL certificates (production)
openssl x509 -enddate -noout -in /path/to/cert.pem
```

---

## Rollback

### Fast Rollback

```bash
# List available backups
ls -lh /var/backups/happycmdb/production/

# Full rollback (containers + databases)
bash infrastructure/scripts/rollback.sh <BACKUP_TIMESTAMP> full

# Example
bash infrastructure/scripts/rollback.sh 20251019-143000 full
```

**Duration**: ~15-20 minutes

### Partial Rollback

```bash
# Containers only (keep database)
bash infrastructure/scripts/rollback.sh <TIMESTAMP> containers-only

# Database only (keep containers)
bash infrastructure/scripts/rollback.sh <TIMESTAMP> database-only
```

---

## Health Checks

### Service Health

```bash
# API health
curl http://localhost:3000/api/v1/health | jq

# Web UI
curl -I http://localhost:3001

# All containers
docker-compose -f infrastructure/docker/docker-compose.yml ps
```

### Database Health

```bash
# Neo4j
docker exec cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD> "RETURN 1"

# PostgreSQL
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SELECT 1"

# Redis
docker exec cmdb-redis redis-cli ping
```

### Post-Deployment Validation

```bash
# Full validation suite
bash infrastructure/scripts/post-deploy-validation.sh <staging|production>
```

---

## Monitoring

### Logs

```bash
# Follow all logs
docker-compose -f infrastructure/docker/docker-compose.yml logs -f

# API server logs only
docker logs -f cmdb-api-server

# Filter for errors
docker logs cmdb-api-server --tail 100 | grep -i error

# Deployment logs
tail -f logs/deployment-*.log
```

### Performance

```bash
# Container stats
docker stats --no-stream cmdb-api-server cmdb-neo4j cmdb-postgres

# API response time
curl -w "Time: %{time_total}s\n" -o /dev/null -s http://localhost:3000/api/v1/health

# Memory usage
docker exec cmdb-api-server ps aux --sort=-%mem | head -10
```

---

## Common Issues - Fast Fix

### Issue: Health check fails

```bash
# Check logs
docker logs cmdb-api-server --tail 50

# Restart container
docker restart cmdb-api-server

# If still fails - check database connections
docker exec cmdb-api-server nc -zv cmdb-neo4j 7687
```

### Issue: Build fails

```bash
# Clean build cache
find packages -name "tsconfig.tsbuildinfo" -delete
find packages -name "dist" -type d -exec rm -rf {} +

# Rebuild
npm run build
```

### Issue: Out of disk space

```bash
# Clean Docker cache
docker system prune -a -f

# Remove old images
docker images | grep happycmdb | tail -n +5 | awk '{print $3}' | xargs docker rmi -f

# Clean old backups (keep last 7)
find /var/backups/happycmdb -type d -mtime +7 -exec rm -rf {} +
```

### Issue: Database connection fails

```bash
# Restart database containers
docker restart cmdb-neo4j cmdb-postgres cmdb-redis

# Wait 30 seconds
sleep 30

# Test connections again
bash infrastructure/scripts/post-deploy-validation.sh staging
```

---

## Emergency Procedures

### Complete System Restart

```bash
# Stop all containers
docker-compose -f infrastructure/docker/docker-compose.yml down

# Clean volumes (CAUTION: deletes data!)
docker-compose -f infrastructure/docker/docker-compose.yml down -v

# Restore from backup
bash infrastructure/scripts/restore-neo4j.sh <BACKUP_FILE>
bash infrastructure/scripts/restore-postgres.sh <BACKUP_FILE>

# Restart everything
docker-compose -f infrastructure/docker/docker-compose.yml up -d

# Wait and validate
sleep 60
bash infrastructure/scripts/post-deploy-validation.sh production
```

### Fast Recovery (No Database Loss)

```bash
# Stop app containers only
docker stop cmdb-api-server cmdb-web-ui

# Checkout previous version
git checkout <PREVIOUS_COMMIT>

# Rebuild
npm run build

# Restart
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server web-ui
```

---

## Backup & Restore

### Create Backup

```bash
# All databases
bash infrastructure/scripts/backup-all.sh

# Neo4j only
bash infrastructure/scripts/backup-neo4j.sh /path/to/backup.tar.gz

# PostgreSQL only
bash infrastructure/scripts/backup-postgres.sh /path/to/backup.sql.gz

# Verify backup
bash infrastructure/scripts/backup-health-check.sh
```

### Restore Backup

```bash
# Neo4j
bash infrastructure/scripts/restore-neo4j.sh /path/to/backup.tar.gz

# PostgreSQL
bash infrastructure/scripts/restore-postgres.sh /path/to/backup.sql.gz
```

---

## Useful Shortcuts

### Container Management

```bash
# Restart specific service
docker restart cmdb-<service>

# View container logs (last 100 lines)
docker logs --tail 100 cmdb-<service>

# Execute shell in container
docker exec -it cmdb-<service> bash

# Remove and recreate container
docker stop cmdb-<service> && docker rm cmdb-<service> && \
docker-compose -f infrastructure/docker/docker-compose.yml up -d <service>
```

### Database Shortcuts

```bash
# Neo4j shell
docker exec -it cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD>

# PostgreSQL shell
docker exec -it cmdb-postgres psql -U cmdb_user -d cmdb

# Redis CLI
docker exec -it cmdb-redis redis-cli
```

### Quick Queries

```bash
# CI count
docker exec cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD> \
  "MATCH (n:CI) RETURN count(n) as total"

# Connector count
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SELECT COUNT(*) FROM connectors"

# Recent discovery jobs
curl http://localhost:3000/api/v1/discovery/jobs?limit=10 | jq
```

---

## Environment Files

### Load Environment

```bash
# Staging
export $(cat .env.staging | xargs)

# Production
export $(cat .env.production | xargs)
```

### Critical Variables

```bash
NODE_ENV=production
LOG_LEVEL=warn
NEO4J_URI=bolt://localhost:7687
NEO4J_PASSWORD=<SECURE>
POSTGRES_PASSWORD=<SECURE>
JWT_SECRET=<SECURE>
ENCRYPTION_KEY=<SECURE>
SSL_ENABLED=true
```

---

## Deployment Checklist (Printable)

### Staging

- [ ] Run `pre-deploy-checklist.sh staging`
- [ ] Run `deploy-staging.sh`
- [ ] Monitor logs for 10 minutes
- [ ] Run `post-deploy-validation.sh staging`
- [ ] Notify QA team

### Production

- [ ] Staging tested successfully
- [ ] Run `pre-deploy-checklist.sh production`
- [ ] Create fresh backup
- [ ] Notify stakeholders (30 min before)
- [ ] Run `deploy-production.sh`
- [ ] Approve each manual step
- [ ] Monitor during traffic shift
- [ ] Run `post-deploy-validation.sh production`
- [ ] Monitor for 1 hour
- [ ] Notify stakeholders (complete)

---

## Contact

**Deployment Issues**: Slack #happycmdb-deployments
**Emergencies**: PagerDuty - HappyCMDB Production Service
**Documentation**: http://localhost:8080
**Full Runbook**: infrastructure/docs/DEPLOYMENT_RUNBOOK.md
