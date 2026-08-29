// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation Schemas
 * Common Joi schemas for API endpoints
 */

import Joi from 'joi';

const CANONICAL_GCP_TOKEN_URI = 'https://oauth2.googleapis.com/token';

// STS uses the commercial and GovCloud AWS partitions served by amazonaws.com.
// Keeping this explicit prevents untrusted host fragments from reaching URL construction.
const AWS_STS_REGIONS = [
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-6',
  'ap-southeast-7',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-gov-east-1',
  'us-gov-west-1',
  'us-west-1',
  'us-west-2',
] as const;

const awsConnectionCredentialsSchema = Joi.object({
  region: Joi.string().valid(...AWS_STS_REGIONS).optional(),
}).unknown(true);

const gcpConnectionCredentialsSchema = Joi.object()
  .unknown(true)
  .custom((credentials: Record<string, unknown>, helpers: Joi.CustomHelpers) => {
    const rawServiceAccount = credentials.credentials;
    let serviceAccount: unknown = rawServiceAccount;
    if (typeof rawServiceAccount === 'string') {
      try {
        serviceAccount = JSON.parse(rawServiceAccount);
      } catch {
        return credentials;
      }
    }

    if (!serviceAccount || typeof serviceAccount !== 'object') {
      return credentials;
    }

    const tokenUri = (serviceAccount as Record<string, unknown>).token_uri;
    if (tokenUri !== undefined && tokenUri !== CANONICAL_GCP_TOKEN_URI) {
      return helpers.error('any.invalid');
    }

    return credentials;
  })
  .messages({
    'any.invalid': `GCP token_uri must be ${CANONICAL_GCP_TOKEN_URI}`,
  });

/**
 * Authentication Schemas
 */
export const authSchemas = {
  _login: Joi.object({
    username: Joi.string().alphanum().min(3).max(30).required(),
    password: Joi.string().min(8).required(),
  }),

  _refreshToken: Joi.object({
    refreshToken: Joi.string().required(),
  }),

  _generateApiKey: Joi.object({
    name: Joi.string().min(3).max(100).required(),
    expiresInDays: Joi.number().integer().min(1).max(365).optional(),
  }),

  _updateProfile: Joi.object({
    name: Joi.string().min(1).max(255).optional(),
    // Avatar is a data-URL image; server body-parser limit is 10mb
    // (rest/server.ts), so this stays comfortably under that.
    avatar: Joi.string().max(8_000_000).allow('').optional(),
  }).min(1),

  _changePassword: Joi.object({
    currentPassword: Joi.string().min(1).required(),
    newPassword: Joi.string().min(8).required(),
  }),
};

/**
 * Settings Schemas
 * GeneralSettings/NotificationSettings/DiscoverySettings PUT payloads
 * (web-ui/src/components/settings/*). Kept permissive on unknown keys so
 * the frontend's evolving preference field sets don't need a schema
 * change alongside every UI tweak; still typed and bounded on the fields
 * that exist today.
 */
export const settingsSchemas = {
  general: Joi.object({
    language: Joi.string().max(10).optional(),
    timezone: Joi.string().max(64).optional(),
    dateFormat: Joi.string().max(32).optional(),
    defaultPage: Joi.string().max(255).optional(),
  }).unknown(true).min(1),

  notifications: Joi.object({
    emailOnJobFailure: Joi.boolean().optional(),
    emailOnJobSuccess: Joi.boolean().optional(),
    emailOnDiscoveryCompletion: Joi.boolean().optional(),
    inAppNotifications: Joi.boolean().optional(),
    emailDigestFrequency: Joi.string().valid('never', 'daily', 'weekly', 'monthly').optional(),
  }).unknown(true).min(1),

  discoveryProvider: Joi.object({
    credentials: Joi.object().required(),
  }),

  testConnection: Joi.object({
    provider: Joi.string().valid('aws', 'azure', 'gcp', 'ssh').required(),
    credentials: Joi.alternatives()
      .conditional('provider', {
        is: 'aws',
        then: awsConnectionCredentialsSchema,
        otherwise: Joi.alternatives().conditional('provider', {
          is: 'gcp',
          then: gcpConnectionCredentialsSchema,
          otherwise: Joi.object().unknown(true),
        }),
      })
      .required(),
  }),
};

/**
 * CI (Configuration Item) Schemas
 */
export const ciSchemas = {
  _create: Joi.object({
    _type: Joi.string()
      .valid(
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
      )
      .required(),
    _name: Joi.string().min(1).max(255).required(),
    _hostname: Joi.string().max(255).optional(),
    _ipAddress: Joi.string().ip({ version: ['ipv4', 'ipv6'] }).optional(),
    _status: Joi.string().valid('active', 'inactive', 'maintenance', 'decommissioned').optional(),
    _environment: Joi.string().valid('production', 'staging', 'development', 'test').optional(),
    _attributes: Joi.object().optional(),
    _tags: Joi.array().items(Joi.string()).optional(),
  }),

  _update: Joi.object({
    _name: Joi.string().min(1).max(255).optional(),
    _hostname: Joi.string().max(255).optional(),
    _ipAddress: Joi.string().ip({ version: ['ipv4', 'ipv6'] }).optional(),
    _status: Joi.string().valid('active', 'inactive', 'maintenance', 'decommissioned').optional(),
    _environment: Joi.string().valid('production', 'staging', 'development', 'test').optional(),
    _attributes: Joi.object().optional(),
    _tags: Joi.array().items(Joi.string()).optional(),
  }),

  _query: Joi.object({
    _type: Joi.string().optional(),
    _status: Joi.string().optional(),
    _environment: Joi.string().optional(),
    _tags: Joi.array().items(Joi.string()).optional(),
    _limit: Joi.number().integer().min(1).max(1000).default(100),
    _offset: Joi.number().integer().min(0).default(0),
  }),
};

/**
 * Relationship Schemas
 */
export const relationshipSchemas = {
  _create: Joi.object({
    _fromCiId: Joi.string().uuid().required(),
    _toCiId: Joi.string().uuid().required(),
    _type: Joi.string()
      .valid('DEPENDS_ON', 'HOSTS', 'CONNECTS_TO', 'USES', 'OWNED_BY', 'MANAGED_BY')
      .required(),
    _attributes: Joi.object().optional(),
  }),
};

/**
 * Discovery Schemas
 */
export const discoverySchemas = {
  _trigger: Joi.object({
    _provider: Joi.string().valid('aws', 'azure', 'gcp', 'ssh', 'nmap').required(),
    _scope: Joi.object({
      _regions: Joi.array().items(Joi.string()).optional(),
      _resourceGroups: Joi.array().items(Joi.string()).optional(),
      _tags: Joi.object().optional(),
    }).optional(),
  }),

  _schedule: Joi.object({
    _provider: Joi.string().valid('aws', 'azure', 'gcp', 'ssh', 'nmap').required(),
    _schedule: Joi.string().required(), // Cron expression
    _enabled: Joi.boolean().default(true),
  }),
};

/**
 * Common Schemas
 */
export const commonSchemas = {
  _uuid: Joi.string().uuid(),

  _pagination: Joi.object({
    _limit: Joi.number().integer().min(1).max(1000).default(100),
    _offset: Joi.number().integer().min(0).default(0),
  }),

  _dateRange: Joi.object({
    _startDate: Joi.date().iso().required(),
    _endDate: Joi.date().iso().min(Joi.ref('startDate')).required(),
  }),
};

/**
 * Cypher Injection Prevention
 * Validates identifiers and property names to prevent injection
 */
export const cypherSafeIdentifier = Joi.string()
  .pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .message('Invalid identifier: must start with letter or underscore, contain only alphanumeric characters and underscores');

/**
 * SQL Injection Prevention
 * Common patterns for SQL-safe strings
 */
export const sqlSafeString = Joi.string().pattern(
  /^[^;'"\\\x00-\x1f]*$/,
  'SQL-safe string'
);

/**
 * File Path Validation (prevents directory traversal)
 */
export const safePath = Joi.string()
  .pattern(/^[^.\/\\][^\/\\]*$/)
  .message('Invalid path: directory traversal not allowed');

/**
 * Generic sanitized string (no HTML/script tags)
 */
export const sanitizedString = Joi.string()
  .pattern(/^[^<>]*$/)
  .message('Invalid input: HTML tags not allowed');
