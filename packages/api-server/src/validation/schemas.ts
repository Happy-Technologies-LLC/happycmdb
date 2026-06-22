// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation Schemas
 * Common Joi schemas for API endpoints
 */

import Joi from 'joi';

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
