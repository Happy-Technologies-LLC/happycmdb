# JAMF Pro Connector

Integration connector for JAMF Pro - Apple device management platform.

## Overview

The JAMF Pro connector provides comprehensive integration with JAMF Pro for discovering and managing Apple devices (macOS, iOS, iPadOS), applications, and management policies in your HappyCMDB.

**Connector Type:** `jamf`
**Version:** 1.0.0
**Category:** Connector
**Verified:** Yes

## Features

- ✅ Multi-resource extraction (computers, mobile devices, applications, policies)
- ✅ Support for both Classic API (XML) and new API (JSON)
- ✅ Relationship inference (applications ↔ devices, policies → computers)
- ✅ Incremental sync support
- ✅ Managed device filtering
- ✅ Last check-in time filtering
- ✅ Supervised device filtering
- ✅ Comprehensive device attributes (hardware, OS, battery, storage)

## Resources

### 1. Computers
- **CI Type:** `server`
- **Description:** macOS devices (MacBooks, iMacs, Mac Pro, Mac Mini)
- **Default:** Enabled
- **Incremental:** Yes
- **Batch Size:** 100

**Extracted Attributes:**
- Device identification (serial, UDID, MAC address, IP)
- Hardware specs (model, processor, RAM, storage, battery)
- Operating system (name, version, build)
- Management status (managed, MDM capable)
- Last contact time

### 2. Mobile Devices
- **CI Type:** `mobile-device`
- **Description:** iOS and iPadOS devices (iPhones, iPads)
- **Default:** Enabled
- **Incremental:** Yes
- **Batch Size:** 100

**Extracted Attributes:**
- Device identification (serial, UDID, WiFi/Bluetooth MAC, IMEI)
- Device info (model, OS version, phone number)
- Storage (capacity, available, percentage used)
- Battery level
- Management status (managed, supervised)
- Carrier information

### 3. Applications
- **CI Type:** `application`
- **Description:** Installed applications across all devices
- **Default:** Enabled
- **Incremental:** No (full sync)
- **Batch Size:** 500

**Extracted Attributes:**
- Application name and version
- Bundle ID (macOS apps)
- Installation path
- Size
- Install count (number of devices)
- Device types (computer, mobile_device)

**Note:** Applications are deduplicated by bundle ID or name.

### 4. Policies
- **CI Type:** `policy`
- **Description:** Management policies applied to computers
- **Default:** Disabled (opt-in)
- **Incremental:** No (full sync)
- **Batch Size:** 50

**Extracted Attributes:**
- Policy name and enabled status
- Frequency and triggers
- Category
- Scope (computers, groups)
- Self Service configuration
- Execution settings

## Configuration

### Connection Configuration

```json
{
  "jamf_url": "https://company.jamfcloud.com",
  "username": "api_user",
  "password": "api_password",
  "use_classic_api": true
}
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `jamf_url` | string | Yes | - | JAMF Pro URL (e.g., https://company.jamfcloud.com) |
| `username` | string | Yes | - | JAMF Pro API username |
| `password` | string | Yes | - | JAMF Pro API password |
| `use_classic_api` | boolean | No | `true` | Use Classic API (XML) instead of new API (JSON) |

### Global Filters

**Computers:**
```json
{
  "computers": {
    "managed_only": true,
    "last_checkin_days": 30
  }
}
```

**Mobile Devices:**
```json
{
  "mobile_devices": {
    "supervised_only": false,
    "managed_only": true
  }
}
```

### Resource-Specific Configuration

```json
{
  "enabled_resources": ["computers", "mobile_devices", "applications"],
  "resource_configs": {
    "computers": {
      "managed_only": true,
      "last_checkin_days": 30
    },
    "mobile_devices": {
      "supervised_only": false,
      "managed_only": true
    },
    "applications": {
      "include_mobile_apps": true
    },
    "policies": {
      "enabled_only": true
    }
  }
}
```

## Relationships

The connector automatically infers the following relationships:

### Application → Device (INSTALLED_ON)
- Links applications to computers and mobile devices where they're installed
- Properties: `device_type` (computer | mobile_device)

### Policy → Computer (APPLIES_TO)
- Links management policies to the computers in their scope
- Properties: `policy_name`

## API Support

### Classic API (XML)
- Default mode, fully supported
- Endpoints:
  - `/JSSResource/computers`
  - `/JSSResource/mobiledevices`
  - `/JSSResource/policies`
- XML responses parsed to JSON internally

### New API (JSON)
- Partial support (computers only)
- Set `use_classic_api: false` to enable
- Endpoints:
  - `/api/v1/computers-inventory`
  - `/api/v1/auth/token` (bearer token)
- JSON responses (no parsing needed)

**Recommendation:** Use Classic API for full feature support.

## Authentication

### Basic Authentication (Classic API)
- Username and password passed with each request
- No token management required

### Bearer Token (New API)
- Token obtained via `/api/v1/auth/token`
- Automatically refreshed by connector
- Token included in `Authorization: Bearer <token>` header

## Filtering

### Computers
- **Managed Only:** Only sync computers under JAMF management (default: `true`)
- **Last Check-in:** Only sync computers that checked in within N days (default: `30`)

### Mobile Devices
- **Managed Only:** Only sync managed devices (default: `true`)
- **Supervised Only:** Only sync supervised devices (default: `false`)

### Policies
- **Enabled Only:** Only sync enabled policies (default: `true`)

## Example Configuration

```json
{
  "name": "JAMF Pro Production",
  "type": "jamf",
  "enabled": true,
  "schedule": "0 */6 * * *",
  "connection": {
    "jamf_url": "https://acme.jamfcloud.com",
    "username": "cmdb_api",
    "password": "secure_password",
    "use_classic_api": true,
    "computers": {
      "managed_only": true,
      "last_checkin_days": 30
    },
    "mobile_devices": {
      "supervised_only": false,
      "managed_only": true
    }
  },
  "enabled_resources": [
    "computers",
    "mobile_devices",
    "applications"
  ],
  "resource_configs": {
    "applications": {
      "include_mobile_apps": true
    }
  }
}
```

## CI Type Mappings

| JAMF Resource | HappyCMDB CI Type |
|---------------|---------------------|
| Computer | `server` |
| Mobile Device | `mobile-device` |
| Application | `application` |
| Policy | `policy` |

## Status Mappings

| JAMF Status | HappyCMDB Status |
|-------------|-------------------|
| Managed | `active` |
| Unmanaged | `inactive` |

## Installation

```bash
cd packages/connectors/jamf
npm install
npm run build
```

## Testing

```bash
npm test           # Run all tests
npm run test:watch # Run tests in watch mode
```

## Dependencies

- `axios` - HTTP client for JAMF API
- `xml2js` - XML parser for Classic API responses
- `@cmdb/common` - Common utilities and logger
- `@cmdb/integration-framework` - Integration framework base classes

## Performance Notes

- **Rate Limiting:** 5 requests/second for computers and mobile devices
- **Batch Size:** 100 devices per request (configurable)
- **Pagination:** Automatic pagination for large datasets
- **Deduplication:** Applications deduplicated by bundle ID
- **Error Handling:** Continues extraction if individual device fetch fails

## Best Practices

1. **Use Classic API** - More stable and feature-complete
2. **Filter by Last Check-in** - Reduce sync time by excluding stale devices
3. **Managed Devices Only** - Focus on devices under your management
4. **Schedule During Off-Hours** - Large organizations may have 10,000+ devices
5. **Enable Incremental Sync** - Faster subsequent syncs (computers, mobile devices)
6. **Monitor API Usage** - JAMF has API rate limits

## Troubleshooting

### Connection Failures
- Verify JAMF URL (no trailing slash)
- Check username/password (API role required)
- Test connectivity: `curl -u username:password https://jamf-url/JSSResource/activationcode`

### Slow Extraction
- Reduce `last_checkin_days` to exclude old devices
- Enable `managed_only` filter
- Increase `batch_size` (max 500)

### Missing Devices
- Check filters (managed_only, last_checkin_days)
- Verify devices are in JAMF inventory
- Check device last check-in time

### XML Parsing Errors
- Switch to new API: `use_classic_api: false`
- Update JAMF Pro to latest version
- Check JAMF API logs

## Support

For issues, questions, or feature requests, please refer to the HappyCMDB documentation or file an issue in the repository.

## License

MIT License - See LICENSE file in repository root
