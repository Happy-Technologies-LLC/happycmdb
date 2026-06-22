// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getNeo4jClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import neo4j from 'neo4j-driver';

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

      const session = this.neo4jClient.getSession();
      try {
        // Build dynamic query
        const conditions: string[] = [
          '(ci.name CONTAINS $query OR ci.external_id CONTAINS $query)',
        ];
        const limitNum = Math.min(parseInt(String(limit)), 1000);
        const offsetNum = parseInt(String(offset));
        const params: any = {
          query: query.trim(),
          limit: neo4j.int(limitNum),
          offset: neo4j.int(offsetNum),
        };

        if (type) {
          conditions.push('ci.type = $type');
          params.type = type;
        }

        if (status) {
          conditions.push('ci.status = $status');
          params.status = status;
        }

        if (environment) {
          conditions.push('ci.environment = $environment');
          params.environment = environment;
        }

        // Handle metadata filters
        if (metadata_filters && typeof metadata_filters === 'object') {
          Object.entries(metadata_filters).forEach(([key, value], index) => {
            const paramName = `metaValue${index}`;
            conditions.push(`ci.metadata CONTAINS $${paramName}`);
            params[paramName] = `"${key}":"${value}"`;
          });
        }

        const whereClause = conditions.join(' AND ');

        // Get total count
        const countQuery = `
          MATCH (ci:CI)
          WHERE ${whereClause}
          RETURN count(ci) as total
        `;
        const countResult = await session.run(countQuery, params);
        const total = countResult.records[0]!.get('total').toNumber();

        // Get paginated results
        const searchQuery = `
          MATCH (ci:CI)
          WHERE ${whereClause}
          RETURN ci
          ORDER BY ci.name
          SKIP $offset
          LIMIT $limit
        `;

        const result = await session.run(searchQuery, params);
        const cis = result.records.map((r) => {
          const props = r.get('ci').properties;
          return {
            id: props.id,
            external_id: props.external_id,
            name: props.name,
            type: props.type,
            status: props.status,
            environment: props.environment,
            created_at: props.created_at,
            updated_at: props.updated_at,
            discovered_at: props.discovered_at,
            metadata: props.metadata ? JSON.parse(props.metadata) : {},
          };
        });

        res.json({
          success: true,
          data: cis,
          pagination: {
            total,
            count: cis.length,
            offset: offsetNum,
            limit: limitNum,
          },
          query: query.trim(),
          filters: {
            type,
            status,
            environment,
            metadata_filters,
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error performing advanced search', error);
      res.status(500).json({
        success: false,
        error: 'Failed to perform advanced search',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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

      const limitNum = Math.min(parseInt(String(limit)), 1000);

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          CALL db.index.fulltext.queryNodes('ci_fulltext_search', $query)
          YIELD node, score
          RETURN node, score
          ORDER BY score DESC
          LIMIT $limit
          `,
          { query: query.trim(), limit: neo4j.int(limitNum) }
        );

        const cis = result.records.map((r) => {
          const props = r.get('node').properties;
          return {
            ci: {
              id: props.id,
              external_id: props.external_id,
              name: props.name,
              type: props.type,
              status: props.status,
              environment: props.environment,
              created_at: props.created_at,
              updated_at: props.updated_at,
              discovered_at: props.discovered_at,
              metadata: props.metadata ? JSON.parse(props.metadata) : {},
            },
            score: r.get('score'),
          };
        });

        res.json({
          success: true,
          data: cis,
          count: cis.length,
          query: query.trim(),
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error performing full-text search', error);

      // Check if full-text index doesn't exist
      if (error instanceof Error && error.message.includes('ci_fulltext_search')) {
        res.status(500).json({
          success: false,
          error: 'Full-text index not configured',
          message:
            'The full-text search index "ci_fulltext_search" does not exist. Please run the database initialization script.',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to perform full-text search',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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

      const limitNum = Math.min(parseInt(String(limit)), 1000);

      const session = this.neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (ci:CI {type: $ci_type})-[:${relationship_type}]->(related:CI {type: $related_ci_type})
          RETURN DISTINCT ci
          ORDER BY ci.name
          LIMIT $limit
          `,
          {
            ci_type,
            related_ci_type,
            limit: neo4j.int(limitNum),
          }
        );

        const cis = result.records.map((r) => {
          const props = r.get('ci').properties;
          return {
            id: props.id,
            external_id: props.external_id,
            name: props.name,
            type: props.type,
            status: props.status,
            environment: props.environment,
            created_at: props.created_at,
            updated_at: props.updated_at,
            discovered_at: props.discovered_at,
            metadata: props.metadata ? JSON.parse(props.metadata) : {},
          };
        });

        res.json({
          success: true,
          data: cis,
          count: cis.length,
          pattern: {
            ci_type,
            relationship_type,
            related_ci_type,
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error searching by relationship pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to search by relationship pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get CIs without any relationships (orphaned CIs)
   * GET /search/orphaned
   */
  async getOrphanedCIs(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 100, offset = 0 } = req.query;

      const limitNum = Math.min(parseInt(String(limit)), 1000);
      const offsetNum = parseInt(String(offset));

      const session = this.neo4jClient.getSession();
      try {
        // Get total count
        const countQuery = `
          MATCH (ci:CI)
          WHERE NOT (ci)-[]-()
          RETURN count(ci) as total
        `;
        const countResult = await session.run(countQuery);
        const total = countResult.records[0]!.get('total').toNumber();

        // Get paginated results
        const result = await session.run(
          `
          MATCH (ci:CI)
          WHERE NOT (ci)-[]-()
          RETURN ci
          ORDER BY ci.created_at DESC
          SKIP $offset
          LIMIT $limit
          `,
          { offset: neo4j.int(offsetNum), limit: neo4j.int(limitNum) }
        );

        const cis = result.records.map((r) => {
          const props = r.get('ci').properties;
          return {
            id: props.id,
            external_id: props.external_id,
            name: props.name,
            type: props.type,
            status: props.status,
            environment: props.environment,
            created_at: props.created_at,
            updated_at: props.updated_at,
            discovered_at: props.discovered_at,
            metadata: props.metadata ? JSON.parse(props.metadata) : {},
          };
        });

        res.json({
          success: true,
          data: cis,
          pagination: {
            total,
            count: cis.length,
            offset: offsetNum,
            limit: limitNum,
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting orphaned CIs', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve orphaned CIs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
