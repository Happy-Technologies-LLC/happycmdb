// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getPostgresClient, getNeo4jClient } from '@cmdb/database';
import { logger } from '@cmdb/common';

export class AnalyticsController {
  private postgresClient = getPostgresClient();
  private neo4jClient = getNeo4jClient();

  /**
   * Get CI count by type
   * GET /analytics/ci-counts
   */
  async getCICountsByType(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          ci_type,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_current = true
        GROUP BY ci_type
        ORDER BY count DESC
      `);

      res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      logger.error('Error getting CI counts by type', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CI counts',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get CI count by status
   * GET /analytics/ci-status
   */
  async getCICountsByStatus(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          ci_status as status,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_current = true
        GROUP BY ci_status
        ORDER BY count DESC
      `);

      res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      logger.error('Error getting CI counts by status', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CI status counts',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get CI count by environment
   * GET /analytics/ci-environments
   */
  async getCICountsByEnvironment(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          environment,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_current = true AND environment IS NOT NULL
        GROUP BY environment
        ORDER BY count DESC
      `);

      res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      logger.error('Error getting CI counts by environment', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve CI environment counts',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get relationship count by type
   * GET /analytics/relationship-counts
   */
  async getRelationshipCounts(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          relationship_type,
          COUNT(*) as count
        FROM cmdb.fact_ci_relationships
        GROUP BY relationship_type
        ORDER BY count DESC
      `);

      res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      logger.error('Error getting relationship counts', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve relationship counts',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get discovery statistics
   * GET /analytics/discovery-stats
   */
  async getDiscoveryStats(req: Request, res: Response): Promise<void> {
    try {
      const { start_date, end_date } = req.query;

      let dateFilter = '';
      const params: any[] = [];

      if (start_date) {
        params.push(start_date);
        dateFilter += ` AND discovered_at >= $${params.length}`;
      }

      if (end_date) {
        params.push(end_date);
        dateFilter += ` AND discovered_at <= $${params.length}`;
      }

      const result = await this.postgresClient.query(
        `
        SELECT
          COUNT(*) as total_cis,
          COUNT(DISTINCT ci_type) as unique_types,
          MIN(discovered_at) as first_discovery,
          MAX(discovered_at) as last_discovery
        FROM dim_ci
        WHERE is_current = true ${dateFilter}
        `,
        params
      );

      const providerStats = await this.postgresClient.query(
        `
        SELECT
          discovery_provider,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_current = true AND discovery_provider IS NOT NULL ${dateFilter}
        GROUP BY discovery_provider
        ORDER BY count DESC
        `,
        params
      );

      res.json({
        success: true,
        data: {
          summary: result.rows[0],
          by_provider: providerStats.rows,
        },
        filters: {
          start_date,
          end_date,
        },
      });
    } catch (error) {
      logger.error('Error getting discovery stats', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve discovery statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get CI discovery timeline
   * GET /analytics/discovery-timeline
   */
  async getDiscoveryTimeline(req: Request, res: Response): Promise<void> {
    try {
      const { interval = 'day', limit = 30 } = req.query;

      // Validate interval
      const validIntervals = ['hour', 'day', 'week', 'month'];
      if (!validIntervals.includes(interval as string)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Invalid interval. Must be one of: ${validIntervals.join(', ')}`,
        });
        return;
      }

      const limitNum = Math.min(parseInt(String(limit)), 365);

      const result = await this.postgresClient.query(
        `
        SELECT
          date_trunc($1, discovered_at) as period,
          COUNT(*) as count,
          COUNT(DISTINCT ci_type) as unique_types
        FROM dim_ci
        WHERE is_current = true
        GROUP BY period
        ORDER BY period DESC
        LIMIT $2
        `,
        [interval, limitNum]
      );

      res.json({
        success: true,
        data: result.rows,
        interval,
      });
    } catch (error) {
      logger.error('Error getting discovery timeline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve discovery timeline',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get top CIs by relationship count
   * GET /analytics/top-connected
   */
  async getTopConnectedCIs(req: Request, res: Response): Promise<void> {
    try {
      const { limit = 10, direction = 'both' } = req.query;

      const limitNum = Math.min(parseInt(String(limit)), 100);

      let query = '';
      if (direction === 'in') {
        query = `
          SELECT
            c.ci_id,
            c.ci_name,
            c.ci_type,
            COUNT(r.relationship_id) as relationship_count
          FROM dim_ci c
          JOIN cmdb.fact_ci_relationships r ON c.ci_id = r.to_ci_id
          WHERE c.is_current = true
          GROUP BY c.ci_id, c.ci_name, c.ci_type
          ORDER BY relationship_count DESC
          LIMIT $1
        `;
      } else if (direction === 'out') {
        query = `
          SELECT
            c.ci_id,
            c.ci_name,
            c.ci_type,
            COUNT(r.relationship_id) as relationship_count
          FROM dim_ci c
          JOIN cmdb.fact_ci_relationships r ON c.ci_id = r.from_ci_id
          WHERE c.is_current = true
          GROUP BY c.ci_id, c.ci_name, c.ci_type
          ORDER BY relationship_count DESC
          LIMIT $1
        `;
      } else {
        query = `
          SELECT
            c.ci_id,
            c.ci_name,
            c.ci_type,
            COUNT(DISTINCT r1.relationship_id) + COUNT(DISTINCT r2.relationship_id) as relationship_count
          FROM dim_ci c
          LEFT JOIN cmdb.fact_ci_relationships r1 ON c.ci_id = r1.from_ci_id
          LEFT JOIN cmdb.fact_ci_relationships r2 ON c.ci_id = r2.to_ci_id
          WHERE c.is_current = true
          GROUP BY c.ci_id, c.ci_name, c.ci_type
          ORDER BY relationship_count DESC
          LIMIT $1
        `;
      }

      const result = await this.postgresClient.query(query, [limitNum]);

      res.json({
        success: true,
        data: result.rows,
        direction,
      });
    } catch (error) {
      logger.error('Error getting top connected CIs', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve top connected CIs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get dependency depth statistics
   * GET /analytics/dependency-depth
   */
  async getDependencyDepthStats(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.postgresClient.query(`
        WITH RECURSIVE dependency_depth AS (
          SELECT
            from_ci_id as ci_id,
            to_ci_id,
            1 as depth
          FROM cmdb.fact_ci_relationships
          WHERE relationship_type = 'DEPENDS_ON'

          UNION ALL

          SELECT
            dd.ci_id,
            r.to_ci_id,
            dd.depth + 1
          FROM dependency_depth dd
          JOIN cmdb.fact_ci_relationships r ON dd.to_ci_id = r.from_ci_id
          WHERE r.relationship_type = 'DEPENDS_ON' AND dd.depth < 10
        )
        SELECT
          ci_id,
          MAX(depth) as max_depth,
          COUNT(DISTINCT to_ci_id) as total_dependencies
        FROM dependency_depth
        GROUP BY ci_id
        ORDER BY max_depth DESC
        LIMIT 100
      `);

      const depthDistribution = await this.postgresClient.query(`
        WITH RECURSIVE dependency_depth AS (
          SELECT
            from_ci_id as ci_id,
            to_ci_id,
            1 as depth
          FROM cmdb.fact_ci_relationships
          WHERE relationship_type = 'DEPENDS_ON'

          UNION ALL

          SELECT
            dd.ci_id,
            r.to_ci_id,
            dd.depth + 1
          FROM dependency_depth dd
          JOIN cmdb.fact_ci_relationships r ON dd.to_ci_id = r.from_ci_id
          WHERE r.relationship_type = 'DEPENDS_ON' AND dd.depth < 10
        ),
        max_depths AS (
          SELECT
            ci_id,
            MAX(depth) as max_depth
          FROM dependency_depth
          GROUP BY ci_id
        )
        SELECT
          max_depth,
          COUNT(*) as count
        FROM max_depths
        GROUP BY max_depth
        ORDER BY max_depth
      `);

      res.json({
        success: true,
        data: {
          top_cis: result.rows,
          depth_distribution: depthDistribution.rows,
        },
      });
    } catch (error) {
      logger.error('Error getting dependency depth stats', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve dependency depth statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get CI change history
   * GET /analytics/change-history
   */
  async getChangeHistory(req: Request, res: Response): Promise<void> {
    try {
      const { ci_id, limit = 50 } = req.query;

      if (!ci_id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required',
        });
        return;
      }

      const limitNum = Math.min(parseInt(String(limit)), 1000);

      const result = await this.postgresClient.query(
        `
        SELECT
          changed_at,
          change_type,
          changed_fields,
          previous_values,
          new_values,
          changed_by
        FROM ci_change_history
        WHERE ci_id = $1
        ORDER BY changed_at DESC
        LIMIT $2
        `,
        [ci_id, limitNum]
      );

      res.json({
        success: true,
        data: result.rows,
        ci_id,
      });
    } catch (error) {
      logger.error('Error getting change history', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve change history',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get dashboard summary statistics
   * GET /analytics/dashboard
   */
  async getDashboardStats(_req: Request, res: Response): Promise<void> {
    const session = this.neo4jClient.getSession();
    try {
      // Get overall counts from Neo4j
      const ciCountsResult = await session.run(`
        MATCH (ci:CI)
        RETURN
          COUNT(ci) as total_cis,
          COUNT(DISTINCT ci.type) as unique_types,
          COUNT(DISTINCT ci.environment) as unique_environments
      `);

      const relationshipCountResult = await session.run(`
        MATCH ()-[r]->()
        RETURN COUNT(r) as total_relationships
      `);

      const byTypeResult = await session.run(`
        MATCH (ci:CI)
        RETURN ci.type as ci_type, COUNT(ci) as count
        ORDER BY count DESC
      `);

      const byStatusResult = await session.run(`
        MATCH (ci:CI)
        RETURN ci.status as status, COUNT(ci) as count
        ORDER BY count DESC
      `);

      const byEnvironmentResult = await session.run(`
        MATCH (ci:CI)
        WHERE ci.environment IS NOT NULL
        RETURN ci.environment as environment, COUNT(ci) as count
        ORDER BY count DESC
      `);

      // Get recent discoveries (last 10 CIs discovered by discovery workers)
      const recentDiscoveriesResult = await session.run(`
        MATCH (ci:CI)
        WHERE ci.metadata CONTAINS 'discovery_provider'
        RETURN ci {
          .id,
          .name,
          .type,
          .status,
          .environment,
          last_discovered: ci.discovered_at
        } as ci
        ORDER BY ci.discovered_at DESC
        LIMIT 10
      `);

      // Transform arrays to Record<string, number>
      const byTypeMap = byTypeResult.records.reduce((acc: Record<string, number>, record: any) => {
        const type = record.get('ci_type');
        const count = record.get('count').toNumber();
        if (type) acc[type] = count;
        return acc;
      }, {});

      const byStatusMap = byStatusResult.records.reduce((acc: Record<string, number>, record: any) => {
        const status = record.get('status');
        const count = record.get('count').toNumber();
        if (status) acc[status] = count;
        return acc;
      }, {});

      const byEnvironmentMap = byEnvironmentResult.records.reduce((acc: Record<string, number>, record: any) => {
        const env = record.get('environment');
        const count = record.get('count').toNumber();
        if (env) acc[env] = count;
        return acc;
      }, {});

      // Transform recent discoveries
      const recentDiscoveries = recentDiscoveriesResult.records.map((record: any) => {
        const ci = record.get('ci');
        const lastDiscovered = ci.last_discovered;

        // Convert Neo4j DateTime to ISO string
        let lastDiscoveredStr = null;
        if (lastDiscovered) {
          try {
            // Neo4j DateTime has year, month, day, hour, minute, second, nanosecond
            const date = new Date(Date.UTC(
              lastDiscovered.year.toNumber(),
              lastDiscovered.month.toNumber() - 1, // JS months are 0-indexed
              lastDiscovered.day.toNumber(),
              lastDiscovered.hour.toNumber(),
              lastDiscovered.minute.toNumber(),
              lastDiscovered.second.toNumber(),
              Math.floor(lastDiscovered.nanosecond.toNumber() / 1000000) // Convert nanoseconds to milliseconds
            ));
            lastDiscoveredStr = date.toISOString();
          } catch (e) {
            logger.debug('Failed to convert lastDiscovered to ISO string', e);
          }
        }

        return {
          id: ci.id,
          name: ci.name,
          type: ci.type,
          status: ci.status,
          environment: ci.environment || null,
          last_discovered: lastDiscoveredStr,
        };
      });

      res.json({
        total_cis: ciCountsResult.records[0]?.get('total_cis')?.toNumber() || 0,
        by_type: byTypeMap,
        by_status: byStatusMap,
        by_environment: byEnvironmentMap,
        recent_discoveries: recentDiscoveries,
        health_score: 0,
        critical_relationships: relationshipCountResult.records[0]?.get('total_relationships')?.toNumber() || 0,
      });
    } catch (error) {
      logger.error('Error getting dashboard stats', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve dashboard statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      await session.close();
    }
  }
}
