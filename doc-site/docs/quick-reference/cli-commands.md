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

::: warning Jobs CLI tenant boundary
`cmdb jobs list`, `status`, `retry` and `cancel` only see and change jobs owned by your
organization. They call the authenticated `/api/v1/jobs` routes and need a JWT
(`--token <jwt>` or `CMDB_ACCESS_TOKEN`) or an API key (the global `--key <key>` option or
`CMDB_API_KEY`); without one they exit nonzero with
`Jobs API authentication required (--key or --token)`. Each command takes an actual queue
name such as `discovery-nmap` or `etl-sync` (not `discovery:aws`), and there is no
tokenless or `--all` listing. A foreign, missing or organization-less job ID reads the same
as any other unavailable job, and raw worker results, progress, failure reasons, stack
traces and job configuration are never printed. Direct Redis or database credentials are
infrastructure access, not a tenant identity.

`cmdb jobs stats` and `cmdb jobs run:etl` are unavailable: they exit nonzero with
`Queue operations require the authenticated API; global operations unavailable` without
contacting BullMQ or the scheduler, until a separately authorized platform-operations API
exists (HP1-S6/P-6). See the repository README, "Jobs CLI tenant boundary".
:::

### List Jobs

```bash
# List your organization's waiting jobs in a queue (API key as a global option)
cmdb --key "$CMDB_API_KEY" jobs list discovery-nmap

# Filter by state (waiting, active, completed, failed) and limit (1-100), with a JWT
cmdb jobs list discovery-nmap -s failed --token "$CMDB_ACCESS_TOKEN"
cmdb jobs list etl-sync -s completed -l 50 --token "$CMDB_ACCESS_TOKEN"
```

### Run Jobs

```bash
# Queue Nmap discovery for your organization (requires the write permission)
cmdb jobs run:discovery nmap --token "$CMDB_ACCESS_TOKEN"
cmdb jobs run:discovery nmap -c '{"targets":["<public-cidr>"]}' --token "$CMDB_ACCESS_TOKEN"

# Unavailable: exits nonzero with the fixed refusal above (HP1-S6/P-6)
cmdb jobs run:etl sync
```

The API accepts `nmap`, `active-directory` and `snmp` discovery; `ssh` returns
`Credential-backed discovery execution unavailable` (HP1-S5), and cloud providers are not
triggerable through this route. Loopback, link-local, private (RFC1918/ULA) and metadata
targets are refused (see the README discovery egress restriction).

### Job Status & Control

```bash
# Status of one of your jobs (no raw worker output)
cmdb jobs status discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"

# Retry or cancel one of your jobs (requires the write permission)
cmdb jobs retry discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"
cmdb jobs cancel etl-sync <job-id> --token "$CMDB_ACCESS_TOKEN"
```

Retry and cancel on the `discovery-active-directory`, `discovery-snmp` and `discovery-ai`
queues return `Queue mutation unavailable`.

### Queue Statistics

```bash
# Unavailable: exits nonzero with the fixed refusal above (HP1-S6/P-6)
cmdb jobs stats
cmdb jobs stats discovery-nmap
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

# 4. Run discovery for your organization (JWT or --key required)
cmdb jobs run:discovery nmap --token "$CMDB_ACCESS_TOKEN"

# 5. Monitor job
cmdb jobs status discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"

# 6. (Queue stats are unavailable: `cmdb jobs stats` exits nonzero, HP1-S6/P-6)

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

# 4. Check your organization's failed jobs
cmdb jobs list discovery-nmap -s failed --token "$CMDB_ACCESS_TOKEN"

# 5. Get job details (no raw worker output)
cmdb jobs status discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"

# 6. (Queue depth is unavailable: `cmdb jobs stats` exits nonzero, HP1-S6/P-6)

# 7. Retry failed job
cmdb jobs retry discovery-nmap <job-id> --token "$CMDB_ACCESS_TOKEN"
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

# 5. (Cleaning queues is a global operation and unavailable, HP1-S6/P-6)

# 6. View system stats
cmdb analytics summary
cmdb db stats
```

## Environment Variables for CLI

```bash
# API endpoint (including /api/v1; default http://localhost:3000/api/v1)
export CMDB_API_URL=https://cmdb.example.com/api/v1

# API authentication: an API key, or a JWT for the jobs commands
# (`cmdb jobs list/status/retry/cancel/run:discovery` need one of the two)
export CMDB_API_KEY=your-api-key
export CMDB_ACCESS_TOKEN=your-jwt

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
