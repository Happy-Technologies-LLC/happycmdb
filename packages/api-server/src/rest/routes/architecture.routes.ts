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
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { executeBoundedAnalysis } from '../../middleware/analysis-admission';
import { errorLogFields } from '../../utils/log-error';
import { assertNoCIGap, CIGapError, CI_GAP_RESPONSE } from '../../read-admission';

export const architectureRoutes = Router();
const authMiddleware = getAuthMiddleware();
const invalidCIId = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function executeAnalysis(
  req: Request, res: Response, operation: () => Promise<{ status: number; body: unknown }>
): Promise<void> {
  return executeBoundedAnalysis(req, res, async () => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof CIGapError) return { status: 409, body: CI_GAP_RESPONSE };
      throw error;
    }
  }, {
    scope: 'architecture',
    timeoutMs: ARCHITECTURE_REQUEST_TIMEOUT_MS,
    withDeadline: withArchitectureDeadline,
    deadlineError: () => new ArchitectureDeadlineError(),
    failure: architectureFailure,
    internalError: 'Failed to analyze architecture',
  });
}


/**
 * Analyze architecture for a business service of the caller's organization
 * GET /api/v1/architecture/business-services/:serviceId/analysis
 * 403 without an org claim; 404 for an unknown or another organization's service.
 */
architectureRoutes.get(
  '/business-services/:serviceId/analysis',
  authMiddleware.requireOrganization(),
  authMiddleware.requirePermission('write'),
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
  authMiddleware.requireOrganization(),
  authMiddleware.requirePermission('write'),
  async (req: Request, res: Response): Promise<void> => {
    await executeAnalysis(req, res, async () => {
      const { ci_ids } = req.body;
      if (!Array.isArray(ci_ids) || ci_ids.length === 0) {
        return { status: 400, body: { success: false, error: 'ci_ids array is required' } };
      }
      if (!ci_ids.every((id: unknown) => typeof id === 'string' &&
        id.length >= 1 && id.length <= 255 && !invalidCIId.test(id))) {
        return { status: 400, body: { success: false, error: 'ci_ids must contain CI IDs of 1–255 characters' } };
      }
      const ids = [...new Set(ci_ids as string[])];
      if (ids.length > MAX_ARCHITECTURE_ROOTS) {
        return { status: 400, body: { success: false, error: `Too many CI IDs (maximum ${MAX_ARCHITECTURE_ROOTS})` } };
      }
      const organizationId = requestOrganizationId(req);
      for (const id of ids) {
        const ci = await getNeo4jClient().getCI(id, organizationId, architectureRemainingMs());
        architectureRemainingMs();
        if (!ci) {
          await assertNoCIGap(organizationId, id);
          return { status: 404, body: { success: false, error: 'Not Found', message: 'CI not found' } };
        }
      }
      for (const id of ids) await assertNoCIGap(organizationId, id);
      logger.info('Architecture analysis requested for CIs', { ci_count: ids.length });
      const analysis = await getArchitectureOptimizationEngine().analyzeArchitecture(ids, organizationId);
      for (const id of ids) await assertNoCIGap(organizationId, id);
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
  authMiddleware.requireOrganization(),
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
