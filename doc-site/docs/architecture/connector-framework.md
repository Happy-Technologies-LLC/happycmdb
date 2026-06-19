# Connector Framework Architecture

## Overview

The HappyCMDB Connector Framework is a plugin-based architecture that enables dynamic integration with external systems for data discovery, synchronization, and management. Introduced in v2.0, it replaces the v1.0 ad-hoc discovery workers with a standardized, scalable integration platform.

## Key Features

- **Plugin Architecture** - Dynamic connector loading and lifecycle management
- **Multi-Resource Support** - Single connector can handle multiple resource types
- **Unified Configuration** - Standardized connection and resource configuration
- **Registry System** - Browse, install, and update connectors from a catalog
- **Event-Driven** - Emit events for downstream processing (identity resolution, relationships)
- **Health Monitoring** - Built-in health checks and performance metrics

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    HappyCMDB Platform                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐│
│  │   Web UI        │  │   CLI Tool      │  │  REST API   ││
│  │   (React)       │  │   (Node.js)     │  │  Clients    ││
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘│
│           │                    │                   │        │
│           └────────────────────┼───────────────────┘        │
│                                ▼                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         API Server (REST + GraphQL)                 │   │
│  │  - Connector CRUD operations                        │   │
│  │  - Resource management                              │   │
│  │  - Registry integration                             │   │
│  │  - Job scheduling                                   │   │
│  └────────────────────┬────────────────────────────────┘   │
│                       │                                     │
│  ┌────────────────────┴────────────────────────────────┐   │
│  │           Connector Management Layer                │   │
│  │  - ConnectorRegistry (local installed)              │   │
│  │  - ConnectorInstaller (download/install)            │   │
│  │  - ConnectorExecutor (run ETL jobs)                 │   │
│  │  - VersionManager (updates/migrations)              │   │
│  └────────────────────┬────────────────────────────────┘   │
│                       │                                     │
│  ┌────────────────────┴────────────────────────────────┐   │
│  │              Data Layer                             │   │
│  │  - PostgreSQL (metadata, configs, history)          │   │
│  │  - Neo4j (discovered CIs, relationships)            │   │
│  │  - Redis (job queues, caching)                      │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                        ▲
                        │ HTTPS
                        ▼
┌─────────────────────────────────────────────────────────────┐
│            Connector Registry (Self-Hosted)                 │
│  - GitHub Releases (connector packages)                     │
│  - catalog.json (manifest)                                  │
│  - Documentation (per connector)                            │
│  - 100% Open Source (Apache 2.0)                            │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### Base Connector Interface

All connectors extend `BaseIntegrationConnector` which provides:

```typescript
abstract class BaseIntegrationConnector extends EventEmitter {
  // Lifecycle methods
  abstract initialize(): Promise<void>;
  abstract testConnection(): Promise<TestResult>;

  // Data extraction
  abstract extract(): Promise<ExtractedData[]>;
  abstract extractRelationships(): Promise<ExtractedRelationship[]>;
  abstract transform(sourceData: any): Promise<TransformedCI>;
  abstract extractIdentifiers(data: any): IdentificationAttributes;

  // Orchestration
  async run(): Promise<RunResult>;
  getHealth(): ConnectorHealth;
}
```

**Key Methods:**

- **`initialize()`** - Set up API clients, validate credentials, prepare resources
- **`testConnection()`** - Verify connectivity before running extraction
- **`extract()`** - Retrieve raw data from external system
- **`extractRelationships()`** - Discover relationships between CIs
- **`transform()`** - Convert raw data to standardized CI format
- **`extractIdentifiers()`** - Extract unique identifiers for deduplication
- **`run()`** - Orchestrated execution with event emission
- **`getHealth()`** - Return current status and metrics

### Connector Registry

The `ConnectorRegistry` manages installed connectors:

```typescript
class ConnectorRegistry {
  async discover(connectorsPath: string): Promise<void>;
  async createInstance(config: ConnectorConfig): Promise<BaseIntegrationConnector>;
  getInstance(name: string): BaseIntegrationConnector | undefined;
  getAvailableTypes(): ConnectorDefinition[];
}
```

**Features:**
- Auto-discovers connectors from filesystem
- Loads connector metadata from `connector.json`
- Creates instances with dependency injection
- Maintains singleton instances per configuration

### Integration Manager

The `IntegrationManager` orchestrates connector lifecycle:

```typescript
class IntegrationManager {
  async loadConnectors(configs: ConnectorConfig[]): Promise<void>;
  async runConnector(name: string): Promise<RunResult>;
  getHealthStatuses(): ConnectorHealth[];
  setEnabled(name: string, enabled: boolean): void;
}
```

**Features:**
- Schedules connectors with cron expressions
- Forwards events to identity resolution and relationship processing
- Manages connector health and status
- Handles graceful shutdown and restart

## Connector Metadata

Each connector includes a `connector.json` manifest:

```json
{
  "type": "servicenow",
  "name": "ServiceNow CMDB",
  "version": "2.0.0",
  "description": "Integration connector for ServiceNow CMDB",
  "verified": true,
  "entryPoint": "index.js",
  "capabilities": {
    "extraction": true,
    "relationships": true,
    "incremental": true,
    "bidirectional": true
  },
  "resources": [
    {
      "id": "cmdb_ci_server",
      "name": "Servers",
      "description": "Physical and virtual servers",
      "ciType": "server",
      "enabledByDefault": true,
      "operations": ["extract", "sync"],
      "extraction": {
        "incremental": true,
        "batchSize": 100,
        "rateLimit": 10
      }
    }
  ],
  "configuration_schema": {
    "connection": [
      {
        "name": "instance_url",
        "type": "string",
        "required": true,
        "description": "ServiceNow instance URL"
      },
      {
        "name": "username",
        "type": "string",
        "required": true,
        "secret": false
      },
      {
        "name": "password",
        "type": "string",
        "required": true,
        "secret": true
      }
    ]
  }
}
```

## Multi-Resource Support

Connectors can manage multiple resource types within a single integration:

**Example: ServiceNow Connector Resources**
- `cmdb_ci_server` - Physical/virtual servers
- `cmdb_ci_vm_instance` - Virtual machines
- `cmdb_ci_database` - Database instances
- `cmdb_ci_app` - Applications
- `cmdb_ci_service` - Business services
- `cmdb_ci_network_adapter` - Network interfaces

**Benefits:**
- Single authentication/connection for all resources
- Shared configuration and credentials
- Dependency management (e.g., extract servers before applications)
- Resource-level metrics and error handling

## Event-Driven Processing

Connectors emit events during execution:

```typescript
// Events emitted by connectors
connector.on('run:start', ({ runId, connector }) => { });
connector.on('data:extracted', ({ runId, records }) => { });
connector.on('ci:transformed', ({ runId, source, ci, identifiers }) => { });
connector.on('relationship:extracted', ({ runId, relationship }) => { });
connector.on('run:completed', ({ runId, metrics }) => { });
connector.on('run:failed', ({ runId, error }) => { });
```

These events are consumed by:
- **Identity Resolution Engine** - Deduplicates CIs from multiple sources
- **Relationship Processor** - Creates Neo4j relationships
- **Metrics Collector** - Tracks performance and success rates
- **Notification Service** - Alerts on failures

## Database Schema

### Installed Connectors

```sql
CREATE TABLE installed_connectors (
  id UUID PRIMARY KEY,
  connector_type VARCHAR(100) UNIQUE NOT NULL,
  category VARCHAR(50) NOT NULL, -- 'discovery' or 'connector'
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Version
  installed_version VARCHAR(20) NOT NULL,
  latest_available_version VARCHAR(20),

  -- Status
  enabled BOOLEAN DEFAULT true,
  verified BOOLEAN DEFAULT false,

  -- Installation
  installed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  install_path TEXT NOT NULL,

  -- Metadata from connector.json
  metadata JSONB NOT NULL,
  capabilities JSONB,
  resources JSONB,
  configuration_schema JSONB,

  -- Statistics
  total_runs INTEGER DEFAULT 0,
  successful_runs INTEGER DEFAULT 0,
  failed_runs INTEGER DEFAULT 0,
  last_run_at TIMESTAMP
);
```

### Connector Configurations

```sql
CREATE TABLE connector_configurations (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  connector_type VARCHAR(100) NOT NULL,

  -- Status
  enabled BOOLEAN DEFAULT true,

  -- Scheduling
  schedule VARCHAR(100), -- cron expression
  schedule_enabled BOOLEAN DEFAULT false,

  -- Configuration
  connection JSONB NOT NULL,
  options JSONB DEFAULT '{}',
  enabled_resources TEXT[],
  resource_configs JSONB DEFAULT '{}',

  -- Error handling
  max_retries INTEGER DEFAULT 3,
  retry_delay_seconds INTEGER DEFAULT 300,
  continue_on_error BOOLEAN DEFAULT false,

  -- Notifications
  notification_channels TEXT[],
  notification_on_success BOOLEAN DEFAULT false,
  notification_on_failure BOOLEAN DEFAULT true,

  -- Audit
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),

  FOREIGN KEY (connector_type)
    REFERENCES installed_connectors(connector_type)
    ON DELETE CASCADE
);
```

### Connector Run History

```sql
CREATE TABLE connector_run_history (
  id UUID PRIMARY KEY,
  config_id UUID NOT NULL,
  connector_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(100), -- NULL for connector-level runs

  -- Execution
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  status VARCHAR(50) NOT NULL, -- queued, running, completed, failed, cancelled

  -- Metrics
  records_extracted INTEGER DEFAULT 0,
  records_transformed INTEGER DEFAULT 0,
  records_loaded INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  duration_ms INTEGER,

  -- Errors
  errors JSONB DEFAULT '[]',
  error_message TEXT,

  -- Metadata
  triggered_by VARCHAR(50), -- manual, schedule, api, cli
  triggered_by_user VARCHAR(255),
  job_id VARCHAR(255), -- BullMQ job ID

  FOREIGN KEY (config_id)
    REFERENCES connector_configurations(id)
    ON DELETE CASCADE
);
```

## Connector Registry (Remote Catalog)

HappyCMDB hosts a self-hosted connector registry on GitHub:

**Repository:** `https://github.com/happycmdb/connectors`

**Structure:**
```
happycmdb-connectors/
├── catalog.json                  # Main manifest
├── connectors/
│   ├── servicenow/
│   │   ├── connector.json
│   │   ├── README.md
│   │   ├── CHANGELOG.md
│   │   ├── package.json
│   │   └── src/
│   ├── vmware-vsphere/
│   ├── aws-discovery/
│   └── ... (43 connectors)
└── .github/workflows/
    ├── build-and-test.yml
    ├── publish-connector.yml
    └── update-catalog.yml
```

**catalog.json Format:**
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
          "breaking_changes": false
        }
      ],
      "author": "HappyCMDB",
      "license": "Apache-2.0",
      "downloads": 1523,
      "rating": 4.8,
      "tags": ["cmdb", "itsm", "servicenow"]
    }
  ]
}
```

## Connector Lifecycle

### Installation Flow

1. **Browse Catalog** - User browses available connectors in UI/CLI
2. **Select Connector** - Choose connector type and version
3. **Download Package** - Fetch `.tgz` from GitHub releases
4. **Verify Checksum** - Ensure package integrity
5. **Install Dependencies** - `npm install` in connector directory
6. **Register Connector** - Add to `installed_connectors` table
7. **Load Metadata** - Parse `connector.json` and store capabilities

### Configuration Flow

1. **Select Connector** - Choose installed connector type
2. **Configure Connection** - Provide credentials and connection details
3. **Select Resources** - Choose which resources to sync (multi-resource)
4. **Configure Resources** - Set resource-specific options
5. **Set Schedule** - Optional cron expression for automated runs
6. **Test Connection** - Verify connectivity before saving
7. **Save Configuration** - Store in `connector_configurations` table

### Execution Flow

1. **Trigger Run** - Manual, scheduled, or API-triggered
2. **Load Configuration** - Retrieve from database
3. **Create Instance** - Instantiate connector with config
4. **Initialize** - Set up API clients and validate credentials
5. **Test Connection** - Quick health check
6. **Extract Data** - Retrieve raw data from external system
7. **Transform Data** - Convert to standardized CI format
8. **Extract Relationships** - Discover CI relationships
9. **Emit Events** - Send to identity resolution and relationship processor
10. **Record Metrics** - Update run history and statistics
11. **Send Notifications** - Alert on success/failure

## Example: ServiceNow Connector

### connector.json

```json
{
  "type": "servicenow",
  "name": "ServiceNow CMDB",
  "version": "2.0.0",
  "capabilities": {
    "extraction": true,
    "relationships": true,
    "incremental": true,
    "bidirectional": true
  },
  "resources": [
    {
      "id": "cmdb_ci_server",
      "name": "Servers",
      "ciType": "server",
      "enabledByDefault": true,
      "operations": ["extract", "sync"]
    },
    {
      "id": "cmdb_ci_vm_instance",
      "name": "Virtual Machines",
      "ciType": "virtual-machine",
      "enabledByDefault": true,
      "operations": ["extract", "sync"]
    },
    {
      "id": "cmdb_ci_database",
      "name": "Databases",
      "ciType": "database",
      "enabledByDefault": false,
      "operations": ["extract", "sync"]
    }
  ]
}
```

### Implementation

```typescript
import { BaseIntegrationConnector } from '@cmdb/integration-framework';

export default class ServiceNowConnector extends BaseIntegrationConnector {
  private client: ServiceNowClient;

  async initialize(): Promise<void> {
    this.client = new ServiceNowClient({
      instance: this.config.connection.instance_url,
      auth: {
        username: this.config.connection.username,
        password: this.config.connection.password,
      },
    });
  }

  async testConnection(): Promise<TestResult> {
    try {
      await this.client.get('/api/now/table/sys_user?sysparm_limit=1');
      return { success: true, message: 'Connected to ServiceNow' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  async extract(): Promise<ExtractedData[]> {
    const records: ExtractedData[] = [];

    // Extract each enabled resource
    for (const resourceId of this.config.enabled_resources) {
      const data = await this.extractResource(resourceId);
      records.push(...data);
    }

    return records;
  }

  private async extractResource(resourceId: string): Promise<ExtractedData[]> {
    const resourceConfig = this.config.resource_configs[resourceId] || {};
    const query = resourceConfig.query || '';

    const response = await this.client.get(
      `/api/now/table/${resourceId}?sysparm_query=${query}`
    );

    return response.result.map((record: any) => ({
      source_id: record.sys_id,
      source_type: `ServiceNow::${resourceId}`,
      raw_data: record,
    }));
  }

  async transform(sourceData: any): Promise<TransformedCI> {
    const record = sourceData.raw_data;

    return {
      id: `servicenow-${record.sys_id}`,
      name: record.name || record.sys_id,
      type: this.mapCIType(sourceData.source_type),
      metadata: {
        sys_id: record.sys_id,
        sys_class_name: record.sys_class_name,
        serial_number: record.serial_number,
        ip_address: record.ip_address,
        // ... other fields
      },
    };
  }

  extractIdentifiers(data: any): IdentificationAttributes {
    const record = data.raw_data;
    return {
      external_id: record.sys_id,
      serial_number: record.serial_number,
      mac_address: record.mac_address,
      fqdn: record.fqdn,
    };
  }

  async extractRelationships(): Promise<ExtractedRelationship[]> {
    // Extract CI relationships from ServiceNow
    const response = await this.client.get('/api/now/table/cmdb_rel_ci');

    return response.result.map((rel: any) => ({
      from_source_id: rel.parent.value,
      to_source_id: rel.child.value,
      type: rel.type.display_value,
    }));
  }
}
```

## Migration from v1.0 to v2.0

### v1.0 Discovery Workers

```typescript
// Old v1.0 approach
class AWSDiscoveryWorker {
  async discover() {
    // Direct Neo4j writes
    const instances = await this.fetchEC2Instances();
    for (const instance of instances) {
      await neo4j.run('CREATE (n:CI {id: $id, ...})', instance);
    }
  }
}
```

### v2.0 Integration Connectors

```typescript
// New v2.0 approach
class AWSIntegrationConnector extends BaseIntegrationConnector {
  async extract() {
    // Return raw data
    return instances.map(i => ({ source_id: i.InstanceId, raw_data: i }));
  }

  async transform(data) {
    // Convert to standard format
    return { id, name, type: 'virtual-machine', metadata };
  }

  extractIdentifiers(data) {
    // For deduplication
    return { external_id: data.raw_data.InstanceId, ... };
  }
}
```

**Key Differences:**
- **Separation of concerns** - Extract, transform, load are separate
- **Event emission** - Connectors don't write directly to database
- **Identity resolution** - Automatic deduplication across sources
- **Relationship extraction** - Explicit relationship discovery
- **Multi-resource** - Single connector handles multiple resource types

## Performance Considerations

### Batch Processing

```typescript
async extract(): Promise<ExtractedData[]> {
  const batchSize = this.config.options.batch_size || 100;
  const records: ExtractedData[] = [];

  let offset = 0;
  while (true) {
    const batch = await this.client.get({
      limit: batchSize,
      offset,
    });

    records.push(...batch);

    if (batch.length < batchSize) break;
    offset += batchSize;

    // Rate limiting
    await this.rateLimiter.wait();
  }

  return records;
}
```

### Incremental Extraction

```typescript
async extract(): Promise<ExtractedData[]> {
  const lastRun = this.state.last_run;

  if (lastRun && this.capabilities.incremental) {
    // Only fetch records updated since last run
    const query = `sys_updated_on>${lastRun.toISOString()}`;
    return await this.client.get({ query });
  }

  // Full extraction on first run
  return await this.client.get({});
}
```

### Resource Dependencies

```typescript
async extract(): Promise<ExtractedData[]> {
  const records: ExtractedData[] = [];

  // Extract in dependency order
  const orderedResources = this.getResourceDependencyOrder();

  for (const resourceId of orderedResources) {
    const resourceRecords = await this.extractResource(resourceId);
    records.push(...resourceRecords);

    // Store for dependent resources
    this.resourceCache.set(resourceId, resourceRecords);
  }

  return records;
}
```

## Security

### Credential Storage

- Credentials encrypted at rest in PostgreSQL
- Credentials loaded into memory only during connector execution
- Credentials never logged or exposed in API responses
- Use credential references instead of embedded credentials

### Connector Sandboxing

```typescript
// Connectors run in isolated Node.js VM context
const vm = require('vm');

const sandbox = {
  console: sandboxedConsole,
  require: sandboxedRequire,
  process: sandboxedProcess,
};

const context = vm.createContext(sandbox);
const connectorCode = fs.readFileSync(connectorPath);
vm.runInContext(connectorCode, context, { timeout: 300000 });
```

### Checksum Verification

```typescript
async installConnector(type: string, version: string) {
  const metadata = await registry.getConnectorMetadata(type, version);
  const packagePath = await downloader.download(metadata.download_url);

  // Verify checksum
  const actualChecksum = await computeSHA256(packagePath);
  if (actualChecksum !== metadata.checksum) {
    throw new Error('Checksum mismatch - package may be compromised');
  }

  // Install
  await installer.install(packagePath);
}
```

## Related Documentation

- [Unified Credentials System](/components/credentials)
- [Discovery Agents](/components/discovery-agents)
- [Connector Registry](/components/connector-registry)
- [Version History](/architecture/version-history)
- [System Overview](/architecture/system-overview)
- [CLI Commands](/quick-reference/cli-commands)
