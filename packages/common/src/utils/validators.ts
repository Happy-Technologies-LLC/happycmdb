// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation Utilities
 *
 * Centralized validation schemas and utilities using Joi.
 * Provides reusable validation schemas for common data types
 * used across the CMDB platform.
 */

import Joi from 'joi';

/**
 * Validation result
 */
export interface ValidationResult<T = any> {
  /** Whether validation passed */
  valid: boolean;
  /** Validated and sanitized value (if valid) */
  value?: T;
  /** Validation error (if invalid) */
  error?: string;
  /** Detailed error information */
  details?: any;
}

/**
 * Validate data against a Joi schema
 *
 * @param schema - Joi schema to validate against
 * @param data - Data to validate
 * @returns Validation result
 */
export function validate<T>(schema: Joi.Schema, data: any): ValidationResult<T> {
  const result = schema.validate(data, { abortEarly: false, stripUnknown: true });

  if (result.error) {
    return {
      valid: false,
      error: result.error.message,
      details: result.error.details,
    };
  }

  return {
    valid: true,
    value: result.value,
  };
}

/**
 * Common validation schemas
 */
export const schemas = {
  /** UUID validation */
  uuid: Joi.string().uuid(),

  /** ISO timestamp validation */
  timestamp: Joi.string().isoDate(),

  /** CI Type validation */
  ciType: Joi.string().valid(
    'server',
    'virtual-machine',
    'container',
    'application',
    'service',
    'database',
    'network-device',
    'storage',
    'load-balancer',
    'cloud-resource'
  ),

  /** CI Status validation */
  ciStatus: Joi.string().valid('active', 'inactive', 'maintenance', 'decommissioned'),

  /** Environment validation */
  environment: Joi.string().valid('production', 'staging', 'development', 'test'),

  /** Relationship Type validation */
  relationshipType: Joi.string().valid(
    'DEPENDS_ON',
    'HOSTS',
    'CONNECTS_TO',
    'USES',
    'OWNED_BY',
    'PART_OF',
    'DEPLOYED_ON',
    'BACKED_UP_BY'
  ),

  /** Discovery Provider validation */
  discoveryProvider: Joi.string().valid('aws', 'azure', 'gcp', 'ssh', 'nmap', 'kubernetes', 'docker'),

  /** Discovery Method validation */
  discoveryMethod: Joi.string().valid('agentless', 'agent'),

  /** Job Status validation */
  jobStatus: Joi.string().valid('pending', 'running', 'completed', 'failed'),
};

/**
 * CI validation schema
 */
export const ciSchema = Joi.object({
  id: Joi.string().required(),
  external_id: Joi.string().optional(),
  name: Joi.string().required().min(1).max(500),
  type: schemas.ciType.required(),
  status: schemas.ciStatus.required(),
  environment: schemas.environment.optional(),
  created_at: schemas.timestamp.required(),
  updated_at: schemas.timestamp.required(),
  discovered_at: schemas.timestamp.required(),
  metadata: Joi.object().optional().default({}),
});

/**
 * CI Input validation schema
 */
export const ciInputSchema = Joi.object({
  id: Joi.string().required(),
  external_id: Joi.string().optional(),
  name: Joi.string().required().min(1).max(500),
  type: schemas.ciType.required(),
  status: schemas.ciStatus.optional().default('active'),
  environment: schemas.environment.optional(),
  discovered_at: schemas.timestamp.optional(),
  metadata: Joi.object().optional().default({}),
});

/**
 * CI update validation schema (REST PUT /cis/:id and GraphQL updateCI)
 */
export const ciUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(500).optional(),
  type: schemas.ciType.optional(),
  status: schemas.ciStatus.optional(),
  environment: schemas.environment.optional(),
  metadata: Joi.object().optional(),
});

/**
 * Relationship validation schema
 */
export const relationshipSchema = Joi.object({
  from_id: Joi.string().required(),
  to_id: Joi.string().required(),
  type: schemas.relationshipType.required(),
  properties: Joi.object().optional().default({}),
});

/**
 * Discovery Job validation schema
 */
export const discoveryJobSchema = Joi.object({
  id: Joi.string().required(),
  provider: schemas.discoveryProvider.required(),
  method: schemas.discoveryMethod.required(),
  config: Joi.object({
    credentials: Joi.any().optional(),
    regions: Joi.array().items(Joi.string()).optional(),
    filters: Joi.object().optional(),
    targets: Joi.array().items(Joi.string()).optional(),
  }).required(),
  status: schemas.jobStatus.required(),
  created_at: schemas.timestamp.required(),
  started_at: schemas.timestamp.optional(),
  completed_at: schemas.timestamp.optional(),
  error: Joi.string().optional(),
});

/**
 * Discovered CI validation schema
 */
export const discoveredCISchema = ciInputSchema.keys({
  discovery_job_id: Joi.string().required(),
  discovery_provider: schemas.discoveryProvider.required(),
  confidence_score: Joi.number().min(0).max(1).required(),
});

/**
 * Pagination parameters validation schema
 */
export const paginationSchema = Joi.object({
  // Offset-based pagination
  limit: Joi.number().integer().min(1).max(1000).optional(),
  offset: Joi.number().integer().min(0).optional(),
  // Page-based pagination
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(1000).optional(),
  // Sorting
  sort_by: Joi.string().optional(),
  sort_order: Joi.string().valid('asc', 'desc').optional(),
});

/**
 * Query filters validation schema
 */
export const queryFiltersSchema = Joi.object({
  type: schemas.ciType.optional(),
  status: schemas.ciStatus.optional(),
  environment: schemas.environment.optional(),
  search: Joi.string().optional(),
}).concat(paginationSchema);

/**
 * Validator helper functions
 */
export const validators = {
  /**
   * Validate CI data
   */
  validateCI: (data: any) => validate(ciSchema, data),

  /**
   * Validate CI input data
   */
  validateCIInput: (data: any) => validate(ciInputSchema, data),

  /**
   * Validate relationship data
   */
  validateRelationship: (data: any) => validate(relationshipSchema, data),

  /**
   * Validate discovery job data
   */
  validateDiscoveryJob: (data: any) => validate(discoveryJobSchema, data),

  /**
   * Validate discovered CI data
   */
  validateDiscoveredCI: (data: any) => validate(discoveredCISchema, data),

  /**
   * Validate pagination parameters
   */
  validatePagination: (data: any) => validate(paginationSchema, data),

  /**
   * Validate query filters
   */
  validateQueryFilters: (data: any) => validate(queryFiltersSchema, data),
};

export default validators;
