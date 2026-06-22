// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { DiscoveryController } from '../controllers/discovery.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { schemas } from '@cmdb/common';

/**
 * Discovery Routes - Legacy ad-hoc discovery endpoints
 *
 * NOTE: For reusable discovery configurations with credentials and schedules,
 * use the new Discovery Definitions API at /api/v1/discovery/definitions
 *
 * These endpoints are maintained for backward compatibility and one-off discoveries.
 */

export const discoveryRoutes = Router();
const controller = new DiscoveryController();

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

// POST /discovery/schedule - Schedule discovery job
discoveryRoutes.post(
  '/schedule',
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

// DELETE /discovery/jobs/:id - Cancel job
discoveryRoutes.delete(
  '/jobs/:id',
  controller.cancelJob.bind(controller)
);
