// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Pattern Learning Routes
 *
 * Backs the AI Pattern Learning UI: pattern library CRUD/lifecycle,
 * discovery sessions, and cost/learning analytics. Every route requires
 * authentication (server.ts mounts `authMiddleware.authenticate()` on
 * every /api/v1 route before this router). Workflow actors (submit/
 * approve/reject/activate/deactivate) are always derived server-side from
 * req.user - request bodies never carry an actor field. Mutating routes
 * additionally require the 'write' permission (authMiddleware.
 * requirePermission('write')), except approve/activate, which are gated
 * to the 'admin' role (authMiddleware.requireRole('admin')) given the
 * infrastructure execution risk of promoting a pattern into active use.
 * Reads (list/get/usage/history/sessions/analytics) and validate/analyze
 * (which never transition pattern/session status) rely on the central
 * authentication only.
 */

import { Router } from 'express';
import Joi from 'joi';
import { AIPatternController } from '../controllers/ai-pattern.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const aiPatternRoutes = Router();
const controller = new AIPatternController();
const authMiddleware = getAuthMiddleware();

// ============================================================================
// Validation schemas
// ============================================================================

// `status` filters accept either a comma-separated string (`?status=a,b`) or
// a repeated/bracket array param (`?status=a&status=b`, or axios's default
// `?status[]=a&status[]=b` serialization, which Express's extended query
// parser resolves to an array) - never both forms mixed in undefined ways.
const statusFilterSchema = Joi.alternatives().try(Joi.string(), Joi.array().items(Joi.string()));

const listPatternsSchema = Joi.object({
  status: statusFilterSchema.optional(),
  category: Joi.string().optional(),
  isActive: Joi.string().valid('true', 'false').optional(),
  minConfidence: Joi.number().min(0).max(1).optional(),
  minUsage: Joi.number().integer().min(0).optional(),
  search: Joi.string().optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
  offset: Joi.number().integer().min(0).optional(),
});

const submitPatternSchema = Joi.object({
  notes: Joi.string().max(2000).optional(),
});

const approvePatternSchema = Joi.object({
  notes: Joi.string().max(2000).optional(),
});

const rejectPatternSchema = Joi.object({
  reason: Joi.string().max(2000).required(),
});

const deactivatePatternSchema = Joi.object({
  reason: Joi.string().max(2000).optional(),
});

const listSessionsSchema = Joi.object({
  status: statusFilterSchema.optional(),
  aiModel: Joi.string().optional(),
  dateFrom: Joi.string().isoDate().optional(),
  dateTo: Joi.string().isoDate().optional(),
  minCost: Joi.number().min(0).optional(),
  maxCost: Joi.number().min(0).optional(),
  search: Joi.string().optional(),
  // Pattern executions served from the fast path get a synthetic session
  // row purely to satisfy a foreign key (see AIPatternController's
  // PATTERN_MATCHER_SYNTHETIC_MODEL); they're excluded from the session
  // list by default and only included when explicitly requested.
  includeSynthetic: Joi.string().valid('true', 'false').optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
  offset: Joi.number().integer().min(0).optional(),
});

const costAnalyticsSchema = Joi.object({
  dateFrom: Joi.string().isoDate().optional(),
  dateTo: Joi.string().isoDate().optional(),
});

const patternUsageSchema = Joi.object({
  days: Joi.number().integer().min(1).max(365).default(30),
});

// ============================================================================
// Pattern Management Routes
// ============================================================================

// GET /api/v1/ai/patterns
aiPatternRoutes.get(
  '/patterns',
  validateOptional(listPatternsSchema, 'query'),
  controller.listPatterns.bind(controller)
);

// POST /api/v1/ai/patterns/compile (before /:patternId so "compile" is never
// captured as a pattern ID)
aiPatternRoutes.post(
  '/patterns/compile',
  authMiddleware.requirePermission('write'),
  controller.compileAndSubmitPatterns.bind(controller)
);

// GET /api/v1/ai/patterns/:patternId
aiPatternRoutes.get('/patterns/:patternId', controller.getPattern.bind(controller));

// DELETE /api/v1/ai/patterns/:patternId
aiPatternRoutes.delete(
  '/patterns/:patternId',
  authMiddleware.requirePermission('write'),
  controller.deletePattern.bind(controller)
);

// ============================================================================
// Pattern Workflow Routes
// ============================================================================

// POST /api/v1/ai/patterns/:patternId/submit
aiPatternRoutes.post(
  '/patterns/:patternId/submit',
  authMiddleware.requirePermission('write'),
  validateOptional(submitPatternSchema, 'body'),
  controller.submitForReview.bind(controller)
);

// POST /api/v1/ai/patterns/:patternId/approve
aiPatternRoutes.post(
  '/patterns/:patternId/approve',
  authMiddleware.requireRole('admin'),
  validateOptional(approvePatternSchema, 'body'),
  controller.approvePattern.bind(controller)
);

// POST /api/v1/ai/patterns/:patternId/reject
aiPatternRoutes.post(
  '/patterns/:patternId/reject',
  authMiddleware.requirePermission('write'),
  validateRequest(rejectPatternSchema, 'body'),
  controller.rejectPattern.bind(controller)
);

// POST /api/v1/ai/patterns/:patternId/activate
aiPatternRoutes.post(
  '/patterns/:patternId/activate',
  authMiddleware.requireRole('admin'),
  controller.activatePattern.bind(controller)
);

// POST /api/v1/ai/patterns/:patternId/deactivate
aiPatternRoutes.post(
  '/patterns/:patternId/deactivate',
  authMiddleware.requirePermission('write'),
  validateOptional(deactivatePatternSchema, 'body'),
  controller.deactivatePattern.bind(controller)
);

// POST /api/v1/ai/patterns/:patternId/validate
aiPatternRoutes.post('/patterns/:patternId/validate', controller.validatePattern.bind(controller));

// GET /api/v1/ai/patterns/:patternId/usage
aiPatternRoutes.get(
  '/patterns/:patternId/usage',
  validateOptional(patternUsageSchema, 'query'),
  controller.getPatternUsage.bind(controller)
);

// GET /api/v1/ai/patterns/:patternId/history
aiPatternRoutes.get('/patterns/:patternId/history', controller.getPatternHistory.bind(controller));

// ============================================================================
// Discovery Session Routes
// ============================================================================

// GET /api/v1/ai/sessions
aiPatternRoutes.get(
  '/sessions',
  validateOptional(listSessionsSchema, 'query'),
  controller.listSessions.bind(controller)
);

// GET /api/v1/ai/sessions/:sessionId
aiPatternRoutes.get('/sessions/:sessionId', controller.getSession.bind(controller));

// POST /api/v1/ai/sessions/:sessionId/analyze
aiPatternRoutes.post('/sessions/:sessionId/analyze', controller.analyzeSession.bind(controller));

// ============================================================================
// Analytics Routes
// ============================================================================

// GET /api/v1/ai/analytics/cost
aiPatternRoutes.get(
  '/analytics/cost',
  validateOptional(costAnalyticsSchema, 'query'),
  controller.getCostAnalytics.bind(controller)
);

// GET /api/v1/ai/analytics/learning
aiPatternRoutes.get('/analytics/learning', controller.getLearningStats.bind(controller));
