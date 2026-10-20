// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Reconciliation Routes
 * REST API routes for identity resolution and CI reconciliation
 */

import { Router, type Request, type Response } from 'express';
import Joi from 'joi';
import { ReconciliationController } from '../controllers/reconciliation.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { journalRequestGuard } from '../../journal-http';

export const reconciliationRoutes = Router();
const controller = new ReconciliationController();
const authMiddleware = getAuthMiddleware();
// Policy tables are global. Until platform operations have their own boundary,
// no authenticated role may inspect or change them.
function refuseGlobalPolicy(_req: Request, res: Response): void {
  res.status(403).json({ success: false, error: 'Global reconciliation policy unavailable' });
}

// Apply audit middleware to all routes
reconciliationRoutes.use(auditMiddleware);

// Validation schemas
const matchRequestSchema = Joi.object({
  identifiers: Joi.object({
    external_id: Joi.string().optional(),
    serial_number: Joi.string().optional(),
    uuid: Joi.string().optional(),
    mac_address: Joi.array().items(Joi.string()).optional(),
    fqdn: Joi.string().optional(),
    hostname: Joi.string().optional(),
    ip_address: Joi.array().items(Joi.string()).optional()
  }).required(),
  source: Joi.string().optional(),
  ci_type: Joi.string().optional(),
  environment: Joi.string().optional()
});

const mergeRequestSchema = Joi.object({
  name: Joi.string().required(),
  ci_type: Joi.string().required(),
  source: Joi.string().required(),
  source_id: Joi.string().required(),
  identifiers: Joi.object({
    external_id: Joi.string().optional(),
    serial_number: Joi.string().optional(),
    uuid: Joi.string().optional(),
    mac_address: Joi.array().items(Joi.string()).optional(),
    fqdn: Joi.string().optional(),
    hostname: Joi.string().optional(),
    ip_address: Joi.array().items(Joi.string()).optional()
  }).required(),
  attributes: Joi.object().optional(),
  relationships: Joi.array().optional(),
  confidence_score: Joi.number().min(0).max(100).optional(),
  environment: Joi.string().optional(),
  status: Joi.string().optional()
});

const resolveConflictSchema = Joi.object({
  resolution: Joi.string().valid('accept_source', 'accept_target', 'merge').required(),
  merged_data: Joi.object().optional()
});


const conflictsQuerySchema = Joi.object({
  status: Joi.string().valid('pending', 'resolved', 'dismissed').default('pending'),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0)
});

// Routes

/**
 * POST /api/v1/reconciliation/match
 * Find duplicate/matching CIs based on identification attributes.
 * Read-like: a lookup query that does not persist state, so it stays
 * authenticated-read rather than requiring 'write'.
 */
reconciliationRoutes.post(
  '/match',
  authMiddleware.requireOrganization(),
  validateRequest(matchRequestSchema, 'body'),
  controller.findMatches.bind(controller)
);

/**
 * POST /api/v1/reconciliation/merge
 * Merge/reconcile a discovered CI into the CMDB
 */
reconciliationRoutes.post(
  '/merge',
  authMiddleware.requirePermission('write'),
  authMiddleware.requireOrganization(),
  journalRequestGuard({ merge: true }),
  validateRequest(mergeRequestSchema, 'body'),
  controller.mergeCI.bind(controller)
);

/**
 * GET /api/v1/reconciliation/conflicts
 * List pending reconciliation conflicts
 */
reconciliationRoutes.get(
  '/conflicts',
  authMiddleware.requireOrganization(),
  validateOptional(conflictsQuerySchema, 'query'),
  controller.listConflicts.bind(controller)
);

/**
 * POST /api/v1/reconciliation/conflicts/:id/resolve
 * Resolve a specific reconciliation conflict
 */
reconciliationRoutes.post(
  '/conflicts/:id/resolve',
  authMiddleware.requirePermission('write'),
  authMiddleware.requireOrganization(),
  validateRequest(resolveConflictSchema, 'body'),
  controller.resolveConflict.bind(controller)
);

/**
 * GET /api/v1/reconciliation/rules
 * List reconciliation rules and configuration
 */
reconciliationRoutes.get('/rules', refuseGlobalPolicy);

/**
 * POST /api/v1/reconciliation/rules
 * Create a new reconciliation rule
 */
reconciliationRoutes.post('/rules', refuseGlobalPolicy);

/**
 * GET /api/v1/reconciliation/source-authorities
 * List source authority scores
 */
reconciliationRoutes.get('/source-authorities', refuseGlobalPolicy);

/**
 * PUT /api/v1/reconciliation/source-authorities/:source
 * Update source authority score
 */
reconciliationRoutes.put('/source-authorities/:source', refuseGlobalPolicy);

/**
 * GET /api/v1/reconciliation/lineage/:ci_id
 * Get source lineage for a CI
 */
reconciliationRoutes.get(
  '/lineage/:ci_id',
  authMiddleware.requireOrganization(),
  controller.getCILineage.bind(controller)
);

/**
 * GET /api/v1/reconciliation/field-sources/:ci_id
 * Get field-level source attribution
 */
reconciliationRoutes.get(
  '/field-sources/:ci_id',
  authMiddleware.requireOrganization(),
  controller.getCIFieldSources.bind(controller)
);
