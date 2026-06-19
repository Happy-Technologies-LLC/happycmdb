# CrowdStrike Falcon Connector

Real-time threat intelligence and endpoint protection integration for HappyCMDB.

## Overview

The CrowdStrike Falcon connector provides comprehensive integration with CrowdStrike's Falcon platform, enabling discovery and tracking of:

- **Devices**: Protected endpoints (servers, workstations, VMs) with Falcon agent installed
- **Detections**: Security threat detections and alerts from Falcon EDR
- **Vulnerabilities**: CVE vulnerabilities discovered by Falcon Spotlight
- **Incidents**: Security incidents containing related detections

## Features

- OAuth 2.0 authentication with automatic token refresh
- Multi-resource extraction with configurable filters
- Pagination support for large datasets
- Regional API support (US-1, US-2, EU-1, etc.)
- Automatic relationship inference (DETECTED_ON, AFFECTS, CONTAINS)
- Incremental sync support for all resources
- Rate limiting and batch processing

## Configuration

### Required Fields

```json
{
  "client_id": "your-falcon-api-client-id",
  "client_secret": "your-falcon-api-client-secret",
  "base_url": "https://api.crowdstrike.com"
}
```

### Regional API Endpoints

- **US-1**: `https://api.crowdstrike.com` (default)
- **US-2**: `https://api.us-2.crowdstrike.com`
- **EU-1**: `https://api.eu-1.crowdstrike.com`
- **US-GOV-1**: `https://api.laggar.gcw.crowdstrike.com`

### Optional Filters

#### Devices

```json
{
  "devices": {
    "status": ["normal", "containment_pending", "contained"],
    "platform": ["Windows", "Mac", "Linux"]
  }
}
```

#### Detections

```json
{
  "detections": {
    "severity": ["critical", "high", "medium", "low"],
    "status": ["new", "in_progress", "reopened"]
  }
}
```

## Resources

### 1. Devices (CI Type: `server` or `virtual-machine`)

Protected endpoints with Falcon agent installed.

**Extracted Fields:**
- `device_id` - Unique device identifier
- `hostname` - Device hostname
- `platform_name` - OS platform (Windows, Mac, Linux)
- `os_version` - Operating system version
- `mac_address` - MAC address
- `local_ip` / `external_ip` - IP addresses
- `agent_version` - Falcon agent version
- `last_seen` / `first_seen` - Activity timestamps
- `status` - Device status (normal, contained, etc.)
- `serial_number` - Hardware serial number
- `system_manufacturer` / `system_product_name` - Hardware info

**Default Batch Size**: 500

### 2. Detections (CI Type: `detection`)

Threat detections and alerts from Falcon EDR.

**Extracted Fields:**
- `detection_id` - Unique detection identifier
- `severity` / `max_severity` - Severity scores (0-100)
- `max_confidence` - Confidence score (0-100)
- `status` - Detection status (new, in_progress, etc.)
- `tactic` / `technique` - MITRE ATT&CK mappings
- `device.device_id` - Associated device
- `created_timestamp` - Detection time
- `behaviors` - Associated behaviors

**Default Batch Size**: 1000

**Relationships Created:**
- Detection → Device (`DETECTED_ON`)

### 3. Vulnerabilities (CI Type: `vulnerability`)

CVE vulnerabilities from Falcon Spotlight.

**Extracted Fields:**
- `cve.id` - CVE identifier (e.g., CVE-2024-1234)
- `cve.description` - Vulnerability description
- `cve.base_score` - CVSS base score
- `cve.severity` - Severity level (critical, high, medium, low)
- `cve.exploit_status` - Exploitation status
- `aid` - Affected device ID
- `apps` - Affected software products
- `status` - Vulnerability status (open, closed, remediated)

**Default Batch Size**: 500

**Relationships Created:**
- Vulnerability → Device (`AFFECTS`)

### 4. Incidents (CI Type: `incident`)

Security incidents containing related detections.

**Extracted Fields:**
- `incident_id` - Unique incident identifier
- `name` - Incident name
- `description` - Incident description
- `status` - Incident status (new, in_progress, closed, etc.)
- `severity` - Severity score (0-100)
- `assigned_to` / `assigned_to_name` - Assignment info
- `tactics` / `techniques` - MITRE ATT&CK mappings
- `hosts` - Associated devices
- `created` / `modified_timestamp` - Timestamps

**Default Batch Size**: 100

**Relationships Created:**
- Incident → Detection (`CONTAINS`)

## Usage Examples

### Basic Configuration

```typescript
import CrowdStrikeConnector from '@cmdb/connector-crowdstrike';

const connector = new CrowdStrikeConnector({
  name: 'CrowdStrike Production',
  type: 'crowdstrike',
  enabled: true,
  connection: {
    client_id: process.env.CROWDSTRIKE_CLIENT_ID,
    client_secret: process.env.CROWDSTRIKE_CLIENT_SECRET,
    base_url: 'https://api.crowdstrike.com',
  },
});

await connector.initialize();
```

### Test Connection

```typescript
const result = await connector.testConnection();
console.log(result.success); // true
console.log(result.message); // "Successfully connected to CrowdStrike Falcon"
```

### Extract Devices

```typescript
const devices = await connector.extractResource('devices', {
  status_filter: ['normal'],
  platform_filter: ['Linux', 'Windows'],
});

console.log(`Extracted ${devices.length} devices`);
```

### Extract Critical Detections

```typescript
const detections = await connector.extractResource('detections', {
  severity_filter: ['critical', 'high'],
  status_filter: ['new', 'in_progress'],
  days_back: 7,
});

console.log(`Found ${detections.length} critical/high detections`);
```

### Extract Vulnerabilities

```typescript
const vulnerabilities = await connector.extractResource('vulnerabilities', {
  severity_filter: ['critical', 'high'],
  exploit_status_filter: ['EXPLOITED_IN_THE_WILD', 'WEAPONIZED'],
});

console.log(`Found ${vulnerabilities.length} critical vulnerabilities`);
```

### Transform Data

```typescript
// Transform device to CMDB CI
const transformedDevice = await connector.transformResource('devices', deviceData);
console.log(transformedDevice.ci_type); // "server" or "virtual-machine"
console.log(transformedDevice.status); // "active", "maintenance", or "inactive"
console.log(transformedDevice.confidence_score); // 95

// Transform detection to CMDB CI
const transformedDetection = await connector.transformResource('detections', detectionData);
console.log(transformedDetection.ci_type); // "detection"
console.log(transformedDetection.attributes.severity); // "critical", "high", "medium", "low"
```

## API Endpoints Used

| Resource | Query Endpoint | Details Endpoint |
|----------|----------------|------------------|
| Devices | `/devices/queries/devices/v1` | `/devices/entities/devices/v2` |
| Detections | `/detects/queries/detects/v1` | `/detects/entities/summaries/GET/v1` |
| Vulnerabilities | `/spotlight/combined/vulnerabilities/v1` | N/A (combined) |
| Incidents | `/incidents/queries/incidents/v1` | `/incidents/entities/incidents/GET/v1` |

## Authentication

The connector uses OAuth 2.0 Client Credentials flow:

1. Exchange client ID/secret for access token
2. Access token valid for ~30 minutes
3. Automatic token refresh on expiry
4. Token included in all API requests via `Authorization: Bearer` header

## Rate Limiting

Default rate limits per resource:
- Devices: 10 requests/second
- Detections: 10 requests/second
- Vulnerabilities: 5 requests/second
- Incidents: 5 requests/second

## Pagination

All resources support pagination:
- Query endpoints return IDs (offset/limit)
- Details endpoints fetch full records
- Automatic batching based on resource batch size

## Status Mappings

### Device Status → CMDB Status
- `normal` → `active`
- `containment_pending` → `maintenance`
- `contained` → `inactive`
- `lift_containment_pending` → `maintenance`

### Detection Status → CMDB Status
- `new` / `in_progress` / `reopened` → `active`
- `true_positive` / `false_positive` / `ignored` / `closed` → `inactive`

### Vulnerability Status → CMDB Status
- `open` → `active`
- `closed` / `remediated` → `inactive`

### Incident Status → CMDB Status
- `new` / `in_progress` / `reopened` → `active`
- `closed` → `inactive`

## Severity Mappings

Numeric severity (0-100) mapped to strings:
- `70-100` → `critical`
- `50-69` → `high`
- `30-49` → `medium`
- `10-29` → `low`
- `0-9` → `informational`

## Testing

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

## License

MIT
