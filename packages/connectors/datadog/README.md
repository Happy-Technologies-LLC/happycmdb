# Datadog Connector

Integration connector for Datadog monitoring platform.

## Overview

The Datadog connector enables HappyCMDB to discover and synchronize infrastructure, containers, services, and monitors from Datadog's monitoring platform.

## Supported Resources

### Hosts (Infrastructure)
- **CI Type**: `server`
- **Description**: Infrastructure hosts monitored by Datadog agents
- **API Endpoint**: `GET /api/v1/hosts`
- **Enabled by Default**: Yes

### Containers
- **CI Type**: `container`
- **Description**: Container instances discovered by Datadog
- **API Endpoint**: `GET /api/v2/containers`
- **Enabled by Default**: Yes

### Services (APM)
- **CI Type**: `service`
- **Description**: Application services from Datadog APM
- **API Endpoint**: `GET /api/v2/services/definitions`
- **Enabled by Default**: Yes

### Monitors
- **CI Type**: None (metadata only)
- **Description**: Datadog monitor configurations
- **API Endpoint**: `GET /api/v1/monitor`
- **Enabled by Default**: Yes

## Configuration

### Connection Parameters

```json
{
  "api_key": "your-datadog-api-key",
  "app_key": "your-datadog-application-key",
  "site": "datadoghq.com"
}
```

- **api_key** (required): Datadog API key
- **app_key** (required): Datadog application key
- **site** (optional): Datadog site (default: `datadoghq.com`)
  - US1: `datadoghq.com`
  - US3: `us3.datadoghq.com`
  - US5: `us5.datadoghq.com`
  - EU: `datadoghq.eu`
  - AP1: `ap1.datadoghq.com`

### Resource-Specific Configuration

#### Hosts
```json
{
  "filter": "env:production",
  "include_muted": true
}
```

#### Containers
```json
{
  "filter": "image_name:nginx"
}
```

#### Services
```json
{
  "env": "production"
}
```

#### Monitors
```json
{
  "group_states": "all",
  "tags": "team:platform,service:web-api"
}
```

## Authentication

### UnifiedCredential Protocol

Use the `api_key` protocol:

```typescript
{
  protocol: 'api_key',
  scope: 'api',
  credentials: {
    api_key: 'dd_api_key',
    app_key: 'dd_application_key',
    site: 'datadoghq.com'
  }
}
```

### Obtaining API Keys

1. Log in to Datadog
2. Navigate to **Organization Settings** → **API Keys**
3. Create or copy your API key
4. Navigate to **Organization Settings** → **Application Keys**
5. Create or copy your application key

## Relationships

The connector automatically infers the following relationships:

### Container → Host (HOSTED_ON)
Containers are linked to their host servers based on the `host` attribute.

### Monitor → Service (MONITORS)
Monitors are linked to services when:
- The monitor query contains the service name
- The monitor tags include the service name

## Data Mapping

### Host to Server CI

| Datadog Field | CMDB Attribute |
|--------------|----------------|
| `id` | `source_id` |
| `name` | `name` |
| `meta.agent_version` | `attributes.agent_version` |
| `meta.platform` | `attributes.platform` |
| `meta.cpuCores` | `attributes.cpu_cores` |
| `meta.os` | `attributes.os` |
| `is_muted` | `status` (maintenance) |
| `up` | `status` (active/inactive) |
| `tags` | `environment` (env:production) |

### Container to Container CI

| Datadog Field | CMDB Attribute |
|--------------|----------------|
| `id` | `source_id` |
| `attributes.name` | `name` |
| `attributes.image_name` | `attributes.image_name` |
| `attributes.image_tag` | `attributes.image_tag` |
| `attributes.state` | `status` |
| `attributes.host` | Relationship to host |

### Service to Service CI

| Datadog Field | CMDB Attribute |
|--------------|----------------|
| `id` | `source_id` |
| `attributes.name` | `name` |
| `attributes.env` | `environment` |
| `schema.languages` | `attributes.languages` |
| `schema.type` | `attributes.type` |

## Status Mapping

### Hosts
- `is_muted: true` → `maintenance`
- `up: false` → `inactive`
- `up: true` → `active`

### Containers
- `running` → `active`
- `paused` → `maintenance`
- `stopped`, `exited` → `inactive`
- `dead` → `decommissioned`

### Monitors
- `OK`, `Alert`, `Warn` → `active`
- `No Data`, `Ignored` → `maintenance`

## Environment Detection

The connector extracts environment from Datadog tags:
- Tags: `env:production`, `env:staging`, `env:development`, `env:test`
- Default: `production`

## Example Usage

```typescript
import DatadogConnector from '@cmdb/connector-datadog';

const connector = new DatadogConnector({
  name: 'Production Datadog',
  type: 'datadog',
  enabled: true,
  connection: {
    api_key: process.env.DATADOG_API_KEY,
    app_key: process.env.DATADOG_APP_KEY,
    site: 'datadoghq.com',
  },
  enabled_resources: ['hosts', 'containers', 'services'],
  resource_configs: {
    hosts: {
      filter: 'env:production',
      include_muted: false,
    },
    services: {
      env: 'production',
    },
  },
});

await connector.initialize();
const testResult = await connector.testConnection();

if (testResult.success) {
  // Extract all enabled resources
  await connector.run();
}
```

## Testing

```bash
npm test
```

## API Rate Limits

Datadog API has the following rate limits:
- **Hosts API**: 10 requests/second (configurable in connector)
- **Other APIs**: Varies by endpoint

The connector implements rate limiting through the `rate_limit` configuration in each resource's extraction settings.

## Error Handling

The connector handles the following error scenarios:
- Invalid API keys → Connection test failure
- Network errors → Retry with exponential backoff
- Rate limiting → Automatic throttling
- Missing data → Graceful degradation

## Confidence Scores

- **Hosts**: 95 (high confidence from monitoring agent)
- **Containers**: 95 (high confidence from runtime data)
- **Services**: 90 (good confidence from APM)
- **Monitors**: 100 (authoritative configuration data)

## Version

Current version: **1.0.0**

## License

Part of HappyCMDB platform.
