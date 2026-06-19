// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { CIController } from '../controllers/ci.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { ciInputSchema, queryFiltersSchema, schemas } from '@cmdb/common';

export const ciRoutes = Router();
const controller = new CIController();

// Apply audit middleware to all routes
ciRoutes.use(auditMiddleware);

// Validation schemas
const updateCISchema = Joi.object({
  name: Joi.string().min(1).max(500).optional(),
  type: schemas.ciType.optional(),
  status: schemas.ciStatus.optional(),
  environment: schemas.environment.optional(),
  metadata: Joi.object().optional(),
});

const searchCISchema = Joi.object({
  query: Joi.string().required().min(1),
  limit: Joi.number().integer().min(1).max(1000).default(50),
});

const relationshipQuerySchema = Joi.object({
  direction: Joi.string().valid('in', 'out', 'both').default('both'),
});

const depthQuerySchema = Joi.object({
  depth: Joi.number().integer().min(1).max(10).default(5),
});

// Get all CIs with filtering
ciRoutes.get(
  '/',
  validateOptional(queryFiltersSchema, 'query'),
  controller.getAllCIs.bind(controller)
);

// Search CIs (must be before /:id to avoid route conflict)
ciRoutes.post(
  '/search',
  validateRequest(searchCISchema, 'body'),
  controller.searchCIs.bind(controller)
);

// Get CI by ID
ciRoutes.get('/:id', controller.getCIById.bind(controller));

// Create new CI
ciRoutes.post(
  '/',
  validateRequest(ciInputSchema, 'body'),
  controller.createCI.bind(controller)
);

// Update CI
ciRoutes.put(
  '/:id',
  validateRequest(updateCISchema, 'body'),
  controller.updateCI.bind(controller)
);

// Delete CI
ciRoutes.delete('/:id', controller.deleteCI.bind(controller));

// Get CI relationships
ciRoutes.get(
  '/:id/relationships',
  validateOptional(relationshipQuerySchema, 'query'),
  controller.getCIRelationships.bind(controller)
);

// Get CI dependencies
ciRoutes.get(
  '/:id/dependencies',
  validateOptional(depthQuerySchema, 'query'),
  controller.getCIDependencies.bind(controller)
);

// Get CI impact analysis
ciRoutes.get(
  '/:id/impact',
  validateOptional(depthQuerySchema, 'query'),
  controller.getImpactAnalysis.bind(controller)
);

// Get CI audit history
ciRoutes.get('/:id/audit', controller.getCIAuditHistory.bind(controller));
