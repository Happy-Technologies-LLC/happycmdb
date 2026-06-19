# Discovery Agents

## Overview

Discovery Agents are lightweight processes that run in your network to perform local infrastructure scanning and discovery. Unlike agentless discovery (which runs from the HappyCMDB server), agents run closer to the targets, enabling discovery behind firewalls, in air-gapped networks, and across distributed locations.

## Key Features

- **Network Proximity** - Scan devices within local networks
- **Firewall Traversal** - Discover infrastructure behind firewalls
- **Distributed Discovery** - Deploy agents in multiple datacenters
- **Smart Routing** - Automatic agent selection based on network reachability
- **Load Balancing** - Distribute discovery jobs across multiple agents
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
          │  - 10.0.0.0/8               │    │  - 192.168.0.0/16         │
          │  - 172.16.0.0/12            │    │  - 10.10.0.0/16           │
          │                             │    │                           │
          │ Capabilities:               │    │ Capabilities:             │
          │  - nmap                     │    │  - nmap                   │
          │  - ssh                      │    │  - ssh                    │
          │                             │    │  - snmp                   │
          └──────────────┬──────────────┘    └────────────┬──────────────┘
                         │                                 │
          ┌──────────────▼──────────────┐    ┌────────────▼──────────────┐
          │   Local Network             │    │   Local Network           │
          │   (Datacenter East)         │    │   (Datacenter West)       │
          │   - Servers                 │    │   - Servers               │
          │   - Network Devices         │    │   - Network Devices       │
          │   - Applications            │    │   - IoT Devices           │
          └─────────────────────────────┘    └───────────────────────────┘
```

## Database Schema

```sql
CREATE TABLE discovery_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id VARCHAR(255) UNIQUE NOT NULL, -- Unique agent identifier
  hostname VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45),

  -- Capabilities
  provider_capabilities TEXT[] NOT NULL, -- ['nmap', 'ssh', 'snmp']
  reachable_networks TEXT[] NOT NULL,    -- ['10.0.0.0/8', '192.168.1.0/24']

  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'active',
    CHECK (status IN ('active', 'inactive', 'offline', 'disabled')),

  -- Heartbeat
  last_heartbeat_at TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Job statistics
  total_jobs_assigned INTEGER DEFAULT 0,
  total_jobs_completed INTEGER DEFAULT 0,
  total_jobs_failed INTEGER DEFAULT 0,

  -- Agent metadata
  version VARCHAR(50),
  platform VARCHAR(50),   -- 'linux', 'windows', 'darwin'
  arch VARCHAR(20),       -- 'x64', 'arm64'

  -- Registration
  registered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agents_status ON discovery_agents(status);
CREATE INDEX idx_agents_last_heartbeat ON discovery_agents(last_heartbeat_at);
CREATE INDEX idx_agents_networks ON discovery_agents USING gin(reachable_networks);

-- View: Active agents with network coverage
CREATE VIEW active_discovery_agents AS
SELECT
  id,
  agent_id,
  hostname,
  provider_capabilities,
  reachable_networks,
  last_heartbeat_at,
  total_jobs_completed,
  total_jobs_failed
FROM discovery_agents
WHERE status = 'active'
  AND last_heartbeat_at > NOW() - INTERVAL '5 minutes';

-- View: Agent network coverage
CREATE VIEW agent_network_coverage AS
SELECT
  unnest(reachable_networks) AS network,
  array_agg(agent_id) AS agents,
  count(*) AS agent_count
FROM discovery_agents
WHERE status = 'active'
GROUP BY network;
```

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
  "ip_address": "10.0.1.5",
  "provider_capabilities": ["nmap", "ssh"],
  "reachable_networks": ["10.0.0.0/8", "172.16.0.0/12"],
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

### Auto-Detection Example

```typescript
import * as os from 'os';
import * as net from 'net';

class DiscoveryAgent {
  async detectNetworks(): Promise<string[]> {
    const networks: string[] = [];
    const interfaces = os.networkInterfaces();

    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;

      for (const addr of addrs) {
        // Skip internal/loopback
        if (addr.internal) continue;

        if (addr.family === 'IPv4') {
          // Convert IP to CIDR network (assuming /24 for simplicity)
          const parts = addr.address.split('.');
          const network = `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
          networks.push(network);
        }
      }
    }

    return [...new Set(networks)]; // Deduplicate
  }

  async detectCapabilities(): Promise<string[]> {
    const capabilities: string[] = [];

    // Check for nmap
    try {
      await exec('which nmap');
      capabilities.push('nmap');
    } catch {}

    // Check for ssh
    try {
      await exec('which ssh');
      capabilities.push('ssh');
    } catch {}

    // Check for snmpwalk
    try {
      await exec('which snmpwalk');
      capabilities.push('snmp');
    } catch {}

    return capabilities;
  }

  async registerWithAPI() {
    const registration = {
      agent_id: this.config.agentId,
      hostname: os.hostname(),
      ip_address: await this.getLocalIP(),
      provider_capabilities: await this.detectCapabilities(),
      reachable_networks: await this.detectNetworks(),
      version: '1.0.0',
      platform: os.platform(),
      arch: os.arch(),
    };

    await axios.post(`${this.apiUrl}/api/v1/agents/register`, registration);
  }
}
```

## Heartbeat Monitoring

### Heartbeat Protocol

Agents send heartbeat every 60 seconds to indicate they're alive:

**Endpoint**: `POST /api/v1/agents/heartbeat`

**Request Body**:
```json
{
  "agent_id": "dc1-scanner-a1b2c3d4e5f6",
  "status": "active",
  "current_jobs": 2,
  "available_capacity": 8
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "acknowledged": true,
    "pending_jobs": 1
  }
}
```

### Stale Agent Detection

Agents that haven't sent a heartbeat in 5 minutes are marked as `offline`:

```typescript
// Runs every 60 seconds
async function markStaleAgentsOffline() {
  await db.query(`
    UPDATE discovery_agents
    SET status = 'offline'
    WHERE status = 'active'
      AND last_heartbeat_at < NOW() - INTERVAL '5 minutes'
  `);
}
```

## Smart Routing

### Network-Based Agent Selection

When a discovery definition is run with `method: 'agent'` and no specific agent is assigned, the system automatically selects the best agent based on network reachability:

```typescript
async function findBestAgentForNetworks(
  targetNetworks: string[],
  provider: string
): Promise<string | null> {
  // Query agents that:
  // 1. Are active
  // 2. Have required provider capability
  // 3. Have at least one matching network

  const result = await db.query(`
    SELECT
      agent_id,
      reachable_networks,
      total_jobs_completed,
      total_jobs_failed
    FROM active_discovery_agents
    WHERE
      $1 = ANY(provider_capabilities)  -- Has required capability
      AND reachable_networks && $2     -- Has network overlap
    ORDER BY
      -- Prefer agents with better success rate
      (total_jobs_completed::float / NULLIF(total_jobs_completed + total_jobs_failed, 0)) DESC NULLS LAST,
      -- Then prefer agents with more matching networks
      cardinality(reachable_networks & $2) DESC
    LIMIT 1
  `, [provider, targetNetworks]);

  return result.rows[0]?.agent_id || null;
}
```

### Usage Example

```typescript
// Discovery definition (no agent_id specified)
const definition = {
  name: "Datacenter East Network Scan",
  provider: "nmap",
  method: "agent",  // Use agent-based discovery
  agent_id: null,   // Auto-select best agent
  config: {
    targets: ["10.0.0.0/16", "172.16.0.0/12"]
  }
};

// When definition is run:
// 1. System queries active_discovery_agents
// 2. Finds agents with 'nmap' capability and matching networks
// 3. Selects agent with best success rate
// 4. Dispatches job to selected agent
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
  - 10.0.0.0/8
  - 172.16.0.0/12

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
          "targets": ["10.0.1.0/24"],
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
      "ip_address": "10.0.1.10",
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
cmdb agents find-best --networks 10.0.0.0/16 --provider nmap

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
