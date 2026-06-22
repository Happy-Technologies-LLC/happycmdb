// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { RelationshipController } from '../controllers/relationship.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { relationshipSchema, schemas } from '@cmdb/common';

export const relationshipRoutes = Router();
const controller = new RelationshipController();

// Validation schemas
const listRelationshipsQuerySchema = Joi.object({
  type: schemas.relationshipType.optional(),
  from_id: Joi.string().optional(),
  to_id: Joi.string().optional(),
  ci_id: Joi.string().optional(),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

// GET /relationships - List relationships with filtering
relationshipRoutes.get(
  '/',
  validateOptional(listRelationshipsQuerySchema, 'query'),
  controller.listRelationships.bind(controller)
);

// POST /relationships - Create relationship
relationshipRoutes.post(
  '/',
  validateRequest(relationshipSchema, 'body'),
  controller.createRelationship.bind(controller)
);

// DELETE /relationships/:id - Delete relationship (supports query params too)
relationshipRoutes.delete(
  '/:id?',
  controller.deleteRelationship.bind(controller)
);

// GET /relationships/type/:type - Get relationships by type
relationshipRoutes.get(
  '/type/:type',
  controller.getRelationshipsByType.bind(controller)
);
