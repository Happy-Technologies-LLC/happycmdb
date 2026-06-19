# Field Mapping Guide

## Overview

HappyCMDB's connector framework supports flexible field mapping that automatically handles:
- **Standard CI fields** - Core attributes stored directly on the CI object
- **Dynamic metadata fields** - Custom attributes stored in the `_metadata` object

This allows you to map ANY field from your source system to HappyCMDB, whether it's a predefined standard field or a completely custom attribute.

---

## How It Works

### 1. Standard Fields (Direct Mapping)

These fields are stored directly on the CI object and are indexed for fast querying:

```typescript
const STANDARD_CI_FIELDS = [
  'name',           // CI name
  'type',           // CI type (required)
  'status',         // Operational status
  'environment',    // Deployment environment
  'description',    // Description
  'external_id',    // External system identifier
  'ip_address',     // Primary IP address
  'hostname',       // Hostname
  'serial_number',  // Serial number
  'manufacturer',   // Hardware manufacturer
  'model',          // Hardware model
  'location',       // Physical/logical location
  'owner',          // Owner/responsible party
  'cost_center',    // Cost center
];
```

### 2. Dynamic Metadata Fields (Automatic)

ANY field NOT in the standard list is automatically stored in `_metadata`:

```typescript
// Example mapping from Lansweeper connector
{
  "field_mappings": {
    "name": "AssetBasicInfo.AssetName",           // → Standard field
    "serial_number": "AssetBasicInfo.SerialNumber", // → Standard field
    "cpu_name": "Processor.Name",                 // → metadata.cpu_name
    "ram_mb": "Memory.TotalPhysical",             // → metadata.ram_mb
    "bios_version": "BIOS.Version",               // → metadata.bios_version
    "last_seen": "AssetBasicInfo.LastSeen"        // → metadata.last_seen
  }
}
```

---

## Using Field Mappings in Connectors

### In connector.json

Define field mappings for each resource:

```json
{
  "type": "lansweeper",
  "name": "Lansweeper Asset Discovery",
  "version": "1.0.0",
  "resources": [
    {
      "id": "servers",
      "name": "Servers",
      "ci_type": "server",
      "field_mappings": {
        "name": "AssetBasicInfo.AssetName",
        "ip_address": "AssetBasicInfo.IPAddress",
        "serial_number": "AssetBasicInfo.SerialNumber",
        "cpu_name": "Processor.Name",
        "cpu_count": "Processor.NumberOfCores",
        "ram_mb": "Memory.TotalPhysical",
        "disk_size_gb": "DiskDrive.Size",
        "os": "OperatingSystem.Caption",
        "os_version": "OperatingSystem.Version"
      }
    }
  ]
}
```

### In Your Connector Class

The `BaseIntegrationConnector` provides the `applyFieldMappings()` helper:

```typescript
import { BaseIntegrationConnector, TransformedCI } from '@cmdb/integration-framework';

export class LansweeperConnector extends BaseIntegrationConnector {

  async transformResource(resourceId: string, sourceData: any): Promise<TransformedCI> {
    // Apply field mappings automatically
    const { standardFields, metadata } = this.applyFieldMappings(resourceId, sourceData);

    // Build the transformed CI
    return {
      name: standardFields.name || 'Unknown',
      ci_type: 'server',
      status: 'active',
      environment: 'production',

      // Standard fields go in attributes
      attributes: {
        ip_address: standardFields.ip_address,
        serial_number: standardFields.serial_number,
        manufacturer: standardFields.manufacturer,
        model: standardFields.model,
        ...metadata  // ALL non-standard fields go here
      },

      identifiers: this.extractIdentifiers(sourceData),
      source: 'lansweeper',
      source_id: sourceData.AssetID,
      confidence_score: 0.95,
    };
  }
}
```

**Result:**
```json
{
  "_id": "ci_abc123",
  "name": "SERVER-001",
  "_type": "server",
  "_status": "active",
  "environment": "production",
  "_metadata": {
    "cpu_name": "Intel Xeon E5-2680",
    "cpu_count": 16,
    "ram_mb": 32768,
    "disk_size_gb": 500,
    "os": "Windows Server 2019",
    "os_version": "10.0.17763"
  }
}
```

---

## UI Configuration

### Step 1: Select Target Fields

When configuring a connector in the UI, you can:

1. **Select standard fields** - From the "Standard CI Fields" section
2. **Select common metadata fields** - From the "Common Metadata Fields" section
3. **Enter custom field names** - Click "Enter custom field name..." to create any field

![Field Mapping UI](https://via.placeholder.com/800x400?text=Field+Mapping+UI)

### Step 2: Visual Feedback

The UI shows you which fields will be stored in metadata:

- **Standard fields** - No badge
- **Metadata fields** - Shows "Metadata" badge with explanation

### Step 3: Pre-populated Mappings

Connector templates come with pre-configured field mappings that you can:
- ✅ Keep as-is
- ✏️ Modify
- ➕ Add new mappings
- 🗑️ Remove unwanted mappings

---

## Examples

### Example 1: Network Device (Cisco Meraki)

```json
{
  "field_mappings": {
    "name": "name",                  // → Standard field
    "serial_number": "serial",       // → Standard field
    "model": "model",                // → Standard field
    "firmware_version": "firmware",  // → metadata.firmware_version
    "mac_address": "mac",            // → metadata.mac_address
    "wan_ip": "wan1Ip",              // → metadata.wan_ip
    "public_ip": "publicIp",         // → metadata.public_ip
    "network_id": "networkId",       // → metadata.network_id
    "tags": "tags"                   // → metadata.tags
  }
}
```

### Example 2: Security Tool (CrowdStrike)

```json
{
  "field_mappings": {
    "name": "hostname",                    // → Standard field
    "os": "os_version",                    // → metadata.os
    "last_seen": "last_seen",              // → metadata.last_seen
    "agent_version": "agent_version",      // → metadata.agent_version
    "sensor_id": "device_id",              // → metadata.sensor_id
    "platform_name": "platform_name",      // → metadata.platform_name
    "policy_name": "device_policies.name", // → metadata.policy_name
    "threat_count": "detection_count"      // → metadata.threat_count
  }
}
```

### Example 3: Monitoring Tool (Datadog)

```json
{
  "field_mappings": {
    "name": "name",                        // → Standard field
    "ip_address": "ip",                    // → Standard field
    "status": "status",                    // → Standard field (mapped to CI status)
    "up_time": "up",                       // → metadata.up_time
    "monitor_id": "id",                    // → metadata.monitor_id
    "monitor_type": "type",                // → metadata.monitor_type
    "query": "query",                      // → metadata.query
    "message": "message",                  // → metadata.message
    "tags": "tags"                         // → metadata.tags
  }
}
```

---

## Viewing Dynamic Metadata

### In the UI

Navigate to **Inventory → [Select CI] → Overview Tab**:

The "Metadata" section automatically displays all dynamic metadata fields in a responsive grid:

```
┌─────────────────────────────────────────────────────┐
│ Metadata                                            │
├─────────────────────────────────────────────────────┤
│ CPU NAME                 RAM MB        DISK SIZE GB │
│ Intel Xeon E5-2680       32768         500          │
│                                                     │
│ OS                       OS VERSION                 │
│ Windows Server 2019      10.0.17763                 │
│                                                     │
│ BIOS VERSION             FIRMWARE VERSION           │
│ 2.5.0                    1.2.3                      │
└─────────────────────────────────────────────────────┘
```

Complex values (objects, arrays) are displayed using a JSON viewer with collapsible sections.

### Via GraphQL API

```graphql
query GetCI($id: ID!) {
  ci(id: $id) {
    id
    name
    type
    status
    metadata  # Returns the full metadata object
  }
}
```

### Via REST API

```bash
GET /api/v1/cis/ci_abc123

{
  "id": "ci_abc123",
  "name": "SERVER-001",
  "type": "server",
  "status": "active",
  "metadata": {
    "cpu_name": "Intel Xeon E5-2680",
    "cpu_count": 16,
    "ram_mb": 32768,
    "disk_size_gb": 500,
    "os": "Windows Server 2019",
    "os_version": "10.0.17763",
    "bios_version": "2.5.0",
    "firmware_version": "1.2.3"
  }
}
```

---

## Best Practices

### 1. Use Standard Fields When Possible
Standard fields are indexed and optimized for querying:

✅ **Good:**
```json
{
  "name": "AssetName",
  "ip_address": "IPAddress",
  "serial_number": "SerialNumber"
}
```

❌ **Avoid:**
```json
{
  "device_name": "AssetName",      // Use 'name' instead
  "primary_ip": "IPAddress",       // Use 'ip_address' instead
  "asset_serial": "SerialNumber"   // Use 'serial_number' instead
}
```

### 2. Use Descriptive Metadata Field Names
Metadata fields should be clear and consistent:

✅ **Good:**
```json
{
  "cpu_cores": "Processor.Cores",
  "os_version": "OS.Version",
  "last_patch_date": "Patching.LastDate"
}
```

❌ **Avoid:**
```json
{
  "c": "Processor.Cores",          // Too cryptic
  "osver": "OS.Version",           // Inconsistent naming
  "lpd": "Patching.LastDate"       // Unclear abbreviation
}
```

### 3. Group Related Fields
Use prefixes for related metadata:

```json
{
  "network_mac_address": "Network.MAC",
  "network_vlan_id": "Network.VLAN",
  "network_subnet": "Network.Subnet",
  "security_patch_level": "Security.PatchLevel",
  "security_last_scan": "Security.LastScan",
  "security_vulnerabilities": "Security.VulnCount"
}
```

### 4. Document Custom Fields
Add descriptions in your connector.json:

```json
{
  "field_mappings": {
    "custom_warranty_expiry": {
      "source": "Warranty.ExpiryDate",
      "description": "Warranty expiration date in ISO 8601 format"
    }
  }
}
```

---

## Troubleshooting

### Issue: Fields Not Appearing in Metadata

**Cause:** Field might be a standard field being stored incorrectly.

**Solution:** Check the `STANDARD_CI_FIELDS` list in `BaseIntegrationConnector`. If your field is there, it won't go to metadata.

### Issue: Nested Source Path Not Working

**Cause:** Source data doesn't match the path structure.

**Solution:** Debug by logging the source data:
```typescript
console.log('Source data:', JSON.stringify(sourceData, null, 2));
```

Then verify your path matches:
```json
"cpu_name": "Processor.Name"  // Works if sourceData.Processor.Name exists
```

### Issue: Metadata Not Displayed in UI

**Cause:** Metadata might be stored as a string instead of an object.

**Solution:** Verify Neo4j client is parsing metadata correctly:
```typescript
// In neo4j/client.ts
_metadata: props.metadata ? JSON.parse(props.metadata) : {}
```

---

## Summary

- ✅ **Standard fields** → Stored directly on CI object, indexed for fast queries
- ✅ **Metadata fields** → Stored in `_metadata`, automatically detected
- ✅ **Any field name** → Supported via custom field input in UI
- ✅ **Automatic routing** → `applyFieldMappings()` handles standard vs metadata
- ✅ **Full UI support** → Display, edit, and configure in web interface
- ✅ **Pre-configured** → Connector templates come with sensible defaults

The system is designed to be **flexible** - you never need to modify core code to add new fields. Just define the mapping and the framework handles the rest!
