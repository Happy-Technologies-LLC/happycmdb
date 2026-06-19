# Microsoft SCCM (Configuration Manager) Connector

Enterprise connector for Microsoft System Center Configuration Manager (SCCM) integration with HappyCMDB.

## Overview

This connector enables bi-directional synchronization between Microsoft SCCM and HappyCMDB, providing comprehensive visibility into managed devices, software inventory, device collections, and software updates.

## Features

- **Multi-Resource Support**: Extract 4 different resource types from SCCM
- **SQL-Based Discovery**: Direct SQL queries to SCCM database views (read-only)
- **Batch Processing**: Efficient pagination for large datasets (1000+ devices)
- **Relationship Mapping**: Automatic relationship discovery between devices, software, collections, and updates
- **Windows Authentication**: Support for both SQL and Windows authentication
- **Flexible Filtering**: Configurable filters for each resource type

## Supported Resources

### 1. Devices (CI Type: `server` / `virtual-machine`)

Managed devices including workstations, laptops, servers, and virtual machines.

**Extracted Attributes:**
- Device name, manufacturer, model, serial number
- Operating system and version
- Hardware specs (CPU, memory, disk)
- Network configuration (IP, MAC address)
- SCCM client version and status
- Last hardware scan timestamp

**SQL View:** `v_R_System`, `v_GS_COMPUTER_SYSTEM`, `v_GS_PROCESSOR`, etc.

### 2. Software Inventory (CI Type: `software`)

Installed software packages discovered by SCCM software inventory.

**Extracted Attributes:**
- Product name, version, publisher
- Install date and product ID
- Install count (devices with this software)
- Associated device information

**SQL View:** `v_GS_ADD_REMOVE_PROGRAMS`

### 3. Collections (CI Type: `collection`)

Device collections (static and dynamic) used for grouping and targeting.

**Extracted Attributes:**
- Collection ID, name, comment
- Member count and collection type
- Limiting collection references
- Rule count and refresh timestamps

**SQL View:** `v_Collection`, `v_CollectionRuleDirect`

### 4. Updates (CI Type: `update`)

Software updates and patch compliance status.

**Extracted Attributes:**
- Article ID, Bulletin ID, title
- Severity level (Critical, Important, etc.)
- Deployment and compliance status
- Install/required counts per device
- Date posted and revised

**SQL View:** `v_UpdateInfo`, `v_Update_ComplianceSummary`

## Relationships

The connector automatically infers 3 relationship types:

1. **Software → Device** (`INSTALLED_ON`): Software installed on devices
2. **Device → Collection** (`MEMBER_OF`): Devices that are members of collections
3. **Update → Device** (`REQUIRED_BY` / `INSTALLED_ON`): Update compliance status

## Configuration

### Connection Configuration

```json
{
  "server": "sccm-sql.example.com",
  "database": "CM_PS1",
  "username": "sccm_user",
  "password": "sccm_password",
  "use_windows_auth": false,
  "site_code": "PS1",
  "devices": {
    "active_only": true,
    "last_scan_days": 30
  }
}
```

**Parameters:**

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `server` | Yes | - | SCCM SQL Server FQDN |
| `database` | Yes | `CM_PS1` | ConfigMgr database name |
| `username` | No | - | SQL username (empty for Windows auth) |
| `password` | No | - | SQL password |
| `use_windows_auth` | No | `true` | Use Windows authentication |
| `site_code` | Yes | `PS1` | SCCM site code |
| `devices.active_only` | No | `true` | Only extract active clients |
| `devices.last_scan_days` | No | `30` | Only devices scanned in last N days |

### Resource-Specific Configuration

#### Devices

```json
{
  "active_only": true,
  "last_scan_days": 30,
  "device_types": ["Desktop", "Laptop", "Server", "Virtual Machine"]
}
```

#### Software Inventory

```json
{
  "include_system_software": false,
  "min_install_count": 1
}
```

#### Collections

```json
{
  "exclude_system_collections": true,
  "min_member_count": 0
}
```

#### Updates

```json
{
  "deployed_only": false,
  "required_only": true,
  "severity_levels": ["Critical", "Important"]
}
```

## Usage

### Installation

```bash
cd packages/connectors/sccm
npm install
npm run build
```

### Configuration Example

```typescript
import SCCMConnector from '@cmdb/connector-sccm';

const config = {
  name: 'Production SCCM',
  type: 'sccm',
  enabled: true,
  connection: {
    server: 'sccm-sql.example.com',
    database: 'CM_PS1',
    username: 'cmdb_reader',
    password: 'password',
    use_windows_auth: false,
    site_code: 'PS1',
  },
  enabled_resources: ['devices', 'software_inventory', 'updates'],
  resource_configs: {
    devices: {
      active_only: true,
      last_scan_days: 7,
    },
    updates: {
      severity_levels: ['Critical'],
    },
  },
};

const connector = new SCCMConnector(config);
await connector.initialize();

// Test connection
const testResult = await connector.testConnection();
console.log(testResult);

// Extract devices
const devices = await connector.extractResource('devices');
console.log(`Extracted ${devices.length} devices`);

// Extract relationships
const relationships = await connector.extractRelationships();
console.log(`Found ${relationships.length} relationships`);

// Cleanup
await connector.cleanup();
```

### Running Tests

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage
```

## SQL Permissions

The SCCM connector requires **read-only** access to the ConfigMgr database. Create a dedicated SQL user with the following permissions:

```sql
USE CM_PS1;
GO

-- Create read-only user
CREATE LOGIN cmdb_reader WITH PASSWORD = 'SecurePassword123!';
CREATE USER cmdb_reader FOR LOGIN cmdb_reader;

-- Grant read access to SCCM views
GRANT SELECT ON SCHEMA::dbo TO cmdb_reader;

-- Alternatively, grant access to specific views only
GRANT SELECT ON v_R_System TO cmdb_reader;
GRANT SELECT ON v_GS_COMPUTER_SYSTEM TO cmdb_reader;
GRANT SELECT ON v_GS_PROCESSOR TO cmdb_reader;
GRANT SELECT ON v_GS_ADD_REMOVE_PROGRAMS TO cmdb_reader;
GRANT SELECT ON v_Collection TO cmdb_reader;
GRANT SELECT ON v_UpdateInfo TO cmdb_reader;
GRANT SELECT ON v_Update_ComplianceSummary TO cmdb_reader;
-- Add other views as needed
```

## Performance Considerations

1. **Batch Size**: Default 1000 rows per query. Adjust based on network latency.
2. **Active Clients Only**: Filter inactive devices to reduce processing time.
3. **Recent Scans**: Use `last_scan_days` to only process recently scanned devices.
4. **SQL Indexing**: Ensure SCCM database has proper indexes on ResourceID columns.
5. **Network Latency**: Run connector close to SCCM SQL Server for best performance.

## Troubleshooting

### Connection Issues

**Error:** `Connection failed: Login failed for user 'cmdb_reader'`

- Verify SQL username and password are correct
- Check if user has SELECT permissions on SCCM views
- Ensure SQL Server allows SQL authentication (if not using Windows auth)

### No Data Returned

**Issue:** Extraction completes but returns 0 records

- Check `active_only` filter - may be excluding all devices
- Verify `last_scan_days` is not too restrictive
- Confirm devices exist in SCCM with recent hardware scans

### Performance Issues

**Issue:** Extraction takes very long time

- Reduce `last_scan_days` to limit dataset
- Enable `active_only` to exclude obsolete devices
- Check SQL Server query performance (missing indexes)
- Increase `batch_size` if network latency is low

## SCCM SQL Views Reference

| View | Purpose |
|------|---------|
| `v_R_System` | Core device information |
| `v_GS_COMPUTER_SYSTEM` | Hardware manufacturer/model |
| `v_GS_PROCESSOR` | CPU information |
| `v_GS_OPERATING_SYSTEM` | OS details |
| `v_GS_PC_BIOS` | BIOS and serial number |
| `v_GS_DISK` | Disk information |
| `v_RA_System_IPAddresses` | Network IP addresses |
| `v_GS_ADD_REMOVE_PROGRAMS` | Installed software |
| `v_Collection` | Device collections |
| `v_FullCollectionMembership` | Collection membership |
| `v_UpdateInfo` | Software update catalog |
| `v_Update_ComplianceSummary` | Update compliance summary |
| `v_Update_ComplianceStatus` | Per-device update status |

## Version History

- **1.0.0** (2025-10-10): Initial release
  - Multi-resource support (devices, software, collections, updates)
  - Relationship extraction (INSTALLED_ON, MEMBER_OF, REQUIRED_BY)
  - SQL Server connection with Windows/SQL authentication
  - Comprehensive test coverage

## License

MIT License - see LICENSE file for details

## Support

For issues, questions, or contributions, please visit:
- GitHub: https://github.com/happycmdb/happycmdb
- Documentation: http://localhost:8080/connectors/sccm
