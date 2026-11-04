// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Business Service Routes
 * REST API endpoints for business service management
 */

import { NextFunction, Request, Response, Router } from 'express';
import Joi from 'joi';
import { BusinessServiceController } from '../controllers/business-service.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware';
import { ROLE_PERMISSIONS } from '../../auth/types';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { journalRequestGuard } from '../../journal-http';
import { C1_LIFECYCLES } from '../../services/business-service-reference';

export const businessServiceRoutes = Router();
const controller = new BusinessServiceController();
const authMiddleware = getAuthMiddleware();

// Apply audit middleware to all routes
businessServiceRoutes.use(auditMiddleware);

// Tenant scoping: every route below reads/writes only the caller's
// organization; a token without an org claim is rejected with 403.
businessServiceRoutes.use(authMiddleware.requireOrganization());

// The tenant always comes from the token. A body naming organization_id is
// rejected (400) rather than silently stripped, so callers learn it is not settable.
const organizationIdForbidden = Joi.any().forbidden();

// HAP-1423: operational_status is exactly the valid_status CHECK (001), so a value the table refuses is a 400, never
// a 500. lifecycle is the C1 vocabulary (043 valid_lifecycle). version is server-managed (If-Match on PATCH).
// owner_principal_id is the identity-provider subject of one accountable human (C1, F14).
const OPERATIONAL_STATUSES = ['active', 'inactive', 'maintenance', 'decommissioned'];
const ownerPrincipalId = Joi.string().trim().min(1).max(255);
const ownerGroup = Joi.string().trim().min(1).max(255);

/*
 * D38 (HAP-1565): owner_principal_id is HIVE's D15 tier-change approver, so only a role holding the `admin` permission
 * (ROLE_PERMISSIONS: the admin role) may set, change or clear it, on create and update alike. Any other writer naming
 * the field, whatever its value, is refused before the handler: nothing written, no audit row. Checked on the body
 * Joi validated, with `in` rather than an own-key test: a raw `"__proto__":{"owner_principal_id":…}` member passes
 * an own-key test and Joi's clone then serves it as an inherited, then own, owner_principal_id.
 * A non-admin create leaves the owner null (never the caller).
 */
const OWNER_PRINCIPAL_ADMIN_ONLY = {
  success: false, error: 'Forbidden', message: 'owner_principal_id can be set or changed only by an admin',
};
function ownerPrincipalAdminOnly(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if ('owner_principal_id' in req.body && !(user && ROLE_PERMISSIONS[user._role]?.includes('admin'))) {
    res.status(403).json(OWNER_PRINCIPAL_ADMIN_ONLY);
    return;
  }
  next();
}

// Validation schemas
const createBusinessServiceSchema = Joi.object({
  service_id: Joi.any().forbidden(),
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
    .valid(...OPERATIONAL_STATUSES)
    .default('active'),
  lifecycle: Joi.string().valid(...C1_LIFECYCLES).default('planned'),
  owner_principal_id: ownerPrincipalId.optional(),
  owner_group: ownerGroup.optional(),
  version: Joi.any().forbidden(),
  service_type: Joi.string().optional(),
  owned_by: Joi.string().optional(),
  managed_by: Joi.string().optional(),
  support_group: Joi.string().optional(),
  service_level_requirement: Joi.string().optional(),
  category: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  related_ci_types: Joi.array().items(Joi.string()).optional(),
  cost_allocation: Joi.object().optional(),
  metadata: Joi.object().optional(),
  organization_id: organizationIdForbidden
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
    .valid(...OPERATIONAL_STATUSES)
    .optional(),
  lifecycle: Joi.string().valid(...C1_LIFECYCLES).optional(),
  owner_principal_id: ownerPrincipalId.allow(null).optional(),
  owner_group: ownerGroup.allow(null).optional(),
  version: Joi.any().forbidden(),
  service_type: Joi.string().optional(),
  owned_by: Joi.string().optional(),
  managed_by: Joi.string().optional(),
  support_group: Joi.string().optional(),
  service_level_requirement: Joi.string().optional(),
  category: Joi.string().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  related_ci_types: Joi.array().items(Joi.string()).optional(),
  cost_allocation: Joi.object().optional(),
  metadata: Joi.object().optional(),
  organization_id: organizationIdForbidden
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
  // ci_id is VARCHAR(100) and UNIQUE(ci_id, service_id, mapping_type): reject
  // ids the upsert would fail on (500) here (400):
  // - NUL: PostgreSQL text cannot hold U+0000.
  // - Unpaired surrogates: UTF-8 encoding replaces each with U+FFFD, so
  //   distinct JS strings could collide in the database. With them rejected
  //   the encoding is injective, and .unique() on the JS strings is
  //   uniqueness of the stored values.
  // - Length: VARCHAR(100) counts characters (code points), not the UTF-16
  //   units Joi's .max() counts.
  ci_ids: Joi.array()
    .items(
      Joi.string()
        .pattern(/^[^\u0000\p{Cs}]+$/u)
        // A code point is 1-2 UTF-16 units: only 101-200 units need counting.
        .custom((value: string, helpers) =>
          value.length > 100 && (value.length > 200 || [...value].length > 100)
            ? helpers.error('string.max', { limit: 100 })
            : value)
        .messages({ 'string.pattern.base': '{{#label}} must not contain NUL characters or unpaired surrogates' })
    )
    .min(1).max(100).unique().required()
    // Stop at the first failing item: validate() runs with abortEarly:false,
    // which would still run .unique() over non-string items, and Joi
    // compares those pairwise (quadratic). Only strings reach .unique() now,
    // and Joi checks strings with a hash lookup.
    .prefs({ abortEarly: true }),
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

/*
 * Portfolio writes (HAP-1423): HAP-443's request-shape rules (journalRequestGuard, on the raw body before Joi strips
 * unknown keys) and actor (requestActor); each accepted write appends one hash-chained audit_log row.
 */

/**
 * @route   POST /api/v1/business-services
 * @desc    Create a new business service
 * @access  Private
 */
businessServiceRoutes.post(
  '/',
  authMiddleware.requirePermission('write'),
  journalRequestGuard(),
  validateRequest(createBusinessServiceSchema, 'body'),
  ownerPrincipalAdminOnly,
  controller.createBusinessService.bind(controller)
);

/**
 * @route   PATCH /api/v1/business-services/:service_id
 * @desc    Update an existing business service; optional If-Match: "<version>"
 * @access  Private
 */
businessServiceRoutes.patch(
  '/:service_id',
  authMiddleware.requirePermission('write'),
  journalRequestGuard(),
  validateRequest(updateBusinessServiceSchema, 'body'),
  ownerPrincipalAdminOnly,
  controller.updateBusinessService.bind(controller)
);

/**
 * @route   DELETE /api/v1/business-services/:service_id
 * @desc    Delete a business service with no CI mappings or dependencies (else 409: retire it)
 * @access  Private
 */
businessServiceRoutes.delete(
  '/:service_id',
  authMiddleware.requirePermission('write'),
  journalRequestGuard(),
  controller.deleteBusinessService.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id/cis
 * @desc    Get all CIs mapped to a business service. 200 {success, data: []}
 *          when the service exists with no mappings; 404
 *          {success: false, error: 'Business service not found'} when it does not.
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
 * @desc    Get service dependencies. 200 {success, data: []} when the service
 *          exists with no dependencies; 404
 *          {success: false, error: 'Business service not found'} when it does not.
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/dependencies',
  controller.getServiceDependencies.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id/context
 * @desc    C1 context read: the bounded dependency and impact subgraph (HAP-1408)
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/context',
  controller.getServiceContext.bind(controller)
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
 * @desc    Get service health metrics. 200 {success, data: {incidents, changes}}
 *          when the service exists (empty metrics are 0 counts / null
 *          averages and ratios); 404
 *          {success: false, error: 'Business service not found'} when it does not.
 *          Input contract: the fact tables hold daily service/date event
 *          counters. incidents_7d/30d and changes_7d/30d sum incident_count /
 *          change_count over rows with utc_today - 7/30 days <= date <=
 *          utc_today, utc_today = (now() AT TIME ZONE 'UTC')::date (independent
 *          of the DB session TimeZone; future-dated rows are excluded);
 *          success_rate_30d = SUM(successful_count) / SUM(change_count) * 100
 *          over that same 30-day window, null when the window has no changes.
 *          avg_mttr_30d = SUM(mttr_minutes * incident_count) / SUM(incident_count)
 *          over in-window rows with a non-null mttr_minutes, null when there
 *          are none; sla_breaches_30d is 0 when the window has no incidents.
 *          Producer mapping, the producer's date attribution and replay
 *          guarantees are not asserted here.
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/health',
  controller.getServiceHealth.bind(controller)
);

/**
 * @route   GET /api/v1/business-services/:service_id/costs
 * @desc    Get service cost summary. 200 {success, data: {ci_count,
 *          total_monthly_cost, cost_by_tower}} when the service exists (no
 *          mappings => ci_count 0, null totals); 404
 *          {success: false, error: 'Business service not found'} when it does not.
 *          A CI mapped under several mapping types is counted and costed once.
 * @access  Private
 */
businessServiceRoutes.get(
  '/:service_id/costs',
  controller.getServiceCosts.bind(controller)
);
