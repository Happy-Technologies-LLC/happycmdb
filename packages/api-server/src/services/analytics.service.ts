// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { CIListUnavailableError } from '../read-admission';

// A relationship is reportable only if both current dimension endpoints
// belong to the caller. Use the same edge set in all relationship reports.
const tenantRelationships = `
  SELECT r.* FROM cmdb.fact_ci_relationships r
  JOIN cmdb.dim_ci source ON source.ci_key = r.from_ci_key
  JOIN cmdb.dim_ci target ON target.ci_key = r.to_ci_key
  WHERE source.is_current AND target.is_current
    AND source.organization_id = $1 AND target.organization_id = $1
`;
/** Bounded even for dense cyclic graphs; failure is identical for either API. */
export class DependencyDepthLimitError extends Error {}
const DEPTH_EDGE_LIMIT = 128;
const DEPTH_STATEMENT_TIMEOUT_MS = 5000;


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
  async getCICountsByType(organizationId: string): Promise<Array<{ ci_type: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT ci_type, COUNT(*) as count FROM cmdb.dim_ci
        WHERE is_current AND organization_id = $1
        GROUP BY ci_type ORDER BY count DESC
      `, [organizationId]);

      return result.rows;
    } catch (error) {
      logger.error('Error getting CI counts by type', error);
      throw error;
    }
  }

  /**
   * Get CI count by status
   */
  async getCICountsByStatus(organizationId: string): Promise<Array<{ status: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT ci_status as status, COUNT(*) as count FROM cmdb.dim_ci
        WHERE is_current AND organization_id = $1
        GROUP BY ci_status ORDER BY count DESC
      `, [organizationId]);

      return result.rows;
    } catch (error) {
      logger.error('Error getting CI counts by status', error);
      throw error;
    }
  }

  /**
   * Get CI count by environment
   */
  async getCICountsByEnvironment(organizationId: string): Promise<Array<{ environment: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT environment, COUNT(*) as count FROM cmdb.dim_ci
        WHERE is_current AND environment IS NOT NULL AND organization_id = $1
        GROUP BY environment ORDER BY count DESC
      `, [organizationId]);

      return result.rows;
    } catch (error) {
      logger.error('Error getting CI counts by environment', error);
      throw error;
    }
  }

  /**
   * Get relationship count by type
   */
  async getRelationshipCounts(organizationId: string): Promise<Array<{ relationship_type: string; count: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT r.relationship_type, COUNT(*) as count
        FROM cmdb.fact_ci_relationships r
        JOIN cmdb.dim_ci source ON source.ci_key = r.from_ci_key
        JOIN cmdb.dim_ci target ON target.ci_key = r.to_ci_key
        WHERE source.is_current AND target.is_current
          AND source.organization_id = $1 AND target.organization_id = $1
        GROUP BY r.relationship_type ORDER BY count DESC
      `, [organizationId]);

      return result.rows;
    } catch (error) {
      logger.error('Error getting relationship counts', error);
      throw error;
    }
  }

  /**
   * Get discovery statistics with date range filtering
   */
  async getDiscoveryStats(organizationId: string, startDate?: Date, endDate?: Date): Promise<{
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
      const params: unknown[] = [organizationId];

      if (startDate) {
        params.push(startDate);
        dateFilter += ` AND f.discovered_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        dateFilter += ` AND f.discovered_at <= $${params.length}`;
      }

      const summaryResult = await this.postgresClient.query(`
        SELECT COUNT(DISTINCT f.ci_key) as total_cis,
          COUNT(DISTINCT c.ci_type) as unique_types,
          MIN(f.discovered_at) as first_discovery, MAX(f.discovered_at) as last_discovery
        FROM cmdb.fact_discovery f
        JOIN cmdb.dim_ci c ON c.ci_key = f.ci_key
        WHERE c.is_current AND c.organization_id = $1 ${dateFilter}
      `, params);
      const providerResult = await this.postgresClient.query(`
        SELECT f.discovery_provider, COUNT(*) as count
        FROM cmdb.fact_discovery f
        JOIN cmdb.dim_ci c ON c.ci_key = f.ci_key
        WHERE c.is_current AND c.organization_id = $1
          AND f.discovery_provider IS NOT NULL ${dateFilter}
        GROUP BY f.discovery_provider
      `, params);

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
    organizationId: string,
    interval: 'hour' | 'day' | 'week' | 'month' = 'day',
    limit: number = 30
  ): Promise<Array<{ period: Date; count: number; unique_types: number }>> {
    try {
      const result = await this.postgresClient.query(`
        SELECT date_trunc($1, f.discovered_at) as period,
          COUNT(*) as count, COUNT(DISTINCT c.ci_type) as unique_types
        FROM cmdb.fact_discovery f
        JOIN cmdb.dim_ci c ON c.ci_key = f.ci_key
        WHERE c.is_current AND c.organization_id = $3
        GROUP BY period ORDER BY period DESC LIMIT $2
      `, [interval, limit, organizationId]);

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
    organizationId: string,
    limit: number = 10,
    direction: 'in' | 'out' | 'both' = 'both'
  ): Promise<
    Array<{
      ci_id: string;
      ci_name: string;
      ci_type: string;
      relationship_count: string;
    }>
  > {
    try {
      // Rank by the mart's upper bound, then verify graph ownership only for
      // candidates that can still enter the page. A zero-edge limit-one read
      // never sends the complete tenant inventory to Neo4j.
      const expiresAt = Date.now() + 7000;
      const remaining = () => {
        const ms = expiresAt - Date.now();
        if (ms <= 0) throw new CIListUnavailableError();
        return ms;
      };
      const query = async (text: string, values: unknown[]) => {
        try {
          return await this.postgresClient.pool.query({
            text, values, query_timeout: remaining(),
          } as import('pg').QueryConfig & { query_timeout: number });
        } catch (error) {
          if (error instanceof Error && error.message === 'Query read timeout') {
            throw new CIListUnavailableError();
          }
          throw error;
        }
      };
      const eligible = `SELECT c.ci_key, c.ci_id, c.ci_name, c.ci_type FROM cmdb.dim_ci c
        WHERE c.is_current AND NOT c.org_backfilled AND c.organization_id = $1
          AND NOT EXISTS (SELECT 1 FROM ci_reconciliation_operations j
            WHERE j.organization_id = $1 AND j.ci_id = c.ci_id
              AND j.state IN ('pending', 'failed'))`;
      const edge = direction === 'in' ? 'r.to_ci_key = c.ci_key'
        : direction === 'out' ? 'r.from_ci_key = c.ci_key'
        : '(r.from_ci_key = c.ci_key OR r.to_ci_key = c.ci_key)';
      const relationships = `SELECT r.relationship_key, r.from_ci_key, r.to_ci_key,
          source.ci_id AS from_id, target.ci_id AS to_id
        FROM cmdb.fact_ci_relationships r
        JOIN eligible source ON source.ci_key = r.from_ci_key
        JOIN eligible target ON target.ci_key = r.to_ci_key`;
      const rankedEndpoints = direction === 'in'
        ? 'SELECT to_ci_key AS ci_key FROM tenant_relationships'
        : direction === 'out'
          ? 'SELECT from_ci_key AS ci_key FROM tenant_relationships'
          : `SELECT from_ci_key AS ci_key FROM tenant_relationships
             UNION ALL SELECT to_ci_key FROM tenant_relationships WHERE to_ci_key <> from_ci_key`;
      const pageSize = Math.min(32, Math.max(2, limit + 1));
      const selected: Array<{
        ci_id: string; ci_name: string; ci_type: string; relationship_count: string;
      }> = [];
      let offset = 0;
      while (offset < 1024) {
        const batch = await query(`
          WITH eligible AS MATERIALIZED (${eligible}),
            tenant_relationships AS MATERIALIZED (${relationships}),
            upper_counts AS (
              SELECT ci_key, COUNT(*) AS upper_count
              FROM (${rankedEndpoints}) endpoints GROUP BY ci_key
            )
          SELECT c.ci_id, c.ci_name, c.ci_type,
            COALESCE(upper_counts.upper_count, 0) AS upper_count
          FROM eligible c LEFT JOIN upper_counts ON upper_counts.ci_key = c.ci_key
          ORDER BY upper_count DESC, c.ci_id LIMIT $2 OFFSET $3
        `, [organizationId, pageSize, offset]);
        if (!batch.rows.length) return selected;
        offset += batch.rows.length;
        const candidates = batch.rows as Array<{
          ci_id: string; ci_name: string; ci_type: string; upper_count: string;
        }>;
        const worst = selected[limit - 1];
        const competitive = worst ? candidates.filter(candidate =>
          Number(candidate.upper_count) > Number(worst.relationship_count) ||
          (Number(candidate.upper_count) === Number(worst.relationship_count) &&
            candidate.ci_id < worst.ci_id)) : candidates;
        if (!competitive.length) return selected;
        const session = this.neo4jClient.getSession();
        const owned = new Set<string>();
        try {
          const ids = competitive.map(candidate => candidate.ci_id);
          const edges = await query(`
            WITH eligible AS (${eligible}), tenant_relationships AS (${relationships})
            SELECT c.ci_id, r.from_id, r.to_id
            FROM eligible c JOIN tenant_relationships r ON ${edge}
            WHERE c.ci_id = ANY($2::text[])
            ORDER BY c.ci_id, r.relationship_key LIMIT $3
          `, [organizationId, ids, 2049]);
          if (edges.rows.length > 2048) throw new CIListUnavailableError();
          const graphIds = [...new Set([...ids, ...edges.rows.flatMap(
            row => [row.from_id as string, row.to_id as string])])];
          for (let start = 0; start < graphIds.length; start += 512) {
            const result = await session.run(
              `MATCH (ci:CI) WHERE ci.id IN $ids AND ci.organization_id = $organizationId
               RETURN ci.id AS id`,
              { ids: graphIds.slice(start, start + 512), organizationId },
              { timeout: remaining() });
            for (const record of result.records) owned.add(record.get('id') as string);
          }
          const counts = new Map<string, number>();
          for (const row of edges.rows) {
            const neighbor = row.from_id === row.ci_id ? row.to_id : row.from_id;
            if (owned.has(neighbor)) counts.set(row.ci_id, (counts.get(row.ci_id) ?? 0) + 1);
          }
          for (const candidate of competitive) {
            if (!owned.has(candidate.ci_id)) continue;
            selected.push({
              ci_id: candidate.ci_id, ci_name: candidate.ci_name, ci_type: candidate.ci_type,
              relationship_count: String(counts.get(candidate.ci_id) ?? 0),
            });
          }
          selected.sort((a, b) =>
            Number(b.relationship_count) - Number(a.relationship_count) || a.ci_id.localeCompare(b.ci_id));
          selected.length = Math.min(selected.length, limit);
        } finally {
          await session.close();
        }
        if (batch.rows.length < pageSize) return selected;
        const last = candidates[candidates.length - 1]!;
        const floor = selected[limit - 1];
        if (floor && (Number(last.upper_count) < Number(floor.relationship_count) ||
          (Number(last.upper_count) === Number(floor.relationship_count) && last.ci_id >= floor.ci_id))) {
          return selected;
        }
        remaining();
      }
      throw new CIListUnavailableError();
    } catch (error) {
      logger.error('Error getting top connected CIs', error);
      throw error;
    }
  }

  /**
   * Get dependency depth statistics
   * Analyzes how deep dependency chains go and identifies CIs with complex dependencies
   */
  async getDependencyDepthStats(organizationId: string): Promise<{
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
      // LIMIT is applied before recursion. UNION deduplicates (origin, target,
      // depth) states so cycles cannot multiply path counts exponentially.
      const query = `
        WITH RECURSIVE tenant_relationships AS MATERIALIZED (
          SELECT r.from_ci_key, r.to_ci_key
          FROM cmdb.fact_ci_relationships r
          JOIN cmdb.dim_ci source ON source.ci_key = r.from_ci_key
          JOIN cmdb.dim_ci target ON target.ci_key = r.to_ci_key
          WHERE source.is_current AND target.is_current
            AND source.organization_id = $1 AND target.organization_id = $1
            AND r.relationship_type = 'DEPENDS_ON'
          LIMIT $2
        ), bounds AS (
          SELECT COUNT(*) <= $3 AS allowed FROM tenant_relationships
        ), dependency_depth AS (
          SELECT from_ci_key AS ci_key, to_ci_key, 1 AS depth
          FROM tenant_relationships CROSS JOIN bounds WHERE bounds.allowed
          UNION
          SELECT dd.ci_key, r.to_ci_key, dd.depth + 1
          FROM dependency_depth dd
          JOIN tenant_relationships r ON r.from_ci_key = dd.to_ci_key
          WHERE dd.depth < 10
        ), max_depths AS (
          SELECT ci_key, MAX(depth) AS max_depth,
            COUNT(DISTINCT to_ci_key) AS total_dependencies
          FROM dependency_depth GROUP BY ci_key
        )
        SELECT (SELECT allowed FROM bounds) AS allowed,
          (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
            SELECT c.ci_id, d.max_depth, d.total_dependencies
            FROM max_depths d JOIN cmdb.dim_ci c ON c.ci_key = d.ci_key
            WHERE c.is_current AND c.organization_id = $1
            ORDER BY d.max_depth DESC, c.ci_id LIMIT 100
          ) t) AS top_cis,
          (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
            SELECT max_depth, COUNT(*) AS count
            FROM max_depths GROUP BY max_depth ORDER BY max_depth
          ) t) AS depth_distribution`;
      const result = await this.postgresClient.transaction(async client => {
        await client.query("SELECT set_config('statement_timeout', $1, true)", [String(DEPTH_STATEMENT_TIMEOUT_MS)]);
        return client.query(query, [organizationId, DEPTH_EDGE_LIMIT + 1, DEPTH_EDGE_LIMIT]);
      });
      if (!result.rows[0].allowed) throw new DependencyDepthLimitError();
      return {
        top_cis: result.rows[0].top_cis,
        depth_distribution: result.rows[0].depth_distribution,
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
    limit: number,
    incarnationId: string | null
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
    const result = await this.postgresClient.query(
      `SELECT h.changed_at AS change_timestamp, h.change_type, h.changed_by,
              f.field_name,
              h.previous_values ->> f.field_name AS old_value,
              h.new_values ->> f.field_name AS new_value
       FROM ci_change_history h
       CROSS JOIN LATERAL unnest(
         CASE WHEN h.changed_fields IS NULL OR cardinality(h.changed_fields) = 0
                OR h.changed_fields = ARRAY['*'] THEN ARRAY[NULL::text]
              ELSE h.changed_fields END
       ) WITH ORDINALITY AS f(field_name, ord)
       WHERE h.ci_id = $1 AND h.organization_id = $2
         AND h.ci_incarnation_id = $4::uuid
       ORDER BY h.changed_at DESC, h.id, f.ord
       LIMIT $3`,
      [ciId, organizationId, limit, incarnationId]
    );
    return result.rows;
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
        WHERE ch.organization_id = $3::uuid ${dateFilter}
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
  async getDashboardStats(organizationId: string): Promise<{
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
        SELECT COUNT(*) as total_cis, COUNT(DISTINCT ci_type) as unique_types,
          COUNT(DISTINCT environment) as unique_environments
        FROM cmdb.dim_ci WHERE is_current AND organization_id = $1
      `, [organizationId]);
      const relationshipCount = await this.postgresClient.query(`
        WITH tenant_relationships AS (${tenantRelationships})
        SELECT COUNT(*) as total_relationships FROM tenant_relationships
      `, [organizationId]);
      const byType = await this.postgresClient.query(`
        SELECT ci_type, COUNT(*) as count FROM cmdb.dim_ci
        WHERE is_current AND organization_id = $1
        GROUP BY ci_type ORDER BY count DESC LIMIT 5
      `, [organizationId]);
      const byStatus = await this.postgresClient.query(`
        SELECT ci_status as status, COUNT(*) as count FROM cmdb.dim_ci
        WHERE is_current AND organization_id = $1 GROUP BY ci_status
      `, [organizationId]);
      const byEnvironment = await this.postgresClient.query(`
        SELECT environment, COUNT(*) as count FROM cmdb.dim_ci
        WHERE is_current AND organization_id = $1 AND environment IS NOT NULL
        GROUP BY environment
      `, [organizationId]);
      const recentDiscoveries = await this.postgresClient.query(`
        SELECT COUNT(*) as count FROM cmdb.fact_discovery f
        JOIN cmdb.dim_ci c ON c.ci_key = f.ci_key
        WHERE c.is_current AND c.organization_id = $1
          AND f.discovered_at > NOW() - INTERVAL '24 hours'
      `, [organizationId]);

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
   * Get aggregated report data for export
   */
  async getInventoryReport(organizationId: string, filters?: {
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
      const conditions: string[] = ['c.is_current', 'c.organization_id = $1'];
      const params: unknown[] = [organizationId];

      if (filters?.type) {
        params.push(filters.type);
        conditions.push(`c.ci_type = $${params.length}`);
      }

      if (filters?.status) {
        params.push(filters.status);
        conditions.push(`c.ci_status = $${params.length}`);
      }

      if (filters?.environment) {
        params.push(filters.environment);
        conditions.push(`c.environment = $${params.length}`);
      }

      const whereClause = conditions.join(' AND ');

      const result = await this.postgresClient.query(
        `
        SELECT
          c.ci_id, c.ci_name, c.ci_type, c.ci_status as status,
          c.environment, c.created_at as discovered_at,
          COUNT(DISTINCT r.relationship_key) as relationship_count
        FROM cmdb.dim_ci c
        LEFT JOIN (
          ${tenantRelationships}
        ) r ON c.ci_key = r.from_ci_key OR c.ci_key = r.to_ci_key
        WHERE ${whereClause}
        GROUP BY c.ci_key, c.ci_id, c.ci_name, c.ci_type, c.ci_status, c.environment, c.created_at
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
