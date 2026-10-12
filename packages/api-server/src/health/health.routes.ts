// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Health Check Routes
 * Express router configuration for health endpoints
 */

import { Router, type Request, type Response } from 'express';
import { HealthController } from './health.controller';
import { getAuthMiddleware } from '../auth/auth-bootstrap';

const router = Router();
const healthController = new HealthController();
// Aggregate health data is platform-wide; liveness probes remain public.
function refuseGlobalMetrics(_req: Request, res: Response): void {
  res.status(403).json({ success: false, error: 'Global health metrics unavailable' });
}

/**
 * GET / - Comprehensive health check
 * Returns detailed health status of all system components
 * Accessible at: /api/v1/health
 */
router.get('/', (req, res) => healthController.getHealth(req, res));

/**
 * GET /ready - Readiness probe
 * Returns 200 if service is ready to accept traffic
 * Accessible at: /api/v1/health/ready
 */
router.get('/ready', (req, res) => healthController.getReadiness(req, res));

/**
 * GET /alive - Liveness probe
 * Returns 200 if service is alive and running
 * Accessible at: /api/v1/health/alive
 */
router.get('/alive', (req, res) => healthController.getLiveness(req, res));

/**
 * GET /api/v1/cmdb-health/metrics - global aggregates unavailable to tenants.
 * Authenticate even though this router is mounted before the shared auth gate.
 */
router.get('/metrics', getAuthMiddleware().authenticate(), refuseGlobalMetrics);

/**
 * GET /services - Service health status
 * Returns health status of all services
 * Accessible at: /api/v1/health/services
 */
router.get('/services', (req, res) => healthController.getServices(req, res));

/**
 * GET /api/v1/cmdb-health/timeseries - same authenticated global refusal.
 */
router.get('/timeseries', getAuthMiddleware().authenticate(), refuseGlobalMetrics);

export default router;
