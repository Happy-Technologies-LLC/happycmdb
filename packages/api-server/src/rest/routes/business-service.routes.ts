// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Business Service Routes
 * REST API endpoints for business service management
 */

import { Router } from 'express';
import Joi from 'joi';
import { BusinessServiceController } from '../controllers/business-service.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';

export const businessServiceRoutes = Router();
const controller = new BusinessServiceController();
const authMiddleware = getAuthMiddleware();

// Apply audit middleware to all routes
businessServiceRoutes.use(auditMiddleware);

// Validation schemas
const createBusinessServiceSchema = Joi.object({
  service_id: Joi.string().required().pattern(/^bs-[a-z0-9-]+$/),
  name: Joi.string().required().min(3).max(255),
  description: Joi.string().optional().allow(''),
  service_classification: Joi.string()
    .valid('compute', 'storage', 'network', 'data', 'application', 'security', 'end_user', 'iot', 'blockchain', 'quantum', 'other_it')
    .required(),
  tbm_tower: Joi.string()
    .valid('compute', 'storage', 'network', 'data', 'application', 'security', 'end_user', 'iot', 'blockchain', 'quantum', 'other_it')
    .required(),
  business_criticality: Joi.string()
    .valid('critical', 'high', 'medium', 'low')
    .required(),
  operational_status: Joi.string()
    .valid('active', 'inactive', 'planned', 'retired')
    .default('active'),
  service_type: Joi.string().optional(),
  owned_by: Joi.string().optional(),
  managed_by: Joi.string().optional(),
  support_group: Joi.string().optional(),
  service_level_requirement: Joi.string().optional(),
  category: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  related_ci_types: Joi.array().items(Joi.string()).optional(),
  cost_allocation: Joi.object().optional(),
  metadata: Joi.object().optional()
});

const updateBusinessServiceSchema = Joi.object({
  name: Joi.string().min(3).max(255).optional(),
  description: Joi.string().optional().allow(''),
  service_classification: Joi.string()
    .valid('compute', 'storage', 'network', 'data', 'application', 'security', 'end_user', 'iot', 'blockchain', 'quantum', 'other_it')
    .optional(),
  tbm_tower: Joi.string()
    .valid('compute', 'storage', 'network', 'data', 'application', 'security', 'end_user', 'iot', 'blockchain', 'quantum', 'other_it')
    .optional(),
  business_criticality: Joi.string()
    .valid('critical', 'high', 'medium', 'low')
    .optional(),
  operational_status: Joi.string()
    .valid('active', 'inactive', 'planned', 'retired')
    .optional(),
  service_type: Joi.string().optional(),
  owned_by: Joi.string().optional(),
  managed_by: Joi.string().optional(),
  support_group: Joi.string().optional(),
  service_level_requirement: Joi.string().optional(),
  category: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  related_ci_types: Joi.array().items(Joi.string()).optional(),
  cost_allocation: Joi.object().optional(),
  metadata: Joi.object().optional()
});

const querySchema = Joi.object({
  search: Joi.string().optional(),
  service_classification: Joi.string().optional(),
  tbm_tower: Joi.string().optional(),
  business_criticality: Joi.string().optional(),
  operational_status: Joi.string().optional(),
  owned_by: Joi.string().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(50)
});

const mapCIsSchema = Joi.object({
  ci_ids: Joi.array().items(Joi.string()).min(1).required(),
  mapping_type: Joi.string()
    .valid('hosts', 'supports', 'enables', 'provides')
    .default('supports'),
  confidence_score: Joi.number().min(0).max(1).default(1.0)
});

const createDependencySchema = Joi.object({
  depends_on_service_id: Joi.string().required(),
  dependency_type: Joi.string()
    .valid('technical', 'business', 'data', 'security')
    .default('technical')
});

/**
 * @route   GET /api/v1/business-services
 * @desc    List all business services with optional filtering
 * @access  Private
 */
businessServiceRoutes.get(
  '/',
  validateOptional(querySchema, 'query'),
  controller.listBusinessServices.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id
 * @desc    Get a specific business service by ID
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id',
  controller.getBusinessService.bind(controller)
);

/**
 * @route   POST /api/v1/business-services
 * @desc    Create a new business service
 * @access  Private
 */
businessServiceRoutes.post(
  '/',
  authMiddleware.requirePermission('write'),
  validateRequest(createBusinessServiceSchema, 'body'),
  controller.createBusinessService.bind(controller)
);

/**
 * @route   PATCH /api/v1/business-services/:service_id
 * @desc    Update an existing business service
 * @access  Private
 */
businessServiceRoutes.patch(
  '/:service_id',
  authMiddleware.requirePermission('write'),
  validateRequest(updateBusinessServiceSchema, 'body'),
  controller.updateBusinessService.bind(controller)
);

/**
 * @route   DELETE /api/v1/business-services/:service_id
 * @desc    Delete a business service
 * @access  Private
 */
businessServiceRoutes.delete(
  '/:service_id',
  authMiddleware.requirePermission('write'),
  controller.deleteBusinessService.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id/cis
 * @desc    Get all CIs mapped to a business service
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/cis',
  controller.getMappedCIs.bind(controller)
);

/**
 * @route   POST /api/v1/business-services/:service_id/cis
 * @desc    Map CIs to a business service
 * @access  Private
 */
businessServiceRoutes.post(
  '/:service_id/cis',
  authMiddleware.requirePermission('write'),
  validateRequest(mapCIsSchema, 'body'),
  controller.mapCIsToService.bind(controller)
);

/**
 * @route   DELETE /api/v1/business-services/:service_id/cis/:ci_id
 * @desc    Unmap a CI from a business service
 * @access  Private
 */
businessServiceRoutes.delete(
  '/:service_id/cis/:ci_id',
  authMiddleware.requirePermission('write'),
  controller.unmapCIFromService.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id/dependencies
 * @desc    Get service dependencies
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/dependencies',
  controller.getServiceDependencies.bind(controller)
);

/**
 * @route   POST /api/v1/business-services/:service_id/dependencies
 * @desc    Create a service dependency
 * @access  Private
 */
businessServiceRoutes.post(
  '/:service_id/dependencies',
  authMiddleware.requirePermission('write'),
  validateRequest(createDependencySchema, 'body'),
  controller.createServiceDependency.bind(controller)
);

/**
 * @route   DELETE /api/v1/business-services/:service_id/dependencies/:depends_on_service_id
 * @desc    Delete a service dependency
 * @access  Private
 */
businessServiceRoutes.delete(
  '/:service_id/dependencies/:depends_on_service_id',
  authMiddleware.requirePermission('write'),
  controller.deleteServiceDependency.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id/health
 * @desc    Get service health metrics
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/health',
  controller.getServiceHealth.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id/costs
 * @desc    Get service cost summary
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/costs',
  controller.getServiceCosts.bind(controller)
);
