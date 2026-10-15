// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs API Routes
 *
 * This module defines all REST API routes for job management and queue
 * monitoring. Authentication is enforced centrally; every route below also
 * requires a freshly verified platform administrator JWT before queue access.
 */

import { Router } from 'express';
import { jobsController } from '../controllers/jobs.controller';
import { queueController } from '../controllers/queue.controller';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import type { Request, Response, NextFunction } from 'express';
import { QUEUE_NAMES } from '@cmdb/common';

const allowedQueues: readonly string[] = Object.values(QUEUE_NAMES);
const INVALID_QUEUE = { success: false, error: 'Invalid queue name' };
const INVALID_PROVIDER = { success: false, error: 'Invalid discovery provider' };

function requireKnownQueue(req: Request, res: Response, next: NextFunction): void {
  if (!allowedQueues.includes(req.params.queueName ?? '')) {
    res.status(400).json(INVALID_QUEUE);
    return;
  }
  next();
}

// AD, SNMP, and AI queue registration enables tenant reads only. Mutations
// require an explicit authorization decision before those queues are enabled.
const readOnlyQueues: readonly string[] = [
  QUEUE_NAMES._DISCOVERY_ACTIVE_DIRECTORY,
  QUEUE_NAMES._DISCOVERY_SNMP,
  QUEUE_NAMES._DISCOVERY_AI,
];
function requireMutableQueue(req: Request, res: Response, next: NextFunction): void {
  if (readOnlyQueues.includes(req.params.queueName ?? '')) {
    res.status(403).json({ success: false, error: 'Queue mutation unavailable' });
    return;
  }
  next();
}

function requireKnownProvider(req: Request, res: Response, next: NextFunction): void {
  if (!['nmap', 'ssh', 'active-directory', 'snmp'].includes(req.params.provider ?? '')) {
    res.status(400).json(INVALID_PROVIDER);
    return;
  }
  next();
}


const router = Router();
const authMiddleware = getAuthMiddleware();
// All job, schedule and queue surfaces expose global Redis state. Only a
// freshly verified platform administrator's JWT may reach their handlers.
router.use(authMiddleware.requirePlatformAdmin());

// Job Management Routes
// IMPORTANT: More specific routes must come BEFORE generic parameterized routes
// to avoid route conflicts (e.g., /jobs/stats vs /jobs/:queueName)

router.get('/jobs/stats', (req, res) => jobsController.getJobStats(req, res));
router.get('/jobs/schedules/discovery', (req, res) => jobsController.getDiscoverySchedules(req, res));
router.get('/jobs/schedules/etl', (req, res) => jobsController.getETLSchedules(req, res));
router.put('/jobs/schedules/discovery/:provider', requireKnownProvider,
  (req, res) => jobsController.updateDiscoverySchedule(req, res));
router.put('/jobs/schedules/etl/:type', (req, res) => jobsController.updateETLSchedule(req, res));

router.get('/jobs/discovery/stats', (req, res) => jobsController.getDiscoveryStats(req, res));
router.get('/jobs/discovery', (req, res) => jobsController.listDiscoveryJobs(req, res));
router.post('/jobs/discovery/:provider', requireKnownProvider,
  (req, res) => jobsController.triggerDiscovery(req, res));
router.post('/jobs/etl/:type', (req, res) => jobsController.triggerETL(req, res));

router.get('/jobs/:queueName/failed', requireKnownQueue,
  (req, res) => jobsController.getFailedJobs(req, res));
router.post('/jobs/:queueName/clean', requireKnownQueue,
  (req, res) => jobsController.cleanQueue(req, res));
router.get('/jobs/:queueName/:jobId', requireKnownQueue,
  (req, res) => jobsController.getJobStatus(req, res));
router.get('/jobs/:queueName', requireKnownQueue,
  (req, res) => jobsController.listJobs(req, res));
router.delete('/jobs/:queueName/:jobId', requireKnownQueue, requireMutableQueue,
  (req, res) => jobsController.cancelJob(req, res));
router.post('/jobs/:queueName/:jobId/retry', requireKnownQueue, requireMutableQueue,
  (req, res) => jobsController.retryJob(req, res));

router.get('/queues/stats', (req, res) => queueController.getAllQueueStats(req, res));
router.get('/queues/:queueName/stats', requireKnownQueue,
  (req, res) => queueController.getQueueStats(req, res));
router.get('/queues/:queueName/metrics', requireKnownQueue,
  (req, res) => queueController.getQueueMetrics(req, res));
router.get('/queues/workers/status', (req, res) => queueController.getAllWorkerStatus(req, res));
router.get('/queues/health', (req, res) => queueController.getQueueHealth(req, res));
router.post('/queues/:queueName/pause', requireKnownQueue,
  (req, res) => queueController.pauseQueue(req, res));
router.post('/queues/:queueName/resume', requireKnownQueue,
  (req, res) => queueController.resumeQueue(req, res));
router.get('/queues/:queueName/jobs/:jobId/logs', requireKnownQueue,
  (req, res) => queueController.getJobLogs(req, res));

export default router;
