// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getNeo4jClient } from '@cmdb/database';
import { logger, RelationshipType } from '@cmdb/common';
import neo4j from 'neo4j-driver';

export class RelationshipController {
  private neo4jClient = getNeo4jClient();

  /**
   * List relationships with filtering
   * GET /relationships
   */
  async listRelationships(req: Request, res: Response): Promise<void> {
    try {
      const {
        type,
        from_id,
        to_id,
        ci_id,
        limit = 100,
        offset = 0,
      } = req.query;

      const session = this.neo4jClient.getSession();
      try {
        let query = 'MATCH (from:CI)-[r]->(to:CI) WHERE 1=1';
        const params: any = {};

        // Apply filters
        if (type) {
          query += ' AND type(r) = $type';
          params.type = type;
        }
        if (from_id) {
          query += ' AND from.id = $from_id';
          params.from_id = from_id;
        }
        if (to_id) {
          query += ' AND to.id = $to_id';
          params.to_id = to_id;
        }
        if (ci_id) {
          // Match relationships where CI is either source or target
          query += ' AND (from.id = $ci_id OR to.id = $ci_id)';
          params.ci_id = ci_id;
        }

        // Get total count
        const countQuery = query + ' RETURN count(r) as total';
        const countResult = await session.run(countQuery, params);
        const total = countResult.records[0]!.get('total').toNumber();

        // Get paginated results
        const limitNum = Math.min(parseInt(limit as string), 1000);
        const offsetNum = parseInt(offset as string);

        query += ' RETURN from, r, to ORDER BY from.name, to.name SKIP $offset LIMIT $limit';
        params.offset = neo4j.int(offsetNum);
        params.limit = neo4j.int(limitNum);

        const result = await session.run(query, params);

        const relationships = result.records.map((record) => {
          const from = record.get('from').properties;
          const to = record.get('to').properties;
          const rel = record.get('r');

          return {
            from_id: from.id,
            from_name: from.name,
            from_type: from.type,
            to_id: to.id,
            to_name: to.name,
            to_type: to.type,
            type: rel.type,
            properties: rel.properties,
            created_at: rel.properties.created_at,
            updated_at: rel.properties.updated_at,
          };
        });

        res.json({
          success: true,
          data: relationships,
          pagination: {
            total,
            count: relationships.length,
            offset: offsetNum,
            limit: limitNum,
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error listing relationships', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list relationships',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Create a new relationship between CIs
   * POST /relationships
   */
  async createRelationship(req: Request, res: Response): Promise<void> {
    try {
      const { from_id, to_id, type, properties = {} } = req.body;

      // Validate required fields
      if (!from_id || !to_id || !type) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Missing required fields: from_id, to_id, type'
        });
        return;
      }

      // Validate relationship type
      const validTypes: RelationshipType[] = [
        'DEPENDS_ON',
        'HOSTS',
        'CONNECTS_TO',
        'USES',
        'OWNED_BY',
        'PART_OF',
        'DEPLOYED_ON',
        'BACKED_UP_BY',
      ];

      if (!validTypes.includes(type)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Invalid relationship type. Must be one of: ${validTypes.join(', ')}`
        });
        return;
      }

      // Check if both CIs exist
      const fromCI = await this.neo4jClient.getCI(from_id);
      const toCI = await this.neo4jClient.getCI(to_id);

      if (!fromCI) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Source CI with ID '${from_id}' not found`
        });
        return;
      }

      if (!toCI) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Target CI with ID '${to_id}' not found`
        });
        return;
      }

      // Prevent self-relationships
      if (from_id === to_id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Cannot create relationship from CI to itself'
        });
        return;
      }

      // Create the relationship
      await this.neo4jClient.createRelationship(from_id, to_id, type, properties);

      logger.info('Relationship created', {
        from_id,
        to_id,
        type,
      });

      res.status(201).json({
        success: true,
        data: {
          from_id,
          from_name: fromCI.name,
          from_type: fromCI._type,
          to_id,
          to_name: toCI.name,
          to_type: toCI._type,
          type,
          properties,
        },
        message: 'Relationship created successfully',
      });
    } catch (error) {
      logger.error('Error creating relationship', error);

      // Check for duplicate relationship error
      if (error instanceof Error && error.message.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: 'Relationship already exists'
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create relationship',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Delete a relationship between CIs
   * DELETE /relationships/:id
   * Alternative: DELETE /relationships?from_id=X&to_id=Y&type=Z
   */
  async deleteRelationship(req: Request, res: Response): Promise<void> {
    try {
      // Support both path parameter and query parameter deletion
      const { id } = req.params;
      const { from_id, to_id, type } = req.query;

      const session = this.neo4jClient.getSession();
      try {
        let query: string;
        let params: any;

        if (id) {
          // Delete by relationship ID (if Neo4j internal ID or custom ID)
          res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'Deletion by relationship ID not supported. Use from_id, to_id, and type query parameters.'
          });
          return;
        } else if (from_id && to_id && type) {
          // Delete by from_id, to_id, and type
          // Validate relationship type against the allowed enum to prevent Cypher injection
          const allowedTypes = Object.values(RelationshipType) as string[];
          if (!allowedTypes.includes(type as string)) {
            res.status(400).json({
              success: false,
              error: 'Bad Request',
              message: `Invalid relationship type. Allowed: ${allowedTypes.join(', ')}`,
            });
            return;
          }
          // First check if relationship exists
          const checkQuery = `
            MATCH (from:CI {id: $from_id})-[r:${type}]->(to:CI {id: $to_id})
            RETURN r
          `;

          const checkResult = await session.run(checkQuery, { from_id, to_id });

          if (checkResult.records.length === 0) {
            res.status(404).json({
              success: false,
              error: 'Not Found',
              message: 'Relationship not found'
            });
            return;
          }

          // Delete the relationship
          query = `
            MATCH (from:CI {id: $from_id})-[r:${type}]->(to:CI {id: $to_id})
            DELETE r
          `;
          params = { from_id, to_id };

          await session.run(query, params);

          logger.info('Relationship deleted', {
            from_id,
            to_id,
            type,
          });

          res.json({
            success: true,
            message: 'Relationship deleted successfully',
            data: {
              from_id,
              to_id,
              type,
            },
          });
        } else {
          res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'Missing required parameters: from_id, to_id, and type'
          });
        }
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error deleting relationship', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete relationship',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get relationships by type
   * GET /relationships/type/:type
   */
  async getRelationshipsByType(req: Request, res: Response): Promise<void> {
    try {
      const { type } = req.params;
      const { limit = 100, offset = 0 } = req.query;

      if (!type) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Relationship type is required'
        });
        return;
      }

      // Validate relationship type
      const validTypes: RelationshipType[] = [
        'DEPENDS_ON',
        'HOSTS',
        'CONNECTS_TO',
        'USES',
        'OWNED_BY',
        'PART_OF',
        'DEPLOYED_ON',
        'BACKED_UP_BY',
      ];

      if (!validTypes.includes(type as RelationshipType)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Invalid relationship type. Must be one of: ${validTypes.join(', ')}`
        });
        return;
      }

      const session = this.neo4jClient.getSession();
      try {
        // Get total count
        const countQuery = `
          MATCH (from:CI)-[r:${type}]->(to:CI)
          RETURN count(r) as total
        `;
        const countResult = await session.run(countQuery);
        const total = countResult.records[0]!.get('total').toNumber();

        // Get paginated results
        const limitNum = Math.min(parseInt(limit as string), 1000);
        const offsetNum = parseInt(offset as string);

        const query = `
          MATCH (from:CI)-[r:${type}]->(to:CI)
          RETURN from, r, to
          ORDER BY from.name, to.name
          SKIP $offset
          LIMIT $limit
        `;

        const result = await session.run(query, {
          offset: neo4j.int(offsetNum),
          limit: neo4j.int(limitNum),
        });

        const relationships = result.records.map((record) => {
          const from = record.get('from').properties;
          const to = record.get('to').properties;
          const rel = record.get('r');

          return {
            from_id: from.id,
            from_name: from.name,
            from_type: from.type,
            to_id: to.id,
            to_name: to.name,
            to_type: to.type,
            type: rel.type,
            properties: rel.properties,
            created_at: rel.properties.created_at,
            updated_at: rel.properties.updated_at,
          };
        });

        res.json({
          success: true,
          data: relationships,
          pagination: {
            total,
            count: relationships.length,
            offset: offsetNum,
            limit: limitNum,
          },
          type,
        });
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error getting relationships by type', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve relationships',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
