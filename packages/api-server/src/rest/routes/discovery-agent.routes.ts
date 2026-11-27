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
 * heartbeat themselves alongside operator/admin. Those three writes are
 * owner-bound: an agent-role caller only reaches agents it registered
 * (see DiscoveryAgentService, AgentCaller); operator/admin act org-wide.
 * Heartbeats also pass a per-principal rate limit (rateLimit.endpoints.agentHeartbeat).
 * Finding the best agent for a job and listing/reading agents are
 * read-like -- they don't change agent state -- so they stay
 * authenticated-only with no extra gate.
 */
import { RequestHandler, Router } from 'express';
import Joi from 'joi';
import { DiscoveryAgentController } from '../controllers/discovery-agent.controller';
import { validateRequest } from '../middleware/validation.middleware';
import { schemas, loadConfig, logger, errorClassFields } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';

export const discoveryAgentRoutes = Router();
const controller = new DiscoveryAgentController();
const authMiddleware = getAuthMiddleware();

// Every lookup and mutation below is bound to the verified identity's org.
discoveryAgentRoutes.use(authMiddleware.requireOrganization());

// Validation schemas
const registerAgentSchema = Joi.object({
  agent_id: Joi.string().optional().min(1).max(255),
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
  tags: Joi.array().items(Joi.string().max(100)).max(50).optional(),
});

// The counters are per-heartbeat deltas added to INTEGER columns. A million jobs or CIs in one
// heartbeat interval is far above anything real; the cap keeps a single request well inside INT4
// (400 instead of a 500 at parameter binding).
const MAX_HEARTBEAT_STAT_DELTA = 1_000_000;

/**
 * Heartbeats per verified principal per window (`rateLimit.endpoints.agentHeartbeat`, env
 * `RATE_LIMIT_AGENT_HEARTBEAT_MAX` / `_WINDOW_MS`): 600 per hour by default, ten times the nominal one-per-minute
 * cadence of one agent, so one agent's retries and restarts never trip it. The ceiling is about ten agents per user
 * at a 60 s interval; a user running more raises the budget. The bucket is the verified user (an API key authenticates
 * as its owning user and carries no key id), so all keys of one user share it. Only admitted heartbeats are counted:
 * a refused retry does not extend the lockout, so the user is admitted again once its oldest admitted heartbeat leaves
 * the window. Max 0 mounts no limiter. It honours `rateLimit.enabled` and the internal-service bypass header like every
 * limiter, and fails open on a store error.
 */
// undefined: not built yet; null: no limiter (max 0, or construction failed and was logged once).
let heartbeatLimiter: RequestHandler | null | undefined;
// Built once on the first heartbeat: no Redis connection or limiter state at import time.
function buildHeartbeatLimiter(): RequestHandler | null {
  try {
    const limiter = new RateLimitMiddleware(getRedisClient().getConnection(), loadConfig().rateLimit);
    const budget = limiter.endpointBudget('agentHeartbeat');
    return budget._max === 0
      ? null
      : limiter.custom(budget, 'agent-heartbeat', { admittedOnly: true }) as unknown as RequestHandler;
  } catch (error) {
    logger.error('Heartbeat rate limiter unavailable - allowing requests', undefined, errorClassFields(error));
    return null;
  }
}
const limitHeartbeats: RequestHandler = (req, res, next) => {
  if (heartbeatLimiter === undefined) heartbeatLimiter = buildHeartbeatLimiter();
  if (heartbeatLimiter === null) {
    next();
    return;
  }
  void heartbeatLimiter(req, res, next);
};

const heartbeatSchema = Joi.object({
  agent_id: Joi.string().required().min(1).max(255),
  status: Joi.string().valid('active', 'inactive', 'offline', 'disabled').required(),
  stats: Joi.object({
    jobs_completed: Joi.number().integer().min(0).max(MAX_HEARTBEAT_STAT_DELTA).optional(),
    jobs_failed: Joi.number().integer().min(0).max(MAX_HEARTBEAT_STAT_DELTA).optional(),
    cis_discovered: Joi.number().integer().min(0).max(MAX_HEARTBEAT_STAT_DELTA).optional(),
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
  limitHeartbeats,
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
