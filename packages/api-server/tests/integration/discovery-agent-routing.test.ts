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
        agent_id: `test-agent-${uuidv4()}`,
        hostname: 'agent-01.local',
        provider_capabilities: ['nmap', 'ssh'],
        reachable_networks: ['10.0.0.0/8', '192.168.1.0/24'],
        version: '2.0.0',
        platform: 'linux',
        arch: 'x64',
        api_endpoint: 'http://agent-01.local:5000',
        tags: ['datacenter-1', 'production'],
      };

      const agent = await agentService.registerAgent(registration);
      createdAgentIds.push(agent.agent_id);

      expect(agent.agent_id).toBe(registration.agent_id);
      expect(agent.hostname).toBe(registration.hostname);
      expect(agent.provider_capabilities).toEqual(registration.provider_capabilities);
      expect(agent.reachable_networks).toEqual(registration.reachable_networks);
      expect(agent.status).toBe('active');
      expect(agent.total_jobs_completed).toBe(0);
      expect(agent.total_jobs_failed).toBe(0);
      expect(agent.total_cis_discovered).toBe(0);
    }, 60000);

    it('should update existing agent on re-registration', async () => {
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      // Initial registration
      const initialRegistration: DiscoveryAgentRegistration = {
        agent_id: agentId,
        hostname: 'agent-02.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
        version: '1.0.0',
        platform: 'linux',
        arch: 'x64',
        tags: ['test'],
      };

      await agentService.registerAgent(initialRegistration);

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

      const updatedAgent = await agentService.registerAgent(updatedRegistration);

      expect(updatedAgent.agent_id).toBe(agentId);
      expect(updatedAgent.provider_capabilities).toEqual(['nmap', 'ssh', 'snmp']);
      expect(updatedAgent.reachable_networks).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
      expect(updatedAgent.version).toBe('2.0.0');
      expect(updatedAgent.tags).toEqual(['test', 'updated']);
    }, 60000);
  });

  describe('Agent Heartbeat', () => {
    it('should update agent heartbeat timestamp', async () => {
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      // Register agent
      await agentService.registerAgent({
        agent_id: agentId,
        hostname: 'heartbeat-test.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Wait a moment to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Get initial heartbeat
      const agentBefore = await agentService.getAgent(agentId);
      const initialHeartbeat = agentBefore?.last_heartbeat_at;

      // Send heartbeat
      const heartbeat: AgentHeartbeat = {
        agent_id: agentId,
        status: 'active',
      };

      await agentService.updateHeartbeat(heartbeat);

      // Verify heartbeat was updated
      const agentAfter = await agentService.getAgent(agentId);
      expect(agentAfter?.last_heartbeat_at).not.toBe(initialHeartbeat);
    }, 60000);

    it('should update agent statistics via heartbeat', async () => {
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      // Register agent
      await agentService.registerAgent({
        agent_id: agentId,
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

      await agentService.updateHeartbeat(heartbeat);

      // Verify stats were updated
      const agent = await agentService.getAgent(agentId);
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

      await agentService.updateHeartbeat(heartbeat2);

      // Verify incremental stats
      const agentAfter = await agentService.getAgent(agentId);
      expect(agentAfter?.total_jobs_completed).toBe(8); // 5 + 3
      expect(agentAfter?.total_jobs_failed).toBe(1); // 1 + 0
      expect(agentAfter?.total_cis_discovered).toBe(57); // 42 + 15
    }, 60000);
  });

  describe('Smart Agent Routing with CIDR Networks', () => {
    it('should route job to agent based on network reachability', async () => {
      // Register agent for 10.0.0.0/8 network
      const agent1Id = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agent1Id);

      await agentService.registerAgent({
        agent_id: agent1Id,
        hostname: 'agent-10-net.local',
        provider_capabilities: ['nmap', 'ssh'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Register agent for 192.168.0.0/16 network
      const agent2Id = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agent2Id);

      await agentService.registerAgent({
        agent_id: agent2Id,
        hostname: 'agent-192-net.local',
        provider_capabilities: ['nmap', 'ssh'],
        reachable_networks: ['192.168.0.0/16'],
      });

      // Find best agent for 10.x.x.x network
      const bestAgent10 = await agentService.findBestAgentForNetworks(
        ['10.50.100.0/24'],
        'nmap'
      );

      expect(bestAgent10).toBe(agent1Id);

      // Find best agent for 192.168.x.x network
      const bestAgent192 = await agentService.findBestAgentForNetworks(
        ['192.168.1.0/24'],
        'ssh'
      );

      expect(bestAgent192).toBe(agent2Id);
    }, 60000);

    it('should prefer agent with better success rate', async () => {
      // Register agent with high success rate
      const goodAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(goodAgentId);

      await agentService.registerAgent({
        agent_id: goodAgentId,
        hostname: 'good-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
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
      });

      // Register agent with lower success rate
      const poorAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(poorAgentId);

      await agentService.registerAgent({
        agent_id: poorAgentId,
        hostname: 'poor-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
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
      });

      // Find best agent for 10.x.x.x network
      const bestAgent = await agentService.findBestAgentForNetworks(
        ['10.50.100.0/24'],
        'nmap'
      );

      // Should prefer agent with better success rate (100/105 > 20/50)
      expect(bestAgent).toBe(goodAgentId);
    }, 60000);

    it('should return null if no suitable agent found', async () => {
      // Register agent for 10.0.0.0/8 network
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      await agentService.registerAgent({
        agent_id: agentId,
        hostname: 'limited-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Try to find agent for completely different network
      const bestAgent = await agentService.findBestAgentForNetworks(
        ['172.16.0.0/12'],
        'nmap'
      );

      expect(bestAgent).toBeNull();
    }, 60000);

    it('should not route to agent without required provider capability', async () => {
      // Register agent with only NMAP capability
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      await agentService.registerAgent({
        agent_id: agentId,
        hostname: 'nmap-only-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Try to find agent for SSH discovery
      const bestAgent = await agentService.findBestAgentForNetworks(
        ['10.50.100.0/24'],
        'ssh'
      );

      expect(bestAgent).toBeNull();
    }, 60000);
  });

  describe('Agent Fault Tolerance (Offline Handling)', () => {
    it('should mark stale agents as offline', async () => {
      // Register agent
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      await agentService.registerAgent({
        agent_id: agentId,
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
      const count = await agentService.markStaleAgentsOffline();

      expect(count).toBeGreaterThan(0);

      // Verify agent is marked offline
      const agent = await agentService.getAgent(agentId);
      expect(agent?.status).toBe('offline');
    }, 60000);

    it('should not route to offline agents', async () => {
      // Register active agent
      const activeAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(activeAgentId);

      await agentService.registerAgent({
        agent_id: activeAgentId,
        hostname: 'active-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Register offline agent
      const offlineAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(offlineAgentId);

      await agentService.registerAgent({
        agent_id: offlineAgentId,
        hostname: 'offline-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
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
      const bestAgent = await agentService.findBestAgentForNetworks(
        ['10.50.100.0/24'],
        'nmap'
      );

      // Should route to active agent, not offline one
      expect(bestAgent).toBe(activeAgentId);
    }, 60000);

    it('should handle agent recovery (offline to active)', async () => {
      // Register agent
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      await agentService.registerAgent({
        agent_id: agentId,
        hostname: 'recovery-agent.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Mark agent as offline
      await pool.query(
        `UPDATE discovery_agents
         SET status = 'offline',
             last_heartbeat_at = NOW() - INTERVAL '10 minutes'
         WHERE agent_id = $1`,
        [agentId]
      );

      const offlineAgent = await agentService.getAgent(agentId);
      expect(offlineAgent?.status).toBe('offline');

      // Send heartbeat to recover agent
      await agentService.updateHeartbeat({
        agent_id: agentId,
        status: 'active',
      });

      // Verify agent is back online
      const recoveredAgent = await agentService.getAgent(agentId);
      expect(recoveredAgent?.status).toBe('active');

      // Verify agent can now be routed to
      const bestAgent = await agentService.findBestAgentForNetworks(
        ['10.50.100.0/24'],
        'nmap'
      );

      expect(bestAgent).toBe(agentId);
    }, 60000);
  });

  describe('Agent Listing and Filtering', () => {
    it('should list all agents', async () => {
      // Register multiple agents
      const agent1Id = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agent1Id);
      await agentService.registerAgent({
        agent_id: agent1Id,
        hostname: 'list-agent-1.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
        tags: ['datacenter-1'],
      });

      const agent2Id = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agent2Id);
      await agentService.registerAgent({
        agent_id: agent2Id,
        hostname: 'list-agent-2.local',
        provider_capabilities: ['ssh'],
        reachable_networks: ['192.168.0.0/16'],
        tags: ['datacenter-2'],
      });

      // List all agents
      const agents = await agentService.listAgents();

      expect(agents.length).toBeGreaterThanOrEqual(2);
      expect(agents.map(a => a.agent_id)).toContain(agent1Id);
      expect(agents.map(a => a.agent_id)).toContain(agent2Id);
    }, 60000);

    it('should filter agents by status', async () => {
      // Register active agent
      const activeAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(activeAgentId);
      await agentService.registerAgent({
        agent_id: activeAgentId,
        hostname: 'active-filter.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Register and mark another agent offline
      const offlineAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(offlineAgentId);
      await agentService.registerAgent({
        agent_id: offlineAgentId,
        hostname: 'offline-filter.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      await pool.query(
        `UPDATE discovery_agents SET status = 'offline' WHERE agent_id = $1`,
        [offlineAgentId]
      );

      // Filter by active status
      const activeAgents = await agentService.listAgents({ status: 'active' });
      expect(activeAgents.map(a => a.agent_id)).toContain(activeAgentId);
      expect(activeAgents.map(a => a.agent_id)).not.toContain(offlineAgentId);

      // Filter by offline status
      const offlineAgents = await agentService.listAgents({ status: 'offline' });
      expect(offlineAgents.map(a => a.agent_id)).toContain(offlineAgentId);
      expect(offlineAgents.map(a => a.agent_id)).not.toContain(activeAgentId);
    }, 60000);

    it('should filter agents by provider capability', async () => {
      // Register agent with NMAP capability
      const nmapAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(nmapAgentId);
      await agentService.registerAgent({
        agent_id: nmapAgentId,
        hostname: 'nmap-filter.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Register agent with SSH capability
      const sshAgentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(sshAgentId);
      await agentService.registerAgent({
        agent_id: sshAgentId,
        hostname: 'ssh-filter.local',
        provider_capabilities: ['ssh', 'snmp'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Filter by NMAP provider
      const nmapAgents = await agentService.listAgents({ provider: 'nmap' });
      expect(nmapAgents.map(a => a.agent_id)).toContain(nmapAgentId);

      // Filter by SSH provider
      const sshAgents = await agentService.listAgents({ provider: 'ssh' });
      expect(sshAgents.map(a => a.agent_id)).toContain(sshAgentId);
    }, 60000);

    it('should filter agents by tags', async () => {
      // Register agents with different tags
      const prod1Id = `test-agent-${uuidv4()}`;
      createdAgentIds.push(prod1Id);
      await agentService.registerAgent({
        agent_id: prod1Id,
        hostname: 'prod-agent-1.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
        tags: ['production', 'datacenter-1'],
      });

      const dev1Id = `test-agent-${uuidv4()}`;
      createdAgentIds.push(dev1Id);
      await agentService.registerAgent({
        agent_id: dev1Id,
        hostname: 'dev-agent-1.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['192.168.0.0/16'],
        tags: ['development'],
      });

      // Filter by production tag
      const prodAgents = await agentService.listAgents({ tags: ['production'] });
      expect(prodAgents.map(a => a.agent_id)).toContain(prod1Id);
      expect(prodAgents.map(a => a.agent_id)).not.toContain(dev1Id);
    }, 60000);
  });

  describe('Agent Deletion', () => {
    it('should delete agent', async () => {
      const agentId = `test-agent-${uuidv4()}`;
      createdAgentIds.push(agentId);

      await agentService.registerAgent({
        agent_id: agentId,
        hostname: 'delete-test.local',
        provider_capabilities: ['nmap'],
        reachable_networks: ['10.0.0.0/8'],
      });

      // Verify agent exists
      const agentBefore = await agentService.getAgent(agentId);
      expect(agentBefore).not.toBeNull();

      // Delete agent
      await agentService.deleteAgent(agentId);

      // Verify agent is deleted
      const agentAfter = await agentService.getAgent(agentId);
      expect(agentAfter).toBeNull();

      // Remove from cleanup list
      const index = createdAgentIds.indexOf(agentId);
      if (index > -1) {
        createdAgentIds.splice(index, 1);
      }
    }, 60000);

    it('should throw error when deleting non-existent agent', async () => {
      const nonExistentId = `test-agent-${uuidv4()}`;

      await expect(
        agentService.deleteAgent(nonExistentId)
      ).rejects.toThrow(`Agent ${nonExistentId} not found`);
    }, 60000);
  });
});
