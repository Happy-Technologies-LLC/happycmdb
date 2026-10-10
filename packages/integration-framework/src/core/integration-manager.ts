// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Connector lifecycle, ownership checks, and scheduling. */
import * as cron from 'node-cron';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { BaseIntegrationConnector } from './base-connector';
import { getConnectorRegistry } from '../registry/connector-registry';
import { ConnectorConfiguration, ConnectorRunResult } from '../types/connector.types';
import { getEventProducer, EventType } from '@cmdb/event-processor';

export interface ConnectorConfigurationRow {
  id: string;
  organization_id: string | null;
  name: string;
  connector_type: string;
  credential_id: string | null | undefined;
  enabled: boolean;
  schedule_enabled: boolean;
  schedule: string | null;
  connection: Record<string, unknown>;
  options: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

type OwnedConfig = ConnectorConfiguration & { id: string; organizationId: string | null; schedule_enabled: boolean };
type ScheduleConfig = Pick<OwnedConfig, 'id' | 'organizationId' | 'enabled' | 'schedule_enabled' | 'schedule' | 'credential_id'>;

export class IntegrationManager {
  private static instance: IntegrationManager;
  private schedules = new Map<string, { task: cron.ScheduledTask; organizationId: string; expression: string }>();
  private reconciliationTimer?: NodeJS.Timeout;
  private postgresClient = getPostgresClient();
  private eventProducer = getEventProducer();

  private constructor() {}

  static getInstance(): IntegrationManager {
    if (!IntegrationManager.instance) IntegrationManager.instance = new IntegrationManager();
    return IntegrationManager.instance;
  }

  async loadConnectors(): Promise<void> {
    await this.reconcileSchedules();
  }

  // API and GraphQL writers may run in a different process. The hub owns this
  // poller; a callback also rechecks DB state so a removed schedule cannot fire
  // during the interval before the next reconciliation.
  startScheduleReconciliation(): void {
    if (this.reconciliationTimer) return;
    const poll = async (): Promise<void> => {
      try {
        await this.reconcileSchedules();
      } catch {
        logger.error('Connector schedule reconciliation failed');
      } finally {
        this.reconciliationTimer = setTimeout(poll, 30_000);
        this.reconciliationTimer.unref();
      }
    };
    this.reconciliationTimer = setTimeout(poll, 30_000);
    this.reconciliationTimer.unref();
  }

  private async reconcileSchedules(): Promise<void> {
    const result = await this.postgresClient.query(
      `SELECT id, organization_id, credential_id, enabled, schedule_enabled, schedule
       FROM connector_configurations
       WHERE enabled = true AND schedule_enabled = true AND schedule IS NOT NULL
         AND organization_id IS NOT NULL AND credential_id IS NULL`
    );
    const desired = new Set<string>();
    for (const row of result.rows) {
      if (!row.organization_id || !row.enabled || !row.schedule_enabled || row.credential_id || !row.schedule) continue;
      desired.add(row.id);
      const scheduled = this.schedules.get(row.id);
      if (scheduled && scheduled.organizationId === row.organization_id && scheduled.expression === row.schedule) continue;
      try {
        await this.registerConnector({
          id: row.id, organizationId: row.organization_id,
          credential_id: row.credential_id, enabled: row.enabled,
          schedule_enabled: row.schedule_enabled, schedule: row.schedule,
        });
      } catch {
        logger.error('Connector registration failed');
      }
    }
    for (const id of this.schedules.keys()) {
      if (!desired.has(id)) await this.unregisterConnector(id);
    }
  }

  async registerConnector(config: ScheduleConfig): Promise<void> {
    if (!config.id) return;
    await this.unregisterConnector(config.id);
    if (!config.organizationId || !config.enabled || !config.schedule_enabled || config.credential_id) return;
    // A schedule retains only the configuration ID and owner. Secrets and connector
    // instances are loaded only after the fresh ownership check at execution time.
    if (config.schedule && !cron.validate(config.schedule)) throw new Error('Invalid cron schedule');
    if (config.schedule) {
      const id = config.id;
      const organizationId = config.organizationId;
      const expression = config.schedule;
      const task = cron.schedule(expression, async () => {
        try {
          await this.runConnector(id, organizationId, 'schedule', undefined, expression);
        } catch {
          logger.error('Scheduled connector run failed');
        }
      });
      this.schedules.set(id, { task, organizationId, expression });
    }
  }

  async unregisterConnector(configId: string): Promise<void> {
    this.schedules.get(configId)?.task.stop();
    this.schedules.delete(configId);
  }

  private async ownedConfig(configId: string, organizationId: string | null): Promise<OwnedConfig> {
    const result = await this.postgresClient.query(
      `SELECT * FROM connector_configurations WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2::uuid`,
      [configId, organizationId]
    );
    if (!result.rows.length) throw new Error('CONNECTOR_NOT_FOUND');
    // Refuse stored references even for disabled configurations, before creating
    // a connector or accessing any credential table.
    if (result.rows[0].credential_id) throw new Error('CONNECTOR_CREDENTIAL_UNAVAILABLE');
    if (!result.rows[0].enabled) throw new Error('CONNECTOR_NOT_FOUND');
    return this.mapRowToConfig(result.rows[0]);
  }

  private createConnector(config: OwnedConfig): BaseIntegrationConnector {
    // The credentials table has no ownership column. Do not read or decrypt a referenced
    // credential until an independently verified ownership contract is available.
    if (config.credential_id) throw new Error('CONNECTOR_CREDENTIAL_UNAVAILABLE');
    return getConnectorRegistry().createConnector(config);
  }

  async testConnector(configId: string, organizationId: string | null): Promise<{ success: boolean }> {
    const config = await this.ownedConfig(configId, organizationId);
    const connector = this.createConnector(config);
    try {
      const result = await connector.testConnection();
      return { success: result.success === true };
    } catch {
      return { success: false };
    } finally {
      await connector.cleanup();
    }
  }

  async runConnector(
    configId: string,
    organizationId: string | null,
    triggeredBy = 'manual',
    triggeredByUser?: string,
    expectedSchedule?: string
  ): Promise<ConnectorRunResult> {
    // The schedule captures immutable ID + owner, never a name. A deleted, disabled,
    // reassigned or formerly tenant-owned legacy configuration cannot be run.
    const config = await this.ownedConfig(configId, organizationId);
    if (triggeredBy === 'schedule' && (
      organizationId === null || !expectedSchedule ||
      !config.schedule_enabled || config.schedule !== expectedSchedule
    )) throw new Error('CONNECTOR_NOT_FOUND');
    const connector = this.createConnector(config);
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const startedAt = new Date();
    let historyId: string | undefined;
    try {
      // INSERT SELECT binds the run to the current parent ownership at mutation time.
      const inserted = await this.postgresClient.query(
        `INSERT INTO connector_run_history
         (organization_id, config_id, connector_type, config_name, started_at, status,
          records_extracted, records_transformed, records_loaded, job_id, triggered_by, triggered_by_user)
         SELECT c.organization_id, c.id, c.connector_type, c.name, $3, 'running', 0, 0, 0, $4, $5, $6
         FROM connector_configurations c
         WHERE c.id = $1 AND c.organization_id IS NOT DISTINCT FROM $2::uuid
           AND c.enabled = true AND c.credential_id IS NULL
           AND ($5 <> 'schedule' OR (c.schedule_enabled = true AND c.schedule = $7))
         RETURNING id`,
        [configId, organizationId, startedAt, runId, triggeredBy, triggeredByUser ?? null, expectedSchedule ?? null]
      );
      historyId = inserted.rows[0]?.id;
      if (!historyId) throw new Error('CONNECTOR_NOT_FOUND');
      await this.appendRunLog(historyId, 'info', 'Connector run started');
      await this.eventProducer.emit(EventType.CONNECTOR_RUN_STARTED, 'integration-manager', {
        run_id: runId, connector_name: configId, connector_type: config.type,
        scheduled: triggeredBy === 'schedule',
      });
      await connector.run();
      const completedAt = new Date();
      await this.finishRun(historyId, organizationId, 'completed', completedAt, startedAt);
      await this.appendRunLog(historyId, 'info', 'Connector run completed');
      await this.eventProducer.emit(EventType.CONNECTOR_RUN_COMPLETED, 'integration-manager', {
        run_id: runId, connector_name: configId,
        duration_ms: completedAt.getTime() - startedAt.getTime(),
        records_extracted: 0, records_transformed: 0, records_loaded: 0,
      });
      return {
        run_id: runId, connector_name: config.name, started_at: startedAt,
        completed_at: completedAt, status: 'completed', records_extracted: 0,
        records_transformed: 0, records_loaded: 0,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'CONNECTOR_NOT_FOUND') throw error;
      if (historyId) {
        await this.finishRun(historyId, organizationId, 'failed', new Date(), startedAt);
        await this.appendRunLog(historyId, 'error', 'Connector run failed');
        await this.eventProducer.emit(EventType.CONNECTOR_RUN_FAILED, 'integration-manager', {
          run_id: runId, connector_name: configId,
          error_message: 'CONNECTOR_RUN_FAILED', retry_count: 0,
        });
      }
      logger.error('Connector run failed', { configId });
      throw new Error('CONNECTOR_RUN_FAILED');
    } finally {
      await connector.cleanup();
    }
  }

  private async appendRunLog(historyId: string, level: 'info' | 'error', message: string): Promise<void> {
    try {
      await this.postgresClient.query(
        'INSERT INTO connector_run_log_entries (run_id, level, message) VALUES ($1, $2, $3)',
        [historyId, level, message]
      );
    } catch {
      logger.error('Failed to append connector run log');
    }
  }

  private async finishRun(
    historyId: string, organizationId: string | null, status: string,
    completedAt: Date, startedAt: Date
  ): Promise<void> {
    await this.postgresClient.query(
      `UPDATE connector_run_history SET completed_at = $3, status = $4, duration_ms = $5
       WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2::uuid`,
      [historyId, organizationId, completedAt, status, completedAt.getTime() - startedAt.getTime()]
    );
  }

  mapRowToConfig(row: ConnectorConfigurationRow): OwnedConfig {
    return {
      id: row.id, organizationId: row.organization_id, name: row.name,
      type: row.connector_type, credential_id: row.credential_id ?? undefined,
      enabled: row.enabled, schedule_enabled: row.schedule_enabled, schedule: row.schedule ?? undefined,
      connection: row.connection, options: row.options,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }
}

export function getIntegrationManager(): IntegrationManager {
  return IntegrationManager.getInstance();
}
