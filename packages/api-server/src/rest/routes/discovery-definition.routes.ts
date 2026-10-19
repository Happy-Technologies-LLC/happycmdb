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
 * operator, agent, and admin roles). Normal listing and reads require
 * authentication; the quarantined-row inventory additionally requires admin.
 */

import { Router } from 'express';
import Joi from 'joi';
import { DiscoveryDefinitionController } from '../controllers/discovery-definition.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { schemas, strictDiscoveryDefinitionConfig } from '@cmdb/common';
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
discoveryDefinitionRoutes.use(requireDefinitionOrganization);

// Do not let validation details reflect arbitrary inline credential values.
function rejectUnsafeDefinitionConfig(req: Request, res: Response, next: NextFunction): void {
  if (req.body?.config !== undefined) {
    try {
      strictDiscoveryDefinitionConfig(req.body.config);
    } catch {
      res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid discovery scan configuration' });
      return;
    }
  }
  next();
}

const scanOptionsSchema = Joi.object({
  aggressive: Joi.boolean(), osDetection: Joi.boolean(), serviceDetection: Joi.boolean(),
  fullPortScan: Joi.boolean(), portScan: Joi.boolean(),
});
const configSchema = Joi.object({
  targets: Joi.array().items(Joi.string()), range: Joi.string(), scanOptions: scanOptionsSchema,
});

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
  config: configSchema.optional().default({}),
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
  config: configSchema.optional(),
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
  rejectUnsafeDefinitionConfig,
  validateRequest(createDefinitionSchema, 'body'),
  controller.createDefinition.bind(controller)
);

// GET /api/v1/discovery/definitions - List all definitions
discoveryDefinitionRoutes.get(
  '/',
  validateOptional(listDefinitionsQuerySchema, 'query'),
  controller.listDefinitions.bind(controller)
);

// GET /migration/inventory - admin-only, redacted tenant-scoped quarantine inventory.
discoveryDefinitionRoutes.get(
  '/migration/inventory',
  authMiddleware.requireRole('admin'),
  controller.listUnsafeDefinitionIds.bind(controller)
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
  rejectUnsafeDefinitionConfig,
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
  controller.runDefinition.bind(controller)
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
