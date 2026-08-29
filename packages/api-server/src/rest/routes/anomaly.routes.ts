// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { AnomalyController } from '../controllers/anomaly.controller';
import { validateOptional } from '../middleware/validation.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const anomalyRoutes = Router();
const controller = new AnomalyController();
const authMiddleware = getAuthMiddleware();

// Validation schemas
const recentAnomaliesSchema = Joi.object({
  hours: Joi.number().integer().min(1).max(168).default(24), // Max 1 week
  limit: Joi.number().integer().min(1).max(1000).default(100),
});

const ciAnomaliesSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(500).default(50),
});

const updateStatusSchema = Joi.object({
  status: Joi.string()
    .valid('investigating', 'resolved', 'false_positive', 'confirmed', 'ignored')
    .required(),
  resolved_by: Joi.string().optional(),
});

// Get recent anomalies
// GET /api/v1/anomalies/recent
anomalyRoutes.get(
  '/recent',
  validateOptional(recentAnomaliesSchema, 'query'),
  controller.getRecentAnomalies.bind(controller)
);

// Get anomalies for a specific CI
// GET /api/v1/anomalies/ci/:ciId
anomalyRoutes.get(
  '/ci/:ciId',
  validateOptional(ciAnomaliesSchema, 'query'),
  controller.getAnomaliesForCI.bind(controller)
);

// Get anomaly statistics
// GET /api/v1/anomalies/stats
anomalyRoutes.get('/stats', controller.getAnomalyStats.bind(controller));

// Update anomaly status
// PATCH /api/v1/anomalies/:id/status
anomalyRoutes.patch(
  '/:id/status',
  authMiddleware.requirePermission('write'),
  validateOptional(updateStatusSchema, 'body'),
  controller.updateAnomalyStatus.bind(controller)
);

// Run anomaly detection manually
// POST /api/v1/anomalies/detect
anomalyRoutes.post(
  '/detect',
  authMiddleware.requirePermission('write'),
  controller.runAnomalyDetection.bind(controller)
);
