// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Service offering routes (HAP-1424, PoR S3): the C1 offering read and the UI's offering update, mounted at
 * /api/v1/service-offerings. Listing and creating an offering are nested under its service
 * (business-service.routes.ts: GET|POST /:service_id/offerings). There is no delete: retire is PATCH lifecycle=retired.
 */

import { Router } from 'express';
import Joi from 'joi';
import { ServiceOfferingController } from '../controllers/service-offering.controller';
import { validateRequest } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { journalRequestGuard } from '../../journal-http';
import { C1_LIFECYCLES } from '../../services/business-service-reference';

export const serviceOfferingRoutes = Router();
const controller = new ServiceOfferingController();
const authMiddleware = getAuthMiddleware();

serviceOfferingRoutes.use(auditMiddleware);
// Tenant scoping: the tenant is the token's organization only; a token without one is 403.
serviceOfferingRoutes.use(authMiddleware.requireOrganization());

/*
 * Ids, the tenant and the version are server-managed, so a body naming one is a 400 rather than silently ignored.
 * service_level holds the C1 service-level fields only (unknown members are stripped); no tiers, release records or
 * delivery definitions are stored here.
 */
const serverManaged = Joi.any().forbidden();
const offeringFields = {
  offering_id: serverManaged,
  organization_id: serverManaged,
  tenant_id: serverManaged,
  version: serverManaged,
  name: Joi.string().trim().min(3).max(255),
  description: Joi.string().max(4000).allow(''),
  audience: Joi.string().valid('internal', 'customer'),
  lifecycle: Joi.string().valid(...C1_LIFECYCLES),
  service_level: Joi.object({
    availability_target: Joi.number().min(0).max(100),
    response_target_hours: Joi.number().min(0).max(8760),
    support_hours: Joi.string().trim().min(1).max(100),
  }),
};

export const createServiceOfferingSchema = Joi.object({
  ...offeringFields,
  service_id: serverManaged,
  name: offeringFields.name.required(),
  audience: offeringFields.audience.default('internal'),
  lifecycle: offeringFields.lifecycle.default('planned'),
  service_level: offeringFields.service_level.default({}),
});

/** An offering stays under the service it was created under. */
const updateServiceOfferingSchema = Joi.object({ ...offeringFields, service_id: serverManaged });

/**
 * @route   GET /api/v1/service-offerings/:offering_id
 * @desc    C1 offering read
 * @access  Private
 */
serviceOfferingRoutes.get(
  '/:offering_id',
  controller.getServiceOffering.bind(controller)
);

/**
 * @route   PATCH /api/v1/service-offerings/:offering_id
 * @desc    Update an offering (retire: lifecycle = retired); optional If-Match: "<version>"
 * @access  Private (write)
 */
serviceOfferingRoutes.patch(
  '/:offering_id',
  authMiddleware.requirePermission('write'),
  journalRequestGuard(),
  validateRequest(updateServiceOfferingSchema, 'body'),
  controller.updateServiceOffering.bind(controller)
);
