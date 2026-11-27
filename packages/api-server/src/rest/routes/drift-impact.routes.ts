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
import { JournalUnavailableError } from '@cmdb/database';
import { DriftImpactController } from '../controllers/drift-impact.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { executeBoundedAnalysis } from '../../middleware/analysis-admission';
import { orgReadGate } from '../../middleware/org-read-gate';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware';

export const driftRoutes = Router();
export const impactRoutes = Router();
const controller = new DriftImpactController();
const authMiddleware = getAuthMiddleware();

driftRoutes.use(authMiddleware.requireOrganization());
impactRoutes.use(authMiddleware.requireOrganization());

/** Architecture and impact use the same verified-principal admission/deadline runner. */
function executeImpact(
  req: Request, res: Response, operation: () => Promise<{ status: number; body: unknown }>,
  render?: (res: Response, result: { status: number; body: unknown }) => void
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
      if (failure) {
        return { status: failure.status,
          message: failure.status === 504 ? 'Impact analysis timed out' : 'Impact criticality resource limit exceeded' };
      }
      // v16 §5.3: an AP-P′ admission lock timeout is a 503, never a 500.
      return error instanceof JournalUnavailableError ? { status: 503, message: 'CI write temporarily unavailable' } : null;
    },
    internalError: 'Failed to analyze impact',
    ...(render !== undefined ? { render } : {}),
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
  // HAP-850: a timed-out response can precede its analysis work; the gate slot spans that work.
  orgReadGate(429, { success: false, error: 'Impact analysis rate limit exceeded' },
    async (req: Request, res: Response) => {
      let work: Promise<unknown> = Promise.resolve();
      await executeImpact(req, res, () => (work = controller.getDependencyGraphResult(req as AuthenticatedRequest)));
      await work.catch(() => undefined);
    })
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

// ============================================================================
// Ask (HAP-1928, UX-4b BW13)
// ============================================================================

/** The ask endpoint: a happy-ui/v1 JSON Lines answer, composed by rule from read-only impact data. */
export const askRoutes = Router();
askRoutes.use(authMiddleware.requireOrganization());

const askSchema = Joi.object({
  ci_id: Joi.string().required().min(1).max(64),
  // Phase 1 (decision N4 (a)) answers the impact question only; no free text, no LLM.
  question: Joi.string().valid('impact').default('impact'),
  change_type: Joi.string().min(1).max(64),
});

function sendJsonLines(res: Response, result: { status: number; body: unknown }): void {
  if (result.status === 200 && typeof result.body === 'string') {
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' }).send(result.body);
    return;
  }
  res.status(result.status).json(result.body);
}

// Read-only: the prediction is previewed, never stored, so this needs the read access every impact GET needs.
askRoutes.post(
  '/',
  validateRequest(askSchema, 'body'),
  orgReadGate(429, { success: false, error: 'Impact analysis rate limit exceeded' },
    async (req: Request, res: Response) => {
      let work: Promise<unknown> = Promise.resolve();
      await executeImpact(req, res,
        () => (work = controller.askImpactResult(req as AuthenticatedRequest)), sendJsonLines);
      await work.catch(() => undefined);
    })
);
