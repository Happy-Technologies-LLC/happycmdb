// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { DiscoveryController } from '../controllers/discovery.controller';
import { SettingsController } from '../controllers/settings.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { settingsSchemas } from '../../validation/schemas';
import { schemas } from '@cmdb/common';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

/**
 * Discovery Routes - Legacy ad-hoc discovery endpoints
 *
 * NOTE: For reusable discovery configurations with credentials and schedules,
 * use the new Discovery Definitions API at /api/v1/discovery/definitions
 *
 * These endpoints are maintained for backward compatibility and one-off
 * discoveries. Authentication is enforced centrally: server.ts mounts
 * `authMiddleware.authenticate()` on every /api/v1 route before this
 * router. Scheduling and cancelling a job mutate discovery state, so they
 * additionally require the 'write' permission
 * (`authMiddleware.requirePermission('write')`, satisfied by operator,
 * agent, and admin roles). Listing/reading jobs and validating provider
 * credentials (test-connection) are read-like -- they don't change
 * discovery state -- so they stay authenticated-only with no extra gate.
 */

export const discoveryRoutes = Router();
const controller = new DiscoveryController();
const settingsController = new SettingsController();
const authMiddleware = getAuthMiddleware();

// Validation schemas
const scheduleDiscoverySchema = Joi.object({
  provider: schemas.discoveryProvider.required(),
  config: Joi.object({
    credentials: Joi.any().optional(),
    regions: Joi.array().items(Joi.string()).optional(),
    filters: Joi.object().optional(),
    targets: Joi.array().items(Joi.string()).optional(),
  }).optional().default({}),
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
  validateRequest(scheduleDiscoverySchema, 'body'),
  controller.scheduleDiscovery.bind(controller)
);

// GET /discovery/jobs/:id - Get job status
discoveryRoutes.get(
  '/jobs/:id',
  controller.getJobStatus.bind(controller)
);

// GET /discovery/jobs - List all jobs with pagination
discoveryRoutes.get(
  '/jobs',
  validateOptional(listJobsQuerySchema, 'query'),
  controller.listJobs.bind(controller)
);

// DELETE /discovery/jobs/:id - Cancel job (write: mutates discovery state)
discoveryRoutes.delete(
  '/jobs/:id',
  authMiddleware.requirePermission('write'),
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
