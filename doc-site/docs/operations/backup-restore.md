# Database Backup and Restore

HappyCMDB includes a comprehensive automated backup system for both PostgreSQL and Neo4j databases. This guide covers backup configuration, execution, monitoring, and restore procedures.

## Overview

The backup system provides:

- **Automated daily backups** for PostgreSQL and Neo4j
- **Retention policies** (7 daily, 4 weekly, 12 monthly)
- **Compression** (gzip) for reduced storage
- **Cloud upload** support (AWS S3, Azure Blob)
- **Backup verification** and integrity checks
- **Health monitoring** with alerting
- **Easy restore** with verification

## Quick Start

### 1. Configure Environment Variables

Add backup configuration to your `.env` file:

```bash
# Backup directory
BACKUP_DIR=/var/backups/happycmdb
BACKUP_LOG_DIR=/var/log/happycmdb/backups

# Retention policy
BACKUP_RETENTION_DAILY=7
BACKUP_RETENTION_WEEKLY=4
BACKUP_RETENTION_MONTHLY=12

# Database credentials
POSTGRES_PASSWORD=your-postgres-password
NEO4J_PASSWORD=your-neo4j-password

# Optional: Cloud upload
BACKUP_UPLOAD_ENABLED=false
BACKUP_STORAGE_TYPE=s3
BACKUP_S3_BUCKET=my-backup-bucket
```

### 2. Create Backup Directories

```bash
sudo mkdir -p /var/backups/happycmdb/{postgres,neo4j}/{daily,weekly,monthly}
sudo mkdir -p /var/log/happycmdb/backups
sudo chmod 755 /var/backups/happycmdb
sudo chmod 755 /var/log/happycmdb/backups
```

### 3. Run Manual Backup

```bash
# Backup both databases
./infrastructure/scripts/backup-all.sh

# Or backup individually
./infrastructure/scripts/backup-postgres.sh
./infrastructure/scripts/backup-neo4j.sh
```

## Backup Scripts

### Backup All Databases

**Script**: `/infrastructure/scripts/backup-all.sh`

Orchestrates backup of both PostgreSQL and Neo4j databases.

```bash
./infrastructure/scripts/backup-all.sh
```

**Features**:
- Runs both database backups sequentially
- Centralized logging
- Unified error handling
- Summary report
- Notifications on success/failure

### PostgreSQL Backup

**Script**: `/infrastructure/scripts/backup-postgres.sh`

Creates full PostgreSQL database dump using `pg_dump`.

```bash
./infrastructure/scripts/backup-postgres.sh
```

**Process**:
1. Connects to PostgreSQL using `pg_dump`
2. Creates plain SQL dump
3. Compresses with gzip (level 9)
4. Verifies backup integrity
5. Uploads to cloud storage (if enabled)
6. Creates weekly/monthly copies
7. Applies retention policy
8. Sends notification

**Backup filename**: `postgres_cmdb_YYYYMMDD_HHMMSS.sql.gz`

### Neo4j Backup

**Script**: `/infrastructure/scripts/backup-neo4j.sh`

Creates Neo4j database dump using `neo4j-admin dump`.

```bash
./infrastructure/scripts/backup-neo4j.sh
```

**Process**:
1. Executes `neo4j-admin database dump` inside Docker container
2. Copies dump file from container to host
3. Compresses with gzip (level 9)
4. Verifies backup integrity
5. Uploads to cloud storage (if enabled)
6. Creates weekly/monthly copies
7. Applies retention policy
8. Sends notification

**Backup filename**: `neo4j_cmdb_YYYYMMDD_HHMMSS.dump.gz`

## Restore Scripts

### PostgreSQL Restore

**Script**: `/infrastructure/scripts/restore-postgres.sh`

Restores PostgreSQL database from compressed backup.

```bash
# List available backups
./infrastructure/scripts/restore-postgres.sh --list

# Restore latest daily backup
./infrastructure/scripts/restore-postgres.sh \
  --file $(ls -t /var/backups/happycmdb/postgres/daily/*.sql.gz | head -1) \
  --verify

# Restore specific backup (with database drop)
./infrastructure/scripts/restore-postgres.sh \
  --file /var/backups/happycmdb/postgres/daily/postgres_cmdb_20250118_020000.sql.gz \
  --drop \
  --verify

# Restore to different database
./infrastructure/scripts/restore-postgres.sh \
  --file backup.sql.gz \
  --database cmdb_test
```

**Options**:
- `--file FILE` - Backup file to restore (required)
- `--database NAME` - Target database name (default: cmdb)
- `--host HOST` - PostgreSQL host (default: localhost)
- `--port PORT` - PostgreSQL port (default: 5432)
- `--user USER` - PostgreSQL user (default: cmdb_user)
- `--drop` - Drop existing database before restore
- `--no-create` - Don't create database (assume it exists)
- `--verify` - Verify restore by checking table counts
- `--list` - List available backups

**Restore Process**:
1. Verifies backup file integrity
2. Checks database connection
3. Drops existing database (if `--drop`)
4. Creates new database
5. Decompresses and restores backup
6. Verifies restoration (if `--verify`)

### Neo4j Restore

**Script**: `/infrastructure/scripts/restore-neo4j.sh`

Restores Neo4j database from compressed dump.

```bash
# List available backups
./infrastructure/scripts/restore-neo4j.sh --list

# Restore latest daily backup
./infrastructure/scripts/restore-neo4j.sh \
  --file $(ls -t /var/backups/happycmdb/neo4j/daily/*.dump.gz | head -1) \
  --force \
  --verify

# Restore specific backup
./infrastructure/scripts/restore-neo4j.sh \
  --file /var/backups/happycmdb/neo4j/daily/neo4j_cmdb_20250118_020000.dump.gz \
  --force \
  --verify
```

**Options**:
- `--file FILE` - Backup file to restore (required)
- `--database NAME` - Target database name (default: cmdb)
- `--container NAME` - Neo4j container name (default: cmdb-neo4j)
- `--force` - Force restore (overwrite existing database)
- `--verify` - Verify restore by checking node/relationship counts
- `--list` - List available backups

**Restore Process**:
1. Verifies backup file integrity
2. Checks Neo4j container is running
3. Stops database
4. Drops existing database (if `--force`)
5. Decompresses backup
6. Copies dump to container
7. Restores using `neo4j-admin database load`
8. Starts database
9. Verifies restoration (if `--verify`)

## Automated Backup Scheduling

### Option 1: Cron (Traditional)

#### Install Cron Job

```bash
# Edit cron configuration
sudo nano /infrastructure/config/cron/happycmdb-backup.cron

# Update SCRIPT_DIR path
SCRIPT_DIR=/path/to/happycmdb/infrastructure/scripts

# Install crontab
sudo crontab -u root /path/to/happycmdb/infrastructure/config/cron/happycmdb-backup.cron
```

#### Cron Schedule

```cron
# Full backup - Daily at 2:00 AM
0 2 * * * /path/to/backup-all.sh

# Health check - Every 6 hours
0 */6 * * * /path/to/backup-health-check.sh
```

#### View Installed Crontab

```bash
sudo crontab -u root -l
```

### Option 2: Systemd Timers (Modern)

#### Install Systemd Units

```bash
# Copy service and timer files
sudo cp infrastructure/config/systemd/*.service /etc/systemd/system/
sudo cp infrastructure/config/systemd/*.timer /etc/systemd/system/

# Edit service files to update paths
sudo nano /etc/systemd/system/happycmdb-backup.service
# Update WorkingDirectory and ExecStart paths

# Create environment file
sudo mkdir -p /etc/happycmdb
sudo nano /etc/happycmdb/backup.env
# Add your configuration (see .env.example)

# Reload systemd
sudo systemctl daemon-reload

# Enable and start timers
sudo systemctl enable happycmdb-backup.timer
sudo systemctl start happycmdb-backup.timer

sudo systemctl enable happycmdb-backup-healthcheck.timer
sudo systemctl start happycmdb-backup-healthcheck.timer
```

#### Systemd Timer Schedule

- **Backup**: Daily at 2:00 AM (persistent, 15 min randomized delay)
- **Health Check**: Every 6 hours (00:00, 06:00, 12:00, 18:00)

#### Manage Systemd Timers

```bash
# Check timer status
sudo systemctl status happycmdb-backup.timer
sudo systemctl list-timers

# Run backup manually
sudo systemctl start happycmdb-backup.service

# View logs
sudo journalctl -u happycmdb-backup.service -f
sudo tail -f /var/log/happycmdb/backups/backup.log

# Stop/disable timer
sudo systemctl stop happycmdb-backup.timer
sudo systemctl disable happycmdb-backup.timer
```

## Backup Monitoring

### Health Check Script

**Script**: `/infrastructure/scripts/backup-health-check.sh`

Monitors backup health and sends alerts.

```bash
./infrastructure/scripts/backup-health-check.sh
```

**Checks Performed**:
- Backup directory existence
- Latest backup age (alerts if older than 25 hours)
- Backup count (alerts if fewer than 3 daily backups)
- Backup integrity (tests gzip compression)
- Disk usage (alerts if exceeds 85%)
- Backup log file errors

**Exit Codes**:
- `0` - HEALTHY (all checks passed)
- `1` - WARNING (non-critical issues)
- `2` - CRITICAL (serious issues requiring attention)
- `3` - UNKNOWN (script error)

### Notifications

Configure webhook notifications for backup events:

```bash
# In .env file
BACKUP_NOTIFICATION_ENABLED=true
BACKUP_NOTIFICATION_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

**Notification Events**:
- Backup success/failure
- Health check warnings/critical issues
- Cloud upload failures
- Backup integrity failures

**Webhook Payload**:
```json
{
  "service": "HappyCMDB PostgreSQL Backup",
  "status": "SUCCESS",
  "message": "PostgreSQL backup completed successfully (cmdb)",
  "timestamp": "2025-01-18T02:00:00Z"
}
```

## Cloud Storage Upload

### AWS S3 Configuration

```bash
# In .env file
BACKUP_UPLOAD_ENABLED=true
BACKUP_STORAGE_TYPE=s3
BACKUP_S3_BUCKET=my-backup-bucket
BACKUP_S3_PREFIX=happycmdb
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_DEFAULT_REGION=us-east-1
```

**Requirements**:
- AWS CLI installed (`apt install awscli` or `brew install awscli`)
- IAM user with S3 PutObject permissions
- S3 bucket created

**S3 Bucket Path**:
- PostgreSQL: `s3://my-backup-bucket/happycmdb/postgres_cmdb_YYYYMMDD_HHMMSS.sql.gz`
- Neo4j: `s3://my-backup-bucket/happycmdb/neo4j_cmdb_YYYYMMDD_HHMMSS.dump.gz`

### Azure Blob Storage Configuration

```bash
# In .env file
BACKUP_UPLOAD_ENABLED=true
BACKUP_STORAGE_TYPE=azure
BACKUP_AZURE_CONTAINER=happycmdb-backups
BACKUP_AZURE_PREFIX=happycmdb
AZURE_STORAGE_ACCOUNT=your-storage-account
AZURE_STORAGE_ACCESS_KEY=your-storage-access-key
```

**Requirements**:
- Azure CLI installed (`curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash`)
- Storage account created
- Container created

## Retention Policy

### Default Retention

- **Daily backups**: 7 days (last 7 backups)
- **Weekly backups**: 4 weeks (last 4 Sunday backups)
- **Monthly backups**: 12 months (last 12 backups from 1st of month)

### Customize Retention

```bash
# In .env file
BACKUP_RETENTION_DAILY=14      # Keep 14 daily backups
BACKUP_RETENTION_WEEKLY=8      # Keep 8 weekly backups
BACKUP_RETENTION_MONTHLY=24    # Keep 24 monthly backups
```

### How Retention Works

1. **Daily backups**: Created every day, cleaned after N days
2. **Weekly backups**: Copy of Sunday's daily backup
3. **Monthly backups**: Copy of 1st day of month's daily backup
4. **Cleanup**: Runs after each backup (uses `find -mtime`)

## Backup Verification

### Manual Verification

```bash
# Test backup integrity
gzip -t /var/backups/happycmdb/postgres/daily/postgres_cmdb_20250118_020000.sql.gz

# View backup contents (first 100 lines)
gunzip -c /var/backups/happycmdb/postgres/daily/postgres_cmdb_20250118_020000.sql.gz | head -100

# Check backup size
du -h /var/backups/happycmdb/postgres/daily/*.sql.gz
```

### Test Restore

Periodically test restore to ensure backups are recoverable:

```bash
# Restore to test database
./infrastructure/scripts/restore-postgres.sh \
  --file $(ls -t /var/backups/happycmdb/postgres/daily/*.sql.gz | head -1) \
  --database cmdb_test \
  --drop \
  --verify

# Verify data
psql -U cmdb_user -d cmdb_test -c "SELECT COUNT(*) FROM information_schema.tables;"
```

## Docker Integration

HappyCMDB's Docker Compose configuration includes backup volume mounts:

```yaml
services:
  neo4j:
    volumes:
      - ${BACKUP_DIR:-/var/backups/happycmdb}/neo4j:/backups

  postgres:
    volumes:
      - ${BACKUP_DIR:-/var/backups/happycmdb}/postgres:/backups
```

This allows:
- Backups stored on host (persist after container restart)
- Easy access to backup files
- Cloud upload from host

## Troubleshooting

### Backup Failures

**PostgreSQL connection failed**:
```bash
# Check database is running
docker ps | grep cmdb-postgres

# Test connection manually
PGPASSWORD=your-password psql -h localhost -p 5432 -U cmdb_user -d cmdb -c "SELECT 1"
```

**Neo4j container not running**:
```bash
# Check container status
docker ps -a | grep cmdb-neo4j

# Start container
docker start cmdb-neo4j
```

**Permission denied**:
```bash
# Ensure backup directory is writable
sudo chown -R $(whoami):$(whoami) /var/backups/happycmdb
sudo chmod 755 /var/backups/happycmdb
```

### Restore Failures

**Database already exists**:
```bash
# Use --drop flag to drop existing database
./infrastructure/scripts/restore-postgres.sh --file backup.sql.gz --drop
```

**Out of disk space**:
```bash
# Check available space
df -h /var/backups/happycmdb

# Clean old backups manually
find /var/backups/happycmdb -name "*.gz" -mtime +30 -delete
```

### Health Check Issues

**Backup age warning**:
- Check if backup cron job is running
- View backup logs: `tail -f /var/log/happycmdb/backups/backup.log`
- Run manual backup to test

**Disk usage high**:
- Reduce retention policy
- Enable cloud upload and delete local backups after upload
- Add larger disk to backup mount

**Backup integrity failed**:
- Backup file may be corrupted
- Run manual backup
- Check disk space during backup

## Best Practices

### Security

1. **Encrypt backups**: Use encrypted cloud storage (S3 SSE, Azure encryption)
2. **Secure credentials**: Store passwords in `/etc/happycmdb/backup.env` with `chmod 600`
3. **Off-site backups**: Enable cloud upload for disaster recovery
4. **Access control**: Restrict backup directory permissions (`chmod 700`)

### Performance

1. **Schedule wisely**: Run backups during low-traffic hours (2:00 AM)
2. **Compression**: Use gzip level 9 for maximum compression
3. **Incremental backups**: Consider point-in-time recovery for large databases
4. **Parallel uploads**: Upload to cloud asynchronously

### Monitoring

1. **Health checks**: Run every 6 hours to catch issues early
2. **Notifications**: Configure webhooks for Slack/Teams/PagerDuty
3. **Log retention**: Keep backup logs for 30 days minimum
4. **Test restores**: Monthly test restores to verify recoverability

### Disaster Recovery

1. **Document restore procedures**: Ensure team knows how to restore
2. **RTO/RPO**: Define recovery time/point objectives (e.g., 1 hour RTO, 24 hour RPO)
3. **Multiple regions**: Store backups in multiple AWS regions or Azure regions
4. **Backup the backups**: Replicate cloud backups across accounts

## Example: Complete Backup Setup

```bash
# 1. Create directories
sudo mkdir -p /var/backups/happycmdb/{postgres,neo4j}/{daily,weekly,monthly}
sudo mkdir -p /var/log/happycmdb/backups

# 2. Configure environment
cat >> .env <<EOF
BACKUP_DIR=/var/backups/happycmdb
BACKUP_RETENTION_DAILY=7
BACKUP_UPLOAD_ENABLED=true
BACKUP_STORAGE_TYPE=s3
BACKUP_S3_BUCKET=my-happycmdb-backups
BACKUP_NOTIFICATION_ENABLED=true
BACKUP_NOTIFICATION_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
EOF

# 3. Install systemd timers
sudo cp infrastructure/config/systemd/*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable happycmdb-backup.timer
sudo systemctl start happycmdb-backup.timer

# 4. Run initial backup
./infrastructure/scripts/backup-all.sh

# 5. Verify backup
./infrastructure/scripts/backup-health-check.sh

# 6. Test restore
./infrastructure/scripts/restore-postgres.sh \
  --file $(ls -t /var/backups/happycmdb/postgres/daily/*.sql.gz | head -1) \
  --database cmdb_test \
  --drop \
  --verify
```

## References

- [PostgreSQL pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
- [Neo4j backup documentation](https://neo4j.com/docs/operations-manual/current/backup-restore/)
- [AWS S3 CLI documentation](https://docs.aws.amazon.com/cli/latest/reference/s3/)
- [Azure Blob CLI documentation](https://docs.microsoft.com/en-us/cli/azure/storage/blob)
- [Systemd timer documentation](https://www.freedesktop.org/software/systemd/man/systemd.timer.html)
