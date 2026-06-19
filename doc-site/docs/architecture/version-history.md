# HappyCMDB Version History

## Overview

HappyCMDB has evolved significantly from v1.0 to v2.0+, transitioning from a basic CMDB with discovery workers to an enterprise integration platform with advanced features like connector framework, unified credentials, and multi-resource support.

## Version 1.0 - Core CMDB (Initial Release)

**Release Date**: September 2025
**Status**: ✅ Production (5 phases complete)

### Key Features

- **Graph Database** - Neo4j as primary CI datastore
- **Multi-Cloud Discovery** - Agentless discovery for AWS, Azure, GCP
- **SSH Discovery** - Linux/Unix server discovery
- **Network Discovery** - NMAP-based network scanning
- **REST + GraphQL APIs** - Dual API layer
- **PostgreSQL Data Mart** - Analytics and reporting
- **BullMQ Job Queue** - Background job processing
- **React Web UI** - Basic dashboard
- **Authentication** - JWT-based auth with RBAC

### Architecture

```
Presentation (React UI, CLI)
    ↓
API Layer (REST + GraphQL)
    ↓
Discovery Workers (AWS, Azure, GCP, SSH, NMAP)
    ↓
Storage (Neo4j, PostgreSQL, Redis)
```

### Discovery Workers (v1.0)

Individual workers with direct database writes:

- `AWSDiscoveryWorker` - EC2, RDS, S3 discovery
- `AzureDiscoveryWorker` - Azure VMs, SQL, Storage
- `GCPDiscoveryWorker` - GCP Compute, Storage
- `SSHDiscoveryWorker` - SSH-based server discovery
- `NmapDiscoveryWorker` - Network scanning

**Limitations:**
- Ad-hoc implementation per provider
- Direct Neo4j writes (no abstraction)
- No relationship extraction
- No identity resolution
- Manual configuration per integration
- Provider-specific credential types

### Database Schema (v1.0)

```sql
-- Discovery Credentials (v1.0 - DEPRECATED in v2.0)
CREATE TABLE discovery_credentials (
  id UUID PRIMARY KEY,
  type VARCHAR(50), -- 'aws', 'azure', 'gcp', 'ssh', 'api_key', 'snmp'
  encrypted_credentials JSONB,
  -- Simple provider-specific design
);

-- Discovery Definitions
CREATE TABLE discovery_definitions (
  id UUID PRIMARY KEY,
  provider VARCHAR(50),
  method VARCHAR(50),
  credential_id UUID,  -- Single credential only
  config JSONB
);
```

## Version 2.0 - Integration Platform

**Release Date**: October 2025
**Status**: 🚧 In Progress (67% complete)

### Major Enhancements

#### 1. Connector Framework

Replaced ad-hoc discovery workers with standardized connector architecture:

**Before (v1.0)**:
```typescript
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

**After (v2.0)**:
```typescript
class AWSIntegrationConnector extends BaseIntegrationConnector {
  async extract() {
    // Return raw data (no direct DB writes)
    return instances.map(i => ({ source_id: i.InstanceId, raw_data: i }));
  }

  async transform(data) {
    // Convert to standard format
    return { id, name, type: 'virtual-machine', metadata };
  }

  extractIdentifiers(data) {
    // For identity resolution
    return { external_id, fqdn, ip_address };
  }

  async extractRelationships() {
    // Discover relationships
    return relationships;
  }
}
```

**Benefits**:
- Separation of concerns (extract, transform, load)
- Event-driven processing
- Identity resolution across sources
- Relationship discovery
- Multi-resource support

#### 2. Unified Credential System

Protocol-based credentials replace provider-specific types:

**Before (v1.0)**:
- 6 credential types: `aws`, `azure`, `gcp`, `ssh`, `api_key`, `snmp`
- Tight coupling to providers
- No reusability across integrations

**After (v2.0)**:
- 14 authentication protocols: `aws_iam`, `azure_sp`, `gcp_sa`, `ssh_key`, `oauth2`, `api_key`, `bearer`, `basic`, `snmp_v2c`, `snmp_v3`, `certificate`, `kerberos`, `winrm`
- **Credential Affinity** - Match credentials by network, hostname, OS, device type
- **Credential Sets** - Group credentials with strategies (sequential, parallel, adaptive)
- Unified management for discovery, connectors, and ETL

#### 3. Agent-Based Discovery

Smart agent deployment with network-aware routing:

**Features**:
- Agents run locally in networks (behind firewalls, air-gapped)
- Auto-detection of reachable networks
- Smart routing based on network affinity
- Load balancing across multiple agents
- Heartbeat monitoring
- Capability negotiation

**Use Case**:
```typescript
// Discovery definition (no agent specified)
{
  method: "agent",
  agent_id: null,  // Auto-select
  config: { targets: ["10.0.0.0/16"] }
}

// System automatically selects best agent:
// - Active status
// - Network reachability (10.0.0.0/16 coverage)
// - Provider capability (nmap, ssh)
// - Success rate
```

#### 4. Multi-Resource Support

Single connector handles multiple resource types:

**Example: ServiceNow Connector**
```json
{
  "resources": [
    {
      "id": "cmdb_ci_server",
      "name": "Servers",
      "ciType": "server",
      "enabledByDefault": true
    },
    {
      "id": "cmdb_ci_vm_instance",
      "name": "Virtual Machines",
      "ciType": "virtual-machine"
    },
    {
      "id": "cmdb_ci_database",
      "name": "Databases",
      "ciType": "database"
    }
  ]
}
```

**Benefits**:
- Single authentication for all resources
- Resource-level configuration
- Dependency management
- Resource-specific metrics

#### 5. Connector Registry

Self-hosted catalog with browse, install, update functionality:

**Features**:
- GitHub-based package hosting
- Version management
- Checksum verification
- Verified badge system
- CLI + Web UI + API management
- Private registry support

**Workflow**:
```bash
# Browse catalog
happycmdb connector list

# Install connector
happycmdb connector install servicenow

# Check for updates
happycmdb connector outdated

# Update connector
happycmdb connector update servicenow
```

#### 6. Identity Resolution Engine

Multi-source deduplication with conflict resolution:

**Features**:
- Match CIs across multiple sources (AWS + ServiceNow)
- Confidence scoring
- Conflict resolution strategies
- Master data management

#### 7. Enhanced Data Mart

TimescaleDB-powered analytics:

**Features**:
- Time-series CI history
- Change tracking
- Aggregated metrics
- Pre-built BI dashboards

### Migration from v1.0 to v2.0

#### Database Migrations

```sql
-- 015_unified_credentials.sql
-- Drop old discovery_credentials table
DROP TABLE IF EXISTS discovery_credentials CASCADE;

-- Create new unified credentials
CREATE TABLE credentials (
  id UUID PRIMARY KEY,
  protocol VARCHAR(50) NOT NULL,  -- Protocol-based!
  scope VARCHAR(50) NOT NULL,
  encrypted_credentials JSONB,
  affinity JSONB,  -- NEW: Affinity matching
  -- ...
);

-- Create credential sets
CREATE TABLE credential_sets (
  id UUID PRIMARY KEY,
  credential_ids UUID[] NOT NULL,  -- Array of credentials
  strategy VARCHAR(50) NOT NULL,   -- sequential, parallel, adaptive
  -- ...
);

-- Update discovery_definitions
ALTER TABLE discovery_definitions
  ADD COLUMN credential_set_id UUID,  -- NEW: Support credential sets
  ADD CONSTRAINT xor_credential_or_set CHECK (...);

-- 006_discovery_agents.sql
-- Add discovery agents support
CREATE TABLE discovery_agents (
  id UUID PRIMARY KEY,
  agent_id VARCHAR(255) UNIQUE NOT NULL,
  provider_capabilities TEXT[],
  reachable_networks TEXT[],  -- NEW: Network affinity
  -- ...
);
```

#### Code Migration

**v1.0 Discovery Workers → v2.0 Integration Connectors**

All v1.0 workers converted:
- `AWSDiscoveryWorker` → `AWSIntegrationConnector`
- `AzureDiscoveryWorker` → `AzureIntegrationConnector`
- `GCPDiscoveryWorker` → `GCPIntegrationConnector`
- `SSHDiscoveryWorker` → `SSHIntegrationConnector`
- `NmapDiscoveryWorker` → `NmapIntegrationConnector`

**Protocol Adapters**:
```typescript
// Credential conversion
const awsCreds = CredentialProtocolAdapter.toAWSCredentials(unifiedCred);
const sshConfig = CredentialProtocolAdapter.toSSHConfig(unifiedCred);
```

## Version Comparison

| Feature | v1.0 | v2.0 |
|---------|------|------|
| **Discovery** | Ad-hoc workers | Standardized connectors |
| **Credentials** | 6 provider types | 14 protocol types |
| **Affinity** | ❌ None | ✅ Network/hostname/OS matching |
| **Credential Sets** | ❌ None | ✅ Sequential/parallel/adaptive |
| **Agent Discovery** | ❌ Agentless only | ✅ Agent-based + smart routing |
| **Multi-Resource** | ❌ One CI type per worker | ✅ Multiple resources per connector |
| **Registry** | ❌ None | ✅ Self-hosted catalog |
| **Identity Resolution** | ❌ None | ✅ Multi-source deduplication |
| **Relationships** | ✅ Basic | ✅ Advanced extraction |
| **Event System** | ❌ None | ✅ Event-driven processing |

## Implementation Status (v2.0)

### ✅ Completed (67%)

1. Connector framework architecture
2. Base connector interface
3. Connector registry system
4. Unified credential types and service
5. Credential affinity matching
6. Credential sets and strategies
7. Protocol adapters (AWS, Azure, GCP, SSH, SNMP)
8. Discovery agent infrastructure
9. Agent registration and heartbeat
10. Smart routing (network-based agent selection)
11. Multi-resource connector support
12. Database migrations (015_unified_credentials, 006_discovery_agents)
13. Updated discovery workers (AWS, Azure, GCP)
14. Clean cutover from v1.0 credentials

### 🔜 In Progress (33%)

15. REST API controllers (credentials, agents, connectors)
16. GraphQL schema and resolvers
17. Web UI components:
    - Credential management UI
    - Credential affinity editor
    - Credential set builder
    - Agent management dashboard
    - Connector catalog browser
    - Connector configuration wizard
18. Integration tests
19. Documentation completion
20. Identity resolution engine
21. Enhanced data mart with TimescaleDB
22. Connector library (43 connectors delivered)

## Roadmap

### v2.1 - Enterprise Features (Q1 2026)

- **Visual Data Mapping** - No-code transformation rules
- **Kafka Event Streaming** - Real-time data pipeline
- **Advanced Analytics** - Pre-built BI dashboards
- **AI-Powered Insights** - Anomaly detection and recommendations

### v2.2 - Scalability & Performance (Q2 2026)

- **Horizontal Scaling** - Multi-instance deployment
- **Caching Layer** - Redis-based query cache
- **Query Optimization** - Neo4j query performance tuning
- **Rate Limiting** - API throttling and quotas

### v3.0 - AI/ML Integration (Q3 2026)

- **ML-Based Identity Resolution** - Machine learning matching
- **Predictive Maintenance** - Forecast CI failures
- **Automated Classification** - AI-powered CI tagging
- **Natural Language Queries** - ChatGPT-style interface

## Breaking Changes

### v1.0 → v2.0

#### Credentials

**Breaking**: `discovery_credentials` table dropped, replaced with `credentials`

**Migration Path**:
1. Export existing credentials (if any)
2. Apply migration 015
3. Create new credentials using unified system
4. Update discovery definitions with new credential IDs

#### Discovery Workers

**Breaking**: Worker interfaces changed

**Migration Path**:
- Workers still function but deprecated
- Migrate to new connector framework for v2.0+ features
- Use protocol adapters for backward compatibility

#### API Changes

**New Endpoints**:
- `/api/v1/credentials` (replaces `/api/v1/discovery/credentials`)
- `/api/v1/credential-sets` (new)
- `/api/v1/agents` (new)
- `/api/v1/connectors` (new)

**Deprecated Endpoints**:
- `/api/v1/discovery/credentials` (use `/api/v1/credentials`)

## Best Practices for Migration

1. **Test in Staging First** - Never migrate production directly
2. **Backup Database** - Full backup before migration
3. **Export Credentials** - Save existing credentials externally
4. **Update in Phases** - Migrate one component at a time
5. **Monitor Closely** - Watch logs and metrics during migration
6. **Rollback Plan** - Have database restore procedure ready
7. **Update Documentation** - Document custom configurations

## Related Documentation

- [Connector Framework Architecture](/architecture/connector-framework)
- [Unified Credentials](/components/credentials)
- [Discovery Agents](/components/discovery-agents)
- [Connector Registry](/components/connector-registry)
- [System Overview](/architecture/system-overview)

---

**Current Version**: v2.0 (67% complete)
**Last Updated**: October 2025
