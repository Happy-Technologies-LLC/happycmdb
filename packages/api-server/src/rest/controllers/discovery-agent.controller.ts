// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { DiscoveryAgentService, AGENT_NOT_FOUND, AgentCaller } from '../../services/discovery-agent.service';
import { logger, DISCOVERY_TARGET_REFUSED } from '@cmdb/common';
import { requestOrganizationId, AuthenticatedRequest } from '../../middleware/auth.middleware';
import { sendForbidden } from '../../middleware/forbidden-response';

/** Error class name only; never the message, stack or cause. */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * The verified caller of an agent write. Only operator and admin act org-wide; every other role that reaches these
 * routes (today: agent) is bound to the agents it registered. An unknown role is bound too: it fails closed.
 */
function agentCaller(req: Request): AgentCaller {
  const user = (req as AuthenticatedRequest).user;
  if (!user?._userId) {
    throw new Error('Agent write reached without authentication');
  }
  return { principalId: user._userId, orgWide: user._role === 'operator' || user._role === 'admin' };
}

/**
 * Discovery Agent Controller
 * Handles HTTP requests for agent registration and management
 */
export class DiscoveryAgentController {
  private service = new DiscoveryAgentService();

  /**
   * POST /api/v1/agents/register
   * Register a new agent or update existing registration
   */
  async registerAgent(req: Request, res: Response): Promise<void> {
    try {
      const agent = await this.service.registerAgent(req.body, requestOrganizationId(req), agentCaller(req));
      if (!agent) {
        res.status(404).json({ success: false, error: AGENT_NOT_FOUND });
        return;
      }

      res.status(200).json({
        success: true,
        data: agent,
      });
    } catch {
      logger.error('Error in registerAgent controller');
      res.status(500).json({
        success: false,
        error: 'Failed to register agent',
      });
    }
  }

  /**
   * POST /api/v1/agents/heartbeat
   * Update agent heartbeat and status
   */
  async updateHeartbeat(req: Request, res: Response): Promise<void> {
    try {
      const caller = agentCaller(req);
      // `disabled` is an operator decision: a bound caller can neither set it here nor leave it (the service keeps it).
      // Refused before any query, so it says nothing about whether the agent exists or who owns it.
      if (req.body.status === 'disabled' && !caller.orgWide) {
        sendForbidden(res, 'ROLE_REQUIRED', "Role 'operator or admin' required to disable an agent", {
          required: { roles: ['operator', 'admin'] },
          role: (req as AuthenticatedRequest).user?._role,
        });
        return;
      }
      const updated = await this.service.updateHeartbeat(req.body, requestOrganizationId(req), caller);
      if (!updated) {
        res.status(404).json({ success: false, error: AGENT_NOT_FOUND });
        return;
      }

      res.status(200).json({
        success: true,
        message: 'Heartbeat updated',
      });
    } catch (error: unknown) {
      logger.error('Error in updateHeartbeat controller', { errorClass: errorClass(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to update heartbeat',
      });
    }
  }

  /**
   * GET /api/v1/agents
   * List all agents with optional filters
   */
  async listAgents(req: Request, res: Response): Promise<void> {
    try {
      const filters: any = {};

      if (req.query['status']) {
        filters.status = req.query['status'];
      }

      if (req.query['provider']) {
        filters.provider = req.query['provider'];
      }

      if (req.query['tags']) {
        filters.tags = Array.isArray(req.query['tags'])
          ? req.query['tags']
          : [req.query['tags']];
      }

      const agents = await this.service.listAgents(requestOrganizationId(req), filters);

      res.status(200).json({
        success: true,
        data: agents,
        count: agents.length,
      });
    } catch (error: unknown) {
      logger.error('Error in listAgents controller', { errorClass: errorClass(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to list agents',
      });
    }
  }

  /**
   * GET /api/v1/agents/:agentId
   * Get agent by ID
   */
  async getAgent(req: Request, res: Response): Promise<void> {
    try {
      const agentId = req.params['agentId'];
      if (!agentId) {
        res.status(400).json({
          success: false,
          error: 'Agent ID is required',
        });
        return;
      }

      const agent = await this.service.getAgent(agentId, requestOrganizationId(req));

      if (!agent) {
        res.status(404).json({
          success: false,
          error: AGENT_NOT_FOUND,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: agent,
      });
    } catch (error: unknown) {
      logger.error('Error in getAgent controller', { errorClass: errorClass(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to get agent',
      });
    }
  }

  /**
   * DELETE /api/v1/agents/:agentId
   * Delete an agent
   */
  async deleteAgent(req: Request, res: Response): Promise<void> {
    try {
      const agentId = req.params['agentId'];
      if (!agentId) {
        res.status(400).json({
          success: false,
          error: 'Agent ID is required',
        });
        return;
      }

      const deleted = await this.service.deleteAgent(agentId, requestOrganizationId(req), agentCaller(req));
      if (!deleted) {
        res.status(404).json({ success: false, error: AGENT_NOT_FOUND });
        return;
      }

      res.status(200).json({
        success: true,
        message: 'Agent deleted successfully',
      });
    } catch (error: unknown) {
      logger.error('Error in deleteAgent controller', { errorClass: errorClass(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to delete agent',
      });
    }
  }

  /**
   * POST /api/v1/agents/find-best
   * Find best agent for target networks
   */
  async findBestAgent(req: Request, res: Response): Promise<void> {
    try {
      const { targetNetworks, provider } = req.body;

      if (!targetNetworks || !Array.isArray(targetNetworks) || targetNetworks.length === 0) {
        res.status(400).json({
          success: false,
          error: 'targetNetworks is required and must be a non-empty array',
        });
        return;
      }

      if (!provider) {
        res.status(400).json({
          success: false,
          error: 'provider is required',
        });
        return;
      }

      const agentId = await this.service.findBestAgentForNetworks(targetNetworks, provider, requestOrganizationId(req));

      if (!agentId) {
        res.status(404).json({
          success: false,
          error: 'No suitable agent found',
          message: 'No active agent can reach the specified networks',
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: { agent_id: agentId },
      });
    } catch (error) {
      if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) {
        res.status(400).json({ success: false, error: DISCOVERY_TARGET_REFUSED });
        return;
      }
      logger.error('Error in findBestAgent controller');
      res.status(500).json({ success: false, error: 'Failed to find best agent' });
    }
  }
}
