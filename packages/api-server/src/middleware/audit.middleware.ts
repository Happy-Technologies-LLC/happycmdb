// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response, NextFunction } from 'express';
import { getPostgresClient, getAuditService } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { getNeo4jClient } from '@cmdb/database';
import { optionalRequestOrganizationId } from './auth.middleware';

/**
 * Audit middleware that captures CI changes and logs them to PostgreSQL
 *
 * This middleware:
 * 1. Captures the before-state for UPDATE/DELETE operations
 * 2. Intercepts the response to get the after-state
 * 3. Logs changes to audit_log table
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only audit write operations on CI endpoints
  const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const isCIEndpoint = req.path.includes('/cis');

  if (!isWriteOperation || !isCIEndpoint) {
    return next();
  }

  const ciId = req.params['id'];
  const neo4jClient = getNeo4jClient();
  const postgresClient = getPostgresClient();
  const auditService = getAuditService(postgresClient['pool']);

  // Get actor information from request
  const actor = (req.headers['x-actor'] as string) || 'system';
  const actorType = req.headers['x-actor'] ? 'discovery' : 'system';
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  // Capture before-state for UPDATE and DELETE
  let beforeState: any = null;

  const captureBeforeState = async () => {
    // Before-state is only read within the caller's organization; without an
    // org claim nothing is read (and so nothing of another tenant is logged).
    const organizationId = optionalRequestOrganizationId(req);
    if ((req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') && ciId && organizationId !== null) {
      try {
        beforeState = await neo4jClient.getCI(ciId, organizationId);
      } catch (error) {
        logger.warn('Could not capture before-state for audit', { ciId, error });
      }
    }
  };

  // Intercept response to capture after-state and log audit
  const originalJson = res.json.bind(res);
  res.json = function (data: any) {
    // Don't audit error responses
    if (!data._success) {
      return originalJson(data);
    }

    // Log audit entry asynchronously (don't block response)
    (async () => {
      try {
        const afterState = data._data;

        switch (req.method) {
          case 'POST':
            // CREATE operation
            if (afterState?.id) {
              await auditService.logCICreate(
                afterState.id,
                actor as string,
                actorType as any,
                afterState
              );
              logger.debug('Audit logged: CI created', { ciId: afterState.id });
            }
            break;

          case 'PUT':
          case 'PATCH':
            // UPDATE operation
            if (beforeState && afterState && ciId) {
              await auditService.logCIUpdate(
                ciId,
                actor as string,
                actorType as any,
                beforeState,
                afterState,
                {
                  ip_address: ipAddress,
                  user_agent: userAgent,
                }
              );
              logger.debug('Audit logged: CI updated', { ciId });
            }
            break;

          case 'DELETE':
            // DELETE operation
            if (beforeState && ciId) {
              await auditService.logCIDelete(
                ciId,
                actor as string,
                actorType as any,
                beforeState
              );
              logger.debug('Audit logged: CI deleted', { ciId });
            }
            break;
        }
      } catch (error) {
        // Log error but don't fail the request
        logger.error('Failed to log audit entry', { error, method: req.method, path: req.path });
      }
    })();

    return originalJson(data);
  };

  // Capture before-state before continuing
  captureBeforeState()
    .then(() => next())
    .catch((error) => {
      logger.error('Error in audit middleware', { error });
      next(error);
    });
}

/**
 * Audit middleware for relationship endpoints
 */
export function relationshipAuditMiddleware(req: Request, res: Response, next: NextFunction) {
  const isWriteOperation = ['POST', 'DELETE'].includes(req.method);
  const isRelationshipEndpoint = req.path.includes('/relationships');

  if (!isWriteOperation || !isRelationshipEndpoint) {
    return next();
  }

  const postgresClient = getPostgresClient();
  const auditService = getAuditService(postgresClient['pool']);

  const actor = (req.headers['x-actor'] as string) || 'system';
  const actorType = req.headers['x-actor'] ? 'discovery' : 'system';

  // Intercept response
  const originalJson = res.json.bind(res);
  res.json = function (data: any) {
    if (!data._success) {
      return originalJson(data);
    }

    (async () => {
      try {
        const relationship = data._data || req.body;

        if (req.method === 'POST') {
          await auditService.logRelationshipAdd(
            relationship.from_id || relationship.source_ci_id,
            relationship.to_id || relationship.target_ci_id,
            relationship.type,
            actor as string,
            actorType as any,
            relationship.properties
          );
          logger.debug('Audit logged: Relationship added');
        } else if (req.method === 'DELETE') {
          await auditService.logRelationshipRemove(
            relationship.from_id || relationship.source_ci_id,
            relationship.to_id || relationship.target_ci_id,
            relationship.type,
            actor as string,
            actorType as any,
            relationship.properties
          );
          logger.debug('Audit logged: Relationship removed');
        }
      } catch (error) {
        logger.error('Failed to log relationship audit', { error });
      }
    })();

    return originalJson(data);
  };

  next();
}
