# Discovery Guide

A comprehensive guide to discovering and managing your infrastructure with HappyCMDB's ServiceNow-style 3-tier discovery architecture.

## Overview

HappyCMDB uses a modern 3-tier discovery architecture that separates credentials, discovery configurations, and job execution:

1. **Credentials** - Reusable encrypted credentials for authentication
2. **Discovery Definitions** - Reusable discovery configurations with scheduling
3. **Discovery Jobs** - Individual execution instances

This architecture provides better security, reusability, audit trails, and scheduling capabilities compared to traditional ad-hoc discovery.

## Prerequisites

Before setting up discovery:

- HappyCMDB API server running
- Neo4j graph database accessible
- Cloud provider accounts (AWS, Azure, GCP) or on-premise access
- Appropriate IAM permissions for discovery operations

## Managing Discovery Credentials

Discovery credentials are securely stored, encrypted authentication details used to access your infrastructure.

### Supported Credential Types

- **AWS** - Access Key ID and Secret Access Key
- **Azure** - Tenant ID, Client ID, Client Secret
- **GCP** - Service Account JSON key file
- **SSH** - Username and password or SSH private key
- **API Key** - Generic API key/token authentication
- **SNMP** - Community string or v3 credentials

### Creating Credentials via UI

1. Navigate to **Settings > Credentials** in the HappyCMDB UI
2. Click **New Credential**
3. Select the credential type (AWS, Azure, GCP, SSH, etc.)
4. Enter the required fields:
   - **Name**: Descriptive name (e.g., "AWS Production Account")
   - **Description**: Optional details about the credential
   - **Credential details**: Provider-specific fields
5. Click **Save**

::: warning Security Notice
Credentials are encrypted at rest using AES-256-GCM encryption. The encryption key should be stored securely in your environment variables (`ENCRYPTION_KEY`).
:::

### Creating Credentials via API

**AWS Credentials:**

```bash
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "AWS Production Account",
    "description": "Main AWS production account",
    "type": "aws",
    "credentials": {
      "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
      "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "region": "us-east-1"
    }
  }'
```

**Azure Credentials:**

```bash
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Azure Production Subscription",
    "type": "azure",
    "credentials": {
      "tenantId": "tenant-id-here",
      "clientId": "client-id-here",
      "clientSecret": "client-secret-here",
      "subscriptionId": "subscription-id-here"
    }
  }'
```

**SSH Credentials:**

```bash
curl -X POST http://localhost:3000/api/v1/credentials \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Production SSH Key",
    "type": "ssh",
    "credentials": {
      "username": "admin",
      "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
    }
  }'
```

### Managing Credentials

**List all credentials:**

```bash
curl http://localhost:3000/api/v1/credentials \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Get specific credential:**

```bash
curl http://localhost:3000/api/v1/credentials/{credential_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

::: tip Credential Details
For security, the API returns credential metadata but NOT the actual encrypted credential values.
:::

**Update credential:**

```bash
curl -X PUT http://localhost:3000/api/v1/credentials/{credential_id} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Updated AWS Account",
    "description": "Updated description"
  }'
```

**Delete credential:**

```bash
curl -X DELETE http://localhost:3000/api/v1/credentials/{credential_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

::: danger Credential Deletion
Deleting a credential will fail if it's currently referenced by any discovery definitions. Remove the credential from all definitions first.
:::

### Security Best Practices

1. **Rotate credentials regularly** - Update credentials every 90 days
2. **Use least privilege** - Grant only required permissions
3. **Audit credential usage** - Review audit logs regularly
4. **Protect encryption key** - Store `ENCRYPTION_KEY` securely
5. **Monitor access** - Set up alerts for credential access
6. **Use separate credentials** - Don't share credentials across environments

## Creating Discovery Definitions

Discovery definitions are reusable configurations that specify what to discover, how often, and which credentials to use.

### Benefits Over Ad-Hoc Discovery

- **Reusability** - Define once, run multiple times
- **Scheduling** - Automated discovery with cron patterns
- **Audit Trail** - Track all executions with history
- **Consistency** - Standardized discovery configurations
- **Credential Management** - Centralized credential references
- **Job Tracking** - View all jobs for a definition

### Creating Definitions via UI

1. Navigate to **Discovery > Definitions**
2. Click **New Definition**
3. Configure the definition:
   - **Name**: Descriptive name (e.g., "AWS EC2 Hourly Scan")
   - **Description**: Purpose and scope
   - **Provider**: AWS, Azure, GCP, SSH, or Nmap
   - **Credential**: Select from saved credentials
   - **Configuration**: Provider-specific settings
   - **Schedule**: Optional cron pattern for automation
   - **Enabled**: Toggle to activate/deactivate
4. Click **Save**

### Creating Definitions via API

**AWS EC2 Discovery Definition:**

```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "AWS EC2 Hourly Scan",
    "description": "Discover all EC2 instances in production regions",
    "provider": "aws",
    "credentialId": "cred-123-abc",
    "config": {
      "regions": ["us-east-1", "us-west-2", "eu-west-1"],
      "resourceTypes": ["ec2", "rds", "s3"],
      "tags": {
        "Environment": "production"
      }
    },
    "schedule": {
      "enabled": true,
      "cronPattern": "0 * * * *"
    },
    "enabled": true
  }'
```

**Azure VM Discovery Definition:**

```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Azure Production VMs",
    "description": "Hourly scan of Azure production VMs",
    "provider": "azure",
    "credentialId": "cred-456-def",
    "config": {
      "resourceGroups": ["production-rg"],
      "locations": ["eastus", "westus2"]
    },
    "schedule": {
      "enabled": true,
      "cronPattern": "0 * * * *"
    },
    "enabled": true
  }'
```

**SSH Discovery Definition:**

```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "On-Premise Linux Servers",
    "description": "Daily scan of on-premise Linux infrastructure",
    "provider": "ssh",
    "credentialId": "cred-789-ghi",
    "config": {
      "hosts": [
        "192.168.1.10",
        "192.168.1.11",
        "192.168.1.12"
      ],
      "port": 22,
      "collectPackages": true,
      "collectServices": true
    },
    "schedule": {
      "enabled": true,
      "cronPattern": "0 2 * * *"
    },
    "enabled": true
  }'
```

### Scheduling Syntax (Cron Patterns)

Common cron patterns for discovery scheduling:

```
*/5 * * * *     - Every 5 minutes
*/15 * * * *    - Every 15 minutes
*/30 * * * *    - Every 30 minutes
0 * * * *       - Every hour (on the hour)
0 */2 * * *     - Every 2 hours
0 */6 * * *     - Every 6 hours
0 2 * * *       - Daily at 2 AM
0 0 * * 0       - Weekly on Sunday at midnight
0 0 1 * *       - Monthly on the 1st at midnight
```

::: tip Scheduling Best Practices
- **Cloud resources**: Every 1-6 hours depending on change frequency
- **On-premise servers**: Daily during off-peak hours
- **Network devices**: Every 6-12 hours
- **Development environments**: Every 12-24 hours
:::

### Managing Discovery Definitions

**List all definitions:**

```bash
curl http://localhost:3000/api/v1/discovery/definitions \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Get specific definition:**

```bash
curl http://localhost:3000/api/v1/discovery/definitions/{definition_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Update definition:**

```bash
curl -X PUT http://localhost:3000/api/v1/discovery/definitions/{definition_id} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Updated Name",
    "schedule": {
      "cronPattern": "0 */2 * * *"
    }
  }'
```

**Delete definition:**

```bash
curl -X DELETE http://localhost:3000/api/v1/discovery/definitions/{definition_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Running Definitions On Demand

Run a discovery definition immediately without waiting for the schedule:

```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions/{definition_id}/run \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "success": true,
  "data": {
    "jobId": "job-abc-123",
    "status": "queued",
    "queuedAt": "2025-10-05T10:30:00Z"
  }
}
```

### Managing Schedules

**Enable schedule:**

```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions/{definition_id}/schedule/enable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Disable schedule:**

```bash
curl -X POST http://localhost:3000/api/v1/discovery/definitions/{definition_id}/schedule/disable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## Running Discovery

### Definition-Based Discovery (Recommended)

The recommended approach is to create discovery definitions and either:

1. **Let schedules run automatically** - Set up cron patterns for regular discovery
2. **Run on demand** - Trigger definitions manually when needed

```bash
# Run a definition on demand
curl -X POST http://localhost:3000/api/v1/discovery/definitions/{definition_id}/run \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Check job status
curl http://localhost:3000/api/v1/discovery/jobs/{job_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Ad-Hoc Discovery

For one-time or exploratory discovery, you can still run ad-hoc jobs without creating definitions:

```bash
curl -X POST http://localhost:3000/api/v1/discovery/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "provider": "aws",
    "config": {
      "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
      "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "region": "us-east-1"
    }
  }'
```

::: warning Ad-Hoc Discovery Limitations
Ad-hoc discovery:
- No audit trail of reusable configurations
- Credentials included in request (less secure)
- Cannot be scheduled
- No historical job tracking
- Not recommended for production use
:::

### Monitoring Discovery Progress

**Get job status:**

```bash
curl http://localhost:3000/api/v1/discovery/jobs/{job_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:
```json
{
  "success": true,
  "data": {
    "jobId": "job-abc-123",
    "definitionId": "def-456",
    "provider": "aws",
    "status": "active",
    "progress": 65,
    "startedAt": "2025-10-05T10:30:00Z",
    "stats": {
      "discovered": 42,
      "created": 15,
      "updated": 27,
      "errors": 0
    }
  }
}
```

**List all jobs for a definition:**

```bash
curl http://localhost:3000/api/v1/discovery/jobs?definitionId={definition_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Using the CLI

```bash
# List credentials
cmdb credentials list

# Create credential
cmdb credentials create --type aws --name "AWS Prod" --file aws-creds.json

# List definitions
cmdb definitions list

# Create definition
cmdb definitions create --file definition.json

# Run definition
cmdb definitions run {definition_id}

# Check job status
cmdb discovery status {job_id}
```

## Discovery Results

After discovery completes, you can view results in multiple ways:

### Neo4j Graph View

```cypher
// View all discovered CIs
MATCH (ci:CI)
WHERE ci.discoverySource = 'aws'
RETURN ci
LIMIT 100

// View CI relationships
MATCH (ci:CI)-[r]->(related:CI)
WHERE ci.id = 'i-1234567890abcdef0'
RETURN ci, r, related
```

### REST API

```bash
# List discovered CIs
curl http://localhost:3000/api/v1/cis?discoverySource=aws \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Get CI details
curl http://localhost:3000/api/v1/cis/{ci_id} \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Get CI relationships
curl http://localhost:3000/api/v1/cis/{ci_id}/relationships \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Web UI

1. Navigate to **Inventory > Configuration Items**
2. Filter by discovery source or provider
3. Click on a CI to view details and relationships
4. Use the graph visualization to explore dependencies

## Troubleshooting

### Credential Errors

**Problem**: Authentication failed with cloud provider

**Solution**:
1. Verify credential details are correct
2. Check IAM permissions
3. Ensure credential hasn't expired
4. Review credential audit logs

### Discovery Job Failures

**Problem**: Discovery job fails with timeout

**Solution**:
1. Check network connectivity to cloud provider
2. Reduce scope (fewer regions/resources)
3. Increase job timeout settings
4. Review discovery worker logs

### Missing CIs

**Problem**: Some expected CIs not discovered

**Solution**:
1. Check discovery configuration filters
2. Verify resource tags match criteria
3. Review discovery provider permissions
4. Check for regional restrictions

### Schedule Not Running

**Problem**: Scheduled discovery not executing

**Solution**:
1. Verify schedule is enabled
2. Check cron pattern syntax
3. Ensure discovery scheduler is running
4. Review scheduler logs

## Related Resources

- [Credential Management](/components/credentials)
- [Discovery Definitions](/components/discovery-definitions)
- [REST API Reference](/api/rest/discovery)
- [BullMQ Queue Management](/components/bullmq)
- [Troubleshooting Guide](/troubleshooting/discovery)

## Next Steps

- [Configure cloud provider integrations](/integration/cloud-providers)
- [Set up monitoring for discovery jobs](/monitoring/overview)
- [Explore discovered CIs in the graph](/getting-started/quick-start.md#explore-the-graph)
- [Create custom discovery workflows](/integration/custom)

---

**Last Updated**: 2025-10-05
**Maintainer**: HappyCMDB Team
