// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { ConnectorController } from '../controllers/connector.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';

export const connectorRoutes = Router();
const controller = new ConnectorController();

// Apply audit middleware to all routes
connectorRoutes.use(auditMiddleware);

// Validation schemas
const installConnectorSchema = Joi.object({
  connector_type: Joi.string().required().min(1).max(100),
  version: Joi.string().optional().pattern(/^\d+\.\d+\.\d+$/),
  force: Joi.boolean().optional().default(false),
});

const updateConnectorSchema = Joi.object({
  version: Joi.string().optional().pattern(/^\d+\.\d+\.\d+$/),
  force: Joi.boolean().optional().default(false),
});

const registryQuerySchema = Joi.object({
  category: Joi.string().valid('discovery', 'connector').optional(),
  search: Joi.string().optional().min(1),
  tags: Joi.string().optional(), // Comma-separated tags
  verified_only: Joi.boolean().optional().default(false),
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const installedQuerySchema = Joi.object({
  category: Joi.string().valid('discovery', 'connector').optional(),
  enabled: Joi.boolean().optional(),
  search: Joi.string().optional().min(1),
  sort_by: Joi.string().valid('name', 'connector_type', 'installed_at', 'updated_at').default('name'),
  sort_order: Joi.string().valid('asc', 'desc').default('asc'),
});

// ============================================
// CONNECTOR REGISTRY & INSTALLATION
// ============================================

// Browse remote catalog
connectorRoutes.get(
  '/registry',
  validateOptional(registryQuerySchema, 'query'),
  controller.getRegistry.bind(controller)
);

// Search catalog (must precede /registry/:type to avoid being shadowed)
connectorRoutes.get(
  '/registry/search',
  validateRequest(
    Joi.object({
      q: Joi.string().required().min(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
    }),
    'query'
  ),
  controller.searchRegistry.bind(controller)
);

// Get connector details from catalog
connectorRoutes.get(
  '/registry/:type',
  controller.getRegistryDetails.bind(controller)
);

// List installed connectors
connectorRoutes.get(
  '/installed',
  validateOptional(installedQuerySchema, 'query'),
  controller.getInstalledConnectors.bind(controller)
);

// Get installed connector details
connectorRoutes.get(
  '/installed/:type',
  controller.getInstalledConnectorDetails.bind(controller)
);

// Install connector from registry
connectorRoutes.post(
  '/install',
  validateRequest(installConnectorSchema, 'body'),
  controller.installConnector.bind(controller)
);

// Update connector to specific version
connectorRoutes.put(
  '/:type/update',
  validateRequest(updateConnectorSchema, 'body'),
  controller.updateConnector.bind(controller)
);

// Uninstall connector
connectorRoutes.delete(
  '/:type',
  controller.uninstallConnector.bind(controller)
);

// Verify connector installation
connectorRoutes.post(
  '/:type/verify',
  controller.verifyConnector.bind(controller)
);

// Refresh registry cache
connectorRoutes.post(
  '/cache/refresh',
  controller.refreshRegistryCache.bind(controller)
);

// Check for connector updates
connectorRoutes.get(
  '/outdated',
  controller.checkOutdatedConnectors.bind(controller)
);
