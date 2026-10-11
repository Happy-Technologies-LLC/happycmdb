# Connector Registry

## Overview

The Connector Registry is a browsable catalog of connector templates. The application cannot install, update, verify or remove globally shared connector code. Deployment packaging/file placement outside the application is the only supported operator installation path until a separately reviewed P-6 change.

## Architecture

The registry consists of three components:

1. **Remote Catalog** - GitHub repository hosting connector packages and metadata
2. **Local Cache** - PostgreSQL cache of available connectors
3. **Management API** - Authenticated REST/GraphQL endpoints for browsing; shared lifecycle mutations return a fixed refusal.

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
- Installed/available-for-deployment status (no application install control)
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

## Connector code lifecycle

Browse connector templates through the catalog, authenticated read APIs or
`happycmdb connector list`. Deployment operators package and place connector
code **outside** the running application. The repository no longer ships an
installer library, CLI installation command, or web installation wizard.
External callers previously importing `ConnectorInstaller`, `getConnectorInstaller`
or `DownloadOptions` must stop using those removed exports and deep imports.
No compatibility alias remains.

Authenticated REST `/connectors/install`, `PUT /connectors/:type/update`,
`DELETE /connectors/:type`, `/connectors/:type/verify`, and
`/connectors/cache/refresh` always return HTTP 503 with
`CONNECTOR_LIFECYCLE_UNAVAILABLE`; GraphQL lifecycle mutations return the same
fixed error code. No tenant, seeded internal admin or verified platform operator
can perform runtime global connector changes. A separate P-6 review is required
before any runtime installation support is restored. `GET /connectors/outdated`
remains available for read-only version comparison.

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

## Cache management

Shared registry refresh is unavailable at runtime. Authenticated
`POST /api/v1/connectors/cache/refresh` returns HTTP 503 with
`CONNECTOR_LIFECYCLE_UNAVAILABLE`; deployment operations own any catalog
refresh outside the application.

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

### Package integrity

The application no longer downloads or verifies connector packages. Deployment
operators must verify package integrity before placing code outside the running
application; catalog entries and their published checksums are not an
application installation capability.

### Code Signing (Future Enhancement)

Planned for future releases:
- GPG signatures for verified connectors
- Public key verification
- Trust chain validation

## Troubleshooting

### Connector code is not available

Check deployment packaging and file placement outside the application, then
verify the expected installed connector metadata is visible through the
authenticated read APIs. The API, CLI and web UI cannot install or repair code.

### Catalog entry is missing

Check the externally provided catalog and deployment cache. Runtime cache
refresh is unavailable; no HTTP caller can force a shared registry mutation.

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
