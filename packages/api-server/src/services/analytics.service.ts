// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger, ciIncarnationId } from '@cmdb/common';

/**
 * Analytics Service
 *
 * Provides pre-built analytics queries and reporting capabilities using the PostgreSQL data mart.
 * Leverages TimescaleDB for time-series queries and efficient time-based aggregations.
 */
export class AnalyticsService {
  private postgresClient = getPostgresClient();
  private neo4jClient = getNeo4jClient();
  /**
   * Get CI count by type
   */
  async getCICountsByType(): Promise<Array<{ ci_type: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          ci_type,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_active = true
        GROUP BY ci_type
        ORDER BY count DESC
      `);

      return result.rows;
    } catch (error) {
      logger.error('Error getting CI counts by type', error);
      throw error;
    }
  }

  /**
   * Get CI count by status
   */
  async getCICountsByStatus(): Promise<Array<{ status: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          ci_status as status,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_active = true
        GROUP BY ci_status
        ORDER BY count DESC
      `);

      return result.rows;
    } catch (error) {
      logger.error('Error getting CI counts by status', error);
      throw error;
    }
  }

  /**
   * Get CI count by environment
   */
  async getCICountsByEnvironment(): Promise<Array<{ environment: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          environment,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_active = true AND environment IS NOT NULL
        GROUP BY environment
        ORDER BY count DESC
      `);

      return result.rows;
    } catch (error) {
      logger.error('Error getting CI counts by environment', error);
      throw error;
    }
  }

  /**
   * Get relationship count by type
   */
  async getRelationshipCounts(): Promise<Array<{ relationship_type: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT
          relationship_type,
          COUNT(*) as count
        FROM cmdb.fact_ci_relationships
        GROUP BY relationship_type
        ORDER BY count DESC
      `);

      return result.rows;
    } catch (error) {
      logger.error('Error getting relationship counts', error);
      throw error;
    }
  }

  /**
   * Get discovery statistics with date range filtering
   */
  async getDiscoveryStats(startDate?: Date, endDate?: Date): Promise<{
    summary: {
      total_cis: number;
      unique_types: number;
      first_discovery: Date;
      last_discovery: Date;
    };
    by_provider: Array<{ discovery_provider: string; count: number }>;
  }> {
    try {
      let dateFilter = '';
      const params: any[] = [];

      if (startDate) {
        params.push(startDate);
        dateFilter += ` AND discovered_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        dateFilter += ` AND discovered_at <= $${params.length}`;
      }

      const summaryResult = await this.postgresClient.query(
        `
        SELECT
          COUNT(*) as total_cis,
          COUNT(DISTINCT ci_type) as unique_types,
          MIN(discovered_at) as first_discovery,
          MAX(discovered_at) as last_discovery
        FROM dim_ci
        WHERE is_active = true ${dateFilter}
        `,
        params
      );

      const providerResult = await this.postgresClient.query(
        `
        SELECT
          discovery_provider,
          COUNT(*) as count
        FROM dim_ci
        WHERE is_active = true AND discovery_provider IS NOT NULL ${dateFilter}
        GROUP BY discovery_provider
        ORDER BY count DESC
        `,
        params
      );

      return {
        summary: summaryResult.rows[0],
        by_provider: providerResult.rows,
      };
    } catch (error) {
      logger.error('Error getting discovery stats', error);
      throw error;
    }
  }

  /**
   * Get CI discovery timeline with configurable time bucket intervals
   * Uses TimescaleDB time_bucket function for efficient time-series aggregation
   */
  async getDiscoveryTimeline(
    interval: 'hour' | 'day' | 'week' | 'month' = 'day',
    limit: number = 30
  ): Promise<Array<{ period: Date; count: number; unique_types: number }>> {
    try {
      const result = await this.postgresClient.query(
        `
        SELECT
          date_trunc($1, discovered_at) as period,
          COUNT(*) as count,
          COUNT(DISTINCT ci_type) as unique_types
        FROM dim_ci
        WHERE is_active = true
        GROUP BY period
        ORDER BY period DESC
        LIMIT $2
        `,
        [interval, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting discovery timeline', error);
      throw error;
    }
  }

  /**
   * Get top CIs by relationship count
   */
  async getTopConnectedCIs(
    limit: number = 10,
    direction: 'in' | 'out' | 'both' = 'both'
  ): Promise<
    Array<{
      ci_id: string;
      ci_name: string;
      ci_type: string;
      relationship_count: number;
    }>
  > {
    try {
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
          WHERE c.is_active = true
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
          WHERE c.is_active = true
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
          WHERE c.is_active = true
          GROUP BY c.ci_id, c.ci_name, c.ci_type
          ORDER BY relationship_count DESC
          LIMIT $1
        `;
      }

      const result = await this.postgresClient.query(query, [limit]);
      return result.rows;
    } catch (error) {
      logger.error('Error getting top connected CIs', error);
      throw error;
    }
  }

  /**
   * Get dependency depth statistics
   * Analyzes how deep dependency chains go and identifies CIs with complex dependencies
   */
  async getDependencyDepthStats(): Promise<{
    top_cis: Array<{
      ci_id: string;
      max_depth: number;
      total_dependencies: number;
    }>;
    depth_distribution: Array<{
      max_depth: number;
      count: number;
    }>;
  }> {
    try {
      const topCIsResult = await this.postgresClient.query(`
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

      const distributionResult = await this.postgresClient.query(`
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

      return {
        top_cis: topCIsResult.rows,
        depth_distribution: distributionResult.rows,
      };
    } catch (error) {
      logger.error('Error getting dependency depth stats', error);
      throw error;
    }
  }

  /**
   * Get CI change history
   */
  async getChangeHistory(
    ciId: string,
    organizationId: string,
    limit: number = 50
  ): Promise<
    Array<{
      change_timestamp: Date;
      change_type: string;
      field_name?: string;
      old_value?: string;
      new_value?: string;
      changed_by?: string;
    }>
  > {
    const ci = await this.neo4jClient.getCI(ciId, organizationId);
    const incarnationId = ciIncarnationId(ci);
    if (!incarnationId) return [];
    try {
      const result = await this.postgresClient.query(
        `
        SELECT
          changed_at AS change_timestamp,
          change_type,
          changed_fields::text AS field_name,
          previous_values::text AS old_value,
          new_values::text AS new_value,
          changed_by
        FROM ci_change_history
        WHERE ci_id = $1 AND ci_incarnation_id = $3
          AND metadata->>'organization_id' = $4
        ORDER BY changed_at DESC
        LIMIT $2
        `,
        [ciId, limit, incarnationId, organizationId]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting change history', error);
      throw error;
    }
  }

  /**
   * Get change frequency by CI type over a time period
   * Uses TimescaleDB for efficient time-series aggregation
   */
  async getChangeFrequencyByType(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
    interval: 'hour' | 'day' | 'week' | 'month' = 'day'
  ): Promise<
    Array<{
      ci_type: string;
      period: Date;
      change_count: number;
    }>
  > {
    try {
      let dateFilter = '';
      const incarnations = await this.neo4jClient.listCIIncarnations(organizationId);
      const current = JSON.stringify(incarnations);
      const params: any[] = [interval, current, organizationId];

      if (startDate) {
        params.push(startDate);
        dateFilter += ` AND ch.changed_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        dateFilter += ` AND ch.changed_at <= $${params.length}`;
      }

      const result = await this.postgresClient.query(
        `
        SELECT
          current_ci."ciType" as ci_type,
          date_trunc($1, ch.changed_at) as period,
          COUNT(*) as change_count
        FROM ci_change_history ch
        JOIN jsonb_to_recordset($2::jsonb) AS current_ci("ciId" text, "incarnationId" uuid, "organizationId" text, "ciType" text)
          ON ch.ci_id = current_ci."ciId" AND ch.ci_incarnation_id = current_ci."incarnationId"
          AND current_ci."organizationId" = $3
        WHERE ch.metadata->>'organization_id' = $3 ${dateFilter}
        GROUP BY current_ci."ciType", period
        ORDER BY period DESC, change_count DESC
        `,
        params
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting change frequency by type', error);
      throw error;
    }
  }

  /**
   * Get dashboard summary statistics
   */
  async getDashboardStats(): Promise<{
    summary: {
      total_cis: number;
      unique_types: number;
      unique_environments: number;
      total_relationships: number;
      recent_discoveries_24h: number;
    };
    breakdown: {
      by_type: Array<{ ci_type: string; count: number }>;
      by_status: Array<{ status: string; count: number }>;
      by_environment: Array<{ environment: string; count: number }>;
    };
  }> {
    try {
      const ciCounts = await this.postgresClient.query(`
        SELECT
          COUNT(*) as total_cis,
          COUNT(DISTINCT ci_type) as unique_types,
          COUNT(DISTINCT environment) as unique_environments
        FROM dim_ci
        WHERE is_active = true
      `);

      const relationshipCount = await this.postgresClient.query(`
        SELECT COUNT(*) as total_relationships
        FROM cmdb.fact_ci_relationships
      `);

      const byType = await this.postgresClient.query(`
        SELECT ci_type, COUNT(*) as count
        FROM dim_ci
        WHERE is_active = true
        GROUP BY ci_type
        ORDER BY count DESC
        LIMIT 5
      `);

      const byStatus = await this.postgresClient.query(`
        SELECT ci_status as status, COUNT(*) as count
        FROM dim_ci
        WHERE is_active = true
        GROUP BY ci_status
      `);

      const byEnvironment = await this.postgresClient.query(`
        SELECT environment, COUNT(*) as count
        FROM dim_ci
        WHERE is_active = true AND environment IS NOT NULL
        GROUP BY environment
      `);

      const recentDiscoveries = await this.postgresClient.query(`
        SELECT COUNT(*) as count
        FROM cmdb.fact_discovery
        WHERE discovered_at > NOW() - INTERVAL '24 hours'
      `);

      return {
        summary: {
          total_cis: parseInt(ciCounts.rows[0].total_cis),
          unique_types: parseInt(ciCounts.rows[0].unique_types),
          unique_environments: parseInt(ciCounts.rows[0].unique_environments),
          total_relationships: parseInt(relationshipCount.rows[0].total_relationships),
          recent_discoveries_24h: parseInt(recentDiscoveries.rows[0].count),
        },
        breakdown: {
          by_type: byType.rows,
          by_status: byStatus.rows,
          by_environment: byEnvironment.rows,
        },
      };
    } catch (error) {
      logger.error('Error getting dashboard stats', error);
      throw error;
    }
  }

  /**
   * Execute custom analytics query with pagination
   * Allows for ad-hoc queries while enforcing safety limits
   */
  async executeCustomQuery(
    query: string,
    params: any[] = [],
    limit: number = 1000
  ): Promise<any[]> {
    try {
      // Security: Only allow SELECT queries
      const trimmedQuery = query.trim().toUpperCase();
      if (!trimmedQuery.startsWith('SELECT')) {
        throw new Error('Only SELECT queries are allowed');
      }

      // Security: Prevent dangerous operations
      const dangerousKeywords = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'TRUNCATE', 'ALTER', 'CREATE'];
      if (dangerousKeywords.some(keyword => trimmedQuery.includes(keyword))) {
        throw new Error('Query contains prohibited operations');
      }

      // Add LIMIT if not present
      let finalQuery = query;
      if (!trimmedQuery.includes('LIMIT')) {
        finalQuery += ` LIMIT ${Math.min(limit, 1000)}`;
      }

      const result = await this.postgresClient.query(finalQuery, params);
      return result.rows;
    } catch (error) {
      logger.error('Error executing custom query', error);
      throw error;
    }
  }

  /**
   * Get time-series metrics for CI health (if metrics table exists)
   * Uses TimescaleDB hypertable for efficient time-series queries
   */
  async getCIHealthMetrics(
    ciId: string,
    startTime: Date,
    endTime: Date,
    interval: '5m' | '15m' | '1h' | '6h' | '1d' = '1h'
  ): Promise<
    Array<{
      time_bucket: Date;
      avg_cpu: number;
      avg_memory: number;
      avg_disk: number;
      status_changes: number;
    }>
  > {
    try {
      // Convert interval to PostgreSQL interval format
      const pgInterval = interval.replace('m', ' minutes').replace('h', ' hours').replace('d', ' days');

      const result = await this.postgresClient.query(
        `
        SELECT
          time_bucket($1::interval, time) as time_bucket,
          AVG(cpu_percent) as avg_cpu,
          AVG(memory_percent) as avg_memory,
          AVG(disk_percent) as avg_disk,
          COUNT(DISTINCT status) as status_changes
        FROM metrics_ci_health
        WHERE ci_id = $2 AND time >= $3 AND time <= $4
        GROUP BY time_bucket
        ORDER BY time_bucket DESC
        `,
        [pgInterval, ciId, startTime, endTime]
      );

      return result.rows;
    } catch (error) {
      // If metrics table doesn't exist, return empty array
      if ((error as any).code === '42P01') {
        logger.warn('Metrics table does not exist', { ciId });
        return [];
      }
      logger.error('Error getting CI health metrics', error);
      throw error;
    }
  }

  /**
   * Get aggregated report data for export
   */
  async getInventoryReport(filters?: {
    type?: string;
    status?: string;
    environment?: string;
  }): Promise<
    Array<{
      ci_id: string;
      ci_name: string;
      ci_type: string;
      status: string;
      environment?: string;
      discovered_at: Date;
      relationship_count: number;
    }>
  > {
    try {
      const conditions: string[] = ['c.is_active = true'];
      const params: any[] = [];

      if (filters?.type) {
        params.push(filters.type);
        conditions.push(`c.ci_type = $${params.length}`);
      }

      if (filters?.status) {
        params.push(filters.status);
        conditions.push(`c.status = $${params.length}`);
      }

      if (filters?.environment) {
        params.push(filters.environment);
        conditions.push(`c.environment = $${params.length}`);
      }

      const whereClause = conditions.join(' AND ');

      const result = await this.postgresClient.query(
        `
        SELECT
          c.ci_id,
          c.ci_name,
          c.ci_type,
          c.status,
          c.environment,
          c.discovered_at,
          COUNT(DISTINCT r.relationship_id) as relationship_count
        FROM dim_ci c
        LEFT JOIN cmdb.fact_ci_relationships r ON c.ci_id = r.from_ci_id OR c.ci_id = r.to_ci_id
        WHERE ${whereClause}
        GROUP BY c.ci_id, c.ci_name, c.ci_type, c.status, c.environment, c.discovered_at
        ORDER BY c.ci_name
        `,
        params
      );

      return result.rows;
    } catch (error) {
      logger.error('Error generating inventory report', error);
      throw error;
    }
  }
}
