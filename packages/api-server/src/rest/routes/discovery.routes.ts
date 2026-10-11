// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { DiscoveryController } from '../controllers/discovery.controller';
import { SettingsController } from '../controllers/settings.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { settingsSchemas } from '../../validation/schemas';
import { schemas } from '@cmdb/common';
import { optionalRequestOrganizationId } from '../../middleware/auth.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

/**
 * Discovery Routes - Legacy ad-hoc discovery endpoints
 *
 * NOTE: For reusable discovery configurations with credentials and schedules,
 * use the new Discovery Definitions API at /api/v1/discovery/definitions
 *
 * The CLI consumes legacy schedule and job routes. Authentication is mounted
 * centrally in server.ts; each legacy job route also requires a verified org.
 * Cancellation and scheduling additionally require write permission.
 */

export const discoveryRoutes = Router();
const controller = new DiscoveryController();
const settingsController = new SettingsController();
const authMiddleware = getAuthMiddleware();

// Credential-backed providers cannot run until the org-owned worker pipeline exists.
function refuseUnavailableProvider(req: Request, res: Response, next: NextFunction): void {
  if (['ssh', 'snmp', 'active-directory'].includes(req.body?.provider)) {
    res.status(409).json({ success: false, error: 'Credential-backed discovery execution unavailable' });
    return;
  }
  next();
}

function requireDiscoveryOrganization(req: Request, res: Response, next: NextFunction): void {
  if (!optionalRequestOrganizationId(req)) {
    res.status(403).json({ success: false, error: 'Organization claim required' });
    return;
  }
  next();
}

// Validation schemas
const scheduleDiscoverySchema = Joi.object({
  provider: schemas.discoveryProvider.required(),
  config: Joi.object().unknown(true).optional().default({}),
});

const listJobsQuerySchema = Joi.object({
  status: schemas.jobStatus.optional(),
  provider: schemas.discoveryProvider.optional(),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

// POST /discovery/schedule - Schedule discovery job (write: mutates discovery state)
discoveryRoutes.post(
  '/schedule',
  authMiddleware.requirePermission('write'),
  refuseUnavailableProvider,
  requireDiscoveryOrganization,
  validateRequest(scheduleDiscoverySchema, 'body'),
  controller.scheduleDiscovery.bind(controller)
);

// GET /discovery/jobs/:id - Get job status
discoveryRoutes.get(
  '/jobs/:id',
  requireDiscoveryOrganization,
  controller.getJobStatus.bind(controller)
);

// GET /discovery/jobs - List all jobs with pagination
discoveryRoutes.get(
  '/jobs',
  requireDiscoveryOrganization,
  validateOptional(listJobsQuerySchema, 'query'),
  controller.listJobs.bind(controller)
);

// DELETE /discovery/jobs/:id - Cancel job (write: mutates discovery state)
discoveryRoutes.delete(
  '/jobs/:id',
  authMiddleware.requirePermission('write'),
  requireDiscoveryOrganization,
  controller.cancelJob.bind(controller)
);

// POST /discovery/test-connection - validate discovery provider credentials
// (DiscoverySettings.tsx). Lives here (rather than settings.routes.ts)
// because it must be reachable at /api/v1/discovery/test-connection, which
// this router is already centrally mounted under.
discoveryRoutes.post(
  '/test-connection',
  validateRequest(settingsSchemas.testConnection, 'body'),
  settingsController.testDiscoveryConnection.bind(settingsController)
);
