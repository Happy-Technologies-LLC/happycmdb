// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/connector.resolvers.ts

import { GraphQLError } from 'graphql';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { getIntegrationManager } from '@cmdb/integration-framework';
import { GraphQLContext } from './index';
import { checkGraphQLPermission as requirePermission } from '../../middleware/auth.middleware';
import { ConnectorLifecycleService } from '../../services/connector-lifecycle.service';

/** Maps an `installed_connectors` row (snake_case DB columns) to the GraphQL InstalledConnector shape. */
function mapInstalledConnectorRow(row: any): any {
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
}

/** Maps a `connector_run_history` row (snake_case DB columns) to the GraphQL ConnectorRun shape. */
function mapConnectorRunRow(row: any): any {
  return {
    id: row.id,
    configId: row.config_id,
    connectorType: row.connector_type,
    configName: row.config_name,
    resourceId: row.resource_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status.toUpperCase(),
    recordsExtracted: row.records_extracted,
    recordsTransformed: row.records_transformed,
    recordsLoaded: row.records_loaded,
    recordsFailed: row.records_failed,
    durationMs: row.duration_ms,
    errors: row.errors || [],
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by,
    triggeredByUser: row.triggered_by_user,
    jobId: row.job_id,
  };
}

/** Maps a catalog version JSON entry, tolerating the legacy `releaseDate` key seeded at startup. */
function mapConnectorVersion(version: any): any {
  return {
    ...version,
    releasedAt: version.releasedAt ?? version.releaseDate ?? null,
  };
}

/**
 * Connector Query Resolvers
 */
const ConnectorQueryResolvers = {
  /**
   * Get connector registry (remote catalog)
   */
  connectorRegistry: async (
    _parent: any,
    args: {
      category?: string;
      search?: string;
      tags?: string[];
      verifiedOnly?: boolean;
    }
  ): Promise<any[]> => {
    try {
      const pgClient = getPostgresClient();
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (args.category) {
        conditions.push(`category = $${paramIndex++}`);
        params.push(args.category.toLowerCase());
      }

      if (args.search) {
        conditions.push(`(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
        params.push(`%${args.search}%`);
        paramIndex++;
      }

      if (args.tags && args.tags.length > 0) {
        conditions.push(`tags && $${paramIndex}::text[]`);
        params.push(args.tags);
        paramIndex++;
      }

      if (args.verifiedOnly) {
        conditions.push('verified = true');
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const query = `
        SELECT
          connector_type,
          category,
          name,
          description,
          verified,
          latest_version,
          versions,
          author,
          homepage,
          repository,
          license,
          downloads,
          rating,
          tags
        FROM connector_registry_cache
        ${whereClause}
        ORDER BY verified DESC, downloads DESC, name ASC
      `;

      const result = await pgClient.query(query, params);

      return result.rows.map(row => ({
        connectorType: row.connector_type,
        category: row.category.toUpperCase(),
        name: row.name,
        description: row.description,
        verified: row.verified,
        latestVersion: row.latest_version,
        versions: (row.versions || []).map(mapConnectorVersion),
        author: row.author,
        homepage: row.homepage,
        repository: row.repository,
        license: row.license,
        downloads: row.downloads,
        rating: parseFloat(row.rating),
        tags: row.tags || [],
        metadata: row.metadata || {},
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error fetching connector registry', error);
      throw new GraphQLError('Failed to retrieve connector registry', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get connector details from registry
   */
  connectorRegistryDetails: async (
    _parent: any,
    args: { connectorType: string }
  ): Promise<any | null> => {
    try {
      const pgClient = getPostgresClient();

      const query = `
        SELECT
          connector_type,
          category,
          name,
          description,
          verified,
          latest_version,
          versions,
          author,
          homepage,
          repository,
          license,
          downloads,
          rating,
          tags
        FROM connector_registry_cache
        WHERE connector_type = $1
      `;

      const result = await pgClient.query(query, [args.connectorType]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        connectorType: row.connector_type,
        category: row.category.toUpperCase(),
        name: row.name,
        description: row.description,
        verified: row.verified,
        latestVersion: row.latest_version,
        versions: (row.versions || []).map(mapConnectorVersion),
        author: row.author,
        homepage: row.homepage,
        repository: row.repository,
        license: row.license,
        downloads: row.downloads,
        rating: parseFloat(row.rating),
        tags: row.tags || [],
        metadata: row.metadata || {},
      };
    } catch (error: any) {
      logger.error('GraphQL: Error fetching connector registry details', error);
      throw new GraphQLError('Failed to retrieve connector details', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get installed connectors
   */
  installedConnectors: async (
    _parent: any,
    args: {
      category?: string;
      enabled?: boolean;
    }
  ): Promise<any[]> => {
    try {
      const pgClient = getPostgresClient();
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (args.category) {
        conditions.push(`category = $${paramIndex++}`);
        params.push(args.category.toLowerCase());
      }

      if (args.enabled !== undefined) {
        conditions.push(`enabled = $${paramIndex++}`);
        params.push(args.enabled);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
          total_runs,
          successful_runs,
          failed_runs,
          last_run_at,
          last_run_status,
          tags
        FROM installed_connectors
        ${whereClause}
        ORDER BY name ASC
      `;

      const result = await pgClient.query(query, params);

      return result.rows.map(row => ({
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
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error fetching installed connectors', error);
      throw new GraphQLError('Failed to retrieve installed connectors', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get installed connector by type
   */
  installedConnector: async (
    _parent: any,
    args: { connectorType: string }
  ): Promise<any | null> => {
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
          total_runs,
          successful_runs,
          failed_runs,
          last_run_at,
          last_run_status,
          tags
        FROM installed_connectors
        WHERE connector_type = $1
      `;

      const result = await pgClient.query(query, [args.connectorType]);

      if (result.rows.length === 0) {
        return null;
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
    } catch (error: any) {
      logger.error('GraphQL: Error fetching installed connector', error);
      throw new GraphQLError('Failed to retrieve installed connector', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get connector configurations
   */
  connectorConfigurations: async (
    _parent: any,
    args: {
      connectorType?: string;
      enabled?: boolean;
    }
  ): Promise<any[]> => {
    try {
      const pgClient = getPostgresClient();
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (args.connectorType) {
        conditions.push(`connector_type = $${paramIndex++}`);
        params.push(args.connectorType);
      }

      if (args.enabled !== undefined) {
        conditions.push(`enabled = $${paramIndex++}`);
        params.push(args.enabled);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const query = `
        SELECT
          id,
          name,
          description,
          connector_type,
          enabled,
          schedule,
          schedule_enabled,
          connection,
          options,
          enabled_resources,
          resource_configs,
          max_retries,
          retry_delay_seconds,
          continue_on_error,
          notification_channels,
          notification_on_success,
          notification_on_failure,
          created_at,
          updated_at,
          created_by
        FROM connector_configurations
        ${whereClause}
        ORDER BY name ASC
      `;

      const result = await pgClient.query(query, params);

      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        connectorType: row.connector_type,
        enabled: row.enabled,
        schedule: row.schedule,
        scheduleEnabled: row.schedule_enabled,
        connection: row.connection || {},
        options: row.options || {},
        enabledResources: row.enabled_resources || [],
        resourceConfigs: row.resource_configs || {},
        maxRetries: row.max_retries,
        retryDelaySeconds: row.retry_delay_seconds,
        continueOnError: row.continue_on_error,
        notificationChannels: row.notification_channels || [],
        notificationOnSuccess: row.notification_on_success,
        notificationOnFailure: row.notification_on_failure,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error fetching connector configurations', error);
      throw new GraphQLError('Failed to retrieve connector configurations', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get connector configuration by ID
   */
  connectorConfiguration: async (
    _parent: any,
    args: { id: string }
  ): Promise<any | null> => {
    try {
      const pgClient = getPostgresClient();

      const query = `
        SELECT
          id,
          name,
          description,
          connector_type,
          enabled,
          schedule,
          schedule_enabled,
          connection,
          options,
          enabled_resources,
          resource_configs,
          max_retries,
          retry_delay_seconds,
          continue_on_error,
          notification_channels,
          notification_on_success,
          notification_on_failure,
          created_at,
          updated_at,
          created_by
        FROM connector_configurations
        WHERE id = $1
      `;

      const result = await pgClient.query(query, [args.id]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        connectorType: row.connector_type,
        enabled: row.enabled,
        schedule: row.schedule,
        scheduleEnabled: row.schedule_enabled,
        connection: row.connection || {},
        options: row.options || {},
        enabledResources: row.enabled_resources || [],
        resourceConfigs: row.resource_configs || {},
        maxRetries: row.max_retries,
        retryDelaySeconds: row.retry_delay_seconds,
        continueOnError: row.continue_on_error,
        notificationChannels: row.notification_channels || [],
        notificationOnSuccess: row.notification_on_success,
        notificationOnFailure: row.notification_on_failure,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
      };
    } catch (error: any) {
      logger.error('GraphQL: Error fetching connector configuration', error);
      throw new GraphQLError('Failed to retrieve connector configuration', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get connector runs
   */
  connectorRuns: async (
    _parent: any,
    args: {
      configId?: string;
      connectorType?: string;
      status?: string;
      first?: number;
      offset?: number;
    }
  ): Promise<any[]> => {
    try {
      const pgClient = getPostgresClient();
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (args.configId) {
        conditions.push(`config_id = $${paramIndex++}`);
        params.push(args.configId);
      }

      if (args.connectorType) {
        conditions.push(`connector_type = $${paramIndex++}`);
        params.push(args.connectorType);
      }

      if (args.status) {
        conditions.push(`status = $${paramIndex++}`);
        params.push(args.status.toLowerCase());
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = Math.min(args.first || 50, 1000);
      const offset = args.offset || 0;

      const query = `
        SELECT
          id,
          config_id,
          connector_type,
          config_name,
          resource_id,
          started_at,
          completed_at,
          status,
          records_extracted,
          records_transformed,
          records_loaded,
          records_failed,
          duration_ms,
          errors,
          error_message,
          triggered_by,
          triggered_by_user,
          job_id
        FROM connector_run_history
        ${whereClause}
        ORDER BY started_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;

      params.push(limit, offset);

      const result = await pgClient.query(query, params);

      return result.rows.map(row => ({
        id: row.id,
        configId: row.config_id,
        connectorType: row.connector_type,
        configName: row.config_name,
        resourceId: row.resource_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        status: row.status.toUpperCase(),
        recordsExtracted: row.records_extracted,
        recordsTransformed: row.records_transformed,
        recordsLoaded: row.records_loaded,
        recordsFailed: row.records_failed,
        durationMs: row.duration_ms,
        errors: row.errors || [],
        errorMessage: row.error_message,
        triggeredBy: row.triggered_by,
        triggeredByUser: row.triggered_by_user,
        jobId: row.job_id,
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error fetching connector runs', error);
      throw new GraphQLError('Failed to retrieve connector runs', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get connector run by ID
   */
  connectorRun: async (
    _parent: any,
    args: { id: string }
  ): Promise<any | null> => {
    try {
      const pgClient = getPostgresClient();

      const query = `
        SELECT
          id,
          config_id,
          connector_type,
          config_name,
          resource_id,
          started_at,
          completed_at,
          status,
          records_extracted,
          records_transformed,
          records_loaded,
          records_failed,
          duration_ms,
          errors,
          error_message,
          triggered_by,
          triggered_by_user,
          job_id
        FROM connector_run_history
        WHERE id = $1
      `;

      const result = await pgClient.query(query, [args.id]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        id: row.id,
        configId: row.config_id,
        connectorType: row.connector_type,
        configName: row.config_name,
        resourceId: row.resource_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        status: row.status.toUpperCase(),
        recordsExtracted: row.records_extracted,
        recordsTransformed: row.records_transformed,
        recordsLoaded: row.records_loaded,
        recordsFailed: row.records_failed,
        durationMs: row.duration_ms,
        errors: row.errors || [],
        errorMessage: row.error_message,
        triggeredBy: row.triggered_by,
        triggeredByUser: row.triggered_by_user,
        jobId: row.job_id,
      };
    } catch (error: any) {
      logger.error('GraphQL: Error fetching connector run', error);
      throw new GraphQLError('Failed to retrieve connector run', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get connector statistics
   */
  connectorStats: async (): Promise<any> => {
    try {
      const pgClient = getPostgresClient();

      // Get overall stats
      const statsQuery = `
        SELECT
          COUNT(DISTINCT ic.id) as total_installed,
          COUNT(DISTINCT cc.id) as total_configurations,
          COUNT(DISTINCT CASE
            WHEN crh.started_at >= NOW() - INTERVAL '24 hours'
            THEN crh.id
          END) as total_runs_24h,
          ROUND(
            100.0 * COUNT(CASE
              WHEN crh.started_at >= NOW() - INTERVAL '24 hours'
                AND crh.status = 'completed'
              THEN 1
            END) / NULLIF(COUNT(CASE
              WHEN crh.started_at >= NOW() - INTERVAL '24 hours'
              THEN 1
            END), 0),
            2
          ) as success_rate_24h
        FROM installed_connectors ic
        LEFT JOIN connector_configurations cc ON cc.connector_type = ic.connector_type
        LEFT JOIN connector_run_history crh ON crh.connector_type = ic.connector_type
      `;

      const statsResult = await pgClient.query(statsQuery);
      const stats = statsResult.rows[0];

      // Get top connectors
      const topConnectorsQuery = `
        SELECT
          ic.connector_type,
          ic.name,
          COUNT(DISTINCT cc.id) as total_configurations,
          COUNT(crh.id) as total_runs,
          ROUND(
            100.0 * COUNT(CASE WHEN crh.status = 'completed' THEN 1 END) /
            NULLIF(COUNT(crh.id), 0),
            2
          ) as success_rate
        FROM installed_connectors ic
        LEFT JOIN connector_configurations cc ON cc.connector_type = ic.connector_type
        LEFT JOIN connector_run_history crh ON crh.connector_type = ic.connector_type
        GROUP BY ic.connector_type, ic.name
        ORDER BY total_runs DESC
        LIMIT 10
      `;

      const topConnectorsResult = await pgClient.query(topConnectorsQuery);

      return {
        totalInstalled: parseInt(stats.total_installed) || 0,
        totalConfigurations: parseInt(stats.total_configurations) || 0,
        totalRuns24h: parseInt(stats.total_runs_24h) || 0,
        successRate24h: parseFloat(stats.success_rate_24h) || 0,
        topConnectors: topConnectorsResult.rows.map(row => ({
          connectorType: row.connector_type,
          name: row.name,
          totalConfigurations: parseInt(row.total_configurations) || 0,
          totalRuns: parseInt(row.total_runs) || 0,
          successRate: parseFloat(row.success_rate) || 0,
        })),
      };
    } catch (error: any) {
      logger.error('GraphQL: Error fetching connector stats', error);
      throw new GraphQLError('Failed to retrieve connector statistics', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },
};

/**
 * Connector Mutation Resolvers
 */
const ConnectorMutationResolvers = {
  /**
   * Install connector from registry (admin only)
   */
  installConnector: async (
    _parent: any,
    args: { connectorType: string; version?: string },
    context: GraphQLContext
  ): Promise<any> => {
    requirePermission(context, 'admin');
    try {
      const lifecycleService = new ConnectorLifecycleService();
      const outcome = await lifecycleService.installConnector(args.connectorType, args.version);
      return {
        success: outcome.success,
        connector: outcome.connector ? mapInstalledConnectorRow(outcome.connector) : null,
        message: outcome.message,
        errors: outcome.errors,
      };
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      logger.error('GraphQL: Error installing connector', error);
      throw new GraphQLError('Failed to install connector', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Update connector to a newer version (admin only)
   */
  updateConnector: async (
    _parent: any,
    args: { connectorType: string; version?: string },
    context: GraphQLContext
  ): Promise<any> => {
    requirePermission(context, 'admin');
    try {
      const lifecycleService = new ConnectorLifecycleService();
      const outcome = await lifecycleService.updateConnector(args.connectorType, args.version);
      return {
        success: outcome.success,
        connector: outcome.connector ? mapInstalledConnectorRow(outcome.connector) : null,
        previousVersion: outcome.previousVersion,
        newVersion: outcome.newVersion,
        message: outcome.message,
        errors: outcome.errors,
      };
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      logger.error('GraphQL: Error updating connector', error);
      throw new GraphQLError('Failed to update connector', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Uninstall connector (admin only)
   */
  uninstallConnector: async (
    _parent: any,
    args: { connectorType: string },
    context: GraphQLContext
  ): Promise<any> => {
    requirePermission(context, 'admin');
    try {
      const lifecycleService = new ConnectorLifecycleService();
      const outcome = await lifecycleService.uninstallConnector(args.connectorType);
      return {
        success: outcome.success,
        message: outcome.message,
        errors: outcome.errors,
      };
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      logger.error('GraphQL: Error uninstalling connector', error);
      throw new GraphQLError('Failed to uninstall connector', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Create connector configuration
   */
  createConnectorConfiguration: async (
    _parent: any,
    args: { input: any },
    context: GraphQLContext
  ): Promise<any> => {
    const user = requirePermission(context, 'write');
    try {
      const pgClient = getPostgresClient();

      const query = `
        INSERT INTO connector_configurations (
          name,
          description,
          connector_type,
          enabled,
          schedule,
          schedule_enabled,
          connection,
          options,
          enabled_resources,
          resource_configs,
          max_retries,
          retry_delay_seconds,
          continue_on_error,
          notification_channels,
          notification_on_success,
          notification_on_failure,
          created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
        )
        RETURNING *
      `;

      const values = [
        args.input.name,
        args.input.description,
        args.input.connectorType,
        args.input.enabled ?? true,
        args.input.schedule,
        args.input.scheduleEnabled ?? false,
        JSON.stringify(args.input.connection),
        JSON.stringify(args.input.options || {}),
        args.input.enabledResources || [],
        JSON.stringify(args.input.resourceConfigs || {}),
        args.input.maxRetries ?? 3,
        args.input.retryDelaySeconds ?? 300,
        args.input.continueOnError ?? false,
        args.input.notificationChannels || [],
        args.input.notificationOnSuccess ?? false,
        args.input.notificationOnFailure ?? true,
        user._username,
      ];

      const result = await pgClient.query(query, values);
      const row = result.rows[0];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        connectorType: row.connector_type,
        enabled: row.enabled,
        schedule: row.schedule,
        scheduleEnabled: row.schedule_enabled,
        connection: row.connection,
        options: row.options,
        enabledResources: row.enabled_resources,
        resourceConfigs: row.resource_configs,
        maxRetries: row.max_retries,
        retryDelaySeconds: row.retry_delay_seconds,
        continueOnError: row.continue_on_error,
        notificationChannels: row.notification_channels,
        notificationOnSuccess: row.notification_on_success,
        notificationOnFailure: row.notification_on_failure,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
      };
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      logger.error('GraphQL: Error creating connector configuration', error);
      throw new GraphQLError('Failed to create connector configuration', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Update connector configuration
   */
  updateConnectorConfiguration: async (
    _parent: any,
    args: { id: string; input: any },
    context: GraphQLContext
  ): Promise<any> => {
    const user = requirePermission(context, 'write');
    try {
      const pgClient = getPostgresClient();

      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (args.input.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        values.push(args.input.name);
      }

      if (args.input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        values.push(args.input.description);
      }

      if (args.input.enabled !== undefined) {
        updates.push(`enabled = $${paramIndex++}`);
        values.push(args.input.enabled);
      }

      if (args.input.schedule !== undefined) {
        updates.push(`schedule = $${paramIndex++}`);
        values.push(args.input.schedule);
      }

      if (args.input.scheduleEnabled !== undefined) {
        updates.push(`schedule_enabled = $${paramIndex++}`);
        values.push(args.input.scheduleEnabled);
      }

      if (args.input.connection !== undefined) {
        updates.push(`connection = $${paramIndex++}`);
        values.push(JSON.stringify(args.input.connection));
      }

      if (args.input.options !== undefined) {
        updates.push(`options = $${paramIndex++}`);
        values.push(JSON.stringify(args.input.options));
      }

      if (args.input.enabledResources !== undefined) {
        updates.push(`enabled_resources = $${paramIndex++}`);
        values.push(args.input.enabledResources);
      }

      if (args.input.resourceConfigs !== undefined) {
        updates.push(`resource_configs = $${paramIndex++}`);
        values.push(JSON.stringify(args.input.resourceConfigs));
      }

      if (args.input.maxRetries !== undefined) {
        updates.push(`max_retries = $${paramIndex++}`);
        values.push(args.input.maxRetries);
      }

      if (args.input.retryDelaySeconds !== undefined) {
        updates.push(`retry_delay_seconds = $${paramIndex++}`);
        values.push(args.input.retryDelaySeconds);
      }

      if (args.input.continueOnError !== undefined) {
        updates.push(`continue_on_error = $${paramIndex++}`);
        values.push(args.input.continueOnError);
      }

      if (args.input.notificationChannels !== undefined) {
        updates.push(`notification_channels = $${paramIndex++}`);
        values.push(args.input.notificationChannels);
      }

      if (args.input.notificationOnSuccess !== undefined) {
        updates.push(`notification_on_success = $${paramIndex++}`);
        values.push(args.input.notificationOnSuccess);
      }

      if (args.input.notificationOnFailure !== undefined) {
        updates.push(`notification_on_failure = $${paramIndex++}`);
        values.push(args.input.notificationOnFailure);
      }

      updates.push(`updated_at = NOW()`);
      updates.push(`updated_by = $${paramIndex++}`);
      values.push(user._username);

      values.push(args.id);

      const query = `
        UPDATE connector_configurations
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await pgClient.query(query, values);

      if (result.rows.length === 0) {
        throw new GraphQLError('Configuration not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const row = result.rows[0];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        connectorType: row.connector_type,
        enabled: row.enabled,
        schedule: row.schedule,
        scheduleEnabled: row.schedule_enabled,
        connection: row.connection,
        options: row.options,
        enabledResources: row.enabled_resources,
        resourceConfigs: row.resource_configs,
        maxRetries: row.max_retries,
        retryDelaySeconds: row.retry_delay_seconds,
        continueOnError: row.continue_on_error,
        notificationChannels: row.notification_channels,
        notificationOnSuccess: row.notification_on_success,
        notificationOnFailure: row.notification_on_failure,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
      };
    } catch (error: any) {
      logger.error('GraphQL: Error updating connector configuration', error);
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to update connector configuration', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Delete connector configuration
   */
  deleteConnectorConfiguration: async (
    _parent: any,
    args: { id: string },
    context: GraphQLContext
  ): Promise<any> => {
    requirePermission(context, 'write');
    try {
      const pgClient = getPostgresClient();

      const query = `
        DELETE FROM connector_configurations
        WHERE id = $1
        RETURNING id
      `;

      const result = await pgClient.query(query, [args.id]);

      if (result.rows.length === 0) {
        throw new GraphQLError('Configuration not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      return {
        success: true,
        message: 'Configuration deleted successfully',
      };
    } catch (error: any) {
      logger.error('GraphQL: Error deleting connector configuration', error);
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to delete connector configuration', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Run connector manually. Registers the connector with the
   * IntegrationManager on demand if it wasn't already loaded at startup,
   * runs it, and returns the resulting run-history record regardless of
   * whether the run itself succeeded or failed.
   */
  runConnector: async (
    _parent: any,
    args: { id: string },
    context: GraphQLContext
  ): Promise<any> => {
    const user = requirePermission(context, 'write');
    try {
      const pgClient = getPostgresClient();
      const configResult = await pgClient.query(
        'SELECT * FROM connector_configurations WHERE id = $1',
        [args.id]
      );

      if (configResult.rows.length === 0) {
        throw new GraphQLError('Configuration not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const configRow = configResult.rows[0];

      if (!configRow.enabled) {
        throw new GraphQLError('Configuration is disabled', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      const integrationManager = getIntegrationManager();
      if (!integrationManager.getConnector(configRow.name)) {
        await integrationManager.registerConnector(integrationManager.mapRowToConfig(configRow));
      }

      try {
        await integrationManager.runConnector(configRow.name, 'manual', user._username);
      } catch (runError) {
        // The failure is already recorded in connector_run_history by
        // IntegrationManager; surface the resulting run record below
        // instead of throwing here.
        logger.warn('GraphQL: connector run failed', {
          configId: args.id,
          error: (runError as Error).message,
        });
      }

      const runResult = await pgClient.query(
        `SELECT * FROM connector_run_history WHERE config_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [args.id]
      );

      if (runResult.rows.length === 0) {
        throw new GraphQLError('Connector run did not produce a history record', {
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        });
      }

      return mapConnectorRunRow(runResult.rows[0]);
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      logger.error('GraphQL: Error running connector', error);
      throw new GraphQLError('Failed to run connector', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Enable connector configuration
   */
  enableConnectorConfiguration: async (
    _parent: any,
    args: { id: string },
    context: GraphQLContext
  ): Promise<any> => {
    requirePermission(context, 'write');
    try {
      const pgClient = getPostgresClient();

      const query = `
        UPDATE connector_configurations
        SET enabled = true, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;

      const result = await pgClient.query(query, [args.id]);

      if (result.rows.length === 0) {
        throw new GraphQLError('Configuration not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const row = result.rows[0];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        connectorType: row.connector_type,
        enabled: row.enabled,
        schedule: row.schedule,
        scheduleEnabled: row.schedule_enabled,
        connection: row.connection,
        options: row.options,
        enabledResources: row.enabled_resources,
        resourceConfigs: row.resource_configs,
        maxRetries: row.max_retries,
        retryDelaySeconds: row.retry_delay_seconds,
        continueOnError: row.continue_on_error,
        notificationChannels: row.notification_channels,
        notificationOnSuccess: row.notification_on_success,
        notificationOnFailure: row.notification_on_failure,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
      };
    } catch (error: any) {
      logger.error('GraphQL: Error enabling connector configuration', error);
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to enable connector configuration', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Disable connector configuration
   */
  disableConnectorConfiguration: async (
    _parent: any,
    args: { id: string },
    context: GraphQLContext
  ): Promise<any> => {
    requirePermission(context, 'write');
    try {
      const pgClient = getPostgresClient();

      const query = `
        UPDATE connector_configurations
        SET enabled = false, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `;

      const result = await pgClient.query(query, [args.id]);

      if (result.rows.length === 0) {
        throw new GraphQLError('Configuration not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const row = result.rows[0];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        connectorType: row.connector_type,
        enabled: row.enabled,
        schedule: row.schedule,
        scheduleEnabled: row.schedule_enabled,
        connection: row.connection,
        options: row.options,
        enabledResources: row.enabled_resources,
        resourceConfigs: row.resource_configs,
        maxRetries: row.max_retries,
        retryDelaySeconds: row.retry_delay_seconds,
        continueOnError: row.continue_on_error,
        notificationChannels: row.notification_channels,
        notificationOnSuccess: row.notification_on_success,
        notificationOnFailure: row.notification_on_failure,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
      };
    } catch (error: any) {
      logger.error('GraphQL: Error disabling connector configuration', error);
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to disable connector configuration', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },
};

/**
 * Export connector resolvers
 */
export const connectorResolvers = {
  Query: ConnectorQueryResolvers,
  Mutation: ConnectorMutationResolvers,
};
