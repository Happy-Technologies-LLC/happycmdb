// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Architecture Optimization REST API Routes
 */

import { Router, Request, Response } from 'express';
import { getArchitectureOptimizationEngine } from '@cmdb/ai-ml-engine';
import { logger } from '@cmdb/common';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { errorLogFields } from '../../utils/log-error';

export const architectureRoutes = Router();
const authMiddleware = getAuthMiddleware();

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
    try {
      const { serviceId } = req.params;

      logger.info('Architecture analysis requested', { service_id: serviceId });

      const engine = getArchitectureOptimizationEngine();
      const analysis = await engine.analyzeBusinessService(serviceId, requestOrganizationId(req));

      if (analysis === null) {
        res.status(404).json({
          success: false,
          error: 'Business service not found',
        });
        return;
      }

      res.json({
        success: true,
        analysis,
      });
    } catch (error) {
      logger.error('Architecture analysis failed', { error: errorLogFields(error), service_id: req.params.serviceId });
      res.status(500).json({
        success: false,
        error: 'Failed to analyze architecture',
      });
    }
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
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { ci_ids } = req.body;

      if (!ci_ids || !Array.isArray(ci_ids) || ci_ids.length === 0) {
        res.status(400).json({
          success: false,
          error: 'ci_ids array is required',
        });
        return;
      }

      logger.info('Architecture analysis requested for CIs', { ci_count: ci_ids.length });

      const engine = getArchitectureOptimizationEngine();
      const analysis = await engine.analyzeArchitecture(ci_ids);

      res.json({
        success: true,
        analysis,
      });
    } catch (error) {
      logger.error('Architecture analysis failed', { error: errorLogFields(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to analyze architecture',
      });
    }
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
