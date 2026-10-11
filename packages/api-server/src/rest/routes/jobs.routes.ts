// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs API Routes
 *
 * This module defines all REST API routes for job management and queue
 * monitoring. Authentication is enforced centrally: server.ts mounts
 * `authMiddleware.authenticate()` on every /api/v1 route before this
 * router. Tenant-scoped job routes also require a verified organization claim.
 * Mutating routes additionally require the 'write' permission via
 * `authMiddleware.requirePermission('write')`.
 */

import { Router } from 'express';
import { jobsController } from '../controllers/jobs.controller';
import { queueController } from '../controllers/queue.controller';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { optionalRequestOrganizationId } from '../../middleware/auth.middleware';
import type { Request, Response, NextFunction } from 'express';

function requireJobOrganization(req: Request, res: Response, next: NextFunction): void {
  if (!optionalRequestOrganizationId(req)) {
    res.status(403).json({ success: false, error: 'Organization claim required' });
    return;
  }
  next();
}

// Global queue and schedule operations have no tenant-scoped authorization policy yet.
// Refuse before role checks so viewer, operator and admin receive the same response.
function refuseGlobalOperation(_req: Request, res: Response): void {
  res.status(403).json({ success: false, error: 'Global queue operations unavailable' });
}


const router = Router();
const authMiddleware = getAuthMiddleware();

// Job Management Routes
// IMPORTANT: More specific routes must come BEFORE generic parameterized routes
// to avoid route conflicts (e.g., /jobs/stats vs /jobs/:queueName)

// Job statistics (specific routes first)
router.get('/jobs/stats', refuseGlobalOperation);

// Schedule management (specific routes)
router.get('/jobs/schedules/discovery', refuseGlobalOperation);
router.get('/jobs/schedules/etl', refuseGlobalOperation);
router.put('/jobs/schedules/discovery/:provider', refuseGlobalOperation);
router.put('/jobs/schedules/etl/:type', refuseGlobalOperation);

// Discovery jobs (specific routes)
router.get('/jobs/discovery/stats', refuseGlobalOperation);
router.get('/jobs/discovery', requireJobOrganization, (req, res) =>
  jobsController.listDiscoveryJobs(req, res)
);
router.post('/jobs/discovery/:provider', authMiddleware.requirePermission('write'), requireJobOrganization, (req, res) =>
  jobsController.triggerDiscovery(req, res)
);

// ETL jobs (specific routes)
router.post('/jobs/etl/:type', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.triggerETL(req, res)
);

// Queue-specific routes (must come after /jobs/discovery/stats to avoid conflicts)
router.get('/jobs/:queueName/failed', requireJobOrganization, (req, res) =>
  jobsController.getFailedJobs(req, res)
);
router.post('/jobs/:queueName/clean', refuseGlobalOperation);

// Generic job routes (MUST be last due to :queueName and :jobId parameters)
router.get('/jobs/:queueName/:jobId', requireJobOrganization, (req, res) =>
  jobsController.getJobStatus(req, res)
);
router.get('/jobs/:queueName', requireJobOrganization, (req, res) => jobsController.listJobs(req, res));
router.delete('/jobs/:queueName/:jobId', authMiddleware.requirePermission('write'), requireJobOrganization, (req, res) =>
  jobsController.cancelJob(req, res)
);
router.post('/jobs/:queueName/:jobId/retry', authMiddleware.requirePermission('write'), requireJobOrganization, (req, res) =>
  jobsController.retryJob(req, res)
);

// Queue Monitoring Routes
router.get('/queues/stats', refuseGlobalOperation);
router.get('/queues/:queueName/stats', refuseGlobalOperation);
router.get('/queues/:queueName/metrics', refuseGlobalOperation);
router.get('/queues/workers/status', refuseGlobalOperation);
router.get('/queues/health', refuseGlobalOperation);

// Queue control
router.post('/queues/:queueName/pause', refuseGlobalOperation);
router.post('/queues/:queueName/resume', refuseGlobalOperation);

// Job logs
router.get('/queues/:queueName/jobs/:jobId/logs', requireJobOrganization, (req, res) =>
  queueController.getJobLogs(req, res)
);

export default router;
