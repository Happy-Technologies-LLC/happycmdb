# Connector Registry

## Overview

The Connector Registry is a self-hosted catalog of available connectors that can be browsed, installed, and updated through the HappyCMDB platform. It provides a marketplace-like experience for discovering and managing integration connectors.

## Architecture

The registry consists of three components:

1. **Remote Catalog** - GitHub repository hosting connector packages and metadata
2. **Local Cache** - PostgreSQL cache of available connectors
3. **Management API** - REST/GraphQL endpoints for browsing and installation

## Remote Catalog Structure

**Repository**: `https://github.com/happycmdb/connectors`

```
happycmdb-connectors/
├── catalog.json                  # Main manifest (auto-generated)
├── connectors/
│   ├── servicenow/
│   │   ├── connector.json        # Connector metadata
│   │   ├── README.md             # Documentation
│   │   ├── CHANGELOG.md          # Version history
│   │   ├── package.json
│   │   └── src/
│   ├── vmware-vsphere/
│   ├── aws-discovery/
│   └── ... (43 connectors)
└── .github/workflows/
    ├── build-and-test.yml         # CI
    ├── publish-connector.yml      # CD (GitHub Releases)
    └── update-catalog.yml         # Update catalog.json
```

## Catalog Format

### catalog.json

```json
{
  "version": "1.0.0",
  "updated_at": "2025-10-10T12:00:00Z",
  "connectors": [
    {
      "type": "servicenow",
      "category": "connector",
      "name": "ServiceNow CMDB",
      "description": "Bidirectional sync with ServiceNow CMDB",
      "verified": true,
      "latest_version": "2.0.0",
      "versions": [
        {
          "version": "2.0.0",
          "released_at": "2025-10-01T00:00:00Z",
          "download_url": "https://github.com/happycmdb/connectors/releases/download/servicenow-2.0.0/package.tgz",
          "checksum": "sha256:abc123...",
          "size_bytes": 524288,
          "breaking_changes": false,
          "changelog": "Added support for custom CI types"
        }
      ],
      "author": "HappyCMDB",
      "homepage": "https://docs.happycmdb.io/connectors/servicenow",
      "repository": "https://github.com/happycmdb/connectors/tree/main/connectors/servicenow",
      "license": "Apache-2.0",
      "downloads": 1523,
      "rating": 4.8,
      "tags": ["cmdb", "itsm", "servicenow", "verified"]
    }
  ],
  "categories": [
    {
      "id": "discovery",
      "name": "Discovery Workers",
      "description": "Active infrastructure scanning",
      "count": 20
    },
    {
      "id": "connector",
      "name": "Integration Connectors",
      "description": "External system integrations",
      "count": 25
    }
  ],
  "stats": {
    "total_connectors": 45,
    "total_downloads": 12453,
    "verified_connectors": 38,
    "community_connectors": 7
  }
}
```

## Database Schema

### connector_registry_cache

Caches remote catalog locally for fast browsing:

```sql
CREATE TABLE connector_registry_cache (
  connector_type VARCHAR(100) PRIMARY KEY,
  category VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Availability
  verified BOOLEAN DEFAULT false,
  latest_version VARCHAR(20) NOT NULL,

  -- All available versions
  versions JSONB NOT NULL, -- Array of version objects

  -- Metadata
  author VARCHAR(255),
  homepage VARCHAR(500),
  repository VARCHAR(500),
  license VARCHAR(50),

  -- Statistics
  downloads INTEGER DEFAULT 0,
  rating DECIMAL(3, 2) DEFAULT 0.0,

  -- Tags
  tags TEXT[] DEFAULT '{}',

  -- Cache metadata
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  cache_expires_at TIMESTAMP NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_registry_cache_category ON connector_registry_cache(category);
CREATE INDEX idx_registry_cache_verified ON connector_registry_cache(verified);
CREATE INDEX idx_registry_cache_tags ON connector_registry_cache USING gin(tags);
```

## Browsing Connectors

### Web UI

**Connector Catalog Page** - Browse available connectors with:
- **Search** - Full-text search across name, description, tags
- **Category Filter** - Discovery vs Integration Connectors
- **Verified Badge** - Show only verified connectors
- **Sort Options** - Downloads, rating, name, newest

**Connector Card Display**:
- Connector icon/logo
- Name and short description
- Latest version
- Downloads count
- Star rating
- Tags
- Install button
- "Verified" badge if applicable

### REST API

**List Available Connectors**

```bash
GET /api/v1/connectors/registry

Query Parameters:
  - category: 'discovery' | 'connector'
  - search: string
  - verified: boolean
  - tags: string[]
  - sort: 'downloads' | 'rating' | 'name' | 'newest'
  - limit: number (default: 50)
  - offset: number (default: 0)
```

**Response**:
```json
{
  "success": true,
  "data": {
    "connectors": [
      {
        "type": "servicenow",
        "name": "ServiceNow CMDB",
        "category": "connector",
        "description": "Bidirectional sync with ServiceNow CMDB",
        "verified": true,
        "latest_version": "2.0.0",
        "downloads": 1523,
        "rating": 4.8,
        "tags": ["cmdb", "itsm", "servicenow"]
      }
    ],
    "total": 45,
    "limit": 50,
    "offset": 0
  }
}
```

**Get Connector Details**

```bash
GET /api/v1/connectors/registry/:type
```

**Response**:
```json
{
  "success": true,
  "data": {
    "type": "servicenow",
    "name": "ServiceNow CMDB",
    "description": "...",
    "verified": true,
    "latest_version": "2.0.0",
    "versions": [
      {
        "version": "2.0.0",
        "released_at": "2025-10-01T00:00:00Z",
        "download_url": "...",
        "checksum": "sha256:...",
        "size_bytes": 524288,
        "breaking_changes": false,
        "changelog": "..."
      }
    ],
    "author": "HappyCMDB",
    "homepage": "...",
    "repository": "...",
    "license": "Apache-2.0",
    "tags": ["cmdb", "itsm"]
  }
}
```

### GraphQL API

```graphql
query {
  connectorRegistry(
    category: CONNECTOR,
    verifiedOnly: true,
    search: "vmware"
  ) {
    type
    name
    description
    verified
    latestVersion
    downloads
    rating
    tags
  }
}
```

### CLI

```bash
# List all connectors
happycmdb connector list

# Search connectors
happycmdb connector search vmware

# Show connector details
happycmdb connector info vmware-vsphere

# Filter by category
happycmdb connector list --category discovery

# Show only verified
happycmdb connector list --verified
```

## Installing Connectors

### Installation Flow

1. **Browse Catalog** - User finds desired connector
2. **Select Version** - Choose version to install (latest by default)
3. **Download Package** - Fetch `.tgz` from GitHub releases
4. **Verify Checksum** - Ensure package integrity
5. **Extract Package** - Unpack to connectors directory
6. **Install Dependencies** - Run `npm install` in connector directory
7. **Validate Metadata** - Parse and validate `connector.json`
8. **Register Connector** - Add to `installed_connectors` table
9. **Load Capabilities** - Store resources and configuration schema

### Web UI

**Install Modal**:
1. Select connector
2. Choose version (dropdown with available versions)
3. Review connector details (description, size, dependencies)
4. Click "Install"
5. Progress indicator during installation
6. Success message with "Configure" button

### REST API

**Install Connector**

```bash
POST /api/v1/connectors/install

Body:
{
  "connector_type": "servicenow",
  "version": "2.0.0"  // Optional, defaults to latest
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "uuid-123-abc",
    "connector_type": "servicenow",
    "installed_version": "2.0.0",
    "installed_at": "2025-10-10T12:00:00Z",
    "status": "installed"
  }
}
```

### CLI

```bash
# Install latest version
happycmdb connector install servicenow

# Install specific version
happycmdb connector install servicenow@1.5.0

# Force reinstall
happycmdb connector install servicenow --force

# Install from local file
happycmdb connector install --file ./servicenow-2.0.0.tgz
```

## Updating Connectors

### Check for Updates

**Endpoint**: `GET /api/v1/connectors/updates`

**Response**:
```json
{
  "success": true,
  "data": {
    "updates_available": [
      {
        "connector_type": "servicenow",
        "current_version": "1.5.0",
        "latest_version": "2.0.0",
        "breaking_changes": true,
        "changelog": "Added support for custom CI types"
      }
    ],
    "up_to_date": [
      {
        "connector_type": "aws-discovery",
        "version": "3.1.0"
      }
    ]
  }
}
```

### Update Connector

**Endpoint**: `PUT /api/v1/connectors/:type/update`

**Request Body**:
```json
{
  "version": "2.0.0"  // Optional, defaults to latest
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "connector_type": "servicenow",
    "previous_version": "1.5.0",
    "new_version": "2.0.0",
    "updated_at": "2025-10-10T12:30:00Z",
    "breaking_changes": true
  }
}
```

### CLI

```bash
# Check for updates
happycmdb connector outdated

# Update specific connector
happycmdb connector update servicenow

# Update all connectors
happycmdb connector update --all

# Update to specific version
happycmdb connector update servicenow --version 2.0.0
```

## Uninstalling Connectors

### Safety Checks

Before uninstalling, the system checks:
1. **Active configurations** - Are any connector configs using this?
2. **Running jobs** - Are any jobs currently executing?
3. **Dependencies** - Do other connectors depend on this?

If any checks fail, uninstall is blocked with a detailed error message.

### Uninstall Flow

1. **Pre-check** - Verify no active configurations or jobs
2. **Disable Configs** - Mark all configurations as disabled
3. **Remove Files** - Delete connector directory
4. **Update Database** - Remove from `installed_connectors`
5. **Cleanup Dependencies** - Remove unused npm packages

### REST API

**Uninstall Connector**

```bash
DELETE /api/v1/connectors/:type

Query Parameters:
  - force: boolean (skip safety checks, dangerous!)
```

**Response**:
```json
{
  "success": true,
  "data": {
    "connector_type": "servicenow",
    "uninstalled": true,
    "message": "Connector uninstalled successfully"
  }
}
```

### CLI

```bash
# Uninstall connector
happycmdb connector uninstall servicenow

# Force uninstall (skip checks)
happycmdb connector uninstall servicenow --force
```

## Connector Verification

### Verified Badge

Connectors can be marked as "verified" by the HappyCMDB team, indicating:
- **Code Review** - Source code reviewed for security and quality
- **Testing** - Automated tests with >80% coverage
- **Documentation** - Complete README with examples
- **Maintenance** - Actively maintained with regular updates
- **Security** - No known vulnerabilities

### Verification Process

1. **Submit PR** - Connector submitted to `happycmdb/connectors` repo
2. **Automated Checks** - CI runs tests, linting, security scans
3. **Code Review** - HappyCMDB team reviews implementation
4. **Manual Testing** - Test with real external systems
5. **Documentation Review** - Verify docs are complete
6. **Approval** - Mark as verified in `catalog.json`
7. **Publish** - Release to registry with verified badge

## Cache Management

### Refresh Cache

The registry cache is automatically refreshed every 24 hours. Manual refresh:

```bash
# API
POST /api/v1/connectors/registry/refresh

# CLI
happycmdb connector cache refresh
```

### Clear Cache

```bash
# CLI
happycmdb connector cache clear
```

## Private Registries

### Enterprise Use Case

Organizations can host private connector registries for:
- **Internal connectors** - Custom integrations not for public use
- **Security** - Keep proprietary connectors private
- **Compliance** - Meet regulatory requirements for code review

### Configuration

```yaml
# config/connectors.yml
registries:
  - name: public
    url: https://raw.githubusercontent.com/happycmdb/connectors/main/catalog.json
    priority: 2
    enabled: true

  - name: corporate
    url: https://connectors.company.com/catalog.json
    priority: 1  # Higher priority = checked first
    enabled: true
    auth:
      type: bearer
      token: ${CORPORATE_REGISTRY_TOKEN}
```

## Connector Statistics

### Track Connector Usage

```sql
-- Most popular connectors
SELECT
  c.connector_type,
  c.name,
  COUNT(DISTINCT cc.id) AS config_count,
  SUM(crh.records_loaded) AS total_records_synced
FROM installed_connectors c
LEFT JOIN connector_configurations cc ON c.connector_type = cc.connector_type
LEFT JOIN connector_run_history crh ON cc.id = crh.config_id
WHERE crh.status = 'completed'
GROUP BY c.connector_type, c.name
ORDER BY config_count DESC, total_records_synced DESC
LIMIT 10;
```

## Security Considerations

### Checksum Verification

All downloaded packages are verified against published checksums:

```typescript
async function installConnector(type: string, version: string) {
  const metadata = await registry.getConnectorMetadata(type, version);
  const packagePath = await downloader.download(metadata.download_url);

  // Compute SHA256 checksum
  const actualChecksum = await computeSHA256(packagePath);

  // Verify against published checksum
  if (actualChecksum !== metadata.checksum) {
    throw new Error('Checksum mismatch - package may be compromised');
  }

  // Proceed with installation
  await installer.install(packagePath);
}
```

### Code Signing (Future Enhancement)

Planned for future releases:
- GPG signatures for verified connectors
- Public key verification
- Trust chain validation

## Troubleshooting

### Installation Fails with Checksum Error

**Problem**: Connector download fails checksum verification

**Solutions**:
1. Retry download (may be corrupted)
2. Check network connectivity
3. Verify catalog cache is up-to-date
4. Report to HappyCMDB team if persistent

### Connector Not Appearing in Catalog

**Problem**: Recently published connector not visible

**Solutions**:
1. Refresh registry cache
2. Wait for 24-hour cache expiration
3. Check if connector is in `catalog.json` on GitHub
4. Verify catalog URL in configuration

### Update Fails with Dependency Error

**Problem**: Connector update fails due to npm dependency conflict

**Solutions**:
1. Check compatibility requirements
2. Update Node.js version if needed
3. Clear npm cache: `npm cache clean --force`
4. Retry installation

## Best Practices

1. **Stay Updated** - Enable automatic update notifications
2. **Test Updates** - Test connector updates in staging first
3. **Review Changelogs** - Read breaking changes before updating
4. **Pin Versions** - Pin critical connectors to specific versions
5. **Monitor Health** - Track connector success rates
6. **Prefer Verified** - Use verified connectors when available
7. **Report Issues** - Report bugs to connector maintainers
8. **Contribute Back** - Submit improvements to community connectors

## Related Documentation

- [Connector Framework Architecture](/architecture/connector-framework)
- [Unified Credentials](/components/credentials)
- [Discovery Agents](/components/discovery-agents)
- [CLI Commands](/quick-reference/cli-commands)
- [Version History](/architecture/version-history)
