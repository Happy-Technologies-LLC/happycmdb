# Prometheus Connector for HappyCMDB

Multi-resource integration connector for Prometheus monitoring system.

## Overview

The Prometheus connector extracts monitoring data from Prometheus HTTP API and transforms it into CMDB Configuration Items (CIs). It supports multiple resource types including monitored targets, services, alerts, and metrics.

## Supported Resources

### 1. Targets (Default: Enabled)
- **Description**: Monitored targets being scraped by Prometheus (servers, services, exporters)
- **CI Type**: `server` (inferred from job labels)
- **API Endpoint**: `GET /api/v1/targets`
- **Configuration**:
  - `active_only`: Only include active (up) targets (default: false)
  - `exclude_jobs`: Array of job names to exclude (default: [])

### 2. Services (Default: Enabled)
- **Description**: Services discovered through Prometheus service discovery
- **CI Type**: `service`
- **API Endpoint**: `GET /api/v1/targets/metadata`
- **Configuration**:
  - `include_metadata`: Include target metadata (default: true)

### 3. Alerts (Default: Enabled)
- **Description**: Currently firing alerts from Prometheus Alertmanager
- **CI Type**: `alert`
- **API Endpoint**: `GET /api/v1/alerts`
- **Configuration**:
  - `severity_filter`: Filter by severity levels (default: [])

### 4. Metrics (Default: Disabled)
- **Description**: All available metrics in Prometheus
- **CI Type**: `metric`
- **API Endpoint**: `GET /api/v1/label/__name__/values`
- **Configuration**:
  - `metric_name_pattern`: Regex pattern to filter metric names (default: ".*")
  - `limit`: Maximum number of metrics to extract (default: 1000)

## Configuration

### Connection Configuration

```json
{
  "prometheus_url": "http://prometheus.example.com:9090",
  "basic_auth_username": "admin",
  "basic_auth_password": "secret",
  "timeout_ms": 30000
}
```

### Resource Configuration

Enable/disable resources and configure per-resource settings:

```json
{
  "enabled_resources": ["targets", "services", "alerts"],
  "resource_configs": {
    "targets": {
      "active_only": true,
      "exclude_jobs": ["blackbox-exporter", "test-job"]
    },
    "alerts": {
      "severity_filter": ["critical", "warning"]
    },
    "metrics": {
      "metric_name_pattern": "^node_.*",
      "limit": 500
    }
  }
}
```

## CI Type Inference

The connector intelligently infers CI types from Prometheus job labels:

| Job Label Contains | Inferred CI Type |
|-------------------|------------------|
| `node`, `server` | `server` |
| `kubernetes`, `k8s` | `container` |
| `database`, `postgres`, `mysql` | `database` |
| `application`, `app` | `application` |
| Default | `server` |

## Identification Attributes

### Targets
- `hostname`: Extracted from instance label (host part)
- `ip_address`: Extracted from instance if it contains IPv4 address
- `custom_identifiers`:
  - `prometheus_job`: Job name
  - `prometheus_instance`: Full instance label

### Services
- `custom_identifiers`:
  - `prometheus_service`: Service/job name

### Alerts
- `custom_identifiers`:
  - `prometheus_alertname`: Alert name
  - `prometheus_fingerprint`: Unique alert identifier

## Relationships

The connector automatically discovers relationships between resources:

- **ALERTS_ON**: Links alerts to the targets they are monitoring
  - Source: Alert CI
  - Target: Target CI
  - Properties: `severity`, `alertname`

## Example Usage

### Via CLI

```bash
# Install connector
cmdb connector install prometheus

# Configure connector
cmdb connector config prometheus \
  --url "http://prometheus.example.com:9090" \
  --username "admin" \
  --password "secret" \
  --enable-resources targets,services,alerts

# Run discovery
cmdb connector run prometheus
```

### Via API

```typescript
import { getIntegrationManager } from '@cmdb/integration-framework';

const manager = getIntegrationManager();

// Configure connector
const config = {
  name: 'Production Prometheus',
  type: 'prometheus',
  enabled: true,
  connection: {
    prometheus_url: 'http://prometheus.example.com:9090',
    basic_auth_username: 'admin',
    basic_auth_password: 'secret',
  },
  enabled_resources: ['targets', 'services', 'alerts'],
  resource_configs: {
    targets: {
      active_only: true,
      exclude_jobs: ['test-job'],
    },
  },
};

// Save configuration
await manager.saveConnectorConfiguration(config);

// Run discovery
await manager.runConnector('prometheus');
```

## Environment Label Detection

The connector extracts environment information from Prometheus labels:

- Checks for `env` label
- Checks for `environment` label
- Defaults to `production` if not found

## Status Mapping

| Prometheus Health | CMDB Status |
|-------------------|-------------|
| `up` | `active` |
| `down` | `inactive` |
| Other | `unknown` |

## Confidence Scores

- **Active targets** (health=up): 90
- **Inactive targets** (health=down): 70
- **Services**: 85
- **Alerts**: 100
- **Metrics**: 100

## Authentication

### Basic Authentication

If your Prometheus instance requires authentication, provide credentials:

```json
{
  "basic_auth_username": "admin",
  "basic_auth_password": "secret"
}
```

### No Authentication

If Prometheus is accessible without authentication, simply omit the auth fields:

```json
{
  "prometheus_url": "http://prometheus.example.com:9090"
}
```

## Performance Considerations

- **Rate Limiting**: Default 10 requests/second for targets
- **Batch Size**:
  - Targets: 1000 per batch
  - Services: 500 per batch
  - Alerts: 500 per batch
  - Metrics: 1000 per batch (configurable via `limit`)
- **Timeouts**: Default 30 seconds, configurable via `timeout_ms`

## Troubleshooting

### Connection Issues

If connection test fails:

1. Verify Prometheus URL is accessible
2. Check authentication credentials
3. Ensure Prometheus API is enabled (default: enabled)
4. Check firewall rules

### Missing Targets

If targets are not discovered:

1. Verify targets are visible in Prometheus UI
2. Check `active_only` filter setting
3. Verify jobs are not in `exclude_jobs` list
4. Check Prometheus scrape configuration

### Missing Alerts

If alerts are not extracted:

1. Verify alerts are firing in Prometheus
2. Check `severity_filter` configuration
3. Ensure Alertmanager is configured and running

## API Reference

### Prometheus HTTP API Endpoints Used

- **Build Info**: `GET /api/v1/status/buildinfo` (connection test)
- **Targets**: `GET /api/v1/targets`
- **Target Metadata**: `GET /api/v1/targets/metadata`
- **Alerts**: `GET /api/v1/alerts`
- **Metric Names**: `GET /api/v1/label/__name__/values`

## Version Compatibility

- **Prometheus**: 2.x and later
- **API Version**: v1
- **Tested with**: Prometheus 2.40.0+

## License

MIT

## Support

For issues and questions, please visit:
- GitHub Issues: https://github.com/happycmdb/cmdb/issues
- Documentation: http://localhost:8080/docs/connectors/prometheus
