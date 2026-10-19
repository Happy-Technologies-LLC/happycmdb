// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getNeo4jClient } from '@cmdb/database';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import { logger } from '@cmdb/common';
import neo4j from 'neo4j-driver';
import { literalFulltextQuery } from './literal-fulltext-query';
import { readCIList, CIListUnavailableError, CI_LIST_UNAVAILABLE_RESPONSE } from '../../read-admission';

export class SearchController {
  private neo4jClient = getNeo4jClient();

  /**
   * Advanced search with multiple filters
   * POST /search/advanced
   */
  async advancedSearch(req: Request, res: Response): Promise<void> {
    try {
      const {
        query,
        type,
        status,
        environment,
        metadata_filters,
        limit = 50,
        offset = 0,
      } = req.body;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Search query is required and must be a non-empty string',
        });
        return;
      }

      const organizationId = requestOrganizationId(req);
      const limitNum = Number(limit);
      const offsetNum = Number(offset);
      const { cis, total } = await readCIList(organizationId, async (pending, timeout) => {
        const session = this.neo4jClient.getSession();
        try {
          const conditions: string[] = [
            'ci.organization_id = $organizationId',
            'NOT ci.id IN $pending',
            '(ci.name CONTAINS $query OR ci.external_id CONTAINS $query)',
          ];
          const params: Record<string, unknown> = {
            query: query.trim(), organizationId, pending,
            limit: neo4j.int(limitNum), offset: neo4j.int(offsetNum),
          };
          if (type) { conditions.push('ci.type = $type'); params.type = type; }
          if (status) { conditions.push('ci.status = $status'); params.status = status; }
          if (environment) { conditions.push('ci.environment = $environment'); params.environment = environment; }
          if (metadata_filters && typeof metadata_filters === 'object') {
            Object.entries(metadata_filters).forEach(([key, value], index) => {
              const paramName = `metaValue${index}`;
              conditions.push(`ci.metadata CONTAINS $${paramName}`);
              params[paramName] = `"${key}":"${value}"`;
            });
          }
          const whereClause = conditions.join(' AND ');
          const countResult = await session.run(
            `MATCH (ci:CI) WHERE ${whereClause} RETURN count(ci) AS total`,
            params, { timeout });
          const total = countResult.records[0]!.get('total').toNumber() as number;
          const result = await session.run(
            `MATCH (ci:CI) WHERE ${whereClause}
             RETURN ci ORDER BY ci.name, ci.id SKIP $offset LIMIT $limit`,
            params, { timeout });
          const cis = result.records.map(r => {
            const props = r.get('ci').properties;
            return {
              id: props.id, external_id: props.external_id, name: props.name,
              type: props.type, status: props.status, environment: props.environment,
              created_at: props.created_at, updated_at: props.updated_at,
              discovered_at: props.discovered_at,
              metadata: props.metadata ? JSON.parse(props.metadata) : {},
            };
          });
          return { cis, total };
        } finally {
          await session.close();
        }
      });
      res.json({
        success: true, data: cis,
        pagination: { total, count: cis.length, offset: offsetNum, limit: limitNum },
        query: query.trim(),
        filters: { type, status, environment, metadata_filters },
      });
    } catch (error) {
      if (error instanceof CIListUnavailableError) {
        res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
        return;
      }
      logger.error('Error performing advanced search');
      res.status(500).json({ success: false, error: 'Failed to perform advanced search' });
    }
  }

  /**
   * Full-text search using Neo4j full-text index
   * POST /search/fulltext
   */
  async fulltextSearch(req: Request, res: Response): Promise<void> {
    try {
      const { query, limit = 50 } = req.body;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Search query is required and must be a non-empty string',
        });
        return;
      }

      const limitNum = Number(limit);
      if (!Number.isSafeInteger(limitNum) || limitNum < 1 || limitNum > 1000) {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'Limit must be between 1 and 1000' });
        return;
      }

      const organizationId = requestOrganizationId(req);
      const { cis, total } = await readCIList(organizationId, async (pending, timeout) => {
        const session = this.neo4jClient.getSession();
        try {
          const params = { query: literalFulltextQuery(query), organizationId, pending, limit: neo4j.int(limitNum) };
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
          return { total: countResult.records[0]!.get('total').toNumber() as number,
            cis: pageResult.records.map(row => {
              const props = (row.get('node') as { properties: Record<string, unknown> }).properties;
              return { ci: {
                id: props['id'], external_id: props['external_id'], name: props['name'], type: props['type'],
                status: props['status'], environment: props['environment'],
                created_at: props['created_at'], updated_at: props['updated_at'],
                discovered_at: props['discovered_at'],
                metadata: typeof props['metadata'] === 'string' ? JSON.parse(props['metadata']) : {},
              }, score: row.get('score') as number };
            }) };
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
      logger.error('Error performing full-text search');

      // Check if full-text index doesn't exist
      if (error instanceof Error && error.message.includes('ci_fulltext_idx')) {
        res.status(500).json({
          success: false,
          error: 'Full-text index not configured',
          message:
            'The full-text search index "ci_fulltext_idx" does not exist. Please run the database initialization script.',
        });
        return;
      }

      res.status(500).json({ success: false, error: 'Failed to perform full-text search' });
    }
  }

  /**
   * Search by relationship pattern
   * POST /search/relationships
   */
  async searchByRelationship(req: Request, res: Response): Promise<void> {
    try {
      const { ci_type, relationship_type, related_ci_type, limit = 50 } = req.body;

      if (!ci_type || !relationship_type || !related_ci_type) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Missing required fields: ci_type, relationship_type, related_ci_type',
        });
        return;
      }

      const limitNum = Number(limit);
      const organizationId = requestOrganizationId(req);
      const cis = await readCIList(organizationId, async (pending, timeout) => {
        const session = this.neo4jClient.getSession();
        try {
          const result = await session.run(
            `MATCH (ci:CI {type: $ci_type})-[:${relationship_type}]->(related:CI {type: $related_ci_type})
             WHERE ci.organization_id = $organizationId AND related.organization_id = $organizationId
               AND NOT ci.id IN $pending AND NOT related.id IN $pending
             RETURN DISTINCT ci ORDER BY ci.name, ci.id LIMIT $limit`,
            { ci_type, related_ci_type, organizationId, pending, limit: neo4j.int(limitNum) },
            { timeout });
          return result.records.map(r => {
            const props = r.get('ci').properties;
            return {
              id: props.id, external_id: props.external_id, name: props.name,
              type: props.type, status: props.status, environment: props.environment,
              created_at: props.created_at, updated_at: props.updated_at,
              discovered_at: props.discovered_at,
              metadata: props.metadata ? JSON.parse(props.metadata) : {},
            };
          });
        } finally {
          await session.close();
        }
      });
      res.json({
        success: true, data: cis, count: cis.length,
        pattern: { ci_type, relationship_type, related_ci_type },
      });
    } catch (error) {
      if (error instanceof CIListUnavailableError) {
        res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
        return;
      }
      logger.error('Error searching by relationship pattern');
      res.status(500).json({ success: false, error: 'Failed to search by relationship pattern' });
    }
  }

  /**
   * Get CIs without any relationships (orphaned CIs)
   * GET /search/orphaned
   */
  async getOrphanedCIs(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 100, offset = 0 } = req.query;

      const limitNum = Number(limit);
      const offsetNum = Number(offset);
      const organizationId = requestOrganizationId(req);
      const { cis, total } = await readCIList(organizationId, async (pending, timeout) => {
        const session = this.neo4jClient.getSession();
        try {
          const params = { organizationId, pending, offset: neo4j.int(offsetNum), limit: neo4j.int(limitNum) };
          const where = `ci.organization_id = $organizationId AND NOT ci.id IN $pending
            AND NOT EXISTS {
              MATCH (ci)-[]-(related)
              WHERE related.organization_id = $organizationId
                AND (NOT related:CI OR NOT related.id IN $pending)
            }`;
          const countResult = await session.run(
            `MATCH (ci:CI) WHERE ${where} RETURN count(ci) AS total`,
            params, { timeout });
          const total = countResult.records[0]!.get('total').toNumber() as number;
          const result = await session.run(
            `MATCH (ci:CI) WHERE ${where}
             RETURN ci ORDER BY ci.created_at DESC, ci.id SKIP $offset LIMIT $limit`,
            params, { timeout });
          const cis = result.records.map(r => {
            const props = r.get('ci').properties;
            return {
              id: props.id, external_id: props.external_id, name: props.name,
              type: props.type, status: props.status, environment: props.environment,
              created_at: props.created_at, updated_at: props.updated_at,
              discovered_at: props.discovered_at,
              metadata: props.metadata ? JSON.parse(props.metadata) : {},
            };
          });
          return { cis, total };
        } finally {
          await session.close();
        }
      });
      res.json({
        success: true, data: cis,
        pagination: { total, count: cis.length, offset: offsetNum, limit: limitNum },
      });
    } catch (error) {
      if (error instanceof CIListUnavailableError) {
        res.status(503).json(CI_LIST_UNAVAILABLE_RESPONSE);
        return;
      }
      logger.error('Error getting orphaned CIs');
      res.status(500).json({ success: false, error: 'Failed to retrieve orphaned CIs' });
    }
  }
}
