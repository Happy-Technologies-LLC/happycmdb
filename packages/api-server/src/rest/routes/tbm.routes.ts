// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { TBMController } from '../controllers/tbm.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const tbmRoutes = Router();
const controller = new TBMController();
const authMiddleware = getAuthMiddleware();

// Apply audit middleware to all routes
tbmRoutes.use(auditMiddleware);

// Validation schemas
const allocateCostsSchema = Joi.object({
  sourceId: Joi.string().required(),
  targetType: Joi.string().valid('business_service', 'business_capability', 'application_service').required(),
  targetIds: Joi.array().items(Joi.string()).min(1).required(),
  allocationMethod: Joi.string().valid('direct', 'usage_based', 'equal').default('usage_based'),
  allocationRules: Joi.object().pattern(Joi.string(), Joi.number()).optional(),
});

const costTrendsQuerySchema = Joi.object({
  months: Joi.number().integer().min(1).max(36).default(6),
});

const towerQuerySchema = Joi.object({
  tower: Joi.string()
    .valid(
      'compute',
      'storage',
      'network',
      'data',
      'security',
      'end_user',
      'facilities',
      'risk_compliance',
      'iot',
      'blockchain',
      'quantum'
    )
    .optional(),
});

const licenseQuerySchema = Joi.object({
  vendor: Joi.string().optional(),
  status: Joi.string().valid('active', 'expired', 'expiring_soon').optional(),
});

const renewalsQuerySchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(90),
});

// ============================================================================
// Cost Summary Endpoints
// ============================================================================

tbmRoutes.get(
  '/costs/summary',
  controller.getCostSummary.bind(controller)
);

tbmRoutes.get(
  '/costs/by-tower',
  validateOptional(towerQuerySchema, 'query'),
  controller.getCostsByTower.bind(controller)
);

tbmRoutes.get(
  '/costs/by-capability/:id',
  controller.getCostsByCapability.bind(controller)
);

tbmRoutes.get(
  '/costs/by-service/:id',
  controller.getCostsByBusinessService.bind(controller)
);

tbmRoutes.get(
  '/costs/trends',
  validateOptional(costTrendsQuerySchema, 'query'),
  controller.getCostTrends.bind(controller)
);

// ============================================================================
// Cost Allocation Endpoints
// ============================================================================

tbmRoutes.post(
  '/costs/allocate',
  authMiddleware.requirePermission('write'),
  validateRequest(allocateCostsSchema, 'body'),
  controller.allocateCosts.bind(controller)
);

tbmRoutes.get(
  '/costs/allocations/:ciId',
  controller.getCostAllocations.bind(controller)
);

// ============================================================================
// GL and License Management
// ============================================================================

tbmRoutes.post(
  '/gl/import',
  authMiddleware.requirePermission('write'),
  controller.importGLData.bind(controller)
);

tbmRoutes.get(
  '/licenses',
  validateOptional(licenseQuerySchema, 'query'),
  controller.getLicenses.bind(controller)
);

tbmRoutes.get(
  '/licenses/renewals',
  validateOptional(renewalsQuerySchema, 'query'),
  controller.getUpcomingRenewals.bind(controller)
);
