// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Agent Routing Integration Tests
 *
 * Tests smart agent routing with CIDR networks, agent registration, heartbeat,
 * and fault tolerance (offline agent handling) with real database connections.
 */

import { Pool } from 'pg';
import { getPostgresClient } from '@cmdb/database';
import { DiscoveryAgentService } from '../../src/services/discovery-agent.service';
import {
  DiscoveryAgentRegistration,
  AgentHeartbeat,
  DiscoveryProvider,
  AgentStatus,
} from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';

const ORG = '11111111-1111-4111-8111-111111111111';

describe('Discovery Agent Routing Integration Tests', () => {
  let pool: Pool;
  let agentService: DiscoveryAgentService;
  const createdAgentIds: string[] = [];

  beforeAll(async () => {
    // Connect to the global Postgres container (canonical schema already loaded).
    pool = getPostgresClient().pool;

    // The service reads the same global Postgres client via env vars.
    agentService = new DiscoveryAgentService();
  }, 120000);

  async function registerFresh(input: Omit<DiscoveryAgentRegistration, 'agent_id'>): Promise<string> {
    const agent = await agentService.registerAgent(input, ORG);
    if (!agent) throw new Error('Expected registration to succeed');
    createdAgentIds.push(agent.agent_id);
    return agent.agent_id;
  }

  afterAll(async () => {
    // Cleanup created agents
    for (const agentId of createdAgentIds) {
      try {
        await pool.query('DELETE FROM discovery_agents WHERE agent_id = $1', [agentId]);
      } catch (error) {
        // Ignore cleanup errors
      }
    }

    await pool.end();
  });

  afterEach(async () => {
    // Clean up after each test
    await pool.query('DELETE FROM discovery_agents WHERE agent_id = ANY($1)', [createdAgentIds]);
    createdAgentIds.length = 0;
  });

  describe('Agent Registration', () => {
    it('should register a new discovery agent', async () => {
      const registration: DiscoveryAgentRegistration = {
        hostname: 'agent-01.local',
        provider_capabilities: ['nmap', 'ssh'],
        reachable_networks: ['10.0.0.0/8', '192.168.1.0/24'],
        version: '2.0.0',
        platform: 'linux',
        arch: 'x64',
        api_endpoint: 'http://agent-01.local:5000',
        tags: ['datacenter-1', 'production'],
      };

      const agentId = await registerFresh(registration);
      const agent = await agentService.getAgent(agentId, ORG);
      if (!agent) throw new Error('Expected registered agent to be readable');
      expect(agent?.agent_id).toBe(agentId);
      expect(agent.hostname).toBe(registration.hostname);
      expect(agent.provider_capabilities).toEqual(registration.provider_capabilities);
      expect(agent.reachable_networks).toEqual(registration.reachable_networks);
      expect(agent.status).toBe('active');
      expect(agent.total_jobs_completed).toBe(0);
      expect(agent.total_jobs_failed).toBe(0);
      expect(agent.total_cis_discovered).toBe(0);
    }, 60000);

    it('should update existing agent on re-registration', async () => {
      // Initial registration issues the ID reused for the owned retry.
      const agentId = await registerFresh({
        hostname: 'agent-02.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
        version: '1.0.0',
        platform: 'linux',
        arch: 'x64',
        tags: ['test'],
      });

      // Re-register with updated capabilities
      const updatedRegistration: DiscoveryAgentRegistration = {
        agent_id: agentId,
        hostname: 'agent-02.local',
        provider_capabilities: ['nmap', 'ssh', 'snmp'],
        reachable_networks: ['10.0.0.0/8', '172.16.0.0/12'],
        version: '2.0.0',
        platform: 'linux',
        arch: 'x64',
        tags: ['test', 'updated'],
      };

      const updatedAgent = await agentService.registerAgent(updatedRegistration, ORG);
      if (!updatedAgent) throw new Error('Expected same-org re-registration to succeed');

      expect(updatedAgent.agent_id).toBe(agentId);
      expect(updatedAgent.provider_capabilities).toEqual(['nmap', 'ssh', 'snmp']);
      expect(updatedAgent.reachable_networks).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
      expect(updatedAgent.version).toBe('2.0.0');
      expect(updatedAgent.tags).toEqual(['test', 'updated']);
    }, 60000);
  });

  describe('Agent Heartbeat', () => {
    it('should update agent heartbeat timestamp', async () => {
      // Register agent and retain its issued ID for heartbeats.
      const agentId = await registerFresh({
        hostname: 'heartbeat-test.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Wait a moment to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Get initial heartbeat
      const agentBefore = await agentService.getAgent(agentId, ORG);
      const initialHeartbeat = agentBefore?.last_heartbeat_at;

      // Send heartbeat
      const heartbeat: AgentHeartbeat = {
        agent_id: agentId,
        status: 'active',
      };

      await agentService.updateHeartbeat(heartbeat, ORG);

      // Verify heartbeat was updated
      const agentAfter = await agentService.getAgent(agentId, ORG);
      expect(agentAfter?.last_heartbeat_at).not.toBe(initialHeartbeat);
    }, 60000);

    it('should update agent statistics via heartbeat', async () => {
      const agentId = await registerFresh({
        hostname: 'stats-test.local',
        provider_capabilities: ['nmap', 'ssh'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Send heartbeat with stats
      const heartbeat: AgentHeartbeat = {
        agent_id: agentId,
        status: 'active',
        stats: {
          jobs_completed: 5,
          jobs_failed: 1,
          cis_discovered: 42,
        },
      };

      await agentService.updateHeartbeat(heartbeat, ORG);

      // Verify stats were updated
      const agent = await agentService.getAgent(agentId, ORG);
      expect(agent?.total_jobs_completed).toBe(5);
      expect(agent?.total_jobs_failed).toBe(1);
      expect(agent?.total_cis_discovered).toBe(42);

      // Send another heartbeat (incremental update)
      const heartbeat2: AgentHeartbeat = {
        agent_id: agentId,
        status: 'active',
        stats: {
          jobs_completed: 3,
          jobs_failed: 0,
          cis_discovered: 15,
        },
      };

      await agentService.updateHeartbeat(heartbeat2, ORG);

      // Verify incremental stats
      const agentAfter = await agentService.getAgent(agentId, ORG);
      expect(agentAfter?.total_jobs_completed).toBe(8); // 5 + 3
      expect(agentAfter?.total_jobs_failed).toBe(1); // 1 + 0
      expect(agentAfter?.total_cis_discovered).toBe(57); // 42 + 15
    }, 60000);
  });

  describe('Smart Agent Routing with CIDR Networks', () => {
    it('should route job to agent based on network reachability', async () => {
      // Register agent for the first public network.
      const agent1Id = await registerFresh({
        hostname: 'agent-10-net.local',
        provider_capabilities: ['nmap', 'ssh'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Register agent for the second public network.
      const agent2Id = await registerFresh({
        hostname: 'agent-192-net.local',
        provider_capabilities: ['nmap', 'ssh'],
        reachable_networks: ['9.9.9.0/24'],
      });

      // Find the agent for the first public range.
      const bestAgent10 = await agentService.findBestAgentForNetworks(['8.8.8.0/24'], 'nmap', ORG);

      expect(bestAgent10).toBe(agent1Id);

      // Find the agent for the second public range.
      const bestAgent192 = await agentService.findBestAgentForNetworks(['9.9.9.0/24'], 'ssh', ORG);

      expect(bestAgent192).toBe(agent2Id);
    }, 60000);

    it('should prefer agent with better success rate', async () => {
      // Register agent with high success rate
      const goodAgentId = await registerFresh({
        hostname: 'good-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Simulate successful jobs
      await agentService.updateHeartbeat({
        agent_id: goodAgentId,
        status: 'active',
        stats: {
          jobs_completed: 100,
          jobs_failed: 5,
          cis_discovered: 500,
        },
      }, ORG);

      // Register agent with lower success rate
      const poorAgentId = await registerFresh({
        hostname: 'poor-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Simulate failed jobs
      await agentService.updateHeartbeat({
        agent_id: poorAgentId,
        status: 'active',
        stats: {
          jobs_completed: 20,
          jobs_failed: 30,
          cis_discovered: 50,
        },
      }, ORG);

      // Find best agent for the covered public network.
      const bestAgent = await agentService.findBestAgentForNetworks(['8.8.8.0/24'], 'nmap', ORG);

      // Should prefer agent with better success rate (100/105 > 20/50)
      expect(bestAgent).toBe(goodAgentId);
    }, 60000);

    it('should return null if no suitable agent found', async () => {
      // Register agent for one public network.
      await registerFresh({
        hostname: 'limited-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Try to find agent for completely different network
      const bestAgent = await agentService.findBestAgentForNetworks(['9.9.9.0/24'], 'nmap', ORG);

      expect(bestAgent).toBeNull();
    }, 60000);

    it('should not route to agent without required provider capability', async () => {
      // Register agent with only NMAP capability
      await registerFresh({
        hostname: 'nmap-only-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Try to find agent for SSH discovery
      const bestAgent = await agentService.findBestAgentForNetworks(['8.8.8.0/24'], 'ssh', ORG);

      expect(bestAgent).toBeNull();
    }, 60000);
  });

  describe('Agent Fault Tolerance (Offline Handling)', () => {
    it('should mark stale agents as offline', async () => {
      // Register agent
      const agentId = await registerFresh({
        hostname: 'stale-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Manually set last_heartbeat_at to 10 minutes ago
      await pool.query(
        `UPDATE discovery_agents
         SET last_heartbeat_at = NOW() - INTERVAL '10 minutes'
         WHERE agent_id = $1`,
        [agentId]
      );

      // Mark stale agents as offline
      const count = await agentService.markStaleAgentsOffline(ORG);

      expect(count).toBeGreaterThan(0);

      // Verify agent is marked offline
      const agent = await agentService.getAgent(agentId, ORG);
      expect(agent?.status).toBe('offline');
    }, 60000);

    it('should not route to offline agents', async () => {
      // Register active agent
      const activeAgentId = await registerFresh({
        hostname: 'active-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Register offline agent
      const offlineAgentId = await registerFresh({
        hostname: 'offline-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Mark second agent as offline
      await pool.query(
        `UPDATE discovery_agents
         SET last_heartbeat_at = NOW() - INTERVAL '10 minutes',
             status = 'offline'
         WHERE agent_id = $1`,
        [offlineAgentId]
      );

      // Find best agent
      const bestAgent = await agentService.findBestAgentForNetworks(['8.8.8.0/24'], 'nmap', ORG);

      // Should route to active agent, not offline one
      expect(bestAgent).toBe(activeAgentId);
    }, 60000);

    it('should handle agent recovery (offline to active)', async () => {
      // Register agent
      const agentId = await registerFresh({
        hostname: 'recovery-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['8.8.8.0/24'],
      });

      // Mark agent as offline
      await pool.query(
        `UPDATE discovery_agents
         SET status = 'offline',
             last_heartbeat_at = NOW() - INTERVAL '10 minutes'
         WHERE agent_id = $1`,
        [agentId]
      );

      const offlineAgent = await agentService.getAgent(agentId, ORG);
      expect(offlineAgent?.status).toBe('offline');

      // Send heartbeat to recover agent
      await agentService.updateHeartbeat({
        agent_id: agentId,
        status: 'active',
      }, ORG);

      // Verify agent is back online
      const recoveredAgent = await agentService.getAgent(agentId, ORG);
      expect(recoveredAgent?.status).toBe('active');

      // Verify agent can now be routed to
      const bestAgent = await agentService.findBestAgentForNetworks(['8.8.8.0/24'], 'nmap', ORG);

      expect(bestAgent).toBe(agentId);
    }, 60000);
  });

  describe('Agent Listing and Filtering', () => {
    it('should list all agents', async () => {
      // Register multiple agents
      const agent1Id = await registerFresh({
        hostname: 'list-agent-1.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
        tags: ['datacenter-1'],
      });

      const agent2Id = await registerFresh({
        hostname: 'list-agent-2.local',
        provider_capabilities: ['ssh'],
        reachable_networks: ['192.168.0.0/16'],
        tags: ['datacenter-2'],
      });

      // List all agents
      const agents = await agentService.listAgents(ORG);

      expect(agents.length).toBeGreaterThanOrEqual(2);
      expect(agents.map(a => a.agent_id)).toContain(agent1Id);
      expect(agents.map(a => a.agent_id)).toContain(agent2Id);
    }, 60000);

    it('should filter agents by status', async () => {
      // Register active agent
      const activeAgentId = await registerFresh({
        hostname: 'active-filter.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Register and mark another agent offline
      const offlineAgentId = await registerFresh({
        hostname: 'offline-filter.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      await pool.query(
        `UPDATE discovery_agents SET status = 'offline' WHERE agent_id = $1`,
        [offlineAgentId]
      );

      // Filter by active status
      const activeAgents = await agentService.listAgents(ORG, { status: 'active' });
      expect(activeAgents.map(a => a.agent_id)).toContain(activeAgentId);
      expect(activeAgents.map(a => a.agent_id)).not.toContain(offlineAgentId);

      // Filter by offline status
      const offlineAgents = await agentService.listAgents(ORG, { status: 'offline' });
      expect(offlineAgents.map(a => a.agent_id)).toContain(offlineAgentId);
      expect(offlineAgents.map(a => a.agent_id)).not.toContain(activeAgentId);
    }, 60000);

    it('should filter agents by provider capability', async () => {
      // Register agent with NMAP capability
      const nmapAgentId = await registerFresh({
        hostname: 'nmap-filter.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Register agent with SSH capability
      const sshAgentId = await registerFresh({
        hostname: 'ssh-filter.local',
        provider_capabilities: ['ssh', 'snmp'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Filter by NMAP provider
      const nmapAgents = await agentService.listAgents(ORG, { provider: 'nmap' });
      expect(nmapAgents.map(a => a.agent_id)).toContain(nmapAgentId);

      // Filter by SSH provider
      const sshAgents = await agentService.listAgents(ORG, { provider: 'ssh' });
      expect(sshAgents.map(a => a.agent_id)).toContain(sshAgentId);
    }, 60000);

    it('should filter agents by tags', async () => {
      // Register agents with different tags
      const prod1Id = await registerFresh({
        hostname: 'prod-agent-1.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
        tags: ['production', 'datacenter-1'],
      });

      const dev1Id = await registerFresh({
        hostname: 'dev-agent-1.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['192.168.0.0/16'],
        tags: ['development'],
      });

      // Filter by production tag
      const prodAgents = await agentService.listAgents(ORG, { tags: ['production'] });
      expect(prodAgents.map(a => a.agent_id)).toContain(prod1Id);
      expect(prodAgents.map(a => a.agent_id)).not.toContain(dev1Id);
    }, 60000);
  });

  describe('Agent Deletion', () => {
    it('should delete agent', async () => {
      const agentId = await registerFresh({
        hostname: 'delete-test.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Verify agent exists
      const agentBefore = await agentService.getAgent(agentId, ORG);
      expect(agentBefore).not.toBeNull();

      // Delete agent
      expect(await agentService.deleteAgent(agentId, ORG)).toBe(true);

      // Verify agent is deleted
      const agentAfter = await agentService.getAgent(agentId, ORG);
      expect(agentAfter).toBeNull();

      // Remove from cleanup list
      const index = createdAgentIds.indexOf(agentId);
      if (index > -1) {
        createdAgentIds.splice(index, 1);
      }
    }, 60000);

    it('should return false when deleting a non-existent agent in the caller organization', async () => {
      const nonExistentId = `test-agent-${uuidv4()}`;
      expect(await agentService.deleteAgent(nonExistentId, ORG)).toBe(false);
    }, 60000);
  });
});
