# Microsoft Defender for Endpoint Connector

Enterprise-grade integration connector for Microsoft Defender for Endpoint security platform.

## Overview

This connector enables HappyCMDB to discover and manage security-related configuration items from Microsoft Defender for Endpoint, including protected devices, security alerts, vulnerabilities, and software inventory.

## Features

- **Multi-Resource Support**: Discovers 4+ resource types in a single integration
- **Azure AD OAuth 2.0**: Secure authentication using client credentials flow
- **Incremental Sync**: Supports delta updates for efficient data synchronization
- **OData Filtering**: Advanced filtering capabilities for all resources
- **Relationship Mapping**: Automatically infers relationships between alerts, vulnerabilities, software, and machines
- **Risk-Based Prioritization**: Leverages Defender's risk scoring and exposure levels

## Supported Resources

### 1. Machines (Protected Devices)
**CI Type**: `server` | `virtual-machine`

Protected endpoints monitored by Microsoft Defender for Endpoint.

**Extracted Attributes**:
- Computer DNS name, OS platform, OS version
- IP addresses (internal and external)
- Health status, risk score, exposure level
- Onboarding status, agent version
- First seen, last seen timestamps
- Machine tags

**Filters**:
- Health status: Active, Inactive, ImpairedCommunication
- Risk score: None, Low, Medium, High

### 2. Alerts
**CI Type**: `alert`

Security alerts and threat detections.

**Extracted Attributes**:
- Alert title, severity, status, category
- Detection source (EDR, AV, Custom Detection)
- Affected machine ID
- Investigation state, classification, determination
- Created time, resolved time

**Filters**:
- Severity: Unspecified, Informational, Low, Medium, High
- Status: New, InProgress, Resolved
- Time range (default: 24 hours)

### 3. Vulnerabilities
**CI Type**: `vulnerability`

Software vulnerabilities detected across the estate.

**Extracted Attributes**:
- CVE ID, severity, CVSS v3 score
- Exploit verification status
- Number of exposed machines
- Publication date, last modified date
- Weakness count

**Filters**:
- Severity: None, Low, Medium, High, Critical
- Exploit verified only (true/false)

### 4. Software
**CI Type**: `software`

Software inventory from all protected devices.

**Extracted Attributes**:
- Software name, vendor, version
- Number of machines with software installed
- Weaknesses count, active alerts count
- End of support status and date

**Configuration**:
- Include/exclude end-of-support software

## Inferred Relationships

1. **DETECTED_ON**: Alert → Machine
   - Properties: severity, status

2. **AFFECTS**: Vulnerability → Machine
   - Properties: severity, CVSS score, exploit verified

3. **INSTALLED_ON**: Software → Machine
   - Properties: version, vendor

## Prerequisites

### Azure AD App Registration

1. Register an application in Azure AD
2. Grant API permissions:
   - `WindowsDefenderATP.Read.All` (Application permission)
3. Generate a client secret
4. Note the following values:
   - Tenant ID
   - Application (client) ID
   - Client secret value

### Defender for Endpoint License

- Microsoft 365 E5 or Microsoft Defender for Endpoint Plan 2

## Configuration

### Basic Configuration

```json
{
  "name": "Production Defender Integration",
  "type": "defender",
  "enabled": true,
  "connection": {
    "tenant_id": "00000000-0000-0000-0000-000000000000",
    "client_id": "11111111-1111-1111-1111-111111111111",
    "client_secret": "your-client-secret-here"
  }
}
```

### Advanced Configuration with Filters

```json
{
  "name": "Defender High-Priority Assets",
  "type": "defender",
  "enabled": true,
  "connection": {
    "tenant_id": "00000000-0000-0000-0000-000000000000",
    "client_id": "11111111-1111-1111-1111-111111111111",
    "client_secret": "your-client-secret-here",
    "machines": {
      "health_status": ["Active", "ImpairedCommunication"],
      "risk_score": ["Medium", "High"]
    },
    "alerts": {
      "severity": ["High"],
      "status": ["New", "InProgress"]
    },
    "vulnerabilities": {
      "severity": ["High", "Critical"],
      "exploit_verified": true
    }
  },
  "enabled_resources": ["machines", "alerts", "vulnerabilities"],
  "resource_configs": {
    "alerts": {
      "time_range_hours": 48
    }
  }
}
```

### Resource-Specific Configuration

```json
{
  "resource_configs": {
    "machines": {
      "health_status_filter": "healthStatus eq 'Active' and riskScore eq 'High'",
      "risk_score_filter": "riskScore in ('Medium', 'High')"
    },
    "alerts": {
      "severity_filter": "severity eq 'High' or severity eq 'Critical'",
      "status_filter": "status eq 'New'",
      "time_range_hours": 72
    },
    "vulnerabilities": {
      "severity_filter": "severity in ('High', 'Critical')",
      "exploit_verified_only": true
    },
    "software": {
      "include_end_of_support": false
    }
  }
}
```

## API Rate Limits

- **Machines**: 5 requests/second (batch size: 100)
- **Alerts**: 5 requests/second (batch size: 100)
- **Vulnerabilities**: 5 requests/second (batch size: 100)
- **Software**: 5 requests/second (batch size: 100)

The connector automatically handles pagination and respects rate limits.

## Data Mapping

### Machine Status Mapping

| Defender Status | CMDB Status |
|----------------|-------------|
| Active | active |
| Inactive | inactive |
| ImpairedCommunication | maintenance |
| NoSensorData | inactive |
| NoSensorDataImpairedCommunication | inactive |

### Alert Status Mapping

| Defender Status | CMDB Status |
|----------------|-------------|
| New | active |
| InProgress | active |
| Resolved | inactive |

### CI Type Mapping

| OS Platform | CMDB CI Type |
|------------|--------------|
| Windows* | server |
| Linux* | server |
| macOS* | server |

## Usage Examples

### CLI Usage

```bash
# Test connection
cmdb connector test defender-prod

# Extract all enabled resources
cmdb connector run defender-prod

# Extract specific resource
cmdb connector run defender-prod --resource machines

# Extract with custom configuration
cmdb connector run defender-prod --config config.json

# View run status
cmdb connector status defender-prod
```

### Programmatic Usage

```typescript
import DefenderConnector from '@cmdb/connector-defender';

const connector = new DefenderConnector({
  name: 'Defender Integration',
  type: 'defender',
  enabled: true,
  connection: {
    tenant_id: process.env.AZURE_TENANT_ID,
    client_id: process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
  },
});

// Initialize
await connector.initialize();

// Test connection
const testResult = await connector.testConnection();
console.log('Connection test:', testResult);

// Extract machines
const machines = await connector.extractResource('machines');
console.log(`Extracted ${machines.length} machines`);

// Transform to CMDB format
const transformedMachines = await Promise.all(
  machines.map(m => connector.transformResource('machines', m.data))
);

// Extract relationships
const relationships = await connector.extractRelationships();
console.log(`Extracted ${relationships.length} relationships`);
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Watch mode
npm run test:watch
```

## Troubleshooting

### Authentication Errors

**Error**: `Azure AD authentication failed: Invalid client secret`

**Solution**:
1. Verify client secret is correct and not expired
2. Regenerate client secret in Azure AD if needed
3. Update connector configuration with new secret

### Permission Errors

**Error**: `403 Forbidden - Insufficient privileges`

**Solution**:
1. Ensure app registration has `WindowsDefenderATP.Read.All` permission
2. Grant admin consent for the permission
3. Wait 5-10 minutes for permissions to propagate

### Rate Limiting

**Error**: `429 Too Many Requests`

**Solution**:
1. Reduce batch size in resource configuration
2. Increase delay between requests
3. Use resource-specific rate limiting configuration

### No Data Returned

**Issue**: Extraction returns 0 records

**Solution**:
1. Check OData filters - they may be too restrictive
2. Verify machines are onboarded to Defender
3. Check time range for alerts (default is 24 hours)
4. Review API permissions and admin consent

## Security Best Practices

1. **Credential Management**:
   - Store credentials in secure vault (Azure Key Vault, HashiCorp Vault)
   - Rotate client secrets every 90 days
   - Use managed identities when possible

2. **Least Privilege**:
   - Only grant `Read.All` permissions (not `ReadWrite.All`)
   - Create separate app registrations per environment
   - Review and audit API permissions regularly

3. **Network Security**:
   - Use TLS 1.2 or higher
   - Implement IP whitelisting if possible
   - Monitor API access logs

## Performance Optimization

1. **Reduce Data Volume**:
   - Use severity and status filters
   - Limit alert time range to 24-48 hours
   - Filter machines by risk score
   - Exclude end-of-support software if not needed

2. **Incremental Sync**:
   - Enable incremental sync for all resources
   - Schedule regular delta syncs (hourly/daily)
   - Full sync only weekly or monthly

3. **Relationship Extraction**:
   - Relationships resource depends on all other resources
   - Extract relationships separately and less frequently
   - Consider filtering relationships by importance

## Version History

- **1.0.0** (2024-10-10): Initial release
  - Multi-resource support (machines, alerts, vulnerabilities, software)
  - Azure AD OAuth 2.0 authentication
  - OData filtering
  - Relationship inference

## License

Part of HappyCMDB - See root LICENSE file

## Support

- Documentation: http://localhost:8080/components/defender-connector
- Issues: GitHub Issues
- Community: HappyCMDB Slack Channel
