// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { AnalyticsController } from '../controllers/analytics.controller';
import { validateOptional, validateRequest } from '../middleware/validation.middleware';
import { schemas } from '@cmdb/common';

export const analyticsRoutes = Router();
const controller = new AnalyticsController();

// Validation schemas
const dateRangeSchema = Joi.object({
  start_date: schemas.timestamp.optional(),
  end_date: schemas.timestamp.optional(),
});

const timelineSchema = Joi.object({
  interval: Joi.string().valid('hour', 'day', 'week', 'month').default('day'),
  limit: Joi.number().integer().min(1).max(365).default(30),
});

const topConnectedSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(10),
  direction: Joi.string().valid('in', 'out', 'both').default('both'),
});

const changeHistorySchema = Joi.object({
  ci_id: Joi.string().required(),
  limit: Joi.number().integer().min(1).max(1000).default(50),
});

const ciIdParamSchema = Joi.object({
  ciId: Joi.string().min(1).required(),
});

// Dashboard summary statistics
analyticsRoutes.get('/dashboard', controller.getDashboardStats.bind(controller));

// CI counts by type
analyticsRoutes.get('/ci-counts', controller.getCICountsByType.bind(controller));

// CI counts by status
analyticsRoutes.get('/ci-status', controller.getCICountsByStatus.bind(controller));

// CI counts by environment
analyticsRoutes.get('/ci-environments', controller.getCICountsByEnvironment.bind(controller));

// Relationship counts by type
analyticsRoutes.get('/relationship-counts', controller.getRelationshipCounts.bind(controller));

// Discovery statistics
analyticsRoutes.get(
  '/discovery-stats',
  validateOptional(dateRangeSchema, 'query'),
  controller.getDiscoveryStats.bind(controller)
);

// Discovery timeline
analyticsRoutes.get(
  '/discovery-timeline',
  validateOptional(timelineSchema, 'query'),
  controller.getDiscoveryTimeline.bind(controller)
);

// Top connected CIs
analyticsRoutes.get(
  '/top-connected',
  validateOptional(topConnectedSchema, 'query'),
  controller.getTopConnectedCIs.bind(controller)
);

// Dependency depth statistics
analyticsRoutes.get('/dependency-depth', controller.getDependencyDepthStats.bind(controller));

// CI change history
analyticsRoutes.get(
  '/change-history',
  validateOptional(changeHistorySchema, 'query'),
  controller.getChangeHistory.bind(controller)
);

// Relationship type matrix (source type x target type x relationship type)
analyticsRoutes.get('/relationship-matrix', controller.getRelationshipMatrix.bind(controller));

// Global change timeline (bounded date range)
analyticsRoutes.get(
  '/change-timeline',
  validateOptional(dateRangeSchema, 'query'),
  controller.getChangeTimeline.bind(controller)
);

// CI health metrics derived from anomaly detections
analyticsRoutes.get(
  '/health-metrics/:ciId',
  validateRequest(ciIdParamSchema, 'params'),
  validateOptional(dateRangeSchema, 'query'),
  controller.getHealthMetrics.bind(controller)
);
