// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'crypto';

import { getPostgresClient } from '@cmdb/database';
import { logger, assertDiscoveryRange, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';
import {
  DiscoveryAgent,
  DiscoveryAgentRegistration,
  AgentHeartbeat,
  DiscoveryProvider,
} from '@cmdb/common';

/**
 * Discovery Agent Service
 *
 * Manages discovery agent registration, heartbeats, and routing
 */
export const AGENT_NOT_FOUND = 'Agent not found';

/** The counters are INTEGER columns; the running totals saturate here instead of raising 22003. */
const INT4_MAX = 2147483647;

/**
 * The verified caller of an agent write. Agents are bound to the principal that registered them
 * (`owner_user_id`): a caller with `orgWide` false (the `agent` role) only touches rows it owns, and a foreign,
 * ownerless or missing row is the same "not found" for it. `orgWide` (operator, admin) keeps control of every agent
 * of the organization and is the only caller that may set or clear `disabled`.
 */
export interface AgentCaller {
  /** Verified user id: an API key authenticates as its owning user. */
  principalId: string;
  orgWide: boolean;
}

export class DiscoveryAgentService {
  private postgresClient = getPostgresClient();

  /**
   * Register a new agent or update existing registration. A fresh registration records the caller as the owner; an
   * update by an operator/admin claims an ownerless (pre-057) row for that caller and never rewrites an owner.
   */
  async registerAgent(input: DiscoveryAgentRegistration, organizationId: string, caller: AgentCaller): Promise<DiscoveryAgent | null> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Caller-supplied IDs are update-only: missing and foreign both produce
      // the same 404. Fresh registrations get an unguessable server ID.
      const columns = `id, agent_id, hostname, provider_capabilities, reachable_networks,
          version, platform, arch, api_endpoint, status,
          last_heartbeat_at, last_job_at, total_jobs_completed,
          total_jobs_failed, total_cis_discovered, tags,
          registered_at, updated_at`;
      const values = [
        input.agent_id ?? `agent-${randomUUID()}`,
        input.hostname,
        input.provider_capabilities,
        input.reachable_networks,
        input.version || null,
        input.platform || null,
        input.arch || null,
        input.api_endpoint || null,
        input.tags || [],
        organizationId,
      ];
      const result = input.agent_id
        ? await client.query(
          // `disabled` is operator-only in both directions: a bound caller's re-registration keeps it.
          `UPDATE discovery_agents SET
            hostname = $2, provider_capabilities = $3, reachable_networks = $4,
            version = $5, platform = $6, arch = $7, api_endpoint = $8, tags = $9,
            status = ${caller.orgWide ? "'active'" : "CASE WHEN status = 'disabled' THEN status ELSE 'active' END"},
            owner_user_id = COALESCE(owner_user_id, $11),
            last_heartbeat_at = NOW()
           WHERE agent_id = $1 AND organization_id = $10${caller.orgWide ? '' : ' AND owner_user_id = $11'}
           RETURNING ${columns}`, [...values, caller.principalId]
        )
        : await client.query(
          `INSERT INTO discovery_agents (
            agent_id, organization_id, hostname, provider_capabilities, reachable_networks,
            version, platform, arch, api_endpoint, tags, status, last_heartbeat_at, owner_user_id
          ) VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW(), $11)
          RETURNING ${columns}`, [...values, caller.principalId]
        );

      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      await client.query('COMMIT');

      const agent = this.mapRowToAgent(result.rows[0]);
      logger.info('Agent registered', {
        agentId: agent.agent_id,
        hostname: agent.hostname,
        capabilities: agent.provider_capabilities,
        networks: agent.reachable_networks,
      });

      return agent;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error registering agent');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update agent heartbeat. A bound caller only reaches an agent it owns (anything else is `false`, the same as a
   * missing agent) and cannot move an agent out of `disabled`. Setting `disabled` is refused one layer up, in the
   * controller, before any query.
   */
  async updateHeartbeat(heartbeat: AgentHeartbeat, organizationId: string, caller: AgentCaller): Promise<boolean> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      const updates: string[] = ['last_heartbeat_at = NOW()'];
      const params: any[] = [];

      if (heartbeat.status) {
        params.push(heartbeat.status);
        updates.push(caller.orgWide
          ? `status = $${params.length}`
          : `status = CASE WHEN status = 'disabled' THEN status ELSE $${params.length}::varchar END`);
      }

      if (heartbeat.stats?.jobs_completed !== undefined) {
        params.push(heartbeat.stats.jobs_completed);
        updates.push(`total_jobs_completed = LEAST(total_jobs_completed::bigint + $${params.length}, ${INT4_MAX})::integer`);
      }

      if (heartbeat.stats?.jobs_failed !== undefined) {
        params.push(heartbeat.stats.jobs_failed);
        updates.push(`total_jobs_failed = LEAST(total_jobs_failed::bigint + $${params.length}, ${INT4_MAX})::integer`);
      }

      if (heartbeat.stats?.cis_discovered !== undefined) {
        params.push(heartbeat.stats.cis_discovered);
        updates.push(`total_cis_discovered = LEAST(total_cis_discovered::bigint + $${params.length}, ${INT4_MAX})::integer`);
      }

      params.push(heartbeat.agent_id, organizationId);
      const scope = `agent_id = $${params.length - 1} AND organization_id = $${params.length}`;
      if (!caller.orgWide) {
        params.push(caller.principalId);
      }

      const result = await client.query(
        `UPDATE discovery_agents
         SET ${updates.join(', ')}
         WHERE ${scope}${caller.orgWide ? '' : ` AND owner_user_id = $${params.length}`}`,
        params
      );

      await client.query('COMMIT');

      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating heartbeat', { heartbeat, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get agent by agent_id
   */
  async getAgent(agentId: string, organizationId: string): Promise<DiscoveryAgent | null> {
    try {
      const result = await this.postgresClient.query(
        `SELECT
          id, agent_id, hostname, provider_capabilities, reachable_networks,
          version, platform, arch, api_endpoint, status,
          last_heartbeat_at, last_job_at, total_jobs_completed,
          total_jobs_failed, total_cis_discovered, tags,
          registered_at, updated_at
        FROM discovery_agents
        WHERE agent_id = $1 AND organization_id = $2`,
        [agentId, organizationId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToAgent(result.rows[0]);
    } catch (error) {
      logger.error('Error getting agent', { agentId, error });
      throw error;
    }
  }

  /**
   * List all agents with optional filters
   */
  async listAgents(organizationId: string, filters?: {
    status?: string;
    provider?: DiscoveryProvider;
    tags?: string[];
  }): Promise<DiscoveryAgent[]> {
    try {
      const conditions: string[] = ['organization_id = $1'];
      const params: unknown[] = [organizationId];

      if (filters?.status) {
        params.push(filters.status);
        conditions.push(`status = $${params.length}`);
      }

      if (filters?.provider) {
        params.push(filters.provider);
        conditions.push(`$${params.length} = ANY(provider_capabilities)`);
      }

      if (filters?.tags && filters.tags.length > 0) {
        params.push(filters.tags);
        conditions.push(`tags && $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await this.postgresClient.query(
        `SELECT
          id, agent_id, hostname, provider_capabilities, reachable_networks,
          version, platform, arch, api_endpoint, status,
          last_heartbeat_at, last_job_at, total_jobs_completed,
          total_jobs_failed, total_cis_discovered, tags,
          registered_at, updated_at
        FROM discovery_agents
        ${whereClause}
        ORDER BY last_heartbeat_at DESC`,
        params
      );

      return result.rows.map(row => this.mapRowToAgent(row));
    } catch (error) {
      logger.error('Error listing agents', { filters, error });
      throw error;
    }
  }

  /**
   * Find best agent for target networks
   * Returns agent_id of the best match, or null if no suitable agent found
   */
  async findBestAgentForNetworks(
    targetNetworks: string[],
    provider: DiscoveryProvider,
    organizationId: string
  ): Promise<string | null> {
    if (!Array.isArray(targetNetworks) || targetNetworks.length === 0) {
      throw new Error(DISCOVERY_TARGET_REFUSED);
    }
    targetNetworks.forEach(assertDiscoveryRange);
    try {
      // Select only an agent that covers every validated public target network.
      const result = await this.postgresClient.query(
        `SELECT
          agent_id,
          hostname,
          reachable_networks,
          last_heartbeat_at,
          total_jobs_completed,
          total_jobs_failed
        FROM discovery_agents
        WHERE status = 'active'
          AND organization_id = $3
          AND $1 = ANY(provider_capabilities)
          AND (NOW() - last_heartbeat_at) < INTERVAL '5 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM unnest($2::cidr[]) AS target(target_network)
            WHERE NOT EXISTS (
              SELECT 1 FROM unnest(reachable_networks) AS coverage(agent_network)
              WHERE target.target_network <<= coverage.agent_network
            )
          )
        ORDER BY
          -- Prefer agents with better success rate
          CASE
            WHEN (total_jobs_completed::bigint + total_jobs_failed) > 0
            THEN total_jobs_completed::float / (total_jobs_completed::bigint + total_jobs_failed)
            ELSE 0.5
          END DESC,
          -- Then prefer more recently active agents
          last_heartbeat_at DESC
        LIMIT 1`,
        [provider, targetNetworks, organizationId]
      );

      if (result.rows.length === 0) {
        logger.warn('No suitable agent found for networks', { provider });
        return null;
      }

      const agent = result.rows[0];
      logger.info('Found best agent for networks', {
        agentId: agent.agent_id,
        hostname: agent.hostname,
        targetNetworks,
        provider,
      });

      return agent.agent_id;
    } catch (error) {
      logger.error('Error finding best agent', { provider });
      throw error;
    }
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId: string, organizationId: string, caller: AgentCaller): Promise<boolean> {
    try {
      const result = await this.postgresClient.query(
        `DELETE FROM discovery_agents WHERE agent_id = $1 AND organization_id = $2${caller.orgWide ? '' : ' AND owner_user_id = $3'}`,
        caller.orgWide ? [agentId, organizationId] : [agentId, organizationId, caller.principalId]
      );

      if (result.rowCount === 0) return false;
      logger.info('Agent deleted', { agentId });
      return true;
    } catch (error) {
      logger.error('Error deleting agent', { agentId, error });
      throw error;
    }
  }

  /**
   * Mark stale agents as offline
   * (agents that haven't sent heartbeat in 5+ minutes)
   */
  async markStaleAgentsOffline(organizationId: string): Promise<number> {
    try {
      const result = await this.postgresClient.query(
        `UPDATE discovery_agents
         SET status = 'offline'
         WHERE organization_id = $1
           AND status = 'active'
           AND (NOW() - last_heartbeat_at) > INTERVAL '5 minutes'`,
        [organizationId]
      );

      const count = result.rowCount || 0;
      if (count > 0) {
        logger.info('Marked stale agents as offline', { count });
      }

      return count;
    } catch (error) {
      logger.error('Error marking stale agents offline', error);
      throw error;
    }
  }

  /**
   * Map database row to DiscoveryAgent object
   */
  private mapRowToAgent(row: any): DiscoveryAgent {
    return {
      id: row.id,
      agent_id: row.agent_id,
      hostname: row.hostname,
      provider_capabilities: row.provider_capabilities || [],
      reachable_networks: row.reachable_networks || [],
      version: row.version,
      platform: row.platform,
      arch: row.arch,
      api_endpoint: row.api_endpoint,
      status: row.status,
      last_heartbeat_at: row.last_heartbeat_at.toISOString(),
      last_job_at: row.last_job_at ? row.last_job_at.toISOString() : undefined,
      total_jobs_completed: row.total_jobs_completed || 0,
      total_jobs_failed: row.total_jobs_failed || 0,
      total_cis_discovered: row.total_cis_discovered || 0,
      tags: row.tags || [],
      registered_at: row.registered_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
