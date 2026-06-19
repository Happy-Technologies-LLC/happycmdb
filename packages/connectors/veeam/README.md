# Veeam Backup & Replication Connector

HappyCMDB integration connector for Veeam Enterprise Manager REST API.

## Overview

This connector enables HappyCMDB to discover and manage configuration items (CIs) from Veeam Backup & Replication through the Enterprise Manager REST API.

## Features

- Multi-resource discovery with 4 resource types
- Session-based authentication with automatic token refresh
- Relationship inference between backup infrastructure components
- Support for SSL certificate verification bypass (common for self-signed certs)
- Comprehensive error handling and retry logic

## Supported Resources

### 1. Backup Servers
- **CI Type**: `server`
- **Description**: Veeam Backup & Replication server instances
- **Endpoint**: `GET /api/backupServers`
- **Attributes**: Name, Version, Port, Description

### 2. Protected Virtual Machines
- **CI Type**: `virtual-machine`
- **Description**: Virtual machines under Veeam backup protection
- **Endpoint**: `GET /api/query?type=Vm&filter=IsTemplate==false`
- **Attributes**: Name, Platform, VM Host, Path, Type
- **Environment Inference**: Automatically infers environment from VM name patterns

### 3. Backup Jobs
- **CI Type**: `application`
- **Description**: Veeam backup job definitions
- **Endpoint**: `GET /api/jobs`
- **Attributes**: Name, Job Type, Schedule Status, Description
- **Status**: Maps to `active` if schedule enabled, `inactive` if disabled

### 4. Repositories
- **CI Type**: `storage`
- **Description**: Veeam backup storage repositories
- **Endpoint**: `GET /api/repositories`
- **Attributes**: Name, Type, Path, Capacity, Free Space

## Configuration

### Connection Configuration

```json
{
  "enterprise_manager_url": "https://veeam-em.company.com:9398",
  "username": "domain\\administrator",
  "password": "your-password",
  "verify_ssl": false
}
```

### Configuration Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `enterprise_manager_url` | string | Yes | - | Veeam Enterprise Manager URL with port (typically 9398) |
| `username` | string | Yes | - | Username for authentication (can include domain) |
| `password` | string | Yes | - | Password for authentication |
| `verify_ssl` | boolean | No | `false` | Verify SSL certificates (set to false for self-signed) |

### Enabled Resources

By default, all resources are enabled:
- `backup_servers`
- `protected_vms`
- `backup_jobs`
- `repositories`

You can customize enabled resources in the connector configuration:

```json
{
  "enabled_resources": ["backup_servers", "protected_vms"]
}
```

### Resource-Specific Configuration

Each resource can have custom configuration:

```json
{
  "resource_configs": {
    "protected_vms": {
      "filter": "Platform==VMware",
      "query_type": "Vm"
    },
    "backup_servers": {
      "endpoint": "/api/backupServers"
    }
  }
}
```

## Relationships

The connector automatically infers the following relationships:

- **Backup Jobs → Backup Servers**: `RUNS_ON`
- **Repositories → Backup Servers**: `MANAGED_BY`
- **Protected VMs → Backup Jobs**: Requires additional API calls (planned)

## Authentication

Veeam Enterprise Manager uses session-based authentication:

1. Connector acquires session token via `POST /api/sessionMngr/?v=latest` with HTTP Basic Auth
2. Session token is automatically included in all subsequent requests via `X-RestSvcSessionId` header
3. Tokens are cached and automatically refreshed when expired (default: 14 minutes)
4. Session is closed on cleanup via `DELETE /api/sessionMngr`

## Environment Inference

Protected VMs have their environment automatically inferred from naming patterns:

- `*prod*` → `production`
- `*stag*` → `staging`
- `*dev*` → `development`
- `*test*` or `*qa*` → `test`
- Default → `production` (for backup-protected resources)

## Error Handling

- Automatic session token refresh on 401 responses
- Graceful handling of API errors with detailed logging
- Non-blocking relationship extraction (failures don't stop CI discovery)
- Proper cleanup on connector shutdown

## Testing

Run unit tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm test -- --coverage
```

## API Compatibility

- **Veeam Backup & Replication**: v11.0 and later
- **Veeam Enterprise Manager**: REST API v1.7 and later
- **API Version**: Uses `?v=latest` for session management

## Example Usage

```typescript
import VeeamConnector from '@cmdb/connector-veeam';

const connector = new VeeamConnector({
  name: 'Production Veeam',
  type: 'veeam',
  enabled: true,
  connection: {
    enterprise_manager_url: 'https://veeam-em.prod.company.com:9398',
    username: 'DOMAIN\\svc-veeam',
    password: 'secure-password',
    verify_ssl: false,
  },
  enabled_resources: ['backup_servers', 'protected_vms', 'backup_jobs', 'repositories'],
});

// Initialize and test connection
await connector.initialize();
const testResult = await connector.testConnection();

if (testResult.success) {
  // Run full discovery
  await connector.run();
}

// Cleanup
await connector.cleanup();
```

## Limitations

- Incremental sync not currently supported (full extraction each run)
- Bidirectional sync not supported (read-only)
- VM-to-job relationships require additional API calls (not yet implemented)
- Session tokens expire after 15 minutes (automatically refreshed)

## Roadmap

- [ ] Incremental sync support
- [ ] VM-to-job relationship mapping via `/api/jobs/{jobId}/includes`
- [ ] Backup job run history extraction
- [ ] Repository capacity alerts
- [ ] Support for Veeam Cloud Connect
- [ ] Support for Veeam Backup for Microsoft 365

## License

Part of HappyCMDB platform - see main project LICENSE.

## References

- [Veeam Enterprise Manager REST API Reference](https://helpcenter.veeam.com/docs/backup/em_rest/overview.html)
- [Veeam Backup & Replication Documentation](https://helpcenter.veeam.com/)
