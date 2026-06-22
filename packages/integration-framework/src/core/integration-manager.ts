// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * IntegrationManager (v2.0)
 * Manages connector lifecycle and scheduling
 */

import * as cron from 'node-cron';
import { logger } from '@cmdb/common';
import { getPostgresClient, getUnifiedCredentialService, getOAuthSubstrate } from '@cmdb/database';
import { BaseIntegrationConnector } from './base-connector';
import { getConnectorRegistry } from '../registry/connector-registry';
import { ConnectorConfiguration, ConnectorRunResult } from '../types/connector.types';
import { getEventProducer } from '@cmdb/event-processor';
import { EventType } from '@cmdb/event-processor';

export class IntegrationManager {
  private static instance: IntegrationManager;
  private connectors: Map<string, BaseIntegrationConnector> = new Map();
  private schedules: Map<string, cron.ScheduledTask> = new Map();
  private postgresClient = getPostgresClient();
  private eventProducer = getEventProducer();

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): IntegrationManager {
    if (!IntegrationManager.instance) {
      IntegrationManager.instance = new IntegrationManager();
    }
    return IntegrationManager.instance;
  }

  /**
   * Load all connector configurations from database
   */
  async loadConnectors(): Promise<void> {
    logger.info('Loading connector configurations from database');

    const result = await this.postgresClient.query(
      'SELECT * FROM connector_configurations WHERE enabled = true'
    );

    for (const row of result.rows) {
      try {
        await this.registerConnector(this.mapRowToConfig(row));
      } catch (error) {
        logger.error('Failed to register connector', {
          name: row.name,
          error
        });
      }
    }

    logger.info('Connector configurations loaded', { count: this.connectors.size });
  }

  /**
   * Register connector instance
   */
  async registerConnector(config: ConnectorConfiguration): Promise<void> {
    const registry = getConnectorRegistry();

    // Create connector instance
    const connector = registry.createConnector(config);

    // Set up event listeners
    this.setupConnectorListeners(connector, config.name);

    // Store connector
    this.connectors.set(config.name, connector);

    // Schedule if cron schedule provided
    if (config.schedule) {
      this.scheduleConnector(config.name, config.schedule);
    }

    logger.info('Connector registered', {
      name: config.name,
      type: config.type,
      scheduled: !!config.schedule
    });
  }

  /**
   * Schedule connector to run on cron schedule
   */
  private scheduleConnector(connectorName: string, schedule: string): void {
    // Cancel existing schedule if any
    this.cancelSchedule(connectorName);

    // Validate cron expression
    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron schedule: ${schedule}`);
    }

    // Create scheduled task
    const task = cron.schedule(schedule, async () => {
      logger.info('Scheduled connector run starting', { connector: connectorName });
      await this.runConnector(connectorName);
    });

    this.schedules.set(connectorName, task);
    logger.info('Connector scheduled', { connector: connectorName, schedule });
  }

  /**
   * Cancel scheduled task
   */
  private cancelSchedule(connectorName: string): void {
    const task = this.schedules.get(connectorName);
    if (task) {
      task.stop();
      this.schedules.delete(connectorName);
    }
  }

  /**
   * Set up event listeners for connector
   */
  private setupConnectorListeners(
    connector: BaseIntegrationConnector,
    connectorName: string
  ): void {
    // Log all events
    connector.on('extraction_started', (data) => {
      logger.info('Extraction started', data);
    });

    connector.on('extraction_completed', (data) => {
      logger.info('Extraction completed', data);
    });

    connector.on('extraction_failed', (data) => {
      logger.error('Extraction failed', data);
    });

    connector.on('ci_discovered', async (data) => {
      // Forward to identity resolution engine
      // This will be implemented in identity-resolution package
      logger.debug('CI discovered', {
        connector: connectorName,
        ci_name: data.ci.name
      });
    });
  }

  /**
   * Run connector manually
   */
  async runConnector(connectorName: string): Promise<ConnectorRunResult> {
    const registered = this.connectors.get(connectorName);

    if (registered === undefined) {
      throw new Error(`Connector not found: ${connectorName}`);
    }

    const runId = this.generateRunId();
    const startedAt = new Date();

    // Get connector config for type
    const config = await this.getConnectorConfig(connectorName);

    // When the config references a credential, resolve a fresh instance with
    // run-time auth injected; otherwise use the pre-registered instance.
    const connector =
      config !== null && config.credential_id !== undefined
        ? await this.resolveConnectorForRun(config)
        : registered;

    try {
      logger.info('Running connector', { connector: connectorName, run_id: runId });

      // Emit connector run started event
      await this.eventProducer.emit(
        EventType.CONNECTOR_RUN_STARTED,
        'integration-manager',
        {
          run_id: runId,
          connector_name: connectorName,
          connector_type: config?.type || 'unknown',
          scheduled: false,
        } as any
      );

      // Save run record
      await this.saveConnectorRun({
        run_id: runId,
        connector_name: connectorName,
        started_at: startedAt,
        status: 'running',
        records_extracted: 0,
        records_transformed: 0,
        records_loaded: 0,
      });

      // Run connector
      await connector.run();

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      // Update run record
      const result: ConnectorRunResult = {
        run_id: runId,
        connector_name: connectorName,
        started_at: startedAt,
        completed_at: completedAt,
        status: 'completed',
        records_extracted: 0, // TODO: Track metrics
        records_transformed: 0,
        records_loaded: 0,
      };

      await this.updateConnectorRun(result);

      // Emit connector run completed event
      await this.eventProducer.emit(
        EventType.CONNECTOR_RUN_COMPLETED,
        'integration-manager',
        {
          run_id: runId,
          connector_name: connectorName,
          duration_ms: durationMs,
          records_extracted: result.records_extracted,
          records_transformed: result.records_transformed,
          records_loaded: result.records_loaded,
        } as any
      );

      logger.info('Connector run completed', {
        connector: connectorName,
        run_id: runId
      });

      return result;

    } catch (error) {
      logger.error('Connector run failed', {
        connector: connectorName,
        run_id: runId,
        error
      });

      const result: ConnectorRunResult = {
        run_id: runId,
        connector_name: connectorName,
        started_at: startedAt,
        completed_at: new Date(),
        status: 'failed',
        records_extracted: 0,
        records_transformed: 0,
        records_loaded: 0,
        errors: [(error as Error).message],
      };

      await this.updateConnectorRun(result);

      // Emit connector run failed event
      await this.eventProducer.emit(
        EventType.CONNECTOR_RUN_FAILED,
        'integration-manager',
        {
          run_id: runId,
          connector_name: connectorName,
          error_message: (error as Error).message,
          error_stack: (error as Error).stack,
          retry_count: 0,
        } as any
      );

      throw error;
    }
  }

  /**
   * Test connector connection
   */
  async testConnector(connectorName: string): Promise<any> {
    const registered = this.connectors.get(connectorName);

    if (registered === undefined) {
      throw new Error(`Connector not found: ${connectorName}`);
    }

    logger.info('Testing connector connection', { connector: connectorName });

    // When the config references a credential, resolve a fresh instance with
    // run-time auth injected; otherwise use the pre-registered instance.
    const config = await this.getConnectorConfig(connectorName);
    const connector =
      config !== null && config.credential_id !== undefined
        ? await this.resolveConnectorForRun(config)
        : registered;

    return await connector.testConnection();
  }

  /**
   * Unregister connector
   */
  async unregisterConnector(connectorName: string): Promise<void> {
    const connector = this.connectors.get(connectorName);

    if (!connector) {
      return;
    }

    // Cancel schedule
    this.cancelSchedule(connectorName);

    // Cleanup connector
    await connector.cleanup();

    // Remove from map
    this.connectors.delete(connectorName);

    logger.info('Connector unregistered', { connector: connectorName });
  }

  /**
   * Get all registered connectors
   */
  getConnectors(): Map<string, BaseIntegrationConnector> {
    return this.connectors;
  }

  /**
   * Get connector by name
   */
  getConnector(name: string): BaseIntegrationConnector | undefined {
    return this.connectors.get(name);
  }

  /**
   * Save connector run to database
   */
  private async saveConnectorRun(result: ConnectorRunResult): Promise<void> {
    await this.postgresClient.query(
      `
      INSERT INTO connector_runs
      (run_id, connector_name, started_at, status, records_extracted,
       records_transformed, records_loaded, errors)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        result.run_id,
        result.connector_name,
        result.started_at,
        result.status,
        result.records_extracted,
        result.records_transformed,
        result.records_loaded,
        result.errors ? JSON.stringify(result.errors) : null,
      ]
    );
  }

  /**
   * Update connector run
   */
  private async updateConnectorRun(result: ConnectorRunResult): Promise<void> {
    await this.postgresClient.query(
      `
      UPDATE connector_runs
      SET completed_at = $3,
          status = $4,
          records_extracted = $5,
          records_transformed = $6,
          records_loaded = $7,
          errors = $8
      WHERE run_id = $1 AND connector_name = $2
      `,
      [
        result.run_id,
        result.connector_name,
        result.completed_at,
        result.status,
        result.records_extracted,
        result.records_transformed,
        result.records_loaded,
        result.errors ? JSON.stringify(result.errors) : null,
      ]
    );
  }

  /**
   * Get connector configuration from database
   */
  private async getConnectorConfig(connectorName: string): Promise<ConnectorConfiguration | null> {
    const result = await this.postgresClient.query(
      'SELECT * FROM connector_configurations WHERE name = $1',
      [connectorName]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToConfig(result.rows[0]);
  }

  /**
   * Resolve a fresh connector instance with run-time credentials injected.
   * Only called when config.credential_id !== undefined.
   */
  private async resolveConnectorForRun(
    config: ConnectorConfiguration
  ): Promise<BaseIntegrationConnector> {
    const pool = this.postgresClient.pool;
    const credentialId = config.credential_id as string;

    const credential = await getUnifiedCredentialService(pool).getById(credentialId);
    if (credential === null) {
      throw new Error('Credential not found: ' + credentialId);
    }

    const connection: Record<string, unknown> = { ...config.connection };

    if (credential.protocol === 'oauth2') {
      const resolved = await getOAuthSubstrate(pool).resolve(credentialId);
      connection['auth_type'] = 'oauth2';
      connection['access_token'] = resolved.token;

      const instanceUrl = credential.credentials['instance_url'] as string | undefined;
      if (connection['instance_url'] === undefined && typeof instanceUrl === 'string') {
        connection['instance_url'] = instanceUrl;
      }
    } else {
      // basic/api_key/etc.: the encrypted store is authoritative for secrets.
      Object.assign(connection, credential.credentials);
    }

    const resolvedConfig: ConnectorConfiguration = { ...config, connection };
    return getConnectorRegistry().createConnector(resolvedConfig);
  }

  /**
   * Generate unique run ID
   */
  private generateRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Map database row to configuration
   */
  private mapRowToConfig(row: any): ConnectorConfiguration {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      credential_id: row.credential_id ?? undefined,
      enabled: row.enabled,
      schedule: row.schedule,
      connection: row.connection,
      options: row.options,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

/**
 * Get singleton instance
 */
export function getIntegrationManager(): IntegrationManager {
  return IntegrationManager.getInstance();
}
