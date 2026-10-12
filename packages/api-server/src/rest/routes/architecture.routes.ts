// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture Optimization REST API Routes
 */

import { Router, Request, Response } from 'express';
import {
  architectureFailure, architectureRemainingMs, getArchitectureOptimizationEngine,
  MAX_ARCHITECTURE_ROOTS, ARCHITECTURE_REQUEST_TIMEOUT_MS, ArchitectureDeadlineError,
  withArchitectureDeadline,
} from '@cmdb/ai-ml-engine';
import { getNeo4jClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { requestOrganizationId, type AuthenticatedRequest } from '../../middleware/auth.middleware';
import { errorLogFields } from '../../utils/log-error';

export const architectureRoutes = Router();
const authMiddleware = getAuthMiddleware();
const WINDOW_MS = 60_000;
const MAX_LIMITER_KEYS = 2048;
const limits = new Map<string, { start: number; count: number; active: number }>();
const THROTTLED = { success: false, error: 'Architecture analysis rate limit exceeded' };

/** Two independently enforced buckets: no principal can monopolize its tenant. */
async function executeAnalysis(
  req: Request, res: Response, operation: () => Promise<{ status: number; body: unknown }>
): Promise<void> {
  const now = Date.now();
  const org = requestOrganizationId(req);
  const principal = (req as AuthenticatedRequest).user!._userId;
  const keys = [JSON.stringify(['org', org]), JSON.stringify(['user', org, principal])];
  const buckets: Array<{ start: number; count: number; active: number }> = [];
  for (const [index, key] of keys.entries()) {
    let entry = limits.get(key);
    if (!entry) {
      if (limits.size >= MAX_LIMITER_KEYS) {
        for (const [oldKey, old] of limits) {
          if (old.active === 0 && now - old.start >= WINDOW_MS) limits.delete(oldKey);
        }
      }
      if (limits.size >= MAX_LIMITER_KEYS) {
        res.status(429).json(THROTTLED);
        return;
      }
      entry = { start: now, count: 0, active: 0 };
      limits.set(key, entry);
    }
    if (now - entry.start >= WINDOW_MS) {
      entry.start = now;
      entry.count = 0;
    }
    buckets.push(entry);
    if (entry.count >= (index === 0 ? 40 : 10) || entry.active >= (index === 0 ? 2 : 1)) {
      res.status(429).json(THROTTLED);
      return;
    }
  }
  for (const bucket of buckets) {
    bucket.count++;
    bucket.active++;
  }
  const deadline = now + ARCHITECTURE_REQUEST_TIMEOUT_MS;
  const work = withArchitectureDeadline(deadline, operation).finally(() => {
    for (const bucket of buckets) bucket.active--;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ArchitectureDeadlineError()), ARCHITECTURE_REQUEST_TIMEOUT_MS);
    });
    const result = await Promise.race([work, timeout]);
    if (Date.now() >= deadline) throw new ArchitectureDeadlineError();
    res.status(result.status).json(result.body);
  } catch (error) {
    logger.error('Architecture analysis failed', { error: errorLogFields(error) });
    const failure = architectureFailure(error);
    if (failure) res.status(failure.status).json({ success: false, error: failure.message });
    else res.status(500).json({ success: false, error: 'Failed to analyze architecture' });
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Analyze architecture for a business service of the caller's organization
 * GET /api/v1/architecture/business-services/:serviceId/analysis
 * 403 without an org claim; 404 for an unknown or another organization's service.
 */
architectureRoutes.get(
  '/business-services/:serviceId/analysis',
  authMiddleware.requirePermission('write'),
  authMiddleware.requireOrganization(),
  async (req: Request, res: Response): Promise<void> => {
    await executeAnalysis(req, res, async () => {
      const { serviceId } = req.params;
      logger.info('Architecture analysis requested', { service_id: serviceId });
      const analysis = await getArchitectureOptimizationEngine()
        .analyzeBusinessService(serviceId, requestOrganizationId(req));
      if (analysis === null) {
        return { status: 404, body: { success: false, error: 'Business service not found' } };
      }
      return { status: 200, body: { success: true, analysis } };
    });
  }
);

/**
 * Analyze architecture for a specific set of CIs
 * POST /api/v1/architecture/analyze
 * Body: { ci_ids: string[] }
 * Persists analysis output and runs expensive computation, so callers
 * require write permission.
 */
architectureRoutes.post(
  '/analyze',
  authMiddleware.requirePermission('write'),
  authMiddleware.requireOrganization(),
  async (req: Request, res: Response): Promise<void> => {
    await executeAnalysis(req, res, async () => {
      const { ci_ids } = req.body;
      if (!ci_ids || !Array.isArray(ci_ids) || ci_ids.length === 0) {
        return { status: 400, body: { success: false, error: 'ci_ids array is required' } };
      }
      if (ci_ids.length > MAX_ARCHITECTURE_ROOTS) {
        return { status: 400, body: { success: false, error: `Too many CI IDs (maximum ${MAX_ARCHITECTURE_ROOTS})` } };
      }
      const organizationId = requestOrganizationId(req);
      if (!ci_ids.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
        return { status: 400, body: { success: false, error: 'ci_ids must contain CI IDs' } };
      }
      for (const id of ci_ids as string[]) {
        const ci = await getNeo4jClient().getCI(id, organizationId, architectureRemainingMs());
        architectureRemainingMs();
        if (!ci) {
          return { status: 404, body: { success: false, error: 'CI not found' } };
        }
      }
      logger.info('Architecture analysis requested for CIs', { ci_count: ci_ids.length });
      const analysis = await getArchitectureOptimizationEngine().analyzeArchitecture(ci_ids, organizationId);
      return { status: 200, body: { success: true, analysis } };
    });
  }
);

/**
 * Get architecture recommendations summary
 * GET /api/v1/architecture/recommendations
 */
architectureRoutes.get(
  '/recommendations',
  async (req: Request, res: Response): Promise<void> => {
    try {
      // This endpoint would aggregate recommendations across all business services
      // For now, returning a placeholder response
      res.json({
        success: true,
        message: 'Aggregated recommendations endpoint - implementation pending',
        note: 'Use /business-services/:serviceId/analysis for specific service recommendations',
      });
    } catch (error) {
      logger.error('Failed to get recommendations', { error: errorLogFields(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to get recommendations',
      });
    }
  }
);
