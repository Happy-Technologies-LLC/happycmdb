// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { SearchController } from '../controllers/search.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { schemas } from '@cmdb/common';

export const searchRoutes = Router();
const controller = new SearchController();

// Validation schemas
const advancedSearchSchema = Joi.object({
  query: Joi.string().required().min(1),
  type: schemas.ciType.optional(),
  status: schemas.ciStatus.optional(),
  environment: schemas.environment.optional(),
  metadata_filters: Joi.object().optional(),
  limit: Joi.number().integer().min(1).max(1000).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const fulltextSearchSchema = Joi.object({
  query: Joi.string().required().min(1),
  limit: Joi.number().integer().min(1).max(1000).default(50),
});

const relationshipSearchSchema = Joi.object({
  ci_type: schemas.ciType.required(),
  relationship_type: schemas.relationshipType.required(),
  related_ci_type: schemas.ciType.required(),
  limit: Joi.number().integer().min(1).max(1000).default(50),
});

const orphanedQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0),
});

// Advanced search with multiple filters
searchRoutes.post(
  '/advanced',
  validateRequest(advancedSearchSchema, 'body'),
  controller.advancedSearch.bind(controller)
);

// Full-text search using Neo4j full-text index
searchRoutes.post(
  '/fulltext',
  validateRequest(fulltextSearchSchema, 'body'),
  controller.fulltextSearch.bind(controller)
);

// Search by relationship pattern
searchRoutes.post(
  '/relationships',
  validateRequest(relationshipSearchSchema, 'body'),
  controller.searchByRelationship.bind(controller)
);

// Get orphaned CIs (no relationships)
searchRoutes.get(
  '/orphaned',
  validateOptional(orphanedQuerySchema, 'query'),
  controller.getOrphanedCIs.bind(controller)
);
