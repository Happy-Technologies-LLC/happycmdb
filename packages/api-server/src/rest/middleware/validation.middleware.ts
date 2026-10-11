// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Schema } from 'joi';
import { validate, logger } from '@cmdb/common';

/**
 * Validation middleware factory
 * Creates Express middleware that validates request data against a Joi schema
 *
 * @param schema - Joi schema to validate against
 * @param source - Source of data to validate ('body', 'query', 'params')
 * @returns Express middleware function
 */
export function validateRequest(
  schema: Schema,
  source: 'body' | 'query' | 'params' = 'body'
) {
  return (req: any, res: any, next: any): void => {
    const data = req[source];
    const result = validate(schema, data);

    // Joi details can include nested connection values (including credentials).
    if (!result.valid && req.baseUrl.includes('/connector-configs')) {
      logger.warn('Connector request validation failed', { source, path: req.path });
      res.status(400).json({ success: false, error: 'Validation Error' });
      return;
    }
    if (!result.valid) {
      logger.warn('Request validation failed', {
        source,
        _errors: result.details,
        _path: req.path,
      });

      res.status(400).json({
        _success: false,
        _error: 'Validation Error',
        _message: result.error,
        _details: result.details?.map((d: any) => ({
          _field: d.path.join('.'),
          _message: d.message,
          _type: d.type,
        })),
      });
      return;
    }

    // Replace request data with validated and sanitized value
    req[source] = result.value;
    next();
  };
}

/**
 * Validate multiple sources in a single middleware
 *
 * @param validations - Object mapping sources to schemas
 * @returns Express middleware function
 */
export function validateMultiple(validations: {
  body?: Schema;
  query?: Schema;
  params?: Schema;
}) {
  return (req: any, res: any, next: any): void => {
    const errors: any[] = [];

    // Validate each source
    for (const [source, schema] of Object.entries(validations)) {
      if (!schema) continue;

      const data = req[source as keyof Request];
      const result = validate(schema, data);

      if (!result.valid) {
        errors.push({
          source,
          _error: result.error,
          _details: result.details,
        });
      } else {
        // Replace with validated value
        (req as any)[source] = result.value;
      }
    }

    if (errors.length > 0) {
      logger.warn('Request validation failed', {
        errors,
        _path: req.path,
      });

      res.status(400).json({
        _success: false,
        _error: 'Validation Error',
        _message: 'One or more validation errors occurred',
        _errors: errors.map((e) => ({
          _source: e.source,
          _message: e.error,
          _details: e.details?.map((d: any) => ({
            _field: d.path.join('.'),
            _message: d.message,
            _type: d.type,
          })),
        })),
      });
      return;
    }

    next();
  };
}

/**
 * Optional validation middleware
 * Only validates if data is present
 *
 * @param schema - Joi schema to validate against
 * @param source - Source of data to validate
 * @returns Express middleware function
 */
export function validateOptional(
  schema: Schema,
  source: 'body' | 'query' | 'params' = 'body'
) {
  return (req: any, res: any, next: any): void => {
    const data = req[source];

    // Skip validation if no data present
    if (!data || Object.keys(data).length === 0) {
      next();
      return;
    }

    const result = validate(schema, data);
    if (!result.valid && req.baseUrl.includes('/connector-configs')) {
      logger.warn('Connector request validation failed', { source, path: req.path });
      res.status(400).json({ success: false, error: 'Validation Error' });
      return;
    }

    if (!result.valid) {
      logger.warn('Request validation failed', {
        source,
        _errors: result.details,
        _path: req.path,
      });

      res.status(400).json({
        _success: false,
        _error: 'Validation Error',
        _message: result.error,
        _details: result.details?.map((d: any) => ({
          _field: d.path.join('.'),
          _message: d.message,
          _type: d.type,
        })),
      });
      return;
    }

    // Replace request data with validated and sanitized value
    req[source] = result.value;
    next();
  };
}

/**
 * ValidationMiddleware class for compatibility with class-based usage
 * This is an adapter that wraps the function-based validation
 */
export class ValidationMiddleware {
  /**
   * Validate request data against Joi schema
   * @param schema - Joi schema to validate against
   * @param source - Source of data to validate ('body', 'query', 'params')
   * @returns Express middleware function
   */
  validate(schema: Schema, source: 'body' | 'query' | 'params' = 'body') {
    return validateRequest(schema, source);
  }
}
