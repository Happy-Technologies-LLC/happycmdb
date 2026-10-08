# Discovery Agents

## Overview

Discovery Agents register capabilities and public-network reachability for organization-scoped routing. Under Choice C, agent placement never grants access to private or internal targets.

> **Current Choice C restriction:** discovery refuses private, loopback, link-local,
> metadata, and platform targets for every caller, including agent-based discovery.
> Registration is not permission to scan internal networks. See
> [the fail-closed cutover](../../../docs/discovery-egress-agent-registry-design.md)
> for the current egress and organization-scope contract.

## Key Features

- **Public Network Reachability** - Match agents to validated public target ranges
- **Distributed Discovery** - Deploy agents in multiple locations without relaxing egress policy
- **Smart Routing** - Select only an agent covering every requested public network
- **Load Balancing** - Distribute eligible jobs across agents
- **Health Monitoring** - Track agent status with heartbeats
- **Capability Negotiation** - Agents advertise their discovery capabilities

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│               HappyCMDB API Server                        │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │       Agent Management Service                        │  │
│  │  - Agent registration                                 │  │
│  │  - Heartbeat monitoring                               │  │
│  │  - Smart routing (network affinity)                   │  │
│  │  - Job distribution                                   │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────┬──────────────────────────────────┬─┘
                         │                                  │
          ┌──────────────┴──────────────┐    ┌────────────┴──────────────┐
          │ Agent 1                     │    │ Agent 2                   │
          │ (Datacenter East)           │    │ (Datacenter West)         │
          │                             │    │                           │
          │ Networks:                   │    │ Networks:                 │
          │  - 8.8.8.0/24              │    │  - 9.9.9.0/24            │
          │  - 1.1.1.0/24              │    │  - 8.8.4.0/24            │
          │                             │    │                           │
          │ Capabilities:               │    │ Capabilities:             │
          │  - nmap                     │    │  - nmap                   │
          │  - ssh                      │    │  - ssh                    │
          │                             │    │  - snmp                   │
          └──────────────┬──────────────┘    └────────────┬──────────────┘
                         │                                 │
          ┌──────────────▼──────────────┐    ┌────────────▼──────────────┐
          │   Public Targets            │    │   Public Targets         │
          │   (Site East)               │    │   (Site West)            │
          │   - Validated ranges        │    │   - Validated ranges     │
          │   - Denied private targets  │    │   - Denied private hosts │
          │   - Denied internal names   │    │   - Denied metadata      │
          └─────────────────────────────┘    └───────────────────────────┘
```

## Database Schema

Migration `019_discovery_agents_organization_scope.sql` adds nullable
`organization_id` to the table created by `001_complete_schema.sql` and indexes
`(organization_id, last_heartbeat_at DESC)`. Existing rows remain NULL and are
inaccessible to API callers; every new agent registration records the verified
organization. Global `agent_id` uniqueness is preserved. PUBLIC grants on the
base table and unscoped legacy views are revoked; use organization-filtered
service queries rather than `active_discovery_agents` or `agent_network_coverage`.

## Agent Registration

### Registration Flow

1. **Agent Startup** - Agent starts and auto-detects its environment
2. **Network Detection** - Identify locally reachable networks
3. **Capability Detection** - Check which discovery tools are installed
4. **Registration API Call** - Register with HappyCMDB API
5. **Heartbeat Start** - Begin sending periodic heartbeats (every 60s)

### Registration Request

**Endpoint**: `POST /api/v1/agents/register`

**Request Body**:
```json
{
  "agent_id": "dc1-scanner-a1b2c3d4e5f6",
  "hostname": "dc1-scanner-01",
  "provider_capabilities": ["nmap", "ssh"],
  "reachable_networks": ["8.8.8.0/24", "9.9.9.0/24"],
  "version": "1.0.0",
  "platform": "linux",
  "arch": "x64"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "uuid-123-abc",
    "agent_id": "dc1-scanner-a1b2c3d4e5f6",
    "status": "active",
    "registered_at": "2025-10-10T10:00:00Z"
  }
}
```

### Reachable Network Configuration

Configure only explicitly approved public CIDR ranges. Interface auto-detection
is not an authorization source: local interfaces often yield private networks.
The find-best route validates every requested target against the same fail-closed
public-egress policy and requires one organization-scoped agent covering them all.

## Heartbeat Monitoring

### Heartbeat Protocol

Agents send heartbeat every 60 seconds to indicate they're alive:

**Endpoint**: `POST /api/v1/agents/heartbeat`

**Request Body**:
```json
{
  "agent_id": "dc1-scanner-a1b2c3d4e5f6",
  "status": "active",
  "stats": {
    "jobs_completed": 2,
    "jobs_failed": 0,
    "cis_discovered": 8
  }
}
```

**Response**:
```json
{
  "success": true,
  "message": "Heartbeat updated"
}
```

### Stale Agent Detection

The service can mark agents that haven't sent a heartbeat in 5 minutes `offline`
within a verified caller organization; no scheduler invokes this method yet.
Legacy rows with NULL `organization_id` are never updated:

```typescript
async function markStaleAgentsOffline(verifiedOrganizationId: string) {
  await db.query(`
    UPDATE discovery_agents
    SET status = 'offline'
    WHERE organization_id = $1
      AND status = 'active'
      AND last_heartbeat_at < NOW() - INTERVAL '5 minutes'
  `, [verifiedOrganizationId]);
}
```

## Smart Routing

### Network-Based Agent Selection

Only verified organization-scoped service queries may select an agent. The
service checks active status, recent heartbeat, provider capability, network
reachability, and `organization_id`; legacy NULL rows are never candidates.
The discovery target must also pass the global public-egress policy before any
agent is dispatched. The old `active_discovery_agents` view and private
datacenter-target examples are not valid routing paths under Choice C.

```typescript
const agentId = await agentService.findBestAgentForNetworks(
  approvedPublicNetworks,
  provider,
  verifiedOrganizationId
);
```

## Agent Deployment

### Installation

```bash
# Download agent package
wget https://github.com/happycmdb/happycmdb/releases/download/v1.0.0/cmdb-agent-linux-x64.tar.gz

# Extract
tar -xzf cmdb-agent-linux-x64.tar.gz

# Configure
cp config.example.yml config.yml
nano config.yml
```

### Configuration

```yaml
# config.yml
agent:
  # Unique agent ID (auto-generated if not provided)
  id: dc1-scanner-01

  # HappyCMDB API URL
  api_url: https://cmdb.company.com

  # Authentication token
  api_token: ${CMDB_API_TOKEN}

  # Heartbeat interval (seconds)
  heartbeat_interval: 60

  # Job polling interval (seconds)
  poll_interval: 10

  # Max concurrent jobs
  max_concurrent_jobs: 5

# Discovery providers (optional - auto-detected)
providers:
  nmap:
    enabled: true
    binary_path: /usr/bin/nmap
  ssh:
    enabled: true
  snmp:
    enabled: true

# Network configuration (optional - auto-detected)
networks:
  - 8.8.8.0/24
  - 9.9.9.0/24

# Logging
logging:
  level: info
  file: /var/log/cmdb-agent.log
```

### Running as Systemd Service

```ini
# /etc/systemd/system/cmdb-agent.service
[Unit]
Description=HappyCMDB Discovery Agent
After=network.target

[Service]
Type=simple
User=cmdb
WorkingDirectory=/opt/cmdb-agent
ExecStart=/opt/cmdb-agent/bin/cmdb-agent start
Restart=always
RestartSec=10
Environment="CMDB_API_TOKEN=your-token-here"

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start service
sudo systemctl enable cmdb-agent
sudo systemctl start cmdb-agent

# Check status
sudo systemctl status cmdb-agent

# View logs
sudo journalctl -u cmdb-agent -f
```

### Docker Deployment

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

# Install discovery tools
RUN apk add --no-cache nmap openssh-client net-snmp-tools

CMD ["node", "dist/index.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  cmdb-agent:
    image: happycmdb/agent:latest
    environment:
      - CMDB_API_URL=https://cmdb.company.com
      - CMDB_API_TOKEN=${CMDB_API_TOKEN}
      - AGENT_ID=dc1-scanner-01
    restart: unless-stopped
    network_mode: host  # Access to local network
    volumes:
      - ./config.yml:/app/config.yml:ro
      - ./logs:/app/logs
```

## Job Execution

### Job Queue

Agents poll the API for pending jobs assigned to them:

**Endpoint**: `GET /api/v1/agents/:agentId/jobs`

**Response**:
```json
{
  "success": true,
  "data": {
    "jobs": [
      {
        "job_id": "job-123-abc",
        "definition_id": "def-456-def",
        "provider": "nmap",
        "config": {
          "targets": ["8.8.8.0/24"],
          "ports": [22, 80, 443, 3389]
        },
        "credentials": {
          "id": "cred-789-ghi",
          "protocol": "ssh_key",
          "data": {
            "username": "admin",
            "private_key": "..."
          }
        }
      }
    ]
  }
}
```

### Job Execution Flow

1. **Poll for Jobs** - Agent requests pending jobs from API
2. **Download Job** - Retrieve job configuration and credentials
3. **Execute Discovery** - Run nmap/ssh/snmp scan locally
4. **Transform Results** - Convert raw data to CI format
5. **Upload CIs** - POST discovered CIs back to API
6. **Report Status** - Update job status (completed/failed)

### Reporting Results

**Endpoint**: `POST /api/v1/agents/:agentId/jobs/:jobId/results`

**Request Body**:
```json
{
  "status": "completed",
  "discovered_cis": [
    {
      "name": "server-01",
      "type": "server",
      "ip_address": "8.8.8.8",
      "mac_address": "00:1A:2B:3C:4D:5E",
      "os": "Ubuntu 22.04",
      "open_ports": [22, 80, 443],
      "metadata": {
        "hostname": "server-01.company.com",
        "ssh_version": "OpenSSH_8.9"
      }
    }
  ],
  "stats": {
    "targets_scanned": 254,
    "hosts_discovered": 42,
    "duration_ms": 125000
  }
}
```

## Agent Management UI

### Agent List View

The Web UI provides a dashboard to monitor all registered agents:

**Features:**
- Real-time status (active, inactive, offline)
- Last heartbeat timestamp
- Network coverage visualization
- Capability badges
- Job statistics (success rate)
- Manual enable/disable controls

### Agent Detail View

Detailed view for individual agents:

**Sections:**
- **Overview** - Status, hostname, IP, registration date
- **Capabilities** - Discovery providers available
- **Networks** - List of reachable networks (with CIDR notation)
- **Performance** - Jobs completed, success rate, avg duration
- **Recent Jobs** - Last 20 jobs with status
- **Heartbeat History** - Heartbeat timeline chart

## CLI Commands

```bash
# List all agents
cmdb agents list

# Show agent details
cmdb agents show dc1-scanner-01

# Find best agent for network
cmdb agents find-best --networks 8.8.8.0/24 --provider nmap

# Manually assign job to agent
cmdb discovery run def-123 --agent dc1-scanner-01

# Disable agent
cmdb agents disable dc1-scanner-01

# Delete agent
cmdb agents delete dc1-scanner-01
```

## Security Considerations

### Agent Authentication

- **API Tokens** - Agents authenticate using long-lived API tokens
- **Token Rotation** - Tokens should be rotated every 90 days
- **Token Scoping** - Agent tokens have limited permissions (agent-only scope)

### Network Security

- **TLS/SSL** - All agent-to-API communication uses HTTPS
- **Certificate Validation** - Agents validate API server certificates
- **Firewall Rules** - Agents require outbound HTTPS (443) to API server

### Credential Security

- **Temporary Credentials** - Job credentials are deleted after job completion
- **Memory-Only** - Credentials never written to disk on agent
- **Encrypted Transit** - Credentials encrypted in API responses

## Troubleshooting

### Agent Not Appearing in UI

**Problem**: Agent registered but doesn't show up in agent list

**Solutions**:
1. Check agent logs for registration errors
2. Verify API URL is correct in agent config
3. Ensure API token has agent registration permission
4. Check firewall allows outbound HTTPS to API

### Agent Marked as Offline

**Problem**: Agent shows as offline despite being online

**Solutions**:
1. Check agent logs for heartbeat errors
2. Verify network connectivity to API
3. Ensure system clock is synchronized (NTP)
4. Check if API token expired

### Jobs Not Being Assigned to Agent

**Problem**: Discovery jobs not routed to available agent

**Solutions**:
1. Verify agent has required provider capability
2. Check agent's `reachable_networks` includes target networks
3. Ensure agent status is "active"
4. Check agent's current job capacity (max_concurrent_jobs)

### Discovery Results Not Appearing

**Problem**: Agent completes job but CIs don't appear in CMDB

**Solutions**:
1. Check agent logs for upload errors
2. Verify API token has CI creation permission
3. Check Neo4j connection from API server
4. Review job result payload in agent logs

## Best Practices

1. **Deploy Multiple Agents** - At least 2 agents per datacenter for redundancy
2. **Network Segmentation** - One agent per logical network segment
3. **Monitor Health** - Alert on agents offline > 10 minutes
4. **Update Regularly** - Keep agent software up-to-date
5. **Capacity Planning** - Monitor agent job queue length
6. **Log Aggregation** - Send agent logs to centralized logging (ELK, Splunk)
7. **Resource Limits** - Set appropriate CPU/memory limits for agents
8. **Credential Rotation** - Rotate agent API tokens every 90 days

## Related Documentation

- [Discovery Guide](/getting-started/discovery-guide)
- [Connector Framework Architecture](/architecture/connector-framework)
- [Unified Credentials](/components/credentials)
- [System Overview](/architecture/system-overview)
- [Version History](/architecture/version-history)
