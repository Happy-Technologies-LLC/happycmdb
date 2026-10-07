// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/connector-fields.resolvers.ts

import { GraphQLError } from 'graphql';
import { getPostgresClient } from '@cmdb/database';
import type { GraphQLContext } from './index';
import { connectorScope, connectorPredicate, scopeValues, PUBLIC_RUN } from '../../auth/connector-scope';

function requireScope(context: GraphQLContext) {
  const scope = connectorScope(context.user);
  if (!scope.organizationId && !scope.legacy) {
    throw new GraphQLError('Organization claim required', { extensions: { code: 'FORBIDDEN' } });
  }
}

async function requireOwnedParent(id: string, context: GraphQLContext) {
  requireScope(context);
  const result = await getPostgresClient().query(
    `SELECT id FROM connector_configurations cc WHERE cc.id = $1 AND ${connectorPredicate('cc', 2)}`,
    [id, ...scopeValues(context.user)]
  );
  if (!result.rows.length) throw new GraphQLError('Configuration not found', { extensions: { code: 'NOT_FOUND' } });
}

/**
 * ConnectorConfiguration field resolvers
 */
export const ConnectorConfigurationFieldResolvers = {
  /**
   * Resolve associated connector (join to InstalledConnector)
   */
  connector: async (parent: { id: string; connectorType: string }, _args: unknown, context: GraphQLContext): Promise<unknown> => {
    await requireOwnedParent(parent.id, context);
    try {
      const pgClient = getPostgresClient();

      const query = `
        SELECT
          id,
          connector_type,
          category,
          name,
          description,
          installed_version,
          latest_available_version,
          installed_at,
          updated_at,
          enabled,
          verified,
          install_path,
          metadata,
          capabilities,
          resources,
          configuration_schema,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = installed_connectors.connector_type AND ${connectorPredicate('crh', 2)}) AS total_runs,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = installed_connectors.connector_type AND crh.status = 'completed' AND ${connectorPredicate('crh', 2)}) AS successful_runs,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = installed_connectors.connector_type AND crh.status = 'failed' AND ${connectorPredicate('crh', 2)}) AS failed_runs,
          (SELECT MAX(started_at) FROM connector_run_history crh WHERE crh.connector_type = installed_connectors.connector_type AND ${connectorPredicate('crh', 2)}) AS last_run_at,
          (SELECT status FROM connector_run_history crh WHERE crh.connector_type = installed_connectors.connector_type AND ${connectorPredicate('crh', 2)} ORDER BY started_at DESC LIMIT 1) AS last_run_status,
          tags
        FROM installed_connectors
        WHERE connector_type = $1
      `;

      const result = await pgClient.query(query, [parent.connectorType, ...scopeValues(context.user)]);

      if (result.rows.length === 0) {
        throw new GraphQLError('Associated connector not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const row = result.rows[0];

      return {
        id: row.id,
        connectorType: row.connector_type,
        category: row.category.toUpperCase(),
        name: row.name,
        description: row.description,
        installedVersion: row.installed_version,
        latestAvailableVersion: row.latest_available_version,
        installedAt: row.installed_at,
        updatedAt: row.updated_at,
        enabled: row.enabled,
        verified: row.verified,
        installPath: row.install_path,
        metadata: row.metadata || {},
        capabilities: row.capabilities || { extraction: false, relationships: false, incremental: false, bidirectional: false },
        resources: row.resources || [],
        configurationSchema: row.configuration_schema || {},
        totalRuns: row.total_runs,
        successfulRuns: row.successful_runs,
        failedRuns: row.failed_runs,
        lastRunAt: row.last_run_at,
        lastRunStatus: row.last_run_status,
        tags: row.tags || [],
      };
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to resolve connector');
    }
  },

  /**
   * Resolve run history for configuration
   */
  runs: async (parent: { id: string }, args: { first?: number; offset?: number }, context: GraphQLContext) => {
    await requireOwnedParent(parent.id, context);
    try {
      const result = await getPostgresClient().query(
        `SELECT ${PUBLIC_RUN} FROM connector_run_history crh
         WHERE crh.config_id = $1 AND ${connectorPredicate('crh', 2)}
         ORDER BY crh.started_at DESC LIMIT $4 OFFSET $5`,
        [parent.id, ...scopeValues(context.user), Math.min(Math.max(args.first ?? 50, 1), 1000), Math.max(args.offset ?? 0, 0)]
      );
      return result.rows.map(row => ({
        id: row.id, organizationId: row.organization_id, configId: row.config_id,
        connectorType: row.connector_type, configName: row.config_name,
        resourceId: row.resource_id, startedAt: row.started_at, completedAt: row.completed_at,
        status: row.status.toUpperCase(), recordsExtracted: row.records_extracted,
        recordsTransformed: row.records_transformed, recordsLoaded: row.records_loaded,
        recordsFailed: row.records_failed, durationMs: row.duration_ms, triggeredBy: row.triggered_by,
      }));
    } catch {
      throw new GraphQLError('Failed to resolve runs');
    }
  },

  /**
   * Resolve computed metrics for configuration
   */
  metrics: async (parent: { id: string }, _args: unknown, context: GraphQLContext) => {
    await requireOwnedParent(parent.id, context);
    try {
      const pgClient = getPostgresClient();

      // Get overall run metrics
      const metricsQuery = `
        SELECT
          COUNT(*) as total_runs,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful_runs,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_runs,
          ROUND(
            100.0 * COUNT(CASE WHEN status = 'completed' THEN 1 END) /
            NULLIF(COUNT(*), 0),
            2
          ) as success_rate,
          AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END)::integer as avg_duration_ms,
          SUM(records_extracted + records_loaded) as total_records_processed
        FROM connector_run_history crh
        WHERE config_id = $1 AND ${connectorPredicate('crh', 2)}
      `;

      const metricsResult = await pgClient.query(metricsQuery, [parent.id, ...scopeValues(context.user)]);
      const metrics = metricsResult.rows[0];

      // Get per-resource metrics
      const resourceMetricsQuery = `
        SELECT
          resource_id,
          SUM(records_extracted) as total_records_extracted,
          SUM(records_loaded) as total_records_loaded,
          ROUND(
            100.0 * COUNT(CASE WHEN status = 'completed' THEN 1 END) /
            NULLIF(COUNT(*), 0),
            2
          ) as success_rate,
          AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms / 3 END)::integer as avg_extraction_time_ms,
          AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms / 3 END)::integer as avg_transformation_time_ms,
          AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms / 3 END)::integer as avg_load_time_ms
        FROM connector_run_history crh
        WHERE config_id = $1 AND resource_id IS NOT NULL AND ${connectorPredicate('crh', 2)}
        GROUP BY resource_id
        ORDER BY total_records_extracted DESC
      `;

      const resourceMetricsResult = await pgClient.query(resourceMetricsQuery, [parent.id, ...scopeValues(context.user)]);

      return {
        totalRuns: parseInt(metrics.total_runs) || 0,
        successfulRuns: parseInt(metrics.successful_runs) || 0,
        failedRuns: parseInt(metrics.failed_runs) || 0,
        successRate: parseFloat(metrics.success_rate) || 0,
        avgDurationMs: parseInt(metrics.avg_duration_ms) || 0,
        totalRecordsProcessed: parseInt(metrics.total_records_processed) || 0,
        resourceMetrics: resourceMetricsResult.rows.map(row => ({
          resourceId: row.resource_id,
          totalRecordsExtracted: parseInt(row.total_records_extracted) || 0,
          totalRecordsLoaded: parseInt(row.total_records_loaded) || 0,
          successRate: parseFloat(row.success_rate) || 0,
          avgExtractionTimeMs: parseInt(row.avg_extraction_time_ms) || 0,
          avgTransformationTimeMs: parseInt(row.avg_transformation_time_ms) || 0,
          avgLoadTimeMs: parseInt(row.avg_load_time_ms) || 0,
        })),
      };
    } catch {
      throw new GraphQLError('Failed to resolve metrics');
    }
  },
};

/**
 * Export field resolvers
 */
export const connectorFieldResolvers = {
  ConnectorConfiguration: ConnectorConfigurationFieldResolvers,
};
