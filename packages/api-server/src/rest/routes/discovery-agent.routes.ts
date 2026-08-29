// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Agent Routes
 *
 * REST API routes for managing discovery agents.
 *
 * Authentication is enforced centrally: server.ts mounts
 * `authMiddleware.authenticate()` on every /api/v1 route before this
 * router. Registering, heartbeating, and deleting an agent mutate agent
 * state, so they additionally require the 'write' permission
 * (`authMiddleware.requirePermission('write')`); the 'agent' role has
 * 'write' (see ROLE_PERMISSIONS), so discovery agents can register and
 * heartbeat themselves alongside operator/admin. Finding the best agent
 * for a job and listing/reading agents are read-like -- they don't
 * change agent state -- so they stay authenticated-only with no extra
 * gate.
 */
import { Router } from 'express';
import Joi from 'joi';
import { DiscoveryAgentController } from '../controllers/discovery-agent.controller';
import { validateRequest } from '../middleware/validation.middleware';
import { schemas } from '@cmdb/common';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const discoveryAgentRoutes = Router();
const controller = new DiscoveryAgentController();
const authMiddleware = getAuthMiddleware();

// Validation schemas
const registerAgentSchema = Joi.object({
  agent_id: Joi.string().required().min(1).max(255),
  hostname: Joi.string().required().min(1).max(255),
  provider_capabilities: Joi.array()
    .items(schemas.discoveryProvider)
    .min(1)
    .required(),
  reachable_networks: Joi.array()
    .items(Joi.string().ip({ version: ['ipv4'], cidr: 'required' }))
    .min(1)
    .required(),
  version: Joi.string().optional().max(50),
  platform: Joi.string().optional().max(50),
  arch: Joi.string().optional().max(50),
  api_endpoint: Joi.string().uri().optional().max(500),
  tags: Joi.array().items(Joi.string()).optional(),
});

const heartbeatSchema = Joi.object({
  agent_id: Joi.string().required().min(1).max(255),
  status: Joi.string().valid('active', 'inactive', 'offline', 'disabled').required(),
  stats: Joi.object({
    jobs_completed: Joi.number().integer().min(0).optional(),
    jobs_failed: Joi.number().integer().min(0).optional(),
    cis_discovered: Joi.number().integer().min(0).optional(),
  }).optional(),
});

const findBestAgentSchema = Joi.object({
  targetNetworks: Joi.array()
    .items(Joi.string().ip({ version: ['ipv4'], cidr: 'required' }))
    .min(1)
    .required(),
  provider: schemas.discoveryProvider.required(),
});

// POST /api/v1/agents/register - Register or update agent (write)
discoveryAgentRoutes.post(
  '/register',
  authMiddleware.requirePermission('write'),
  validateRequest(registerAgentSchema, 'body'),
  controller.registerAgent.bind(controller)
);

// POST /api/v1/agents/heartbeat - Update agent heartbeat (write)
discoveryAgentRoutes.post(
  '/heartbeat',
  authMiddleware.requirePermission('write'),
  validateRequest(heartbeatSchema, 'body'),
  controller.updateHeartbeat.bind(controller)
);

// POST /api/v1/agents/find-best - Find best agent for networks
discoveryAgentRoutes.post(
  '/find-best',
  validateRequest(findBestAgentSchema, 'body'),
  controller.findBestAgent.bind(controller)
);

// GET /api/v1/agents - List all agents
discoveryAgentRoutes.get('/', controller.listAgents.bind(controller));

// GET /api/v1/agents/:agentId - Get agent by ID
discoveryAgentRoutes.get('/:agentId', controller.getAgent.bind(controller));

// DELETE /api/v1/agents/:agentId - Delete agent (write)
discoveryAgentRoutes.delete(
  '/:agentId',
  authMiddleware.requirePermission('write'),
  controller.deleteAgent.bind(controller)
);
