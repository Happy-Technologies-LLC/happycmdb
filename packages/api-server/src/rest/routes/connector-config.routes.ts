// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Configuration Routes. Authentication is enforced centrally:
 * server.ts mounts `authMiddleware.authenticate()` on every /api/v1 route
 * before this router. Reads (list/get, resource listing, run history,
 * metrics) stay open to any authenticated role, as does testing an
 * existing configuration's connection (it inspects connectivity without
 * mutating state). Every state-changing route -- create/update/delete a
 * configuration, trigger a run, enable/disable, update enabled resources,
 * and cancel a run -- additionally requires the 'write' permission via
 * `authMiddleware.requirePermission('write')`.
 */

import { Router } from 'express';
import Joi from 'joi';
import { ConnectorConfigController } from '../controllers/connector-config.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const connectorConfigRoutes = Router();
const controller = new ConnectorConfigController();
const authMiddleware = getAuthMiddleware();

// Apply audit middleware to all routes
connectorConfigRoutes.use(auditMiddleware);

// Validation schemas
const createConfigSchema = Joi.object({
  name: Joi.string().required().min(1).max(255),
  description: Joi.string().optional().allow(''),
  connector_type: Joi.string().required().min(1).max(100),
  enabled: Joi.boolean().optional().default(true),
  schedule: Joi.string().optional().allow(''), // Cron expression
  schedule_enabled: Joi.boolean().optional().default(false),
  connection: Joi.object().required(), // Connector-specific connection config
  options: Joi.object().optional().default({}),
  enabled_resources: Joi.array().items(Joi.string()).optional(),
  resource_configs: Joi.object().optional().default({}),
  max_retries: Joi.number().integer().min(0).max(10).optional().default(3),
  retry_delay_seconds: Joi.number().integer().min(0).max(3600).optional().default(300),
  continue_on_error: Joi.boolean().optional().default(false),
  notification_channels: Joi.array().items(Joi.string()).optional().default([]),
  notification_on_success: Joi.boolean().optional().default(false),
  notification_on_failure: Joi.boolean().optional().default(true),
});

const updateConfigSchema = Joi.object({
  name: Joi.string().optional().min(1).max(255),
  description: Joi.string().optional().allow(''),
  enabled: Joi.boolean().optional(),
  schedule: Joi.string().optional().allow(''),
  schedule_enabled: Joi.boolean().optional(),
  connection: Joi.object().optional(),
  options: Joi.object().optional(),
  enabled_resources: Joi.array().items(Joi.string()).optional(),
  resource_configs: Joi.object().optional(),
  max_retries: Joi.number().integer().min(0).max(10).optional(),
  retry_delay_seconds: Joi.number().integer().min(0).max(3600).optional(),
  continue_on_error: Joi.boolean().optional(),
  notification_channels: Joi.array().items(Joi.string()).optional(),
  notification_on_success: Joi.boolean().optional(),
  notification_on_failure: Joi.boolean().optional(),
});

const listConfigsSchema = Joi.object({
  connector_type: Joi.string().optional(),
  enabled: Joi.boolean().optional(),
  schedule_enabled: Joi.boolean().optional(),
  search: Joi.string().optional().min(1),
  sort_by: Joi.string().valid('name', 'created_at', 'updated_at').default('name'),
  sort_order: Joi.string().valid('asc', 'desc').default('asc'),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

const runConfigSchema = Joi.object({
  resource_id: Joi.string().optional(), // Run specific resource only
  triggered_by: Joi.string().optional().default('manual'),
});

const runHistoryQuerySchema = Joi.object({
  config_id: Joi.string().uuid().optional(),
  connector_type: Joi.string().optional(),
  resource_id: Joi.string().optional(),
  status: Joi.string().valid('queued', 'running', 'completed', 'failed', 'cancelled').optional(),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
  sort_by: Joi.string().valid('started_at', 'completed_at', 'duration_ms').default('started_at'),
  sort_order: Joi.string().valid('asc', 'desc').default('desc'),
});

const updateResourcesSchema = Joi.object({
  enabled_resources: Joi.array().items(Joi.string()).required(),
  resource_configs: Joi.object().optional().default({}),
});

// ============================================
// CONNECTOR CONFIGURATIONS
// ============================================

// List all configurations
connectorConfigRoutes.get(
  '/',
  validateOptional(listConfigsSchema, 'query'),
  controller.listConfigurations.bind(controller)
);

// Get configuration details
connectorConfigRoutes.get(
  '/:id',
  controller.getConfiguration.bind(controller)
);

// Create new configuration
connectorConfigRoutes.post(
  '/',
  authMiddleware.requirePermission('write'),
  validateRequest(createConfigSchema, 'body'),
  controller.createConfiguration.bind(controller)
);

// Update configuration
connectorConfigRoutes.put(
  '/:id',
  authMiddleware.requirePermission('write'),
  validateRequest(updateConfigSchema, 'body'),
  controller.updateConfiguration.bind(controller)
);

// Delete configuration
connectorConfigRoutes.delete(
  '/:id',
  authMiddleware.requirePermission('write'),
  controller.deleteConfiguration.bind(controller)
);

// ============================================
// CONFIGURATION OPERATIONS
// ============================================

// Test connection
connectorConfigRoutes.post(
  '/:id/test',
  controller.testConnection.bind(controller)
);

// Trigger manual run
connectorConfigRoutes.post(
  '/:id/run',
  authMiddleware.requirePermission('write'),
  validateOptional(runConfigSchema, 'body'),
  controller.runConnector.bind(controller)
);

// Enable configuration
connectorConfigRoutes.post(
  '/:id/enable',
  authMiddleware.requirePermission('write'),
  controller.enableConfiguration.bind(controller)
);

// Disable configuration
connectorConfigRoutes.post(
  '/:id/disable',
  authMiddleware.requirePermission('write'),
  controller.disableConfiguration.bind(controller)
);

// ============================================
// RESOURCE MANAGEMENT
// ============================================

// List available resources for a configuration
connectorConfigRoutes.get(
  '/:id/resources',
  controller.getAvailableResources.bind(controller)
);

// Update enabled resources
connectorConfigRoutes.put(
  '/:id/resources',
  authMiddleware.requirePermission('write'),
  validateRequest(updateResourcesSchema, 'body'),
  controller.updateEnabledResources.bind(controller)
);

// Get resource-specific configuration
connectorConfigRoutes.get(
  '/:id/resources/:resourceId',
  controller.getResourceConfig.bind(controller)
);

// ============================================
// RUN HISTORY & METRICS
// ============================================

// Get runs for specific configuration
connectorConfigRoutes.get(
  '/:id/runs',
  validateOptional(runHistoryQuerySchema, 'query'),
  controller.getConfigurationRuns.bind(controller)
);

// Get configuration metrics
connectorConfigRoutes.get(
  '/:id/metrics',
  controller.getConfigurationMetrics.bind(controller)
);

// Get resource-specific metrics
connectorConfigRoutes.get(
  '/:id/resources/:resourceId/metrics',
  controller.getResourceMetrics.bind(controller)
);

// ============================================
// GLOBAL RUN HISTORY
// ============================================

// List all runs (global, with filters)
connectorConfigRoutes.get(
  '/runs/all',
  validateOptional(runHistoryQuerySchema, 'query'),
  controller.getAllRuns.bind(controller)
);

// Get specific run details
connectorConfigRoutes.get(
  '/runs/:runId',
  controller.getRunDetails.bind(controller)
);

// Cancel running job
connectorConfigRoutes.post(
  '/runs/:runId/cancel',
  authMiddleware.requirePermission('write'),
  controller.cancelRun.bind(controller)
);
