// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getNeo4jClient, getPostgresClient, getAuditService } from '@cmdb/database';
import { logger, validateCISortField, validateSortDirection } from '@cmdb/common';
import neo4j from 'neo4j-driver';

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
        sort_by = 'name',
        sort_order = 'asc',
        limit,
        offset,
        page,
        pageSize
      } = req.query;

      const session = this.neo4jClient.getSession();
      try {
        let query = 'MATCH (ci:CI) WHERE 1=1';
        const params: any = {};

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

        // Get total count for pagination
        const countQuery = query.replace('MATCH (ci:CI)', 'MATCH (ci:CI)') + ' RETURN count(ci) as total';
        const countResult = await session.run(countQuery, params);
        const total = countResult.records[0]!.get('total').toNumber();

        // Validate sort parameters to prevent Cypher injection
        const sortField = validateCISortField((sort_by as string) || 'name');
        const sortDirection = validateSortDirection((sort_order as string) || 'asc');

        // Safe to use template literals here because sortField and sortDirection are validated
        const sortClause = `ORDER BY ci.${sortField} ${sortDirection}`;

        // Get paginated results
        query += ` RETURN ci ${sortClause} SKIP $offset LIMIT $limit`;
        params.offset = neo4j.int(finalOffset);
        params.limit = neo4j.int(finalLimit);

        const result = await session.run(query, params);
        const cis = result.records.map((r: any) => convertNeo4jTypes(r.get('ci').properties));

        res.json({
          success: true,
          data: cis,
          pagination: {
            total,
            count: cis.length,
            offset: finalOffset,
            limit: finalLimit,
            page: finalPage,
            pageSize: finalLimit,
            totalPages: Math.ceil(total / finalLimit),
          },
        });
      } finally {
        await session.close();
      }
    } catch (error) {
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

      const ci = await this.neo4jClient.getCI(id);

      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${id}' not found`
        });
        return;
      }

      res.json({
        success: true,
        data: convertNeo4jTypes(ci)
      });
    } catch (error) {
      logger.error('Error getting CI', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CI',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async createCI(req: Request, res: Response): Promise<void> {
    try {
      // Validation is handled by middleware, but double-check required fields
      if (!req.body.id || !req.body.name || !req.body.type) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Missing required fields: id, name, type'
        });
        return;
      }

      const ci = await this.neo4jClient.createCI(req.body);
      res.status(201).json({
        success: true,
        data: convertNeo4jTypes(ci),
        message: 'CI created successfully'
      });
    } catch (error) {
      logger.error('Error creating CI', error);

      // Check for duplicate ID error
      if (error instanceof Error && error.message.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: 'CI with this ID already exists'
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create CI',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async updateCI(req: Request, res: Response): Promise<void> {
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

      // Check if CI exists first
      const existing = await this.neo4jClient.getCI(id);
      if (!existing) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${id}' not found`
        });
        return;
      }

      const ci = await this.neo4jClient.updateCI(id, req.body);
      res.json({
        success: true,
        data: ci,
        message: 'CI updated successfully'
      });
    } catch (error) {
      logger.error('Error updating CI', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update CI',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async deleteCI(req: Request, res: Response): Promise<void> {
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

      // Check if CI exists first
      const existing = await this.neo4jClient.getCI(id);
      if (!existing) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${id}' not found`
        });
        return;
      }

      const session = this.neo4jClient.getSession();
      try {
        await session.run('MATCH (ci:CI {id: $id}) DETACH DELETE ci', { id });
        res.status(204).send();
      } finally {
        await session.close();
      }
    } catch (error) {
      logger.error('Error deleting CI', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete CI',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
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

      // Check if CI exists
      const ci = await this.neo4jClient.getCI(id);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${id}' not found`
        });
        return;
      }

      const relationships = await this.neo4jClient.getRelationships(
        id,
        direction as 'in' | 'out' | 'both',
        depthNum
      );

      // Transform relationships to match frontend expectations
      const transformedRelationships = relationships.map((rel: any) => {
        const relatedCI = convertNeo4jTypes(rel._ci);

        // Determine actual direction from Neo4j relationship start/end nodes
        // If current CI is the start node, it's an outgoing relationship
        const isOutgoing = rel._startNodeId === id;

        return {
          id: `${id}-${rel._type}-${relatedCI.id}`,
          type: rel._type,
          source_ci_id: isOutgoing ? id : relatedCI.id,
          target_ci_id: isOutgoing ? relatedCI.id : id,
          source_ci: isOutgoing ? convertNeo4jTypes(ci) : relatedCI,
          target_ci: isOutgoing ? relatedCI : convertNeo4jTypes(ci),
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

      // Check if CI exists
      const ci = await this.neo4jClient.getCI(id);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${id}' not found`
        });
        return;
      }

      const dependencies = await this.neo4jClient.getDependencies(id, depthNum);

      res.json({
        success: true,
        data: dependencies,
        count: dependencies.length,
        depth: depthNum
      });
    } catch (error) {
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

      // Check if CI exists
      const ci = await this.neo4jClient.getCI(id);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${id}' not found`
        });
        return;
      }

      // Get downstream dependencies (CIs that depend on this CI)
      const downstream = await this.neo4jClient.impactAnalysis(id, depthNum);

      // Get upstream dependencies (CIs that this CI depends on)
      const upstream = await this.neo4jClient.getDependencies(id, depthNum);

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

      const limitNum = parseInt(limit as string);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Limit must be a number between 1 and 1000'
        });
        return;
      }

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

        const cis = result.records.map((r: any) => ({
          ci: r.get('node').properties,
          score: r.get('score'),
        }));

        res.json({
          success: true,
          data: cis,
          count: cis.length,
          query: query.trim()
        });
      } finally {
        await session.close();
      }
    } catch (error) {
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

      const postgresClient = getPostgresClient();
      const auditService = getAuditService(postgresClient['pool']);

      const auditHistory = await auditService.getCIAuditHistory(id, limitNum);

      res.json({
        success: true,
        data: auditHistory,
        count: auditHistory.length
      });
    } catch (error) {
      logger.error('Error getting CI audit history', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve audit history',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
