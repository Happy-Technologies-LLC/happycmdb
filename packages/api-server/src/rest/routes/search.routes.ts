// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import {
  SearchController,
  METADATA_FILTER_MAX_KEYS,
  METADATA_FILTER_MAX_KEY_LENGTH,
  METADATA_FILTER_MAX_VALUE_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
} from '../controllers/search.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { schemas } from '@cmdb/common';
import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { orgReadGate } from '../../middleware/org-read-gate';
import { CI_LIST_UNAVAILABLE_RESPONSE } from '../../read-admission';

export const searchRoutes = Router();
const controller = new SearchController();
searchRoutes.use(getAuthMiddleware().requireOrganization());

// Validation schemas
// Strings, finite numbers and booleans only: each is stored by JSON.stringify as a scalar the needle can match.
const metadataFilterValue = Joi.alternatives().try(
  Joi.string().max(METADATA_FILTER_MAX_VALUE_LENGTH).allow(''),
  Joi.number(),
  Joi.boolean()
);
// validate() strips unknown keys, so an out-of-bounds key must match a forbidden pattern to be refused.
const metadataFiltersSchema = Joi.object()
  .pattern(Joi.string().min(1).max(METADATA_FILTER_MAX_KEY_LENGTH), metadataFilterValue)
  .pattern(Joi.string().allow(''), Joi.forbidden())
  .max(METADATA_FILTER_MAX_KEYS);

const advancedSearchSchema = Joi.object({
  query: Joi.string().required().min(1).max(SEARCH_QUERY_MAX_LENGTH),
  type: schemas.ciType.optional(),
  status: schemas.ciStatus.optional(),
  environment: schemas.environment.optional(),
  metadata_filters: metadataFiltersSchema.optional(),
  limit: Joi.number().integer().min(1).max(1000).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const fulltextSearchSchema = Joi.object({
  query: Joi.string().required().min(1).max(SEARCH_QUERY_MAX_LENGTH),
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
  orgReadGate(503, CI_LIST_UNAVAILABLE_RESPONSE, controller.advancedSearch.bind(controller))
);

// Full-text search using Neo4j full-text index
searchRoutes.post(
  '/fulltext',
  validateRequest(fulltextSearchSchema, 'body'),
  orgReadGate(503, CI_LIST_UNAVAILABLE_RESPONSE, controller.fulltextSearch.bind(controller))
);

// Search by relationship pattern
searchRoutes.post(
  '/relationships',
  validateRequest(relationshipSearchSchema, 'body'),
  orgReadGate(503, CI_LIST_UNAVAILABLE_RESPONSE, controller.searchByRelationship.bind(controller))
);

// Get orphaned CIs (no relationships)
searchRoutes.get(
  '/orphaned',
  validateOptional(orphanedQuerySchema, 'query'),
  orgReadGate(503, CI_LIST_UNAVAILABLE_RESPONSE, controller.getOrphanedCIs.bind(controller))
);
