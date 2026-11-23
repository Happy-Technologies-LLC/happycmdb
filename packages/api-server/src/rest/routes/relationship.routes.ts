// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { RelationshipController } from '../controllers/relationship.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { journalRequestGuard } from '../../journal-http';
import { relationshipSchema, schemas } from '@cmdb/common';

export const relationshipRoutes = Router();
const controller = new RelationshipController();
const authMiddleware = getAuthMiddleware();
relationshipRoutes.use(authMiddleware.requireOrganization());

// Validation schemas
const listRelationshipsQuerySchema = Joi.object({
  type: schemas.relationshipType.optional(),
  from_id: Joi.string().optional(),
  to_id: Joi.string().optional(),
  ci_id: Joi.string().optional(),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

// GET /relationships/type/:type takes paging only; the list schema's type/from_id/to_id/ci_id mean something else.
const relationshipsByTypeQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

// HAP-2029: one edge's evidence receipts. Registered before any parameterized GET.
const evidenceQuerySchema = Joi.object({
  from_id: Joi.string().min(1).max(255).required(),
  to_id: Joi.string().min(1).max(255).required(),
  type: schemas.relationshipType.required(),
  limit: Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
});
relationshipRoutes.get(
  '/evidence',
  validateRequest(evidenceQuerySchema, 'query'),
  controller.listEvidence.bind(controller)
);

// GET /relationships - List relationships with filtering
relationshipRoutes.get(
  '/',
  validateOptional(listRelationshipsQuerySchema, 'query'),
  controller.listRelationships.bind(controller)
);

// POST /relationships - Create relationship
relationshipRoutes.post(
  '/',
  authMiddleware.requirePermission('write'),
  journalRequestGuard({ relationship: true }),
  validateRequest(relationshipSchema, 'body'),
  controller.createRelationship.bind(controller)
);

// DELETE /relationships/:id - Delete relationship (supports query params too)
relationshipRoutes.delete(
  '/:id?',
  authMiddleware.requirePermission('write'),
  controller.deleteRelationship.bind(controller)
);

// GET /relationships/type/:type - Get relationships by type
relationshipRoutes.get(
  '/type/:type',
  validateOptional(relationshipsByTypeQuerySchema, 'query'),
  controller.getRelationshipsByType.bind(controller)
);
