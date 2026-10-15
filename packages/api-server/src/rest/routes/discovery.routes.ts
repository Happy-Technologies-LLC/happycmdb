// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { DiscoveryController } from '../controllers/discovery.controller';
import { validateOptional } from '../middleware/validation.middleware';
import { schemas } from '@cmdb/common';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

/**
 * Discovery Routes - Legacy ad-hoc discovery endpoints
 *
 * NOTE: For reusable discovery configurations with credentials and schedules,
 * use the new Discovery Definitions API at /api/v1/discovery/definitions
 *
 * The CLI consumes legacy schedule and job routes. Authentication is mounted
 * centrally in server.ts; only platform admins may inspect legacy queues.
 */

export const discoveryRoutes = Router();
const controller = new DiscoveryController();
const authMiddleware = getAuthMiddleware();

const unavailable = (_req: Request, res: Response): void => {
  res.status(503).json({ success: false, error: 'Service Unavailable',
    message: 'Discovery execution is disabled until the journaled cutover' });
};


const listJobsQuerySchema = Joi.object({
  status: schemas.jobStatus.optional(),
  provider: schemas.discoveryProvider.optional(),
  limit: Joi.number().integer().min(1).max(100).default(100),
  offset: Joi.number().integer().min(0).max(10_000).default(0),
});

function refuseDeepJobOffset(req: Request, res: Response, next: NextFunction): void {
  const offset = req.query.offset;
  if (offset !== undefined) {
    if (typeof offset !== 'string' || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset))) {
      res.status(400).json({ success: false, error: 'Invalid job pagination' });
      return;
    }
    if (Number(offset) > 10_000) {
      res.status(400).json({ success: false, error: 'Deep job pages unavailable' });
      return;
    }
  }
  next();
}


// POST /discovery/schedule - Schedule discovery job (write: mutates discovery state)
discoveryRoutes.post(
  '/schedule',
  authMiddleware.requirePermission('write'),
  unavailable
);

// GET /discovery/jobs/:id - Get job status
discoveryRoutes.get(
  '/jobs/:id',
  authMiddleware.requirePlatformAdmin(),
  controller.getJobStatus.bind(controller)
);

// GET /discovery/jobs - List all jobs with pagination
discoveryRoutes.get(
  '/jobs',
  authMiddleware.requirePlatformAdmin(),
  refuseDeepJobOffset,
  validateOptional(listJobsQuerySchema, 'query'),
  controller.listJobs.bind(controller)
);

// DELETE /discovery/jobs/:id - Cancel job (write: mutates discovery state)
discoveryRoutes.delete(
  '/jobs/:id',
  authMiddleware.requirePlatformAdmin(),
  controller.cancelJob.bind(controller)
);

// POST /discovery/test-connection - validate discovery provider credentials
// (DiscoverySettings.tsx). Lives here (rather than settings.routes.ts)
// because it must be reachable at /api/v1/discovery/test-connection, which
// this router is already centrally mounted under.
discoveryRoutes.post(
  '/test-connection',
  unavailable
);
