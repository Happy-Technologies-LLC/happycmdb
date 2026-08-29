// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs API Routes
 *
 * This module defines all REST API routes for job management and queue
 * monitoring. Authentication is enforced centrally: server.ts mounts
 * `authMiddleware.authenticate()` on every /api/v1 route before this
 * router. Reads only need to be authenticated; every mutating route
 * (trigger discovery/ETL, schedule PUTs, queue clean/cancel/retry,
 * queue pause/resume) additionally requires the 'write' permission via
 * `authMiddleware.requirePermission('write')`.
 */

import { Router } from 'express';
import { jobsController } from '../controllers/jobs.controller';
import { queueController } from '../controllers/queue.controller';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

const router = Router();
const authMiddleware = getAuthMiddleware();

// Job Management Routes
// IMPORTANT: More specific routes must come BEFORE generic parameterized routes
// to avoid route conflicts (e.g., /jobs/stats vs /jobs/:queueName)

// Job statistics (specific routes first)
router.get('/jobs/stats', (req, res) => jobsController.getJobStats(req, res));

// Schedule management (specific routes)
router.get('/jobs/schedules/discovery', (req, res) =>
  jobsController.getDiscoverySchedules(req, res)
);
router.get('/jobs/schedules/etl', (req, res) =>
  jobsController.getETLSchedules(req, res)
);
router.put('/jobs/schedules/discovery/:provider', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.updateDiscoverySchedule(req, res)
);
router.put('/jobs/schedules/etl/:type', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.updateETLSchedule(req, res)
);

// Discovery jobs (specific routes)
router.get('/jobs/discovery/stats', (req, res) =>
  jobsController.getDiscoveryStats(req, res)
);
router.get('/jobs/discovery', (req, res) =>
  jobsController.listDiscoveryJobs(req, res)
);
router.post('/jobs/discovery/:provider', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.triggerDiscovery(req, res)
);

// ETL jobs (specific routes)
router.post('/jobs/etl/:type', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.triggerETL(req, res)
);

// Queue-specific routes (must come after /jobs/discovery/stats to avoid conflicts)
router.get('/jobs/:queueName/failed', (req, res) =>
  jobsController.getFailedJobs(req, res)
);
router.post('/jobs/:queueName/clean', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.cleanQueue(req, res)
);

// Generic job routes (MUST be last due to :queueName and :jobId parameters)
router.get('/jobs/:queueName/:jobId', (req, res) =>
  jobsController.getJobStatus(req, res)
);
router.get('/jobs/:queueName', (req, res) => jobsController.listJobs(req, res));
router.delete('/jobs/:queueName/:jobId', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.cancelJob(req, res)
);
router.post('/jobs/:queueName/:jobId/retry', authMiddleware.requirePermission('write'), (req, res) =>
  jobsController.retryJob(req, res)
);

// Queue Monitoring Routes
router.get('/queues/stats', (req, res) =>
  queueController.getAllQueueStats(req, res)
);
router.get('/queues/:queueName/stats', (req, res) =>
  queueController.getQueueStats(req, res)
);
router.get('/queues/:queueName/metrics', (req, res) =>
  queueController.getQueueMetrics(req, res)
);
router.get('/queues/workers/status', (req, res) =>
  queueController.getAllWorkerStatus(req, res)
);
router.get('/queues/health', (req, res) =>
  queueController.getQueueHealth(req, res)
);

// Queue control
router.post('/queues/:queueName/pause', authMiddleware.requirePermission('write'), (req, res) =>
  queueController.pauseQueue(req, res)
);
router.post('/queues/:queueName/resume', authMiddleware.requirePermission('write'), (req, res) =>
  queueController.resumeQueue(req, res)
);

// Job logs
router.get('/queues/:queueName/jobs/:jobId/logs', (req, res) =>
  queueController.getJobLogs(req, res)
);

export default router;
