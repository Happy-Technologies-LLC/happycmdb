# Runbook: Backup Failure

**Alert Name**: `DatabaseBackupFailed`, `BackupSizeTooSmall`
**Severity**: Critical
**Component**: backup, neo4j, postgresql
**Initial Response Time**: 2 hours

## Symptoms

- No successful backup in >24 hours
- Backup file size unexpectedly small (<50% of previous backup)
- Backup job logs showing errors
- Backup verification failing
- Missing backup files in storage

## Impact

- **Data Recovery Risk**: Cannot restore from backup in disaster scenario
- **Compliance Violation**: Backup policies not being met
- **Business Continuity**: Potential data loss in case of failure
- **RTO/RPO at Risk**: Recovery objectives cannot be met

## Diagnosis

### 1. Check Backup Status

```bash
# Check last successful backup timestamp
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT * FROM backup_status ORDER BY completed_at DESC LIMIT 5;"

# Check backup files on disk
ls -lh /backup/neo4j/ | tail -10
ls -lh /backup/postgresql/ | tail -10

# Check backup file sizes
du -sh /backup/neo4j/*.tar.gz | tail -5
du -sh /backup/postgresql/*.sql.gz | tail -5

# Verify backup age
find /backup -name "*.tar.gz" -o -name "*.sql.gz" -mtime -1 -ls
```

### 2. Check Backup Job Logs

```bash
# Check backup job logs
docker logs cmdb-backup-job --tail=100

# Check system logs for backup-related errors
journalctl -u backup-neo4j.service --since "24 hours ago"
journalctl -u backup-postgresql.service --since "24 hours ago"

# Check cron logs
grep -i backup /var/log/cron
```

### 3. Check Disk Space

```bash
# Check disk space on backup volume
df -h /backup

# Check if backup volume is mounted
mount | grep backup

# Check disk space on database volumes
df -h /var/lib/neo4j
df -h /var/lib/postgresql
```

### 4. Check Database Status

```bash
# Verify databases are running
docker ps | grep -E "neo4j|postgres"

# Check if databases can be queried
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1;"
docker exec cmdb-postgres pg_isready -U cmdb_user

# Check for database locks
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "SELECT * FROM pg_locks WHERE NOT granted;"
```

### 5. Check Backup Storage

```bash
# If using cloud storage (S3, Azure Blob, GCS)
# AWS S3
aws s3 ls s3://happycmdb-backups/neo4j/ --recursive | tail -10
aws s3 ls s3://happycmdb-backups/postgresql/ --recursive | tail -10

# Check storage access permissions
aws s3 cp /tmp/test.txt s3://happycmdb-backups/test.txt
```

## Resolution Steps

### Step 1: Manual Backup - Neo4j

```bash
# Stop Neo4j (if using offline backup)
docker stop cmdb-neo4j

# Create backup directory
sudo mkdir -p /backup/neo4j/manual-$(date +%Y%m%d-%H%M%S)

# Perform backup (offline)
docker run --rm \
  -v /var/lib/docker/volumes/neo4j-data/_data:/data \
  -v /backup/neo4j:/backup \
  neo4j:5.15 \
  neo4j-admin database backup --to-path=/backup/manual-$(date +%Y%m%d-%H%M%S) neo4j

# Or online backup (Neo4j Enterprise)
neo4j-admin backup \
  --backup-dir=/backup/neo4j/manual-$(date +%Y%m%d-%H%M%S) \
  --database=neo4j \
  --from=localhost:6362

# Compress backup
tar czf /backup/neo4j/neo4j-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /backup/neo4j manual-$(date +%Y%m%d-%H%M%S)

# Restart Neo4j
docker start cmdb-neo4j

# Verify backup
tar tzf /backup/neo4j/neo4j-backup-$(date +%Y%m%d-%H%M%S).tar.gz | head
```

### Step 2: Manual Backup - PostgreSQL

```bash
# Create backup
docker exec cmdb-postgres pg_dump \
  -U cmdb_user \
  -d cmdb \
  --format=custom \
  --compress=9 \
  --file=/tmp/cmdb-backup-$(date +%Y%m%d-%H%M%S).dump

# Copy backup out of container
docker cp cmdb-postgres:/tmp/cmdb-backup-$(date +%Y%m%d-%H%M%S).dump \
  /backup/postgresql/

# Compress backup
gzip /backup/postgresql/cmdb-backup-$(date +%Y%m%d-%H%M%S).dump

# Verify backup
pg_restore --list /backup/postgresql/cmdb-backup-$(date +%Y%m%d-%H%M%S).dump.gz | head
```

### Step 3: Upload to Cloud Storage (if applicable)

```bash
# Upload to S3
aws s3 cp /backup/neo4j/neo4j-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  s3://happycmdb-backups/neo4j/

aws s3 cp /backup/postgresql/cmdb-backup-$(date +%Y%m%d-%H%M%S).dump.gz \
  s3://happycmdb-backups/postgresql/

# Verify upload
aws s3 ls s3://happycmdb-backups/neo4j/ | tail -5
aws s3 ls s3://happycmdb-backups/postgresql/ | tail -5
```

### Step 4: Fix Backup Job Issues

**If disk space is the issue**:
```bash
# Clean up old backups (keep last 30 days)
find /backup -name "*.tar.gz" -o -name "*.dump.gz" -mtime +30 -delete

# Rotate logs
journalctl --vacuum-time=7d

# Expand backup volume if needed
# (AWS EBS example)
aws ec2 modify-volume --volume-id vol-xxxxx --size 500
```

**If permissions issue**:
```bash
# Fix backup directory permissions
sudo chown -R 999:999 /backup/postgresql  # PostgreSQL UID
sudo chown -R 7474:7474 /backup/neo4j     # Neo4j UID
sudo chmod -R 755 /backup
```

**If backup script failing**:
```bash
# Review backup script
cat /usr/local/bin/backup-databases.sh

# Test backup script manually
sudo /usr/local/bin/backup-databases.sh

# Check cron schedule
crontab -l | grep backup

# Fix cron schedule if needed
crontab -e
# Add: 0 2 * * * /usr/local/bin/backup-databases.sh >> /var/log/backup.log 2>&1
```

### Step 5: Restore from Backup (Testing)

**Test Neo4j restore**:
```bash
# Stop Neo4j
docker stop cmdb-neo4j

# Clear existing data (TESTING ONLY!)
sudo rm -rf /var/lib/docker/volumes/neo4j-data/_data/*

# Extract backup
tar xzf /backup/neo4j/neo4j-backup-YYYYMMDD-HHMMSS.tar.gz -C /tmp/

# Restore
neo4j-admin database restore \
  --from-path=/tmp/manual-YYYYMMDD-HHMMSS \
  --database=neo4j

# Start Neo4j
docker start cmdb-neo4j

# Verify data
docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
  "MATCH (n) RETURN count(n);"
```

**Test PostgreSQL restore**:
```bash
# Create test database
docker exec cmdb-postgres psql -U cmdb_user -c "CREATE DATABASE cmdb_test;"

# Restore backup to test database
gunzip -c /backup/postgresql/cmdb-backup-YYYYMMDD-HHMMSS.dump.gz | \
docker exec -i cmdb-postgres pg_restore \
  -U cmdb_user \
  -d cmdb_test \
  --no-owner \
  --no-acl

# Verify restore
docker exec cmdb-postgres psql -U cmdb_user -d cmdb_test -c \
  "SELECT count(*) FROM connectors;"

# Drop test database
docker exec cmdb-postgres psql -U cmdb_user -c "DROP DATABASE cmdb_test;"
```

### Step 6: Set Up Automated Backup (if missing)

Create backup script (`/usr/local/bin/backup-databases.sh`):

```bash
#!/bin/bash
set -e

BACKUP_DIR="/backup"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RETENTION_DAYS=30

# Neo4j backup
echo "Starting Neo4j backup..."
docker exec cmdb-neo4j neo4j-admin database dump \
  --database=neo4j \
  --to-path=/tmp/neo4j-backup-${TIMESTAMP}

docker cp cmdb-neo4j:/tmp/neo4j-backup-${TIMESTAMP} ${BACKUP_DIR}/neo4j/
tar czf ${BACKUP_DIR}/neo4j/neo4j-backup-${TIMESTAMP}.tar.gz \
  -C ${BACKUP_DIR}/neo4j neo4j-backup-${TIMESTAMP}
rm -rf ${BACKUP_DIR}/neo4j/neo4j-backup-${TIMESTAMP}

# PostgreSQL backup
echo "Starting PostgreSQL backup..."
docker exec cmdb-postgres pg_dump \
  -U cmdb_user \
  -d cmdb \
  --format=custom \
  --compress=9 \
  > ${BACKUP_DIR}/postgresql/cmdb-backup-${TIMESTAMP}.dump

gzip ${BACKUP_DIR}/postgresql/cmdb-backup-${TIMESTAMP}.dump

# Upload to S3 (if configured)
if [ -n "$S3_BUCKET" ]; then
  aws s3 cp ${BACKUP_DIR}/neo4j/neo4j-backup-${TIMESTAMP}.tar.gz \
    s3://${S3_BUCKET}/neo4j/
  aws s3 cp ${BACKUP_DIR}/postgresql/cmdb-backup-${TIMESTAMP}.dump.gz \
    s3://${S3_BUCKET}/postgresql/
fi

# Clean up old backups
find ${BACKUP_DIR} -name "*.tar.gz" -o -name "*.dump.gz" -mtime +${RETENTION_DAYS} -delete

# Update backup status
docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c \
  "INSERT INTO backup_status (backup_type, status, completed_at) VALUES ('full', 'success', NOW());"

echo "Backup completed successfully"
```

Set up cron job:
```bash
sudo chmod +x /usr/local/bin/backup-databases.sh
crontab -e
# Add: 0 2 * * * /usr/local/bin/backup-databases.sh >> /var/log/backup.log 2>&1
```

## Verification

After resolution:

1. **Backup Files Exist**: Recent backup files on disk and cloud storage
2. **Backup Size Normal**: File sizes consistent with previous backups
3. **Backup Restorable**: Test restore completes successfully
4. **Automated Backups Working**: Cron job executes without errors
5. **Monitoring Updated**: Backup metrics show success
6. **Logs Clean**: No errors in backup logs

## Escalation

If unable to create backup after 4 hours:

1. **Escalate to**: Database Administrator / Senior Infrastructure Engineer
2. **Provide**:
   - Backup job logs (full)
   - Disk space status
   - Database status
   - Error messages
   - Last successful backup date
3. **Consider**:
   - Database replication if available
   - Snapshot-based backup (cloud)
   - External backup service

## Post-Incident Actions

1. **Root Cause Analysis**: Document why backup failed
2. **Backup Testing**: Regular restore testing (monthly)
3. **Monitoring**: Add backup size and success rate monitoring
4. **Retention Policy**: Review and document backup retention
5. **Disaster Recovery Plan**: Update DR documentation
6. **Backup Redundancy**: Consider multiple backup locations
7. **Automation**: Implement backup verification automation

## Common Causes

| Cause | Frequency | Prevention |
|-------|-----------|------------|
| Disk space full | High | Monitor disk usage, automated cleanup |
| Permission issues | Medium | Proper permission setup, testing |
| Database locks | Medium | Run backups during low-usage periods |
| Backup script errors | Medium | Regular script testing, error handling |
| Cloud storage auth failure | Low | Credential rotation, monitoring |
| Network issues | Low | Retry logic, local + remote backups |

## Related Runbooks

- [Database Connection Issues](./database-connection-issues.md)
- [Performance Degradation](./performance-degradation.md)

## Useful Commands

```bash
# Check backup status
ls -lh /backup/*/ | tail -20

# Verify backup integrity
tar tzf /backup/neo4j/neo4j-backup-YYYYMMDD.tar.gz > /dev/null && echo "OK" || echo "CORRUPTED"

# Compare backup sizes
du -sh /backup/neo4j/*.tar.gz | tail -5

# Test cloud backup
aws s3 ls s3://happycmdb-backups/ --recursive | tail -20

# Manual backup all databases
/usr/local/bin/backup-databases.sh

# View backup logs
tail -f /var/log/backup.log
```

## Monitoring Queries

```promql
# Time since last successful backup
time() - last_successful_backup_timestamp_seconds

# Backup file size
backup_size_bytes

# Backup success rate
rate(backup_success_total[24h]) / rate(backup_total[24h])
```
