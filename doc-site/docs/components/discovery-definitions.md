---
title: Discovery Definitions
description: Reusable discovery configurations with scheduling and job tracking
---

# Discovery Definitions

Reusable discovery configurations that define what to discover, how to authenticate, and when to run discovery operations.

## Overview

Discovery Definitions are the cornerstone of HappyCMDB's ServiceNow-style discovery architecture. They provide a reusable, schedulable, and auditable way to configure infrastructure discovery operations.

### Benefits Over Ad-Hoc Discovery

| Feature | Ad-Hoc Discovery | Discovery Definitions |
|---------|-----------------|----------------------|
| **Reusability** | ❌ Configure every time | ✅ Configure once, run many times |
| **Scheduling** | ❌ Manual execution only | ✅ Automated with cron patterns |
| **Audit Trail** | ❌ Limited tracking | ✅ Complete history of all runs |
| **Credential Security** | ❌ Credentials in request | ✅ References encrypted credentials |
| **Job History** | ❌ No association | ✅ Track all jobs for definition |
| **Consistency** | ❌ Config drift risk | ✅ Standardized configurations |
| **Reporting** | ❌ Difficult | ✅ Per-definition metrics |

## Architecture

### Data Model

Discovery definitions are stored in PostgreSQL:

```sql
CREATE TABLE discovery_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  provider VARCHAR(50) NOT NULL,  -- 'aws', 'azure', 'gcp', 'ssh', 'nmap'
  credential_id UUID REFERENCES discovery_credentials(id) ON DELETE RESTRICT,
  config JSONB NOT NULL,          -- Provider-specific configuration
  schedule_enabled BOOLEAN DEFAULT false,
  schedule_cron_pattern VARCHAR(100),
  enabled BOOLEAN DEFAULT true,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP,
  CONSTRAINT unique_definition_name UNIQUE(name)
);

CREATE INDEX idx_definitions_provider ON discovery_definitions(provider);
CREATE INDEX idx_definitions_credential ON discovery_definitions(credential_id);
CREATE INDEX idx_definitions_enabled ON discovery_definitions(enabled);
CREATE INDEX idx_definitions_schedule_enabled ON discovery_definitions(schedule_enabled);
```

### Job Association

Each discovery job is linked to its definition:

```sql
CREATE TABLE discovery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID REFERENCES discovery_definitions(id),
  queue_name VARCHAR(100) NOT NULL,
  bullmq_job_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,    -- 'queued', 'active', 'completed', 'failed'
  progress INTEGER DEFAULT 0,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  result JSONB,
  error JSONB
);

CREATE INDEX idx_jobs_definition ON discovery_jobs(definition_id);
CREATE INDEX idx_jobs_status ON discovery_jobs(status);
```

## Definition Configuration

### AWS Discovery Configuration

```json
{
  "name": "AWS EC2 Production Scan",
  "description": "Hourly discovery of production EC2 instances",
  "provider": "aws",
  "credentialId": "cred-123-abc",
  "config": {
    "regions": ["us-east-1", "us-west-2", "eu-west-1"],
    "resourceTypes": ["ec2", "rds", "s3", "elb", "lambda"],
    "tags": {
      "Environment": "production",
      "ManagedBy": "happycmdb"
    },
    "filters": {
      "ec2": {
        "instanceStates": ["running", "stopped"]
      }
    }
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 * * * *"  // Every hour
  },
  "enabled": true
}
```

**Configuration Options**:

- `regions` - AWS regions to scan (required)
- `resourceTypes` - Types of resources to discover (default: all)
  - `ec2` - EC2 instances
  - `rds` - RDS databases
  - `s3` - S3 buckets
  - `elb` - Load balancers
  - `lambda` - Lambda functions
  - `ecs` - ECS clusters and services
- `tags` - Filter resources by tags (optional)
- `filters` - Provider-specific filters (optional)

### Azure Discovery Configuration

```json
{
  "name": "Azure Production VMs",
  "description": "Daily scan of Azure production virtual machines",
  "provider": "azure",
  "credentialId": "cred-456-def",
  "config": {
    "resourceGroups": ["production-rg", "prod-services-rg"],
    "locations": ["eastus", "westus2", "northeurope"],
    "resourceTypes": ["virtualMachines", "sqlDatabases", "storageAccounts"],
    "tags": {
      "Environment": "production"
    }
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 2 * * *"  // Daily at 2 AM
  },
  "enabled": true
}
```

**Configuration Options**:

- `resourceGroups` - Azure resource groups to scan (optional, default: all)
- `locations` - Azure regions (optional, default: all)
- `resourceTypes` - Types of resources (default: all)
  - `virtualMachines` - Virtual machines
  - `sqlDatabases` - SQL databases
  - `storageAccounts` - Storage accounts
  - `appServices` - App Services
  - `networkInterfaces` - Network interfaces
- `tags` - Filter by tags (optional)

### GCP Discovery Configuration

```json
{
  "name": "GCP Compute Production",
  "description": "Bi-daily GCP compute instance discovery",
  "provider": "gcp",
  "credentialId": "cred-789-ghi",
  "config": {
    "projectIds": ["prod-project-1", "prod-project-2"],
    "zones": ["us-central1-a", "us-east1-b", "europe-west1-c"],
    "resourceTypes": ["computeInstances", "sqlInstances", "storageBuckets"],
    "labels": {
      "environment": "production"
    }
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 */12 * * *"  // Every 12 hours
  },
  "enabled": true
}
```

**Configuration Options**:

- `projectIds` - GCP project IDs (required)
- `zones` - GCP zones to scan (optional, default: all)
- `resourceTypes` - Types of resources (default: all)
  - `computeInstances` - Compute Engine instances
  - `sqlInstances` - Cloud SQL instances
  - `storageBuckets` - Cloud Storage buckets
  - `gkeClusters` - GKE clusters
- `labels` - Filter by labels (optional)

### SSH Discovery Configuration

```json
{
  "name": "On-Premise Linux Servers",
  "description": "Daily discovery of on-premise Linux infrastructure",
  "provider": "ssh",
  "credentialId": "cred-101-jkl",
  "config": {
    "hosts": [
      "192.168.1.10",
      "192.168.1.11",
      "192.168.1.12",
      "web-server-01.internal",
      "db-server-01.internal"
    ],
    "port": 22,
    "timeout": 30000,
    "collectors": {
      "systemInfo": true,
      "packages": true,
      "services": true,
      "networkInterfaces": true,
      "diskUsage": true,
      "processes": false
    }
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 3 * * *"  // Daily at 3 AM
  },
  "enabled": true
}
```

**Configuration Options**:

- `hosts` - List of IP addresses or hostnames (required)
- `port` - SSH port (default: 22)
- `timeout` - Connection timeout in milliseconds (default: 30000)
- `collectors` - Data collectors to enable/disable
  - `systemInfo` - OS, kernel, hardware info
  - `packages` - Installed packages
  - `services` - Running services
  - `networkInterfaces` - Network configuration
  - `diskUsage` - Disk usage statistics
  - `processes` - Running processes

### Nmap Discovery Configuration

```json
{
  "name": "Network Device Scan",
  "description": "Weekly scan of network infrastructure",
  "provider": "nmap",
  "credentialId": null,  // No credential needed for basic nmap
  "config": {
    "targets": [
      "192.168.100.0/24",
      "10.0.10.0/24"
    ],
    "options": {
      "portScan": true,
      "serviceDetection": true,
      "osDetection": true,
      "ports": "22,80,443,3389,8080"
    },
    "timeout": 300000
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 0 * * 0"  // Weekly on Sunday
  },
  "enabled": true
}
```

**Configuration Options**:

- `targets` - IP ranges or CIDR blocks (required)
- `options` - Nmap scanning options
  - `portScan` - Enable port scanning
  - `serviceDetection` - Detect service versions
  - `osDetection` - Attempt OS detection
  - `ports` - Specific ports to scan (default: top 1000)
- `timeout` - Scan timeout in milliseconds (default: 300000)

## Scheduling

### Cron Pattern Syntax

Discovery definitions use standard cron syntax (5 fields):

```
┌─────────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌─────────── day of month (1 - 31)
│ │ │ ┌───────── month (1 - 12)
│ │ │ │ ┌─────── day of week (0 - 6, Sunday = 0)
│ │ │ │ │
* * * * *
```

### Common Patterns

```bash
# Every 5 minutes
*/5 * * * *

# Every 15 minutes
*/15 * * * *

# Every 30 minutes
*/30 * * * *

# Every hour (on the hour)
0 * * * *

# Every 2 hours
0 */2 * * *

# Every 6 hours
0 */6 * * *

# Daily at 2 AM
0 2 * * *

# Daily at midnight
0 0 * * *

# Weekly on Sunday at midnight
0 0 * * 0

# Monthly on the 1st at midnight
0 0 1 * *

# Weekdays at 9 AM
0 9 * * 1-5

# Every hour during business hours (9 AM - 5 PM)
0 9-17 * * *
```

### Scheduling Best Practices

**Cloud Resources**:
- **Production**: Every 1-2 hours
- **Staging**: Every 4-6 hours
- **Development**: Every 12-24 hours

**On-Premise Servers**:
- **Production**: Daily during off-peak hours
- **Development**: Weekly

**Network Devices**:
- **Critical**: Every 6-12 hours
- **Non-critical**: Daily or weekly

**Performance Considerations**:
- Stagger schedules to avoid concurrent heavy loads
- Run intensive scans (Nmap) during maintenance windows
- Consider time zones for global deployments

## API Reference

### Create Definition

**Endpoint**: `POST /api/v1/discovery/definitions`

**Request**:
```json
{
  "name": "AWS EC2 Production",
  "description": "Hourly EC2 discovery",
  "provider": "aws",
  "credentialId": "cred-123-abc",
  "config": {
    "regions": ["us-east-1"],
    "resourceTypes": ["ec2"]
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 * * * *"
  },
  "enabled": true
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "name": "AWS EC2 Production",
    "provider": "aws",
    "credentialId": "cred-123-abc",
    "scheduleEnabled": true,
    "scheduleCronPattern": "0 * * * *",
    "enabled": true,
    "createdBy": "admin@example.com",
    "createdAt": "2025-10-05T10:00:00Z",
    "nextRunAt": "2025-10-05T11:00:00Z"
  }
}
```

### List Definitions

**Endpoint**: `GET /api/v1/discovery/definitions`

**Query Parameters**:
- `provider` - Filter by provider (optional)
- `enabled` - Filter by enabled status (optional)
- `scheduleEnabled` - Filter by schedule status (optional)
- `limit` - Results per page (default: 50)
- `offset` - Pagination offset (default: 0)

**Example**:
```bash
curl http://localhost:3000/api/v1/discovery/definitions?provider=aws&enabled=true \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response**:
```json
{
  "success": true,
  "data": {
    "definitions": [
      {
        "id": "def-456-xyz",
        "name": "AWS EC2 Production",
        "provider": "aws",
        "enabled": true,
        "scheduleEnabled": true,
        "lastRunAt": "2025-10-05T10:00:00Z",
        "nextRunAt": "2025-10-05T11:00:00Z"
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
}
```

### Get Definition

**Endpoint**: `GET /api/v1/discovery/definitions/:id`

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "name": "AWS EC2 Production",
    "description": "Hourly EC2 discovery",
    "provider": "aws",
    "credentialId": "cred-123-abc",
    "config": {
      "regions": ["us-east-1"],
      "resourceTypes": ["ec2"]
    },
    "scheduleEnabled": true,
    "scheduleCronPattern": "0 * * * *",
    "enabled": true,
    "createdBy": "admin@example.com",
    "createdAt": "2025-10-05T10:00:00Z",
    "updatedAt": "2025-10-05T10:00:00Z",
    "lastRunAt": "2025-10-05T10:00:00Z",
    "nextRunAt": "2025-10-05T11:00:00Z",
    "stats": {
      "totalRuns": 42,
      "successfulRuns": 40,
      "failedRuns": 2,
      "averageDuration": 45000,
      "lastSuccess": "2025-10-05T10:00:00Z"
    }
  }
}
```

### Update Definition

**Endpoint**: `PUT /api/v1/discovery/definitions/:id`

**Request**:
```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "config": {
    "regions": ["us-east-1", "us-west-2"]
  },
  "schedule": {
    "cronPattern": "0 */2 * * *"
  }
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "name": "Updated Name",
    "updatedAt": "2025-10-05T11:00:00Z",
    "nextRunAt": "2025-10-05T12:00:00Z"
  }
}
```

### Delete Definition

**Endpoint**: `DELETE /api/v1/discovery/definitions/:id`

**Response**:
```json
{
  "success": true,
  "data": {
    "deleted": true,
    "id": "def-456-xyz"
  }
}
```

::: warning Job History
Deleting a definition does NOT delete historical job records. Job history is preserved for audit purposes.
:::

### Run Definition

**Endpoint**: `POST /api/v1/discovery/definitions/:id/run`

Triggers an immediate discovery job without waiting for the schedule.

**Response**:
```json
{
  "success": true,
  "data": {
    "jobId": "job-789-abc",
    "definitionId": "def-456-xyz",
    "status": "queued",
    "queuedAt": "2025-10-05T11:30:00Z"
  }
}
```

### Enable Schedule

**Endpoint**: `POST /api/v1/discovery/definitions/:id/schedule/enable`

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "scheduleEnabled": true,
    "nextRunAt": "2025-10-05T12:00:00Z"
  }
}
```

### Disable Schedule

**Endpoint**: `POST /api/v1/discovery/definitions/:id/schedule/disable`

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "def-456-xyz",
    "scheduleEnabled": false,
    "nextRunAt": null
  }
}
```

### Get Definition Jobs

**Endpoint**: `GET /api/v1/discovery/definitions/:id/jobs`

**Query Parameters**:
- `status` - Filter by job status (optional)
- `limit` - Results per page (default: 50)
- `offset` - Pagination offset (default: 0)

**Response**:
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "id": "job-789-abc",
        "definitionId": "def-456-xyz",
        "status": "completed",
        "progress": 100,
        "startedAt": "2025-10-05T10:00:00Z",
        "completedAt": "2025-10-05T10:02:30Z",
        "duration": 150000,
        "discovered": 42,
        "created": 5,
        "updated": 37,
        "errors": 0
      }
    ],
    "total": 42,
    "limit": 50,
    "offset": 0
  }
}
```

## CLI Usage

### List Definitions

```bash
cmdb definitions list
cmdb definitions list --provider aws
cmdb definitions list --enabled true
```

### Create Definition

```bash
# Interactive mode
cmdb definitions create

# From file
cmdb definitions create --file definition.json
```

**Example definition.json**:
```json
{
  "name": "AWS EC2 Production",
  "provider": "aws",
  "credentialId": "cred-123-abc",
  "config": {
    "regions": ["us-east-1"]
  },
  "schedule": {
    "enabled": true,
    "cronPattern": "0 * * * *"
  }
}
```

### Get Definition

```bash
cmdb definitions get def-456-xyz
```

### Update Definition

```bash
cmdb definitions update def-456-xyz --file updated-definition.json
```

### Delete Definition

```bash
cmdb definitions delete def-456-xyz
```

### Run Definition

```bash
cmdb definitions run def-456-xyz
```

### Enable/Disable Schedule

```bash
cmdb definitions schedule enable def-456-xyz
cmdb definitions schedule disable def-456-xyz
```

### List Jobs for Definition

```bash
cmdb definitions jobs def-456-xyz
cmdb definitions jobs def-456-xyz --status failed
```

## Monitoring and Metrics

### Definition Performance Metrics

Query definition performance from PostgreSQL:

```sql
-- Success rate per definition
SELECT
  dd.name,
  COUNT(*) FILTER (WHERE dj.status = 'completed') * 100.0 / COUNT(*) as success_rate,
  AVG(EXTRACT(EPOCH FROM (dj.completed_at - dj.started_at)) * 1000) as avg_duration_ms,
  COUNT(*) as total_runs
FROM discovery_definitions dd
JOIN discovery_jobs dj ON dd.id = dj.definition_id
WHERE dj.started_at >= NOW() - INTERVAL '7 days'
GROUP BY dd.id, dd.name
ORDER BY success_rate DESC;
```

### Recent Failures

```sql
-- Recent failed jobs per definition
SELECT
  dd.name,
  dj.id as job_id,
  dj.started_at,
  dj.error->>'message' as error_message
FROM discovery_definitions dd
JOIN discovery_jobs dj ON dd.id = dj.definition_id
WHERE dj.status = 'failed'
  AND dj.started_at >= NOW() - INTERVAL '24 hours'
ORDER BY dj.started_at DESC;
```

### Schedule Compliance

```sql
-- Definitions not running on schedule
SELECT
  name,
  schedule_cron_pattern,
  last_run_at,
  next_run_at,
  EXTRACT(EPOCH FROM (NOW() - last_run_at)) / 3600 as hours_since_last_run
FROM discovery_definitions
WHERE schedule_enabled = true
  AND last_run_at < NOW() - INTERVAL '24 hours'
ORDER BY last_run_at ASC;
```

## Troubleshooting

### Schedule Not Running

**Problem**: Scheduled discovery not executing

**Symptoms**:
- `nextRunAt` is in the past
- No recent jobs created

**Solution**:
```bash
# 1. Check if discovery scheduler is running
ps aux | grep discovery-scheduler

# 2. Check scheduler logs
tail -f /var/log/cmdb/discovery-scheduler.log

# 3. Verify schedule is enabled
curl http://localhost:3000/api/v1/discovery/definitions/def-456-xyz

# 4. Re-enable schedule
curl -X POST http://localhost:3000/api/v1/discovery/definitions/def-456-xyz/schedule/enable
```

### Jobs Failing Consistently

**Problem**: All jobs for a definition failing

**Solution**:
1. **Test credential**:
   ```bash
   curl -X POST http://localhost:3000/api/v1/credentials/{credential_id}/test
   ```

2. **Review recent errors**:
   ```bash
   curl http://localhost:3000/api/v1/discovery/definitions/{def_id}/jobs?status=failed
   ```

3. **Check configuration**:
   - Verify regions/locations exist
   - Check filters aren't too restrictive
   - Ensure credential has required permissions

4. **Run on demand to debug**:
   ```bash
   curl -X POST http://localhost:3000/api/v1/discovery/definitions/{def_id}/run
   ```

### Credential Reference Error

**Problem**: "Credential not found" error

**Solution**:
```bash
# 1. Verify credential exists
curl http://localhost:3000/api/v1/credentials/{credential_id}

# 2. Update definition with valid credential
curl -X PUT http://localhost:3000/api/v1/discovery/definitions/{def_id} \
  -d '{"credentialId": "valid-cred-id"}'
```

### High Discovery Duration

**Problem**: Discovery jobs taking too long

**Solution**:
1. **Reduce scope**:
   - Fewer regions
   - Fewer resource types
   - More specific filters

2. **Split into multiple definitions**:
   - One per region
   - One per resource type

3. **Adjust concurrency** (in worker config)

## Best Practices

1. **Naming Convention** - Use descriptive names: `{Provider} {Scope} {Frequency}`
   - Examples: "AWS EC2 Production Hourly", "Azure VMs Staging Daily"

2. **Scope Appropriately** - Don't discover everything at once
   - Split by environment (prod/staging/dev)
   - Split by region for large deployments
   - Filter by tags/labels when possible

3. **Schedule Wisely** - Consider business needs and load
   - Critical production: Every 1-2 hours
   - Non-critical: Daily during off-peak
   - Stagger schedules to avoid concurrent heavy loads

4. **Monitor Regularly** - Track success rates and duration
   - Set up alerts for failures
   - Review performance metrics weekly
   - Adjust schedules based on change frequency

5. **Document Purpose** - Use description field
   - What does it discover?
   - Why does it exist?
   - Who maintains it?

6. **Test Before Scheduling** - Always run on demand first
   - Verify configuration
   - Check discovery results
   - Confirm duration is acceptable

7. **Use Consistent Credentials** - Minimize credential sprawl
   - One credential per environment per provider
   - Rotate credentials regularly
   - Monitor credential usage

8. **Clean Up Unused** - Delete definitions no longer needed
   - Review quarterly
   - Disable before deleting
   - Job history is preserved

## Related Resources

- [Discovery Guide](/getting-started/discovery-guide)
- [Credential Management](/components/credentials)
- [BullMQ Queue Management](/components/bullmq)
- [REST API Reference](/api/rest/discovery)
- [Troubleshooting Discovery](/troubleshooting/discovery)

---

**Last Updated**: 2025-10-05
**Maintainer**: HappyCMDB Team
