// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Definition Routes
 *
 * REST API routes for managing discovery definitions - reusable discovery configurations.
 *
 * Authentication is enforced centrally: server.ts mounts
 * `authMiddleware.authenticate()` on every /api/v1 route before this
 * router. Create/update/delete/run and enabling or disabling a schedule
 * all mutate definition state, so they additionally require the 'write'
 * permission (`authMiddleware.requirePermission('write')`, satisfied by
 * operator, agent, and admin roles). Listing and reading a single
 * definition are read-only and stay authenticated-only with no extra gate.
 */

import { Router } from 'express';
import Joi from 'joi';
import { DiscoveryDefinitionController } from '../controllers/discovery-definition.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { schemas } from '@cmdb/common';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { optionalRequestOrganizationId } from '../../middleware/auth.middleware';
import type { Request, Response, NextFunction } from 'express';

function requireDefinitionOrganization(req: Request, res: Response, next: NextFunction): void {
  if (!optionalRequestOrganizationId(req)) {
    res.status(403).json({ success: false, error: 'Organization claim required' });
    return;
  }
  next();
}

export const discoveryDefinitionRoutes = Router();
const controller = new DiscoveryDefinitionController();
const authMiddleware = getAuthMiddleware();
// S5 installs organization-owned schedules; S3 must not enqueue or enable
// legacy definition payloads (which may contain inline credentials).
const unavailable = (_req: Request, res: Response): void => {
  res.status(503).json({ success: false, error: 'Service Unavailable',
    message: 'Discovery execution is disabled until the journaled cutover' });
};
discoveryDefinitionRoutes.use('/:id/schedule',
  authMiddleware.requirePlatformAdmin(), unavailable);
discoveryDefinitionRoutes.use(requireDefinitionOrganization);

// Validation schemas
const createDefinitionSchema = Joi.object({
  name: Joi.string().required().min(1).max(255),
  description: Joi.string().optional().max(1000),
  provider: schemas.discoveryProvider.required(),
  method: schemas.discoveryMethod.required(),
  credential_id: Joi.string().uuid().when('provider', {
    is: 'ssh',
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  agent_id: Joi.string().max(255).when('method', {
    is: 'agent',
    then: Joi.required(),
    otherwise: Joi.optional()
  }),
  config: Joi.object().unknown(true).optional().default({}),
  schedule: Joi.string().optional(), // Cron expression
  is_active: Joi.boolean().optional().default(true),
  tags: Joi.array().items(Joi.string()).optional(),
});

const updateDefinitionSchema = Joi.object({
  name: Joi.string().optional().min(1).max(255),
  description: Joi.string().optional().max(1000),
  provider: schemas.discoveryProvider.optional(),
  method: schemas.discoveryMethod.optional(),
  credential_id: Joi.string().uuid().optional(),
  agent_id: Joi.string().max(255).optional(),
  config: Joi.object().unknown(true).optional(),
  schedule: Joi.string().optional(),
  is_active: Joi.boolean().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
});

const listDefinitionsQuerySchema = Joi.object({
  provider: schemas.discoveryProvider.optional(),
  is_active: Joi.string().valid('true', 'false').optional(),
  created_by: Joi.string().optional(),
});

// POST /api/v1/discovery/definitions - Create new definition (write)
discoveryDefinitionRoutes.post(
  '/',
  authMiddleware.requirePermission('write'),
  validateRequest(createDefinitionSchema, 'body'),
  controller.createDefinition.bind(controller)
);

// GET /api/v1/discovery/definitions - List all definitions
discoveryDefinitionRoutes.get(
  '/',
  validateOptional(listDefinitionsQuerySchema, 'query'),
  controller.listDefinitions.bind(controller)
);

// GET /api/v1/discovery/definitions/:id - Get definition by ID
discoveryDefinitionRoutes.get(
  '/:id',
  controller.getDefinition.bind(controller)
);

// PUT /api/v1/discovery/definitions/:id - Update definition (write)
discoveryDefinitionRoutes.put(
  '/:id',
  authMiddleware.requirePermission('write'),
  validateRequest(updateDefinitionSchema, 'body'),
  controller.updateDefinition.bind(controller)
);

// DELETE /api/v1/discovery/definitions/:id - Delete definition (write)
discoveryDefinitionRoutes.delete(
  '/:id',
  authMiddleware.requirePermission('write'),
  controller.deleteDefinition.bind(controller)
);

// POST /api/v1/discovery/definitions/:id/run - Run definition (trigger discovery job) (write)
discoveryDefinitionRoutes.post(
  '/:id/run',
  authMiddleware.requirePermission('write'),
  unavailable
);

// POST /api/v1/discovery/definitions/:id/schedule/enable - Enable scheduled runs (write)
discoveryDefinitionRoutes.post(
  '/:id/schedule/enable',
  authMiddleware.requirePermission('write'),
  controller.enableSchedule.bind(controller)
);

// POST /api/v1/discovery/definitions/:id/schedule/disable - Disable scheduled runs (write)
discoveryDefinitionRoutes.post(
  '/:id/schedule/disable',
  authMiddleware.requirePermission('write'),
  controller.disableSchedule.bind(controller)
);
