// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/connector.resolvers.ts

import { GraphQLError } from 'graphql';
import { getPostgresClient } from '@cmdb/database';
import { getIntegrationManager } from '@cmdb/integration-framework/dist/core/integration-manager';
import { GraphQLContext } from './index';
import { checkGraphQLPermission as requirePermission } from '../../middleware/auth.middleware';
import { denyPlatformAdminGraphQL } from '../../middleware/platform-admin-unavailable';
import { publicInstalledConnectorGraphQL } from '../../services/public-installed-connector';
import { ConnectorJsonPatchBudget, ConnectorJsonPatchError, connectorJsonMerge } from '../../services/connector-json-merge';
import { connectorScope, connectorPredicate, scopeValues, PUBLIC_CONFIG, PUBLIC_RUN } from '../../auth/connector-scope';

function scopedUser(context: GraphQLContext) {
  const scope = connectorScope(context.user);
  if (!scope.organizationId) {
    throw new GraphQLError('Organization claim required', { extensions: { code: 'FORBIDDEN' } });
  }
  return scope;
}

function configNotFound(): GraphQLError {
  return new GraphQLError('Configuration not found', { extensions: { code: 'NOT_FOUND' } });
}

function mapConfigRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name,
    description: row.description, connectorType: row.connector_type,
    enabled: row.enabled, schedule: row.schedule, scheduleEnabled: row.schedule_enabled,
    enabledResources: row.enabled_resources || [], maxRetries: row.max_retries,
    retryDelaySeconds: row.retry_delay_seconds, continueOnError: row.continue_on_error,
    notificationOnSuccess: row.notification_on_success,
    notificationOnFailure: row.notification_on_failure, createdAt: row.created_at,
    updatedAt: row.updated_at, createdBy: row.created_by, updatedBy: row.updated_by,
  };
}


/** Maps a `connector_run_history` row (snake_case DB columns) to the GraphQL ConnectorRun shape. */
function mapConnectorRunRow(row: any): any {
  return {
    id: row.id,
    organizationId: row.organization_id,
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
    triggeredBy: row.triggered_by,
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
    } catch {
      throw new GraphQLError('Failed to retrieve connector registry');
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
    } catch {
      throw new GraphQLError('Failed to retrieve connector details');
    }
  },

  /**
   * Get installed connectors
   */
  installedConnectors: async (
    _parent: unknown,
    args: { category?: string; enabled?: boolean },
    context: GraphQLContext
  ): Promise<unknown[]> => {
    scopedUser(context);
    try {
      const pgClient = getPostgresClient();
      const conditions: string[] = [];
      const params: unknown[] = scopeValues(context.user);
      let paramIndex = 3;

      if (args.category) {
        conditions.push(`ic.category = $${paramIndex++}`);
        params.push(args.category.toLowerCase());
      }

      if (args.enabled !== undefined) {
        conditions.push(`ic.enabled = $${paramIndex++}`);
        params.push(args.enabled);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const query = `
        SELECT ic.id, ic.connector_type, ic.category, ic.name, ic.description,
          ic.installed_version, ic.latest_available_version, ic.installed_at,
          ic.updated_at, ic.enabled, ic.verified, ic.install_path, ic.metadata,
          ic.capabilities, ic.resources, ic.configuration_schema, ic.tags,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND ${connectorPredicate('crh', 1)}) AS total_runs,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND crh.status = 'completed' AND ${connectorPredicate('crh', 1)}) AS successful_runs,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND crh.status = 'failed' AND ${connectorPredicate('crh', 1)}) AS failed_runs,
          (SELECT MAX(started_at) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND ${connectorPredicate('crh', 1)}) AS last_run_at,
          (SELECT status FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND ${connectorPredicate('crh', 1)} ORDER BY started_at DESC LIMIT 1) AS last_run_status
        FROM installed_connectors ic ${whereClause} ORDER BY ic.name ASC
      `;
      const result = await pgClient.query(query, params);

      return result.rows.map(publicInstalledConnectorGraphQL);
    } catch {
      throw new GraphQLError('Failed to retrieve installed connectors');
    }
  },

  /**
   * Get installed connector by type
   */
  installedConnector: async (_parent: unknown, args: { connectorType: string }, context: GraphQLContext): Promise<unknown | null> => {
    scopedUser(context);
    try {
      const pgClient = getPostgresClient();

      const query = `
        SELECT ic.id, ic.connector_type, ic.category, ic.name, ic.description,
          ic.installed_version, ic.latest_available_version, ic.installed_at,
          ic.updated_at, ic.enabled, ic.verified, ic.install_path, ic.metadata,
          ic.capabilities, ic.resources, ic.configuration_schema, ic.tags,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND ${connectorPredicate('crh', 2)}) AS total_runs,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND crh.status = 'completed' AND ${connectorPredicate('crh', 2)}) AS successful_runs,
          (SELECT COUNT(*) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND crh.status = 'failed' AND ${connectorPredicate('crh', 2)}) AS failed_runs,
          (SELECT MAX(started_at) FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND ${connectorPredicate('crh', 2)}) AS last_run_at,
          (SELECT status FROM connector_run_history crh WHERE crh.connector_type = ic.connector_type AND ${connectorPredicate('crh', 2)} ORDER BY started_at DESC LIMIT 1) AS last_run_status
        FROM installed_connectors ic WHERE ic.connector_type = $1
      `;
      const result = await pgClient.query(query, [args.connectorType, ...scopeValues(context.user)]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return publicInstalledConnectorGraphQL(row);
    } catch {
      throw new GraphQLError('Failed to retrieve installed connector');
    }
  },

  /**
   * Get connector configurations
   */
  connectorConfigurations: async (_parent: unknown, args: { connectorType?: string; enabled?: boolean }, context: GraphQLContext) => {
    scopedUser(context);
    const params: unknown[] = scopeValues(context.user);
    const conditions = [connectorPredicate('cc', 1)];
    if (args.connectorType) {
      params.push(args.connectorType);
      conditions.push(`cc.connector_type = $${params.length}`);
    }
    if (args.enabled !== undefined) {
      params.push(args.enabled);
      conditions.push(`cc.enabled = $${params.length}`);
    }
    try {
      const result = await getPostgresClient().query(
        `SELECT ${PUBLIC_CONFIG} FROM connector_configurations cc WHERE ${conditions.join(' AND ')} ORDER BY cc.name ASC`,
        params
      );
      return result.rows.map(mapConfigRow);
    } catch {
      throw new GraphQLError('Failed to retrieve connector configurations');
    }
  },

  /**
   * Get connector configuration by ID
   */
  connectorConfiguration: async (_parent: unknown, args: { id: string }, context: GraphQLContext) => {
    scopedUser(context);
    try {
      const result = await getPostgresClient().query(
        `SELECT ${PUBLIC_CONFIG} FROM connector_configurations cc WHERE cc.id = $1 AND ${connectorPredicate('cc', 2)}`,
        [args.id, ...scopeValues(context.user)]
      );
      if (!result.rows.length) throw configNotFound();
      return mapConfigRow(result.rows[0]);
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to retrieve connector configuration');
    }
  },

  /**
   * Get connector runs
   */
  connectorRuns: async (_parent: unknown, args: { configId?: string; connectorType?: string; status?: string; first?: number; offset?: number }, context: GraphQLContext) => {
    scopedUser(context);
    const params: unknown[] = scopeValues(context.user);
    const conditions = [connectorPredicate('crh', 1)];
    if (args.configId) {
      params.push(args.configId);
      conditions.push(`crh.config_id = $${params.length}`);
    }
    if (args.connectorType) {
      params.push(args.connectorType);
      conditions.push(`crh.connector_type = $${params.length}`);
    }
    if (args.status) {
      params.push(args.status.toLowerCase());
      conditions.push(`crh.status = $${params.length}`);
    }
    params.push(Math.min(Math.max(args.first ?? 50, 1), 1000), Math.max(args.offset ?? 0, 0));
    try {
      if (args.configId) {
        const owner = await getPostgresClient().query(
          `SELECT id FROM connector_configurations cc WHERE cc.id = $1 AND ${connectorPredicate('cc', 2)}`,
          [args.configId, ...scopeValues(context.user)]
        );
        if (!owner.rows.length) throw configNotFound();
      }
      const result = await getPostgresClient().query(
        `SELECT ${PUBLIC_RUN} FROM connector_run_history crh WHERE ${conditions.join(' AND ')}
         ORDER BY crh.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return result.rows.map(mapConnectorRunRow);
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to retrieve connector runs');
    }
  },

  /**
   * Get connector run by ID
   */
  connectorRun: async (_parent: unknown, args: { id: string }, context: GraphQLContext) => {
    scopedUser(context);
    try {
      const result = await getPostgresClient().query(
        `SELECT ${PUBLIC_RUN} FROM connector_run_history crh WHERE crh.id = $1 AND ${connectorPredicate('crh', 2)}`,
        [args.id, ...scopeValues(context.user)]
      );
      if (!result.rows.length) throw new GraphQLError('Run not found', { extensions: { code: 'NOT_FOUND' } });
      return mapConnectorRunRow(result.rows[0]);
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to retrieve connector run');
    }
  },

  /**
   * Get connector statistics
   */
  connectorStats: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
    scopedUser(context);
    const values = scopeValues(context.user);
    try {
      const pg = getPostgresClient();
      const overall = await pg.query(
        `SELECT (SELECT COUNT(*) FROM installed_connectors) AS total_installed,
           (SELECT COUNT(*) FROM connector_configurations cc WHERE ${connectorPredicate('cc', 1)}) AS total_configurations,
           COUNT(*) FILTER (WHERE crh.started_at >= NOW() - INTERVAL '24 hours') AS total_runs_24h,
           ROUND(100.0 * COUNT(*) FILTER (WHERE crh.started_at >= NOW() - INTERVAL '24 hours' AND crh.status = 'completed')
             / NULLIF(COUNT(*) FILTER (WHERE crh.started_at >= NOW() - INTERVAL '24 hours'), 0), 2) AS success_rate_24h
         FROM connector_run_history crh WHERE ${connectorPredicate('crh', 1)}`, values
      );
      const top = await pg.query(
        `SELECT ic.connector_type, ic.name,
           (SELECT COUNT(*) FROM connector_configurations cc WHERE cc.connector_type = ic.connector_type AND ${connectorPredicate('cc', 1)}) AS total_configurations,
           COUNT(crh.id) AS total_runs,
           ROUND(100.0 * COUNT(crh.id) FILTER (WHERE crh.status = 'completed') / NULLIF(COUNT(crh.id), 0), 2) AS success_rate
         FROM installed_connectors ic LEFT JOIN connector_run_history crh
           ON crh.connector_type = ic.connector_type AND ${connectorPredicate('crh', 1)}
         GROUP BY ic.connector_type, ic.name ORDER BY total_runs DESC LIMIT 10`, values
      );
      const stats = overall.rows[0];
      return {
        totalInstalled: Number(stats.total_installed) || 0,
        totalConfigurations: Number(stats.total_configurations) || 0,
        totalRuns24h: Number(stats.total_runs_24h) || 0,
        successRate24h: Number(stats.success_rate_24h) || 0,
        topConnectors: top.rows.map(row => ({
          connectorType: row.connector_type, name: row.name,
          totalConfigurations: Number(row.total_configurations) || 0,
          totalRuns: Number(row.total_runs) || 0, successRate: Number(row.success_rate) || 0,
        })),
      };
    } catch {
      throw new GraphQLError('Failed to retrieve connector statistics');
    }
  },
};

/**
 * Connector Mutation Resolvers
 */
async function toggleConfiguration(id: string, enabled: boolean, context: GraphQLContext) {
  requirePermission(context, 'write');
  scopedUser(context);
  try {
    const result = await getPostgresClient().query(
      `UPDATE connector_configurations cc SET enabled = $4, updated_at = NOW()
       WHERE cc.id = $1 AND ${connectorPredicate('cc', 2)} RETURNING ${PUBLIC_CONFIG}`,
      [id, ...scopeValues(context.user), enabled]
    );
    if (!result.rows.length) throw configNotFound();
    return mapConfigRow(result.rows[0]);
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    throw new GraphQLError('Failed to update connector configuration');
  }
}

const ConnectorMutationResolvers = {
  // Connector installation and control are global. No tenant role/API key
  // substitutes for the dedicated platform-admin flag (HP1-S6/P-6).
  installConnector: denyPlatformAdminGraphQL,
  updateConnector: denyPlatformAdminGraphQL,
  uninstallConnector: denyPlatformAdminGraphQL,

  /**
   * Create connector configuration
   */
  createConnectorConfiguration: async (_parent: unknown, args: { input: Record<string, unknown> }, context: GraphQLContext) => {
    const user = requirePermission(context, 'write');
    const scope = scopedUser(context);
    // NULL ownership has no caller authority until the dedicated platform flag is available.
    if (!scope.organizationId) throw new GraphQLError('Organization claim required', { extensions: { code: 'FORBIDDEN' } });
    const input = args.input;
    const budget = new ConnectorJsonPatchBudget();
    try {
      const connectionJson = budget.add(input.connection ?? {});
      const optionsJson = budget.add(input.options ?? {});
      const resourceConfigsJson = budget.add(input.resourceConfigs ?? {});
      const result = await getPostgresClient().query(
        `INSERT INTO connector_configurations (
           organization_id, name, description, connector_type, enabled, schedule, schedule_enabled,
           connection, options, enabled_resources, resource_configs, max_retries, retry_delay_seconds,
           continue_on_error, notification_channels, notification_on_success, notification_on_failure, created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
         ) RETURNING ${PUBLIC_CONFIG}`,
        [scope.organizationId, input.name, input.description, input.connectorType,
         input.enabled ?? true, input.schedule, input.scheduleEnabled ?? false,
         connectionJson, optionsJson,
         input.enabledResources ?? [], resourceConfigsJson,
         input.maxRetries ?? 3, input.retryDelaySeconds ?? 300, input.continueOnError ?? false,
         input.notificationChannels ?? [], input.notificationOnSuccess ?? false,
         input.notificationOnFailure ?? true, user._username]
      );
      return mapConfigRow(result.rows[0]);
    } catch (error) {
      if (error instanceof ConnectorJsonPatchError) {
        throw new GraphQLError(error.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      throw new GraphQLError('Failed to create connector configuration');
    }
  },

  /**
   * Update connector configuration
   */
  updateConnectorConfiguration: async (_parent: unknown, args: { id: string; input: Record<string, unknown> }, context: GraphQLContext) => {
    const user = requirePermission(context, 'write');
    scopedUser(context);
    const columns: Record<string, string> = {
      name: 'name', description: 'description', enabled: 'enabled', schedule: 'schedule',
      scheduleEnabled: 'schedule_enabled', connection: 'connection', options: 'options',
      enabledResources: 'enabled_resources', resourceConfigs: 'resource_configs',
      maxRetries: 'max_retries', retryDelaySeconds: 'retry_delay_seconds',
      continueOnError: 'continue_on_error', notificationChannels: 'notification_channels',
      notificationOnSuccess: 'notification_on_success', notificationOnFailure: 'notification_on_failure',
    };
    const jsonColumns: Record<string, true> = { connection: true, options: true, resourceConfigs: true };
    const updates: string[] = [];
    const values: unknown[] = [args.id, ...scopeValues(context.user)];
    const budget = new ConnectorJsonPatchBudget();
    try {
      for (const [key, column] of Object.entries(columns)) {
        // An empty resourceConfigs object clears the root; only connection and
        // options empty editors preserve saved secrets.
        const value = args.input[key];
        if (value === undefined || ((jsonColumns[key] || key === 'notificationChannels') &&
          (key !== 'resourceConfigs' || Array.isArray(value)) &&
          value !== null && typeof value === 'object' && Object.keys(value).length === 0)) continue;
        if (jsonColumns[key]) {
          updates.push(`${column} = ${connectorJsonMerge(column, value, values, budget)}`);
        } else {
          values.push(value);
          updates.push(`${column} = $${values.length}`);
        }
      }
      values.push(user._username);
      updates.push(`updated_at = NOW()`, `updated_by = $${values.length}`);
      const result = await getPostgresClient().query(
        `UPDATE connector_configurations cc SET ${updates.join(', ')}
         WHERE cc.id = $1 AND ${connectorPredicate('cc', 2)} RETURNING ${PUBLIC_CONFIG}`,
        values
      );
      if (!result.rows.length) throw configNotFound();
      return mapConfigRow(result.rows[0]);
    } catch (error) {
      if (error instanceof ConnectorJsonPatchError) {
        throw new GraphQLError(error.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to update connector configuration');
    }
  },

  /**
   * Delete connector configuration
   */
  deleteConnectorConfiguration: async (_parent: unknown, args: { id: string }, context: GraphQLContext) => {
    requirePermission(context, 'write');
    scopedUser(context);
    try {
      const result = await getPostgresClient().query(
        `DELETE FROM connector_configurations cc WHERE cc.id = $1 AND ${connectorPredicate('cc', 2)} RETURNING id`,
        [args.id, ...scopeValues(context.user)]
      );
      if (!result.rows.length) throw configNotFound();
      return { success: true, message: 'Configuration deleted successfully' };
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to delete connector configuration');
    }
  },

  /** Run only the verified configuration; executor rechecks ownership before reading secrets. */
  runConnector: async (_parent: unknown, args: { id: string }, context: GraphQLContext) => {
    const user = requirePermission(context, 'write');
    scopedUser(context);
    try {
      const pg = getPostgresClient();
      const config = await pg.query(
        `SELECT id, organization_id, enabled, credential_id FROM connector_configurations cc
         WHERE cc.id = $1 AND ${connectorPredicate('cc', 2)}`,
        [args.id, ...scopeValues(context.user)]
      );
      if (!config.rows.length) throw configNotFound();
      if (config.rows[0].credential_id) {
        throw new GraphQLError('Connector credential reference unavailable', {
          extensions: { code: 'CONNECTOR_CREDENTIAL_UNAVAILABLE' },
        });
      }
      if (!config.rows[0].enabled) throw new GraphQLError('Configuration is disabled', { extensions: { code: 'BAD_USER_INPUT' } });
      const run = await getIntegrationManager().runConnector(args.id, config.rows[0].organization_id, 'manual', user._username);
      const history = await pg.query(
        `SELECT ${PUBLIC_RUN} FROM connector_run_history crh
         WHERE crh.job_id = $1 AND crh.config_id = $2 AND ${connectorPredicate('crh', 3)}`,
        [run.run_id, args.id, ...scopeValues(context.user)]
      );
      if (!history.rows.length) throw new GraphQLError('Connector run did not produce a history record');
      return mapConnectorRunRow(history.rows[0]);
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      if (error instanceof Error && error.message === 'CONNECTOR_CREDENTIAL_UNAVAILABLE') {
        throw new GraphQLError('Connector credential reference unavailable', {
          extensions: { code: 'CONNECTOR_CREDENTIAL_UNAVAILABLE' },
        });
      }
      throw new GraphQLError('Failed to run connector');
    }
  },

  /**
   * Enable connector configuration
   */
  enableConnectorConfiguration: async (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
    toggleConfiguration(args.id, true, context),

  /**
   * Disable connector configuration
   */
  disableConnectorConfiguration: async (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
    toggleConfiguration(args.id, false, context),
};

/**
 * Export connector resolvers
 */
export const connectorResolvers = {
  Query: ConnectorQueryResolvers,
  Mutation: ConnectorMutationResolvers,
};
