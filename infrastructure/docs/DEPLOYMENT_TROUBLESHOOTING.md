# HappyCMDB Deployment - Troubleshooting Guide

**Version**: 2.0
**Last Updated**: 2025-10-19

---

## Table of Contents

1. [Pre-Deployment Issues](#pre-deployment-issues)
2. [Build and Compilation Issues](#build-and-compilation-issues)
3. [Docker Issues](#docker-issues)
4. [Database Issues](#database-issues)
5. [Network and Connectivity Issues](#network-and-connectivity-issues)
6. [Health Check Failures](#health-check-failures)
7. [Performance Issues](#performance-issues)
8. [Rollback Issues](#rollback-issues)
9. [Production-Specific Issues](#production-specific-issues)
10. [Recovery Procedures](#recovery-procedures)

---

## Pre-Deployment Issues

### Issue: Pre-deployment validation fails - uncommitted changes

**Error Message**:
```
✗ Uncommitted changes detected - commit or stash before deploying
```

**Cause**: Local repository has uncommitted changes.

**Solution**:
```bash
# Option 1: Commit changes
git add .
git commit -m "Pre-deployment commit"
git push origin <branch>

# Option 2: Stash changes
git stash save "Pre-deployment stash $(date)"

# Then re-run validation
bash infrastructure/scripts/pre-deploy-checklist.sh <env>
```

---

### Issue: Branch not up to date with remote

**Error Message**:
```
✗ Branch is not up to date with remote - pull latest changes
```

**Solution**:
```bash
# Pull latest changes
git pull origin <branch>

# If conflicts occur
git status
# Resolve conflicts manually
git add <resolved-files>
git commit -m "Merge remote changes"

# Re-run validation
bash infrastructure/scripts/pre-deploy-checklist.sh <env>
```

---

### Issue: Tests failing

**Error Message**:
```
✗ Test failures detected - fix before deploying
```

**Diagnosis**:
```bash
# Run tests with verbose output
npm test -- --verbose

# Run specific test file
npm test -- packages/api-server/__tests__/health.test.ts

# Check for test dependencies
npm install --production=false
```

**Common Causes**:
1. **Missing environment variables**: Copy `.env.example` to `.env.test`
2. **Database not running**: Start test database containers
3. **Stale test data**: Clear test database and re-seed

**Solution**:
```bash
# Fix test environment
cp .env.example .env.test

# Start test databases
docker-compose -f infrastructure/docker/docker-compose.test.yml up -d

# Re-run tests
npm test
```

---

### Issue: Backup too old (>24 hours)

**Error Message**:
```
✗ Latest Neo4j backup is 36 hours old (>24h) - create fresh backup
```

**Solution**:
```bash
# Create fresh backup
bash infrastructure/scripts/backup-all.sh

# Verify backup
bash infrastructure/scripts/backup-health-check.sh

# Re-run validation
bash infrastructure/scripts/pre-deploy-checklist.sh production
```

---

### Issue: SSL certificate expiring soon

**Error Message**:
```
⚠ SSL certificate expires in 25 days - consider renewal
```

**Solution**:
```bash
# Renew Let's Encrypt certificate
sudo certbot renew

# Or for manual certificate
# 1. Generate CSR
openssl req -new -key /path/to/private.key -out /path/to/request.csr

# 2. Submit CSR to CA
# 3. Download new certificate
# 4. Update NGINX_SSL_CERT_PATH in .env.production
# 5. Restart web UI
docker restart cmdb-web-ui
```

---

## Build and Compilation Issues

### Issue: TypeScript compilation errors

**Error Message**:
```
error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'
```

**Diagnosis**:
```bash
# Check TypeScript version
npx tsc --version

# Run build for specific package
cd packages/<package-name>
npm run build

# Check for type definition issues
npm list @types/*
```

**Common Causes**:
1. **Type definition mismatch**: Update `@types/*` packages
2. **Circular dependencies**: Refactor imports
3. **Strict mode errors**: Fix type issues or adjust `tsconfig.json`

**Solution**:
```bash
# Update type definitions
npm update @types/node @types/express @types/jest

# Clean and rebuild
find packages -name "tsconfig.tsbuildinfo" -delete
find packages -name "dist" -type d -exec rm -rf {} +
npm run build

# If still failing - check specific package
cd packages/<failing-package>
npx tsc --noEmit  # Type check without emitting
```

---

### Issue: npm install fails - dependency conflict

**Error Message**:
```
npm ERR! ERESOLVE unable to resolve dependency tree
```

**Solution**:
```bash
# Option 1: Use legacy peer deps
npm install --legacy-peer-deps

# Option 2: Force resolution
npm install --force

# Option 3: Clean and reinstall
rm -rf node_modules package-lock.json
npm cache clean --force
npm install

# For workspaces
rm -rf packages/*/node_modules
npm install
```

---

### Issue: Build succeeds but dist folder empty

**Cause**: TypeScript incremental build cache causing issues.

**Solution**:
```bash
# Clean build info files
find packages -name "tsconfig.tsbuildinfo" -delete

# Clean dist folders
find packages -name "dist" -type d -exec rm -rf {} +

# Rebuild without cache
npm run build

# Verify dist folders exist
for pkg in common database api-server; do
  if [ -d "packages/$pkg/dist" ]; then
    echo "✓ packages/$pkg/dist exists"
  else
    echo "✗ packages/$pkg/dist missing"
  fi
done
```

---

## Docker Issues

### Issue: Docker daemon not running

**Error Message**:
```
✗ Docker daemon is not running
Cannot connect to the Docker daemon
```

**Solution**:
```bash
# macOS
open -a Docker

# Linux
sudo systemctl start docker
sudo systemctl enable docker

# Verify Docker is running
docker info
```

---

### Issue: Out of disk space

**Error Message**:
```
no space left on device
```

**Diagnosis**:
```bash
# Check disk usage
df -h /

# Check Docker disk usage
docker system df

# Check backup directory size
du -sh /var/backups/happycmdb
```

**Solution**:
```bash
# Clean Docker cache (aggressive)
docker system prune -a -f --volumes

# Remove unused images
docker images --filter "dangling=true" -q | xargs docker rmi

# Remove old backups (keep last 7 days)
find /var/backups/happycmdb -type f -mtime +7 -delete

# Clean old logs
find logs -type f -mtime +30 -delete

# Clean npm cache
npm cache clean --force
```

---

### Issue: Docker build fails - network timeout

**Error Message**:
```
ERROR [internal] load metadata for docker.io/library/node:20-alpine
```

**Solution**:
```bash
# Retry with longer timeout
DOCKER_BUILDKIT=1 docker build --network=host \
  -f infrastructure/docker/Dockerfile.api-server .

# Use alternative registry
docker pull --platform linux/amd64 node:20-alpine

# Check DNS resolution
cat /etc/resolv.conf
nslookup docker.io
```

---

### Issue: Container exits immediately after start

**Diagnosis**:
```bash
# Check exit code
docker ps -a --filter "name=cmdb-api-server"

# View logs
docker logs cmdb-api-server

# Inspect container
docker inspect cmdb-api-server
```

**Common Causes**:
1. **Missing environment variables**: Check `.env` file loaded
2. **Database not ready**: Wait for database containers to be healthy
3. **Port already in use**: Check for conflicting processes

**Solution**:
```bash
# Check environment variables
docker exec cmdb-api-server env | grep NEO4J

# Check port conflicts
lsof -i :3000
netstat -an | grep 3000

# Kill conflicting process
kill -9 <PID>

# Restart container
docker restart cmdb-api-server
```

---

### Issue: Cannot remove container - device or resource busy

**Error Message**:
```
Error response from daemon: container <id>: driver "overlay2" failed to remove root filesystem
```

**Solution**:
```bash
# Force remove container
docker rm -f cmdb-api-server

# If still stuck - restart Docker daemon
# macOS
osascript -e 'quit app "Docker"' && open -a Docker

# Linux
sudo systemctl restart docker

# Then remove container
docker rm -f cmdb-api-server
```

---

## Database Issues

### Issue: Neo4j connection refused

**Error Message**:
```
✗ Neo4j connection failed
Neo4jError: Could not connect to bolt://localhost:7687
```

**Diagnosis**:
```bash
# Check Neo4j container is running
docker ps --filter "name=cmdb-neo4j"

# Check Neo4j logs
docker logs cmdb-neo4j --tail 50

# Test connection
docker exec cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD> "RETURN 1"
```

**Common Causes**:
1. **Container not started**: Start Neo4j container
2. **Wrong password**: Verify `NEO4J_PASSWORD` in `.env`
3. **Port conflict**: Check port 7687 not in use

**Solution**:
```bash
# Restart Neo4j
docker restart cmdb-neo4j
sleep 30  # Wait for initialization

# Verify environment variables
docker exec cmdb-neo4j env | grep NEO4J

# Check port is listening
docker exec cmdb-neo4j netstat -an | grep 7687

# If still failing - check firewall
sudo ufw allow 7687/tcp
```

---

### Issue: PostgreSQL connection pool exhausted

**Error Message**:
```
Error: Connection pool exhausted
Timeout acquiring connection from pool
```

**Diagnosis**:
```bash
# Check active connections
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SELECT count(*) FROM pg_stat_activity"

# Check max connections
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SHOW max_connections"

# Find long-running queries
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SELECT pid, now() - pg_stat_activity.query_start AS duration, query
      FROM pg_stat_activity
      WHERE state = 'active'
      ORDER BY duration DESC"
```

**Solution**:
```bash
# Increase max connections in docker-compose.yml
# Add: command: -c max_connections=100

# Restart PostgreSQL
docker restart cmdb-postgres

# Kill stuck connections
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE state = 'idle' AND now() - query_start > interval '5 minutes'"

# Restart API server to reset connection pool
docker restart cmdb-api-server
```

---

### Issue: Database migration fails - already applied

**Error Message**:
```
Migration '001_initial_schema.sql' has already been applied
```

**Diagnosis**:
```bash
# Check migration status
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "SELECT * FROM schema_migrations ORDER BY version DESC"
```

**Solution**:
```bash
# Option 1: Skip migration (if safe)
# Comment out migration in deployment script

# Option 2: Force re-run (CAUTION)
docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
  -c "DELETE FROM schema_migrations WHERE version = '001_initial_schema'"

# Then re-run migration
npm run db:migrate

# Option 3: Manual rollback
# Apply rollback script if available
```

---

### Issue: Redis OOM (Out of Memory)

**Error Message**:
```
OOM command not allowed when used memory > 'maxmemory'
```

**Diagnosis**:
```bash
# Check Redis memory usage
docker exec cmdb-redis redis-cli INFO memory

# Check maxmemory setting
docker exec cmdb-redis redis-cli CONFIG GET maxmemory
```

**Solution**:
```bash
# Flush old keys
docker exec cmdb-redis redis-cli --scan --pattern "cmdb:cache:*" | \
  xargs -L 1000 docker exec cmdb-redis redis-cli DEL

# Increase maxmemory (in docker-compose.yml)
# Add: command: redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru

# Restart Redis
docker restart cmdb-redis

# Set eviction policy
docker exec cmdb-redis redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

---

## Network and Connectivity Issues

### Issue: API not accessible from host

**Error Message**:
```
curl: (7) Failed to connect to localhost port 3000: Connection refused
```

**Diagnosis**:
```bash
# Check container is running
docker ps --filter "name=cmdb-api-server"

# Check port mapping
docker port cmdb-api-server

# Check process inside container
docker exec cmdb-api-server netstat -an | grep 3000

# Check firewall
sudo ufw status
```

**Solution**:
```bash
# Verify API_HOST and API_PORT in .env
# Should be: API_HOST=0.0.0.0 (not 127.0.0.1)

# Check Docker network
docker network inspect happycmdb-network

# Recreate container with correct ports
docker stop cmdb-api-server
docker rm cmdb-api-server
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server

# Check port binding
lsof -i :3000
```

---

### Issue: Containers cannot communicate

**Error Message**:
```
getaddrinfo ENOTFOUND cmdb-neo4j
```

**Diagnosis**:
```bash
# Check Docker network exists
docker network ls | grep happycmdb

# Check container network attachment
docker inspect cmdb-api-server | jq '.[0].NetworkSettings.Networks'

# Test DNS resolution inside container
docker exec cmdb-api-server nslookup cmdb-neo4j
docker exec cmdb-api-server ping -c 3 cmdb-neo4j
```

**Solution**:
```bash
# Recreate Docker network
docker-compose -f infrastructure/docker/docker-compose.yml down
docker network rm happycmdb-network
docker network create happycmdb-network
docker-compose -f infrastructure/docker/docker-compose.yml up -d

# Or use docker-compose networking
# Ensure services use same docker-compose.yml
```

---

## Health Check Failures

### Issue: API health endpoint returns 503

**Error Message**:
```
✗ API Server failed health check
HTTP 503 Service Unavailable
```

**Diagnosis**:
```bash
# Check API logs
docker logs cmdb-api-server --tail 100 | grep -i error

# Test health endpoint directly
curl -v http://localhost:3000/api/v1/health

# Check dependencies
docker exec cmdb-api-server curl -s http://cmdb-neo4j:7687
docker exec cmdb-api-server curl -s http://cmdb-postgres:5432
```

**Solution**:
```bash
# Wait longer (containers may still be initializing)
sleep 60
curl http://localhost:3000/api/v1/health

# Check database connections
docker exec cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD> "RETURN 1"
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SELECT 1"

# Restart API server
docker restart cmdb-api-server
sleep 30
curl http://localhost:3000/api/v1/health
```

---

### Issue: Health check times out

**Error Message**:
```
Health check timed out after 60 seconds
```

**Cause**: API server is slow to start or database connections are slow.

**Solution**:
```bash
# Increase health check timeout in deployment script
# Or wait longer manually
for i in {1..60}; do
  if curl -sf http://localhost:3000/api/v1/health; then
    echo "Health check passed"
    break
  fi
  echo "Attempt $i/60..."
  sleep 5
done

# Check for resource constraints
docker stats cmdb-api-server --no-stream

# Increase container resources in docker-compose.yml
```

---

## Performance Issues

### Issue: High memory usage

**Symptoms**: Container using >2GB RAM

**Diagnosis**:
```bash
# Check memory usage
docker stats --no-stream cmdb-api-server

# Check for memory leaks
docker exec cmdb-api-server node -e "console.log(process.memoryUsage())"

# Check heap dump
docker exec cmdb-api-server node --expose-gc -e "
  global.gc();
  console.log(process.memoryUsage());
"
```

**Solution**:
```bash
# Increase container memory limit
# In docker-compose.yml:
# services:
#   api-server:
#     mem_limit: 2g

# Tune Node.js heap size
# Add to Dockerfile or environment:
# ENV NODE_OPTIONS="--max-old-space-size=1536"

# Restart with new limits
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server

# Monitor for leaks
watch -n 10 'docker stats --no-stream cmdb-api-server'
```

---

### Issue: Slow API response times

**Symptoms**: API endpoints taking >5 seconds

**Diagnosis**:
```bash
# Measure response time
curl -w "Time: %{time_total}s\n" -o /dev/null -s \
  http://localhost:3000/api/v1/cis?limit=100

# Check database query performance
docker exec cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD> \
  "PROFILE MATCH (n:CI) RETURN n LIMIT 100"

# Check for slow queries
docker logs cmdb-api-server | grep "Query took"
```

**Solution**:
```bash
# Add database indexes
docker exec cmdb-neo4j cypher-shell -u neo4j -p <PASSWORD> \
  "CREATE INDEX ci_name_index IF NOT EXISTS FOR (n:CI) ON (n.ci_name)"

# Tune Neo4j memory
# In docker-compose.yml add:
# NEO4J_dbms_memory_heap_initial__size=512m
# NEO4J_dbms_memory_heap_max__size=2g

# Enable API caching
# Set REDIS_ENABLED=true in .env

# Restart services
docker-compose -f infrastructure/docker/docker-compose.yml restart
```

---

## Rollback Issues

### Issue: Rollback script fails - backup not found

**Error Message**:
```
✗ Backup not found: /var/backups/happycmdb/production/20251019-143000
```

**Solution**:
```bash
# List available backups
ls -lh /var/backups/happycmdb/production/

# Use most recent backup
LATEST_BACKUP=$(ls -t /var/backups/happycmdb/production/ | head -1)
bash infrastructure/scripts/rollback.sh "$LATEST_BACKUP" full

# If no backups exist - manual recovery required
# 1. Check git history for previous working commit
# 2. Checkout that commit
# 3. Rebuild and redeploy
```

---

### Issue: Database restore fails - corrupted backup

**Error Message**:
```
tar: Error is not recoverable: exiting now
```

**Diagnosis**:
```bash
# Verify backup integrity
tar -tzf /var/backups/happycmdb/production/<TIMESTAMP>/neo4j-backup.tar.gz
gunzip -t /var/backups/happycmdb/production/<TIMESTAMP>/postgres-backup.sql.gz
```

**Solution**:
```bash
# Try previous backup
ls -lt /var/backups/happycmdb/production/

# If all backups corrupted - contact DBA team
# May need to restore from cloud storage (S3/Azure)

# Manual recovery
# 1. Stop all containers
# 2. Remove corrupt data volumes
# 3. Restore from known-good backup
# 4. Restart services
```

---

## Production-Specific Issues

### Issue: SSL not working after deployment

**Symptoms**: HTTPS connections fail, certificate errors

**Diagnosis**:
```bash
# Check certificate files exist
ls -l /path/to/ssl/cert.pem /path/to/ssl/key.pem

# Test certificate
openssl x509 -in /path/to/ssl/cert.pem -text -noout

# Check Nginx configuration
docker exec cmdb-web-ui nginx -t

# Check Nginx logs
docker logs cmdb-web-ui | grep -i ssl
```

**Solution**:
```bash
# Verify SSL_ENABLED=true in .env.production
# Verify certificate paths in .env.production

# Reload Nginx configuration
docker exec cmdb-web-ui nginx -s reload

# If still failing - recreate container
docker stop cmdb-web-ui
docker rm cmdb-web-ui
docker-compose -f infrastructure/docker/docker-compose.yml up -d web-ui
```

---

### Issue: Blue-green traffic shift fails

**Symptoms**: Green environment unhealthy during traffic shift

**Solution**:
```bash
# Immediately stop traffic shift
# Revert to 100% blue

# Check green environment logs
docker logs cmdb-api-server-green --tail 100

# Diagnose green environment issue
docker exec cmdb-api-server-green curl http://localhost:3000/api/v1/health

# If fixable - fix and retry
# If not fixable - abort deployment and rollback
bash infrastructure/scripts/rollback.sh <BACKUP_TIMESTAMP> full
```

---

## Recovery Procedures

### Complete System Recovery (Disaster Recovery)

**Scenario**: All containers down, data potentially corrupted.

**Steps**:

1. **Stop everything**:
```bash
docker-compose -f infrastructure/docker/docker-compose.yml down -v
```

2. **Restore from backup**:
```bash
# Find latest good backup
ls -lt /var/backups/happycmdb/production/

# Restore databases
bash infrastructure/scripts/restore-neo4j.sh <BACKUP_PATH>/neo4j-backup.tar.gz
bash infrastructure/scripts/restore-postgres.sh <BACKUP_PATH>/postgres-backup.sql.gz
```

3. **Checkout known-good commit**:
```bash
git checkout <PREVIOUS_COMMIT>
```

4. **Rebuild from scratch**:
```bash
./deploy.sh --clean
```

5. **Validate**:
```bash
bash infrastructure/scripts/post-deploy-validation.sh production
```

---

### Partial Recovery (Containers Only)

**Scenario**: Containers crashed but databases are fine.

**Steps**:

1. **Check database health**:
```bash
docker ps --filter "name=cmdb-neo4j"
docker ps --filter "name=cmdb-postgres"
```

2. **Rebuild app containers only**:
```bash
docker stop cmdb-api-server cmdb-web-ui
docker rm cmdb-api-server cmdb-web-ui

npm run build

docker-compose -f infrastructure/docker/docker-compose.yml build --no-cache api-server web-ui
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server web-ui
```

3. **Validate**:
```bash
bash infrastructure/scripts/post-deploy-validation.sh production
```

---

## Getting Help

### Enable Debug Logging

```bash
# Set in .env
LOG_LEVEL=debug

# Restart API server
docker restart cmdb-api-server

# View debug logs
docker logs -f cmdb-api-server
```

### Collect Diagnostic Information

```bash
# Create diagnostic bundle
mkdir -p /tmp/happycmdb-diagnostics

# Container status
docker-compose -f infrastructure/docker/docker-compose.yml ps > /tmp/happycmdb-diagnostics/containers.txt

# Logs
docker logs cmdb-api-server > /tmp/happycmdb-diagnostics/api-server.log 2>&1
docker logs cmdb-neo4j > /tmp/happycmdb-diagnostics/neo4j.log 2>&1
docker logs cmdb-postgres > /tmp/happycmdb-diagnostics/postgres.log 2>&1

# Configuration
cp .env /tmp/happycmdb-diagnostics/env.txt

# System info
docker info > /tmp/happycmdb-diagnostics/docker-info.txt
df -h > /tmp/happycmdb-diagnostics/disk-usage.txt

# Create tarball
tar -czf happycmdb-diagnostics-$(date +%Y%m%d-%H%M%S).tar.gz -C /tmp happycmdb-diagnostics/
```

### Contact Support

- **Slack**: #happycmdb-support
- **Email**: happycmdb-ops@example.com
- **PagerDuty**: HappyCMDB Production Service
- **Documentation**: http://localhost:8080

---

**Remember**: When in doubt, check the logs first!
