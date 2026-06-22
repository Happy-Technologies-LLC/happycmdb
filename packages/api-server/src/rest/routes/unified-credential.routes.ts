// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router } from 'express';
import Joi from 'joi';
import { UnifiedCredentialController } from '../controllers/unified-credential.controller';
import { CredentialSetController } from '../controllers/credential-set.controller';
import { validateRequest, validateOptional } from '../middleware/validation.middleware';
import { auditMiddleware } from '../../middleware/audit.middleware';

export const unifiedCredentialRoutes = Router();
const credentialController = new UnifiedCredentialController();
const credentialSetController = new CredentialSetController();

// Apply audit middleware to all routes
unifiedCredentialRoutes.use(auditMiddleware);

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

/**
 * Auth Protocol validation
 */
const authProtocolSchema = Joi.string().valid(
  'oauth2',
  'api_key',
  'basic',
  'bearer',
  'aws_iam',
  'azure_sp',
  'gcp_sa',
  'ssh_key',
  'ssh_password',
  'certificate',
  'kerberos',
  'snmp_v2c',
  'snmp_v3',
  'winrm'
);

/**
 * Credential Scope validation
 */
const credentialScopeSchema = Joi.string().valid(
  'cloud_provider',
  'ssh',
  'api',
  'network',
  'database',
  'container',
  'universal'
);

/**
 * Credential Affinity schema
 */
const credentialAffinitySchema = Joi.object({
  _networks: Joi.array().items(Joi.string()).optional(),
  _hostname_patterns: Joi.array().items(Joi.string()).optional(),
  _os_types: Joi.array().items(Joi.string()).optional(),
  _device_types: Joi.array().items(Joi.string()).optional(),
  _environments: Joi.array().items(Joi.string()).optional(),
  _cloud_providers: Joi.array().items(Joi.string()).optional(),
  _priority: Joi.number().integer().min(1).max(10).optional(),
});

/**
 * Create Credential schema
 */
const createCredentialSchema = Joi.object({
  name: Joi.string().required().min(1).max(255),
  description: Joi.string().optional().max(1000),
  protocol: authProtocolSchema.required(),
  scope: credentialScopeSchema.required(),
  credentials: Joi.object().required(),
  affinity: credentialAffinitySchema.optional(),
  tags: Joi.array().items(Joi.string()).optional(),
});

/**
 * Update Credential schema
 */
const updateCredentialSchema = Joi.object({
  name: Joi.string().optional().min(1).max(255),
  description: Joi.string().optional().max(1000),
  credentials: Joi.object().optional(),
  affinity: credentialAffinitySchema.optional(),
  tags: Joi.array().items(Joi.string()).optional(),
});

/**
 * Credential Match Context schema
 */
const credentialMatchContextSchema = Joi.object({
  _ip: Joi.string().optional(),
  _hostname: Joi.string().optional(),
  _os_type: Joi.string().optional(),
  _device_type: Joi.string().optional(),
  _environment: Joi.string().optional(),
  _cloud_provider: Joi.string().optional(),
  _required_protocol: authProtocolSchema.optional(),
  _required_scope: credentialScopeSchema.optional(),
});

/**
 * List Credentials Query schema
 */
const listCredentialsQuerySchema = Joi.object({
  _protocol: authProtocolSchema.optional(),
  _scope: credentialScopeSchema.optional(),
  _tags: Joi.string().optional(),
  _created_by: Joi.string().optional(),
  _limit: Joi.number().integer().min(1).max(1000).default(100),
  _offset: Joi.number().integer().min(0).default(0),
});

/**
 * Create Credential Set schema
 */
const createCredentialSetSchema = Joi.object({
  _name: Joi.string().required().min(1).max(255),
  _description: Joi.string().optional().max(1000),
  _credential_ids: Joi.array().items(Joi.string().uuid()).min(1).required(),
  _strategy: Joi.string().valid('sequential', 'parallel', 'adaptive').optional().default('sequential'),
  _stop_on_success: Joi.boolean().optional().default(true),
  _tags: Joi.array().items(Joi.string()).optional(),
});

/**
 * Update Credential Set schema
 */
const updateCredentialSetSchema = Joi.object({
  _name: Joi.string().optional().min(1).max(255),
  _description: Joi.string().optional().max(1000),
  _credential_ids: Joi.array().items(Joi.string().uuid()).min(1).optional(),
  _strategy: Joi.string().valid('sequential', 'parallel', 'adaptive').optional(),
  _stop_on_success: Joi.boolean().optional(),
  _tags: Joi.array().items(Joi.string()).optional(),
});

/**
 * Select Credentials schema
 */
const selectCredentialsSchema = Joi.object({
  _context: credentialMatchContextSchema.optional(),
  _strategy: Joi.string().valid('sequential', 'parallel', 'adaptive').optional(),
});

// =============================================================================
// UNIFIED CREDENTIAL ROUTES
// =============================================================================

/**
 * POST /api/v1/credentials/match - Find best matching credential
 * Must be before /:id routes to avoid route conflicts
 */
unifiedCredentialRoutes.post(
  '/credentials/match',
  validateRequest(credentialMatchContextSchema, 'body'),
  credentialController.match.bind(credentialController)
);

/**
 * POST /api/v1/credentials/rank - Rank all credentials by match
 */
unifiedCredentialRoutes.post(
  '/credentials/rank',
  validateRequest(credentialMatchContextSchema, 'body'),
  credentialController.rank.bind(credentialController)
);

/**
 * GET /api/v1/credentials - List credentials (summaries only)
 */
unifiedCredentialRoutes.get(
  '/credentials',
  validateOptional(listCredentialsQuerySchema, 'query'),
  credentialController.list.bind(credentialController)
);

/**
 * POST /api/v1/credentials - Create credential
 */
unifiedCredentialRoutes.post(
  '/credentials',
  validateRequest(createCredentialSchema, 'body'),
  credentialController.create.bind(credentialController)
);

/**
 * GET /api/v1/credentials/oauth/callback - Handle OAuth provider redirect callback
 * Must be before /:id routes to avoid param capture
 */
unifiedCredentialRoutes.get(
  '/credentials/oauth/callback',
  credentialController.oauthCallback.bind(credentialController)
);

/**
 * GET /api/v1/credentials/:id - Get credential by ID
 */
unifiedCredentialRoutes.get(
  '/credentials/:id',
  credentialController.getById.bind(credentialController)
);

/**
 * PUT /api/v1/credentials/:id - Update credential
 */
unifiedCredentialRoutes.put(
  '/credentials/:id',
  validateRequest(updateCredentialSchema, 'body'),
  credentialController.update.bind(credentialController)
);

/**
 * DELETE /api/v1/credentials/:id - Delete credential
 */
unifiedCredentialRoutes.delete(
  '/credentials/:id',
  credentialController.delete.bind(credentialController)
);

/**
 * POST /api/v1/credentials/:id/validate - Validate credential
 */
unifiedCredentialRoutes.post(
  '/credentials/:id/validate',
  credentialController.validate.bind(credentialController)
);

/**
 * POST /api/v1/credentials/:id/oauth/authorize - Begin OAuth authorization for an oauth2 credential
 */
unifiedCredentialRoutes.post(
  '/credentials/:id/oauth/authorize',
  credentialController.authorize.bind(credentialController)
);

// =============================================================================
// CREDENTIAL SET ROUTES
// =============================================================================

/**
 * GET /api/v1/credential-sets - List all credential sets
 */
unifiedCredentialRoutes.get(
  '/credential-sets',
  credentialSetController.list.bind(credentialSetController)
);

/**
 * POST /api/v1/credential-sets - Create credential set
 */
unifiedCredentialRoutes.post(
  '/credential-sets',
  validateRequest(createCredentialSetSchema, 'body'),
  credentialSetController.create.bind(credentialSetController)
);

/**
 * GET /api/v1/credential-sets/:id - Get credential set by ID
 */
unifiedCredentialRoutes.get(
  '/credential-sets/:id',
  credentialSetController.getById.bind(credentialSetController)
);

/**
 * PUT /api/v1/credential-sets/:id - Update credential set
 */
unifiedCredentialRoutes.put(
  '/credential-sets/:id',
  validateRequest(updateCredentialSetSchema, 'body'),
  credentialSetController.update.bind(credentialSetController)
);

/**
 * DELETE /api/v1/credential-sets/:id - Delete credential set
 */
unifiedCredentialRoutes.delete(
  '/credential-sets/:id',
  credentialSetController.delete.bind(credentialSetController)
);

/**
 * POST /api/v1/credential-sets/:id/select - Select credentials with strategy
 */
unifiedCredentialRoutes.post(
  '/credential-sets/:id/select',
  validateRequest(selectCredentialsSchema, 'body'),
  credentialSetController.select.bind(credentialSetController)
);
