---
title: CLI Commands Reference
description: Complete reference for all HappyCMDB CLI commands
---

# CLI Commands Reference

Complete reference for all HappyCMDB command-line interface commands.

## Worker Management

### Start Workers

```bash
# Start all workers with schedulers
cmdb worker start all -s

# Start discovery workers only
cmdb worker start discovery

# Start ETL workers only
cmdb worker start etl

# Start specific provider worker
cmdb worker start aws-discovery-worker

# Start without schedulers
cmdb worker start all
```

### Stop Workers

```bash
# Stop all workers
cmdb worker stop all

# Stop discovery workers
cmdb worker stop discovery

# Stop ETL workers
cmdb worker stop etl

# Stop specific worker
cmdb worker stop aws-discovery-worker
```

### Worker Status & Control

```bash
# Check worker status
cmdb worker status

# Check health
cmdb worker health

# Pause a worker
cmdb worker pause aws-discovery-worker

# Resume a worker
cmdb worker resume aws-discovery-worker

# Restart a worker
cmdb worker restart aws-discovery-worker
```

## Job Management

### List Jobs

```bash
# List jobs in a queue
cmdb jobs list discovery:aws

# List with status filter
cmdb jobs list discovery:aws -s failed
cmdb jobs list discovery:aws -s completed
cmdb jobs list discovery:aws -s active

# Limit results
cmdb jobs list discovery:aws -l 50

# List all jobs
cmdb jobs list --all
```

### Run Jobs

```bash
# Run discovery job
cmdb jobs run:discovery aws
cmdb jobs run:discovery azure
cmdb jobs run:discovery gcp

# Run discovery with config
cmdb jobs run:discovery aws -c '{"regions":["us-east-1"]}'
cmdb jobs run:discovery azure -c '{"regions":["eastus"]}'

# Run ETL job
cmdb jobs run:etl sync
cmdb jobs run:etl full-refresh
cmdb jobs run:etl change-detection
cmdb jobs run:etl reconciliation

# Run ETL with config
cmdb jobs run:etl sync -c '{"batchSize":2000}'
```

### Job Status & Control

```bash
# Check job status
cmdb jobs status discovery:aws <job-id>
cmdb jobs status etl:sync <job-id>

# Get job logs
cmdb jobs logs <job-id>

# Retry failed job
cmdb jobs retry discovery:aws <job-id>

# Cancel job
cmdb jobs cancel discovery:aws <job-id>

# Clean completed jobs
cmdb jobs clean discovery:aws
cmdb jobs clean etl:sync
```

### Queue Statistics

```bash
# Get all queue statistics
cmdb jobs stats

# Get specific queue stats
cmdb jobs stats discovery:aws
cmdb jobs stats etl:sync

# Get queue metrics
cmdb jobs metrics discovery:aws

# Get worker status
cmdb jobs workers
```

## Data Mart Operations

### Status & Health

```bash
# Check data mart health
cmdb datamart status

# Get statistics
cmdb datamart stats

# Validate integrity
cmdb datamart validate

# Validate with specific checks
cmdb datamart validate --check-counts
cmdb datamart validate --check-relationships
cmdb datamart validate --check-orphans
cmdb datamart validate --check-counts --check-relationships --check-orphans
```

### ETL Operations

```bash
# Trigger incremental sync
cmdb datamart sync

# Incremental sync with wait
cmdb datamart sync --wait

# Sync since specific date
cmdb datamart sync --since 2025-09-30T00:00:00Z

# Sync specific CI types
cmdb datamart sync --types "server,application,database"

# Custom batch size
cmdb datamart sync --batch-size 200

# Full refresh (destructive)
cmdb datamart refresh --confirm

# Full refresh with wait
cmdb datamart refresh --confirm --wait
```

### Reconciliation

```bash
# Run reconciliation (manual review)
cmdb datamart reconcile

# Auto-resolve with strategy
cmdb datamart reconcile --strategy neo4j-wins --auto-resolve
cmdb datamart reconcile --strategy postgres-wins --auto-resolve

# Reconcile specific CIs
cmdb datamart reconcile --ci-ids "ci-123,ci-456"

# Check data age
cmdb datamart reconcile --max-age 12

# Force reconciliation
cmdb datamart reconcile --force
```

### Job Management

```bash
# Check job status
cmdb datamart job-status <job-id>

# List recent jobs
cmdb datamart jobs

# List failed jobs
cmdb datamart jobs --status failed

# Limit results
cmdb datamart jobs --limit 20
```

## Analytics Commands

### Summary & Dashboards

```bash
# Dashboard summary
cmdb analytics summary

# Summary as JSON
cmdb analytics summary --json

# Summary with date range
cmdb analytics summary --start-date 2025-09-01 --end-date 2025-09-30
```

### CI Analytics

```bash
# CI count by type
cmdb analytics by-type

# CI count by environment
cmdb analytics by-env

# CI count by status
cmdb analytics by-status

# Detailed CI breakdown
cmdb analytics inventory --detailed
```

### Change Analytics

```bash
# Get change history
cmdb analytics changes

# Changes for specific CI
cmdb analytics changes --ci-id ci-123

# Limit results
cmdb analytics changes --limit 100

# Changes by date range
cmdb analytics changes --start-date 2025-09-01 --end-date 2025-09-30

# Changes by type
cmdb analytics changes --change-type update
```

### Relationship Analytics

```bash
# Relationship statistics
cmdb analytics relationships

# Top connected CIs
cmdb analytics relationships --top 20

# Relationship matrix
cmdb analytics relationships --matrix

# Specific relationship type
cmdb analytics relationships --type DEPENDS_ON
```

### Custom Queries

```bash
# Discovery statistics
cmdb analytics query discovery-stats
cmdb analytics query discovery-stats --start-date 2025-09-01 --end-date 2025-09-30

# Discovery timeline
cmdb analytics query discovery-timeline
cmdb analytics query discovery-timeline --interval day --limit 30

# Top connected CIs
cmdb analytics query top-connected --limit 20 --direction both
cmdb analytics query top-connected --limit 10 --direction incoming
cmdb analytics query top-connected --limit 10 --direction outgoing

# Dependency depth analysis
cmdb analytics query dependency-depth
cmdb analytics query dependency-depth --json

# Orphaned CIs
cmdb analytics query orphaned-cis
```

## Health Checks

```bash
# Overall system health
cmdb health check

# Health check with details
cmdb health check --verbose

# Check specific component
cmdb health check neo4j
cmdb health check postgresql
cmdb health check redis
cmdb health check api

# Health check as JSON
cmdb health check --json
```

## Discovery Management

```bash
# Trigger discovery scan
cmdb discovery scan --provider aws
cmdb discovery scan --provider azure
cmdb discovery scan --provider gcp

# Scan specific region
cmdb discovery scan --provider aws --region us-east-1

# Scan with custom config
cmdb discovery scan --provider aws --config '{"services":["ec2","rds"]}'

# List discovery schedules
cmdb discovery schedules

# Update schedule
cmdb discovery schedule update aws --cron "*/30 * * * *"

# Disable schedule
cmdb discovery schedule disable aws

# Enable schedule
cmdb discovery schedule enable aws

# Test provider connection
cmdb discovery test aws
cmdb discovery test azure
cmdb discovery test gcp
```

## Configuration Management

```bash
# Show current configuration
cmdb config show

# Show configuration as JSON
cmdb config show --json

# Set configuration value
cmdb config set discovery.concurrency 10
cmdb config set etl.batch_size 2000

# Get configuration value
cmdb config get discovery.concurrency

# Reset configuration
cmdb config reset

# Export configuration
cmdb config export > config-backup.json

# Import configuration
cmdb config import config-backup.json

# Validate configuration
cmdb config validate
```

## Database Operations

```bash
# Run database migrations
cmdb db migrate

# Rollback migration
cmdb db rollback

# Reset database (destructive)
cmdb db reset --confirm

# Seed test data
cmdb db seed

# Backup database
cmdb db backup
cmdb db backup --output /backups/manual-backup.dump

# Restore database
cmdb db restore /backups/manual-backup.dump

# Database statistics
cmdb db stats
```

## Logs

```bash
# Tail logs
cmdb logs tail

# Tail specific service
cmdb logs tail --service api-server
cmdb logs tail --service discovery-engine
cmdb logs tail --service etl-processor

# Filter by level
cmdb logs tail --level error
cmdb logs tail --level warn

# Show last N lines
cmdb logs show --lines 1000

# Show logs since time
cmdb logs show --since "1 hour ago"
cmdb logs show --since "2025-09-30T00:00:00Z"

# Export logs
cmdb logs export --output logs-$(date +%Y%m%d).log
cmdb logs export --service api-server --since "24 hours ago"
```

## User Management

```bash
# List users
cmdb user list

# Create user
cmdb user create --email admin@example.com --name "Admin User" --role admin

# Update user
cmdb user update <user-id> --role operator
cmdb user update <user-id> --name "New Name"

# Delete user
cmdb user delete <user-id>

# Reset password
cmdb user reset-password <user-id>

# List API keys
cmdb user api-keys list

# Create API key
cmdb user api-keys create --name "CI/CD Pipeline" --scopes "read,write"

# Revoke API key
cmdb user api-keys revoke <key-id>
```

## Version & Info

```bash
# Show version
cmdb version

# Show version with details
cmdb version --verbose

# Show system information
cmdb info

# Show system information as JSON
cmdb info --json
```

## Common Options

Most commands support these common options:

```bash
# Output format
--json              # Output as JSON
--yaml              # Output as YAML
--table             # Output as table (default)

# Verbosity
--verbose, -v       # Verbose output
--quiet, -q         # Quiet mode (errors only)
--debug             # Debug mode

# Configuration
--config <file>     # Use custom config file
--env <env>         # Use specific environment

# Help
--help, -h          # Show help
```

## Examples

### Complete Discovery Workflow

```bash
# 1. Check system health
cmdb health check

# 2. Start workers
cmdb worker start all -s

# 3. Check worker status
cmdb worker status

# 4. Run discovery
cmdb jobs run:discovery aws

# 5. Monitor job
cmdb jobs status discovery:aws <job-id>

# 6. Check queue stats
cmdb jobs stats discovery:aws

# 7. Trigger ETL sync
cmdb datamart sync --wait

# 8. Validate data
cmdb datamart validate --check-counts

# 9. View analytics
cmdb analytics summary
```

### Troubleshooting Workflow

```bash
# 1. Check system health
cmdb health check --verbose

# 2. Check logs for errors
cmdb logs tail --level error

# 3. Check worker status
cmdb worker status

# 4. Check failed jobs
cmdb jobs list discovery:aws -s failed

# 5. Get job details
cmdb jobs status discovery:aws <job-id>

# 6. Check queue depth
cmdb jobs stats

# 7. Retry failed job
cmdb jobs retry discovery:aws <job-id>
```

### Maintenance Workflow

```bash
# 1. Backup database
cmdb db backup --output /backups/daily-backup.dump

# 2. Run ETL sync
cmdb datamart sync --wait

# 3. Validate data integrity
cmdb datamart validate --check-counts --check-relationships

# 4. Run reconciliation
cmdb datamart reconcile --auto-resolve

# 5. Clean old jobs
cmdb jobs clean discovery:aws
cmdb jobs clean etl:sync

# 6. View system stats
cmdb analytics summary
cmdb db stats
```

## Environment Variables for CLI

```bash
# API endpoint
export CMDB_API_URL=https://cmdb.example.com

# API authentication
export CMDB_API_KEY=your-api-key

# Default output format
export CMDB_OUTPUT_FORMAT=json

# Default config file
export CMDB_CONFIG_FILE=/etc/cmdb/config.yaml

# Log level
export CMDB_LOG_LEVEL=info
```

## See Also

- [BullMQ Queue Management](/components/bullmq)
- [Data Mart Operations](/components/data-mart)
- [Daily Operations Guide](/operations/daily-operations)
- [Troubleshooting Guide](/operations/troubleshooting)
- [Environment Variables](/configuration/environment-variables)
