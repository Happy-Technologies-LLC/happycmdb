// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requestActor, sendJournalError } from '../../journal-http';
import {
  CITraversalLimitError, createCITraversalWork, getNeo4jClient, getPostgresClient, getAuditService,
} from '@cmdb/database';
import { logger, validateCISortField, validateSortDirection } from '@cmdb/common';
import neo4j from 'neo4j-driver';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { literalFulltextQuery } from './literal-fulltext-query';
import {
  assertNoCIGap, CIGapError, CI_GAP_RESPONSE, CIListUnavailableError, readCIList,
  readSingleCI, CI_LIST_UNAVAILABLE_RESPONSE,
} from '../../read-admission';

/**
 * The one 404 for a CI that is missing or belongs to another organization:
 * a constant body (no echoed id), so a caller cannot tell the two apart and
 * cannot probe other tenants' CI ids.
 */
function sendCINotFound(res: Response): void {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: 'CI not found'
  });
}

function sendTraversalFailure(res: Response, error: unknown): boolean {
  if (error instanceof CITraversalLimitError) {
    res.status(503).json({ success: false, error: 'CI traversal resource limit exceeded' });
    return true;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && (code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated'))) {
    res.status(504).json({ success: false, error: 'CI traversal timed out' });
    return true;
  }
  return false;
}

// Helper function to convert Neo4j types to JavaScript types and transform field names
function convertNeo4jTypes(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(convertNeo4jTypes);
  }

  if (typeof obj === 'object') {
    // Check if it's a Neo4j Integer (has low/high properties)
    if (obj.low !== undefined && obj.high !== undefined && Object.keys(obj).length === 2) {
      return neo4j.integer.toNumber(obj);
    }

    // Check if it's a Neo4j DateTime object with year/month/day fields
    if (obj.year !== undefined && obj.month !== undefined && obj.day !== undefined) {
      const year = neo4j.integer.toNumber(obj.year);
      const month = String(neo4j.integer.toNumber(obj.month)).padStart(2, '0');
      const day = String(neo4j.integer.toNumber(obj.day)).padStart(2, '0');
      const hour = obj.hour ? String(neo4j.integer.toNumber(obj.hour)).padStart(2, '0') : '00';
      const minute = obj.minute ? String(neo4j.integer.toNumber(obj.minute)).padStart(2, '0') : '00';
      const second = obj.second ? String(neo4j.integer.toNumber(obj.second)).padStart(2, '0') : '00';
      return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
    }

    // Recursively convert object properties
    const converted: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        // Transform underscore-prefixed fields to remove underscores for frontend
        const newKey = key.startsWith('_') ? key.substring(1) : key;
        converted[newKey] = convertNeo4jTypes(obj[key]);
      }
    }
    return converted;
  }

  return obj;
}

export class CIController {
  private neo4jClient = getNeo4jClient();

  async getAllCIs(req: Request, res: Response): Promise<void> {
    try {
      const {
        type,
        status,
        environment,
        search,
        external_id: externalId,
        sort_by = 'name',
        sort_order = 'asc',
        limit,
        offset,
        page,
        pageSize
      } = req.query;

      const organizationId = requestOrganizationId(req);
      // The organization predicate is unconditional: every filter below only narrows the caller's own CIs.
      let query = 'MATCH (ci:CI) WHERE ci.organization_id = $organizationId';
        const params: Record<string, unknown> = { organizationId };

        // FD17-S4: exact external_id match (validated by the route, never trimmed). A value that is used only by
        // another organization and an unused value both give the same empty page; there is no global lookup.
        if (externalId !== undefined) {
          query += ' AND ci.external_id = $externalId';
          params.externalId = externalId;
        }

        // Apply filters
        if (type) {
          query += ' AND ci.type = $type';
          params.type = type;
        }
        if (status) {
          query += ' AND ci.status = $status';
          params.status = status;
        }
        if (environment) {
          query += ' AND ci.environment = $environment';
          params.environment = environment;
        }

        // Apply search filter
        if (search && typeof search === 'string') {
          query += ' AND (toLower(ci.name) CONTAINS toLower($search) OR toLower(ci.id) CONTAINS toLower($search) OR toLower(ci.external_id) CONTAINS toLower($search))';
          params.search = search;
        }

        // Handle pagination - support page+limit, page+pageSize, or offset+limit
        let finalOffset: number;
        let finalLimit: number;
        let finalPage: number;

        if (page !== undefined) {
          // Page-based pagination (with either limit or pageSize)
          const pageNum = parseInt(page as string, 10) || 1;
          const size = pageSize !== undefined
            ? parseInt(pageSize as string, 10)
            : (limit !== undefined ? parseInt(limit as string, 10) : 10);
          finalOffset = (pageNum - 1) * size;
          finalLimit = Math.min(size, 1000); // Max 1000 records
          finalPage = pageNum;
        } else {
          // Offset-based pagination
          finalOffset = offset !== undefined ? parseInt(offset as string, 10) : 0;
          finalLimit = limit !== undefined ? Math.min(parseInt(limit as string, 10), 1000) : 100;
          finalPage = Math.floor(finalOffset / finalLimit) + 1;
        }

        // Count and page share the same journal snapshot inside readCIList;
        // never collect the complete graph inventory just to return one page.
        const sortField = validateCISortField((sort_by as string) || 'name');
        const sortDirection = validateSortDirection((sort_order as string) || 'asc');
        query += ' AND NOT ci.id IN $pending';
        const { total, cis } = await readCIList(organizationId, async (pending, timeout) => {
          const session = this.neo4jClient.getSession();
          try {
            const queryParams = { ...params, pending, offset: neo4j.int(finalOffset),
              limit: neo4j.int(finalLimit) };
            const expiresAt = Date.now() + timeout;
            const remaining = () => {
              const milliseconds = expiresAt - Date.now();
              if (milliseconds <= 0) throw new CIListUnavailableError();
              return milliseconds;
            };
            const countResult = await session.run(
              `${query} RETURN count(ci) AS total`, queryParams, { timeout: remaining() });
            const pageResult = await session.run(
              `${query} RETURN ci ORDER BY ci.${sortField} ${sortDirection}, ci.id
               SKIP $offset LIMIT $limit`, queryParams, { timeout: remaining() });
            return {
              total: countResult.records[0]!.get('total').toNumber() as number,
              cis: pageResult.records.map(row =>
                convertNeo4jTypes((row.get('ci') as { properties: Record<string, unknown> }).properties)),
            };
          } finally {
            await session.close();
          }
        });
        res.json({
          success: true,
          data: cis,
          pagination: {
            total, count: cis.length, offset: finalOffset, limit: finalLimit,
            page: finalPage, pageSize: finalLimit, totalPages: Math.ceil(total / finalLimit),
          },
        });
    } catch (error) {
      if (error instanceof CIListUnavailableError) {
        res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
        return;
      }
      logger.error('Error getting CIs', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CIs',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getCIById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required'
        });
        return;
      }

      const organizationId = requestOrganizationId(req);
      const owned = await this.neo4jClient.getCI(id, organizationId);
      if (!owned) {
        await assertNoCIGap(organizationId, id);
        sendCINotFound(res);
        return;
      }
      const ci = await readSingleCI(organizationId, id,
        () => this.neo4jClient.getCI(id, organizationId));
      if (!ci) {
        sendCINotFound(res);
        return;
      }
      res.json({ success: true, data: convertNeo4jTypes(ci) });
    } catch (error) {
      if (error instanceof CIGapError) {
        res.status(409).json(CI_GAP_RESPONSE);
        return;
      }
      logger.error('Error getting CI', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CI',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /** REST CI IDs follow the GraphQL contract: globally unique and server assigned. */
  async createCI(req: Request, res: Response): Promise<void> {
    try {
      if (!req.body.name || !req.body.type) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Missing required fields: name, type'
        });
        return;
      }

      // organization_id and both globally unique identifiers are not client-settable.
      const ci = await this.neo4jClient.createCI(
        { ...req.body, id: randomUUID() }, requestOrganizationId(req), requestActor(req));
      res.status(201).json({
        success: true,
        data: convertNeo4jTypes(ci),
        message: 'CI created successfully'
      });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error creating CI', error);
      res.status(500).json({ success: false, error: 'Failed to create CI' });
    }
  }

  async updateCI(req: Request, res: Response): Promise<void> {
    try {
      const ci = await this.neo4jClient.updateCI(
        req.params['id']!, req.body, requestOrganizationId(req), requestActor(req));
      if (!ci) {
        sendCINotFound(res);
        return;
      }
      res.json({
        success: true,
        data: convertNeo4jTypes(ci),
        message: 'CI updated successfully'
      });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error updating CI', error);
      res.status(500).json({ success: false, error: 'Failed to update CI' });
    }
  }

  async deleteCI(req: Request, res: Response): Promise<void> {
    try {
      // Deletes only a CI of the caller's organization; a foreign id deletes nothing.
      if (!(await this.neo4jClient.deleteCI(req.params['id']!, requestOrganizationId(req), requestActor(req)))) {
        sendCINotFound(res);
        return;
      }
      res.status(204).send();
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error deleting CI', error);
      res.status(500).json({ success: false, error: 'Failed to delete CI' });
    }
  }

  async getCIRelationships(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { direction = 'both', depth = 1 } = req.query;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required'
        });
        return;
      }

      // Validate direction parameter
      if (direction && !['in', 'out', 'both'].includes(direction as string)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Direction must be one of: in, out, both'
        });
        return;
      }

      // Validate depth parameter
      const depthNum = parseInt(depth as string);
      if (isNaN(depthNum) || depthNum < 1 || depthNum > 10) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Depth must be a number between 1 and 10'
        });
        return;
      }

      const organizationId = requestOrganizationId(req);

      // Check if CI exists in the caller's organization
      const ci = await this.neo4jClient.getCI(id, organizationId);
      if (!ci) {
        sendCINotFound(res);
        return;
      }

      // Paths through or to another organization's CI are excluded.
      const relationships = await this.neo4jClient.getRelationships(
        id,
        organizationId,
        direction as 'in' | 'out' | 'both',
        depthNum
      );

      // Transform relationships to match frontend expectations
      const transformedRelationships = relationships.map((rel: any) => {
        const sourceCI = convertNeo4jTypes(rel._startCI);
        const targetCI = convertNeo4jTypes(rel._endCI);
        return {
          id: `${rel._startNodeId}-${rel._type}-${rel._endNodeId}`,
          type: rel._type,
          source_ci_id: rel._startNodeId,
          target_ci_id: rel._endNodeId,
          source_ci: sourceCI,
          target_ci: targetCI,
          properties: convertNeo4jTypes(rel._properties),
          created_at: rel._properties?.created_at ? convertNeo4jTypes(rel._properties.created_at) : new Date().toISOString()
        };
      });

      res.json({
        success: true,
        data: transformedRelationships,
        count: transformedRelationships.length,
        depth: depthNum
      });
    } catch (error) {
      if (sendTraversalFailure(res, error)) return;
      logger.error('Error getting relationships', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve relationships',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getCIDependencies(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { depth = 5 } = req.query;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required'
        });
        return;
      }

      const depthNum = parseInt(depth as string);
      if (isNaN(depthNum) || depthNum < 1 || depthNum > 10) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Depth must be a number between 1 and 10'
        });
        return;
      }

      const organizationId = requestOrganizationId(req);

      // Check if CI exists in the caller's organization
      const ci = await this.neo4jClient.getCI(id, organizationId);
      if (!ci) {
        sendCINotFound(res);
        return;
      }

      const dependencies = await this.neo4jClient.getDependencies(id, organizationId, depthNum);

      res.json({
        success: true,
        data: dependencies,
        count: dependencies.length,
        depth: depthNum
      });
    } catch (error) {
      if (sendTraversalFailure(res, error)) return;
      logger.error('Error getting dependencies', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve dependencies',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getImpactAnalysis(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { depth = 5 } = req.query;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required'
        });
        return;
      }

      const depthNum = parseInt(depth as string);
      if (isNaN(depthNum) || depthNum < 1 || depthNum > 10) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Depth must be a number between 1 and 10'
        });
        return;
      }

      const organizationId = requestOrganizationId(req);

      // Check if CI exists in the caller's organization
      const ci = await this.neo4jClient.getCI(id, organizationId);
      if (!ci) {
        sendCINotFound(res);
        return;
      }

      // Both owned traversals share one request work/node budget.
      const work = createCITraversalWork();
      const downstream = await this.neo4jClient.impactAnalysis(id, organizationId, depthNum, work);
      const upstream = await this.neo4jClient.getDependencies(id, organizationId, depthNum, work);

      // Extract unique CIs from downstream
      const downstreamCIs = downstream.map((item: any) => convertNeo4jTypes(item._ci));

      // Extract unique CIs from upstream paths
      const upstreamCIs: any[] = [];
      const seenIds = new Set<string>();

      for (const path of upstream) {
        // Extract all nodes from the path
        const nodes = path.segments || [];
        for (const segment of nodes) {
          const endNode = segment.end;
          if (endNode && endNode.properties) {
            const ciId = endNode.properties.id;
            if (ciId !== id && !seenIds.has(ciId)) {
              seenIds.add(ciId);
              upstreamCIs.push(convertNeo4jTypes(endNode.properties));
            }
          }
        }
      }

      // Calculate impact score based on number of affected CIs
      const totalImpacted = downstreamCIs.length + upstreamCIs.length;
      const impact_score = Math.min(totalImpacted / 10, 1.0); // Normalize to 0-1 scale

      // Get affected environments
      const allCIs = [...downstreamCIs, ...upstreamCIs];
      const affected_environments = Array.from(
        new Set(allCIs.map((ci: any) => ci.environment).filter(Boolean))
      );

      // Construct the impact analysis response
      const impactAnalysis = {
        ci: convertNeo4jTypes(ci),
        upstream: upstreamCIs,
        downstream: downstreamCIs,
        impact_score,
        affected_environments
      };

      res.json({
        success: true,
        data: impactAnalysis,
        totalImpacted: totalImpacted,
        depth: depthNum
      });
    } catch (error) {
      if (sendTraversalFailure(res, error)) return;
      logger.error('Error performing impact analysis', error);
      res.status(500).json({
        success: false,
        error: 'Failed to perform impact analysis',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async searchCIs(req: Request, res: Response): Promise<void> {
    try {
      const { query, limit = 50 } = req.body;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Search query is required and must be a non-empty string'
        });
        return;
      }

      const limitNum = Number(limit);
      if (!Number.isSafeInteger(limitNum) || limitNum < 1 || limitNum > 1000) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Limit must be a number between 1 and 1000'
        });
        return;
      }

      const organizationId = requestOrganizationId(req);
      const { cis, total } = await readCIList(organizationId, async (pending, timeout) => {
        const session = this.neo4jClient.getSession();
        try {
          const params = { query: literalFulltextQuery(query), limit: neo4j.int(limitNum), organizationId, pending };
          const matched = `CALL db.index.fulltext.queryNodes('ci_fulltext_idx', $query)
             YIELD node, score
             WHERE node:CI AND node.organization_id = $organizationId AND NOT node.id IN $pending`;
          const expiresAt = Date.now() + timeout;
          const remaining = () => {
            const milliseconds = expiresAt - Date.now();
            if (milliseconds <= 0) throw new CIListUnavailableError();
            return milliseconds;
          };
          const countResult = await session.run(
            `${matched} RETURN count(node) AS total`, params, { timeout: remaining() });
          const pageResult = await session.run(
            `${matched} RETURN node, score ORDER BY score DESC, node.id LIMIT $limit`,
            params, { timeout: remaining() });
          return {
            total: countResult.records[0]!.get('total').toNumber() as number,
            cis: pageResult.records.map(row => ({
              ci: (row.get('node') as { properties: Record<string, unknown> }).properties,
              score: row.get('score') as number,
            })),
          };
        } finally {
          await session.close();
        }
      });
      res.json({ success: true, data: cis, count: cis.length, total, query: query.trim() });
    } catch (error) {
      if (error instanceof CIListUnavailableError) {
        res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
        return;
      }
      logger.error('Error searching CIs', error);
      res.status(500).json({
        success: false,
        error: 'Failed to search CIs',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async getCIAuditHistory(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { limit = 100 } = req.query;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required'
        });
        return;
      }

      const limitNum = parseInt(limit as string);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Limit must be between 1 and 1000'
        });
        return;
      }

      // Ownership is checked before the org-bound audit query; legacy and
      // foreign rows are excluded by the service even after CI ID recycling.
      const organizationId = requestOrganizationId(req);
      const ci = await this.neo4jClient.getCI(id, organizationId);
      if (!ci) {
        await assertNoCIGap(organizationId, id);
        sendCINotFound(res);
        return;
      }

      const postgresClient = getPostgresClient();
      const auditService = getAuditService(postgresClient['pool']);

      const auditHistory = await readSingleCI(organizationId, id,
        () => auditService.getCIAuditHistory(id, organizationId, limitNum));

      res.json({
        success: true,
        data: auditHistory,
        count: auditHistory.length
      });
    } catch (error) {
      if (error instanceof CIGapError) {
        res.status(409).json(CI_GAP_RESPONSE);
        return;
      }
      logger.error('Error getting CI audit history', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve audit history',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
