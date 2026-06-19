# Microsoft Intune Connector

Enterprise-grade connector for integrating Microsoft Intune with HappyCMDB. Supports mobile device management, application deployment, compliance policies, and configuration profiles.

## Features

- **5 Resource Types**: Devices, Applications, Compliance Policies, Configuration Profiles, Users
- **OAuth 2.0 Authentication**: Secure client credentials flow
- **Automatic Pagination**: Handles large datasets with OData pagination
- **Relationship Discovery**: Automatically infers device-user, app-device, and policy-device relationships
- **Platform Detection**: Supports iOS, Android, Windows, and macOS
- **Filtering**: Filter by compliance state, ownership, platform, and sync date
- **Multi-tenant Support**: Works across Azure AD tenants

## Prerequisites

### Azure AD App Registration

1. Navigate to [Azure Portal](https://portal.azure.com) → Azure Active Directory → App registrations
2. Click "New registration"
3. Name: `HappyCMDB-Intune-Integration`
4. Supported account types: "Accounts in this organizational directory only"
5. Click "Register"

### API Permissions

Grant the following **Application permissions** (not Delegated):

- `DeviceManagementApps.Read.All` - Read managed apps
- `DeviceManagementConfiguration.Read.All` - Read device configurations
- `DeviceManagementManagedDevices.Read.All` - Read managed devices
- `DeviceManagementServiceConfig.Read.All` - Read compliance policies
- `User.Read.All` - Read user information

After adding permissions, click **Grant admin consent**.

### Client Secret

1. In the app registration, go to "Certificates & secrets"
2. Click "New client secret"
3. Description: `HappyCMDB Integration`
4. Expiration: 24 months (recommended)
5. Click "Add" and **copy the secret value immediately**

## Installation

```bash
# Install the connector
npm install @cmdb/connector-intune

# Or add to HappyCMDB connectors directory
cp -r packages/connectors/intune /path/to/happycmdb/connectors/
```

## Configuration

### Basic Configuration

```typescript
import IntuneConnector from '@cmdb/connector-intune';

const config = {
  name: 'Intune Production',
  type: 'intune',
  enabled: true,
  connection: {
    tenant_id: '12345678-1234-1234-1234-123456789abc',  // Azure AD Tenant ID
    client_id: 'abcdef12-3456-7890-abcd-ef1234567890',  // App Registration Client ID
    client_secret: 'your-client-secret-here',           // Client Secret
  },
};

const connector = new IntuneConnector(config);
await connector.initialize();
```

### Resource-Specific Configuration

```typescript
const config = {
  name: 'Intune Production',
  type: 'intune',
  enabled: true,
  connection: {
    tenant_id: '12345678-1234-1234-1234-123456789abc',
    client_id: 'abcdef12-3456-7890-abcd-ef1234567890',
    client_secret: 'your-client-secret-here',
  },
  enabled_resources: [
    'devices',
    'applications',
    'compliance_policies',
    'users',
  ],
  resource_configs: {
    devices: {
      compliance_state: ['compliant', 'inGracePeriod'],  // Only compliant devices
      ownership: ['company'],                             // Only corporate devices
      last_sync_days: 7,                                  // Synced in last 7 days
    },
    applications: {
      platform: ['iOS', 'Android'],                       // Only mobile apps
    },
    users: {
      has_devices: true,                                  // Only users with devices
    },
  },
};
```

## Usage Examples

### Test Connection

```typescript
const result = await connector.testConnection();

if (result.success) {
  console.log('Connected to:', result.details.organization);
  console.log('Enabled resources:', result.details.enabled_resources);
} else {
  console.error('Connection failed:', result.message);
}
```

### Extract Devices

```typescript
// Extract all devices
const devices = await connector.extractResource('devices');
console.log(`Extracted ${devices.length} devices`);

// Extract filtered devices
const corporateDevices = await connector.extractResource('devices', {
  compliance_state: ['compliant'],
  ownership: ['company'],
  last_sync_days: 30,
});

// Transform device to CMDB format
for (const device of devices) {
  const ci = await connector.transformResource('devices', device.data);
  console.log(`Device: ${ci.name} (${ci.attributes.operating_system})`);
  console.log(`  Status: ${ci.status}`);
  console.log(`  Compliance: ${ci.attributes.compliance_state}`);
  console.log(`  User: ${ci.attributes.user_principal_name}`);
}
```

### Extract Applications

```typescript
// Extract all applications
const apps = await connector.extractResource('applications');

// Extract iOS and Android apps only
const mobileApps = await connector.extractResource('applications', {
  platform: ['iOS', 'Android'],
});

// Transform to CMDB format
for (const app of mobileApps) {
  const ci = await connector.transformResource('applications', app.data);
  console.log(`App: ${ci.name}`);
  console.log(`  Publisher: ${ci.attributes.publisher}`);
  console.log(`  Platform: ${ci.attributes.platform}`);
}
```

### Extract Compliance Policies

```typescript
const policies = await connector.extractResource('compliance_policies');

for (const policy of policies) {
  const ci = await connector.transformResource('compliance_policies', policy.data);
  console.log(`Policy: ${ci.name}`);
  console.log(`  Platform: ${ci.attributes.platform}`);
  console.log(`  Version: ${ci.attributes.version}`);
}
```

### Extract Configuration Profiles

```typescript
const profiles = await connector.extractResource('configuration_profiles');

for (const profile of profiles) {
  const ci = await connector.transformResource('configuration_profiles', profile.data);
  console.log(`Profile: ${ci.name}`);
  console.log(`  Platform: ${ci.attributes.platform}`);
  console.log(`  Description: ${ci.attributes.description}`);
}
```

### Extract Users

```typescript
// Extract all users
const users = await connector.extractResource('users');

// Extract only users with registered devices
const usersWithDevices = await connector.extractResource('users', {
  has_devices: true,
});

for (const user of usersWithDevices) {
  const ci = await connector.transformResource('users', user.data);
  console.log(`User: ${ci.name}`);
  console.log(`  UPN: ${ci.attributes.user_principal_name}`);
  console.log(`  Devices: ${ci.attributes.registered_devices_count}`);
}
```

### Extract Relationships

```typescript
const relationships = await connector.extractRelationships();

console.log(`Extracted ${relationships.length} relationships`);

// Filter by relationship type
const deviceUserRels = relationships.filter(r => r.relationship_type === 'ASSIGNED_TO');
const appDeviceRels = relationships.filter(r => r.relationship_type === 'INSTALLED_ON');
const policyRels = relationships.filter(r => r.relationship_type === 'APPLIES_TO');

console.log(`Device → User: ${deviceUserRels.length}`);
console.log(`App → Device: ${appDeviceRels.length}`);
console.log(`Policy → Device: ${policyRels.length}`);
```

## Supported Resources

| Resource ID | CI Type | Description | Default Enabled |
|------------|---------|-------------|-----------------|
| `devices` | `mobile-device` or `virtual-machine` | Managed devices (phones, tablets, computers) | ✅ |
| `applications` | `application` | Managed apps deployed via Intune | ✅ |
| `compliance_policies` | `policy` | Device compliance policies | ✅ |
| `configuration_profiles` | `configuration` | Device configuration profiles | ✅ |
| `users` | `user` | Users with Intune-managed devices | ❌ |
| `relationships` | N/A | CI relationships (device→user, app→device, policy→device) | ✅ |

## Relationship Types

The connector automatically infers the following relationships:

| Relationship | Source | Target | Description |
|-------------|--------|--------|-------------|
| `ASSIGNED_TO` | Device | User | Device assigned to user |
| `INSTALLED_ON` | Application | Device | App installed on device |
| `APPLIES_TO` | Compliance Policy | Device/Group | Policy applies to device or group |
| `APPLIES_TO` | Configuration Profile | Device/Group | Profile applies to device or group |

## CI Type Mapping

| Intune Type | Operating System | HappyCMDB CI Type |
|------------|------------------|---------------------|
| Managed Device | iOS, Android | `mobile-device` |
| Managed Device | Windows, macOS | `virtual-machine` |
| Mobile App | Any | `application` |
| Compliance Policy | Any | `policy` |
| Configuration Profile | Any | `configuration` |
| User | N/A | `user` |

## Filtering Options

### Devices

```typescript
{
  compliance_state: ['compliant', 'noncompliant', 'inGracePeriod', 'conflict', 'error', 'unknown'],
  ownership: ['company', 'personal', 'unknown'],
  last_sync_days: 30  // Devices synced in last N days
}
```

### Applications

```typescript
{
  platform: ['iOS', 'Android', 'Windows', 'macOS']
}
```

### Users

```typescript
{
  has_devices: true  // Only users with registered devices
}
```

## Error Handling

```typescript
try {
  await connector.initialize();
  const devices = await connector.extractResource('devices');
} catch (error) {
  if (error.message.includes('OAuth authentication failed')) {
    console.error('Check your tenant_id, client_id, and client_secret');
  } else if (error.message.includes('Unauthorized')) {
    console.error('Check API permissions and admin consent');
  } else {
    console.error('Extraction failed:', error.message);
  }
}
```

## Performance Considerations

- **Pagination**: Automatically handles large datasets (1000+ devices)
- **Rate Limiting**: Respects Microsoft Graph API rate limits
- **Token Caching**: Access tokens cached for 55 minutes
- **Relationship Limits**: App-to-device relationships limited to first 100 devices for performance

## CI Attributes

### Device Attributes

```typescript
{
  operating_system: 'iOS',
  os_version: '17.0',
  manufacturer: 'Apple',
  model: 'iPhone 15',
  serial_number: 'C02XYZ123ABC',
  imei: '123456789012345',
  compliance_state: 'compliant',
  ownership_type: 'company',
  last_sync_date: '2025-10-10T10:00:00Z',
  user_principal_name: 'user@example.com',
  is_encrypted: true,
  is_supervised: true,
  total_storage_space_bytes: 128000000000,
  free_storage_space_bytes: 64000000000
}
```

### Application Attributes

```typescript
{
  publisher: 'Microsoft',
  platform: 'iOS',
  description: 'Team collaboration app',
  is_featured: true,
  is_assigned: true,
  large_icon: 'base64-encoded-icon',
  privacy_information_url: 'https://...',
  bundle_id: 'com.microsoft.teams'
}
```

### Compliance Policy Attributes

```typescript
{
  platform: 'iOS',
  description: 'Compliance requirements for iOS devices',
  version: 1,
  scheduled_actions_count: 2
}
```

### User Attributes

```typescript
{
  user_principal_name: 'john.doe@example.com',
  mail: 'john.doe@example.com',
  job_title: 'Engineer',
  department: 'IT',
  office_location: 'Building 1',
  registered_devices_count: 2
}
```

## Troubleshooting

### Connection Issues

**Error: OAuth authentication failed**

- Verify `tenant_id`, `client_id`, and `client_secret` are correct
- Check that client secret hasn't expired
- Ensure app registration is in the correct Azure AD tenant

**Error: Unauthorized**

- Verify all required API permissions are granted
- Click "Grant admin consent" in Azure Portal
- Wait 5-10 minutes for permissions to propagate

### Extraction Issues

**No devices returned**

- Check filter settings (compliance_state, ownership, last_sync_days)
- Verify devices exist in Intune portal
- Check that devices have synced recently

**Pagination timeout**

- Reduce `batch_size` in resource configuration
- Check network connectivity to Microsoft Graph API

## Security Best Practices

1. **Store secrets securely**: Use environment variables or Azure Key Vault
2. **Limit permissions**: Only grant required API permissions
3. **Rotate secrets**: Rotate client secrets every 6-12 months
4. **Monitor access**: Review app registration sign-in logs
5. **Use separate apps**: Different app registrations for dev/prod

## API Rate Limits

Microsoft Graph API throttling limits:

- **Per-app per tenant**: 2,000 requests per second
- **Per-tenant**: 10,000 requests per second

The connector automatically handles rate limiting with exponential backoff.

## Related Documentation

- [Microsoft Graph API Documentation](https://docs.microsoft.com/en-us/graph/)
- [Intune API Reference](https://docs.microsoft.com/en-us/graph/api/resources/intune-graph-overview)
- [Azure AD App Registrations](https://docs.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app)
- [HappyCMDB Integration Framework](../../integration-framework/README.md)

## License

MIT License - see LICENSE file for details

## Support

For issues and feature requests, please open an issue on the [HappyCMDB GitHub repository](https://github.com/happycmdb/happycmdb).
