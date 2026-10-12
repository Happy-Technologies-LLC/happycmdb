// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift & Impact Routes
 *
 * REST API routes for Configuration Drift Detection (`/drift`) and
 * Change Impact Prediction (`/impact`). Authentication is enforced
 * centrally: server.ts mounts `authMiddleware.authenticate()` on every
 * /api/v1 route before these routers.
 */

import { Router, Request, Response } from 'express';
import Joi from 'joi';
import {
  ArchitectureDeadlineError, architectureFailure, withArchitectureDeadline,
  ImpactCriticalityLimitError, ARCHITECTURE_REQUEST_TIMEOUT_MS,
} from '@cmdb/ai-ml-engine';
import { DriftImpactController } from '../controllers/drift-impact.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { executeBoundedAnalysis } from '../../middleware/analysis-admission';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware';

export const driftRoutes = Router();
export const impactRoutes = Router();
const controller = new DriftImpactController();
const authMiddleware = getAuthMiddleware();

driftRoutes.use(authMiddleware.requireOrganization());
impactRoutes.use(authMiddleware.requireOrganization());

/** Architecture and impact use the same verified-principal admission/deadline runner. */
function executeImpact(
  req: Request, res: Response, operation: () => Promise<{ status: number; body: unknown }>
): Promise<void> {
  return executeBoundedAnalysis(req, res, operation, {
    scope: 'impact',
    timeoutMs: ARCHITECTURE_REQUEST_TIMEOUT_MS,
    withDeadline: withArchitectureDeadline,
    deadlineError: () => new ArchitectureDeadlineError(),
    failure: error => {
      if (error instanceof ImpactCriticalityLimitError) {
        return { status: 503, message: 'Impact criticality resource limit exceeded' };
      }
      const failure = architectureFailure(error);
      return failure && {
        status: failure.status,
        message: failure.status === 504 ? 'Impact analysis timed out' : 'Impact criticality resource limit exceeded',
      };
    },
    internalError: 'Failed to analyze impact',
  });
}

// Shared validation schemas
const snapshotTypeSchema = Joi.string().valid('configuration', 'performance', 'relationships');

// ============================================================================
// Drift validation schemas
// ============================================================================

const driftHistoryQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(500).default(50),
});

const createBaselineSchema = Joi.object({
  ci_id: Joi.string().required().min(1),
  snapshot_type: snapshotTypeSchema.required(),
});

const approvedBaselineQuerySchema = Joi.object({
  snapshot_type: snapshotTypeSchema.required(),
});

// ============================================================================
// Drift routes
// ============================================================================

// Detect configuration drift for a CI against its approved baseline.
// Persists a new drift-detection record, so this requires 'write'.
driftRoutes.post(
  '/detect/:ciId',
  authMiddleware.requirePermission('write'),
  controller.detectDrift.bind(controller)
);

// Get drift detection history for a CI
driftRoutes.get(
  '/history/:ciId',
  validateOptional(driftHistoryQuerySchema, 'query'),
  controller.getDriftHistory.bind(controller)
);

// Create a baseline snapshot for a CI
driftRoutes.post(
  '/baseline',
  authMiddleware.requirePermission('write'),
  validateRequest(createBaselineSchema, 'body'),
  controller.createBaseline.bind(controller)
);

// Approve a baseline snapshot. Approval establishes the compliance/golden
// configuration state that all future drift detection is compared
// against, so - like AI pattern approval - it is governance-sensitive
// and requires 'admin' rather than plain 'write'.
driftRoutes.post(
  '/baseline/:baselineId/approve',
  authMiddleware.requireRole('admin'),
  controller.approveBaseline.bind(controller)
);

// Get the currently approved baseline for a CI
driftRoutes.get(
  '/baseline/:ciId',
  validateOptional(approvedBaselineQuerySchema, 'query'),
  controller.getApprovedBaseline.bind(controller)
);

// ============================================================================
// Impact validation schemas
// ============================================================================

const predictImpactSchema = Joi.object({
  ci_id: Joi.string().required().min(1),
  change_type: Joi.string().required().min(1),
});

const dependencyGraphQuerySchema = Joi.object({
  max_depth: Joi.number().integer().min(1).max(5).default(3),
});

const impactHistoryQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(20),
});

// ============================================================================
// Impact routes
// ============================================================================

// Predict the impact of a change on a CI. Persists the prediction as
// impact-history, so this requires 'write'.
impactRoutes.post(
  '/predict',
  authMiddleware.requirePermission('write'),
  validateRequest(predictImpactSchema, 'body'),
  (req: Request, res: Response) =>
    executeImpact(req, res, () => controller.predictImpactResult(req as AuthenticatedRequest))
);

// Build a bounded dependency graph rooted at a CI
impactRoutes.get(
  '/graph/:rootCiId',
  validateOptional(dependencyGraphQuerySchema, 'query'),
  (req: Request, res: Response) =>
    executeImpact(req, res, () => controller.getDependencyGraphResult(req as AuthenticatedRequest))
);

// Get the criticality score for a CI
impactRoutes.get('/criticality/:ciId', (req: Request, res: Response) =>
  executeImpact(req, res, () => controller.getCriticalityScoreResult(req as AuthenticatedRequest)));

// Get impact analysis history for a CI
impactRoutes.get(
  '/history/:ciId',
  validateOptional(impactHistoryQuerySchema, 'query'),
  (req: Request, res: Response) =>
    executeImpact(req, res, () => controller.getImpactHistoryResult(req as AuthenticatedRequest))
);
