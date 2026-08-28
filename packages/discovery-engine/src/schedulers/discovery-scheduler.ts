// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Job Scheduler
 *
 * This module implements scheduled discovery jobs using BullMQ repeatable jobs.
 * Supports cron-based scheduling for different discovery providers.
 *
 * Now supports dynamic scheduling based on discovery definitions stored in PostgreSQL.
 */

import { getQueueManager, QUEUE_NAMES, logger } from '@cmdb/common';
import type { DiscoveryJobData, DiscoveryProvider, DiscoveryDefinition } from '@cmdb/common';
import { getPostgresClient, getScheduleConfigStore } from '@cmdb/database';
import { v4 as uuidv4 } from 'uuid';

/**
 * Schedule configuration for discovery jobs
 */
interface DiscoverySchedule {
  _provider: DiscoveryProvider;
  _queueName: string;
  _cronPattern: string;
  _enabled: boolean;
  _config: any;
}

/**
 * Mapping of definition ID to BullMQ repeatable job key
 */
interface DefinitionJobMapping {
  definitionId: string;
  jobKey: string;
  cronPattern: string;
}

/**
 * Default discovery schedules
 * NOTE: Cloud providers (AWS, Azure, GCP, Kubernetes) are NOT part of Discovery system.
 * They are for Connector use only. Discovery is for network-based protocols only.
 */
const DEFAULT_SCHEDULES: DiscoverySchedule[] = [
  {
    _provider: 'ssh',
    _queueName: QUEUE_NAMES._DISCOVERY_SSH,
    _cronPattern: '0 * * * *', // Every hour
    _enabled: true,
    _config: {
      _targets: [], // Loaded from environment or config
    },
  },
  {
    _provider: 'nmap',
    _queueName: QUEUE_NAMES._DISCOVERY_NMAP,
    _cronPattern: '0 2 * * *', // Daily at 2 AM
    _enabled: true,
    _config: {
      _targets: [], // Loaded from environment or config
    },
  },
];

/**
 * Redis "kind" discriminator this scheduler's persisted schedule configs are stored under.
 * Paired with the provider as the persisted key's id: cmdb:schedule-config:v1:discovery:<provider>.
 */
const SCHEDULE_KIND = 'discovery';

/**
 * Discovery Scheduler
 */
export class DiscoveryScheduler {
  private queueManager = getQueueManager();
  private schedules: Map<string, DiscoverySchedule> = new Map();
  private definitionMappings: Map<string, DefinitionJobMapping> = new Map();
  private isStarted = false;
  private useDatabaseDefinitions = true;

  constructor(customSchedules?: DiscoverySchedule[], useDatabaseDefinitions = true) {
    this.useDatabaseDefinitions = useDatabaseDefinitions;

    // Load default schedules as fallback
    const schedules = customSchedules || DEFAULT_SCHEDULES;
    schedules.forEach((schedule) => {
      this.schedules.set(schedule._provider, schedule);
    });

    logger.info('Discovery scheduler initialized', {
      _scheduleCount: this.schedules.size,
      useDatabaseDefinitions: this.useDatabaseDefinitions,
    });
  }

  /**
   * Start all scheduled discovery jobs
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn('Discovery scheduler already started');
      return;
    }

    logger.info('Starting discovery scheduler...');

    // Hydrate provider-level schedules (ssh/nmap) from the shared Redis-backed config before
    // deciding what to create or remove, so this process agrees with whatever the last process
    // to mutate a schedule (API server or worker) actually persisted.
    await this.loadPersistedSchedules();

    if (this.useDatabaseDefinitions) {
      try {
        // Load and schedule all active definitions from PostgreSQL
        await this.loadAndScheduleDefinitions();
      } catch (error) {
        logger.error('Failed to load definitions from database, falling back to default schedules', error);
        // Fall back to default schedules if database is unavailable
        await this.startDefaultSchedules();
      }
    } else {
      // Use default schedules
      await this.startDefaultSchedules();
    }

    this.isStarted = true;
    logger.info('Discovery scheduler started successfully', {
      definitionsScheduled: this.definitionMappings.size,
      defaultSchedules: this.schedules.size,
    });
  }

  /**
   * Start default schedules (fallback when database is unavailable)
   */
  private async startDefaultSchedules(): Promise<void> {
    for (const [provider, schedule] of this.schedules.entries()) {
      if (!schedule._enabled) {
        logger.info(`Skipping disabled schedule for ${provider}`);
        await this.removeSchedule(provider as DiscoveryProvider);
        continue;
      }

      await this.scheduleDiscoveryJob(schedule);
    }
  }

  /**
   * Load all active discovery definitions from PostgreSQL and schedule them
   */
  private async loadAndScheduleDefinitions(): Promise<void> {
    const postgresClient = getPostgresClient();
    const pool = postgresClient['pool'];

    const result = await pool.query(
      `SELECT * FROM discovery_definitions
       WHERE is_active = true AND schedule IS NOT NULL
       ORDER BY created_at ASC`
    );

    logger.info(`Loaded ${result.rows.length} active discovery definitions from database`);

    for (const row of result.rows) {
      const definition = this.mapRowToDefinition(row);
      await this.scheduleDefinition(definition.id);
    }
  }

  /**
   * Schedule a discovery job
   */
  private async scheduleDiscoveryJob(schedule: DiscoverySchedule): Promise<void> {
    const provider = schedule._provider;
    const queueName = schedule._queueName;
    const cronPattern = schedule._cronPattern;
    const config = schedule._config;

    try {
      const jobData: DiscoveryJobData = {
        _jobId: uuidv4(),
        _provider: provider,
        _config: config,
        _createdAt: new Date().toISOString(),
        triggeredBy: 'scheduler',
      };

      await this.queueManager.addRepeatableJob(
        queueName,
        `discovery-${provider}`,
        jobData,
        {
          pattern: cronPattern,
          immediately: false, // Don't run immediately on start
        }
      );

      logger.info(`Scheduled discovery job for ${provider}`, {
        cronPattern,
        queueName,
      });
    } catch (err) {
      logger.error(`Failed to schedule discovery job for ${provider}`, err);
      throw err;
    }
  }

  /**
   * Trigger immediate discovery job
   */
  async triggerDiscovery(
    provider: DiscoveryProvider,
    config?: any,
    triggeredBy?: string
  ): Promise<string> {
    const schedule = this.schedules.get(provider);
    if (!schedule) {
      throw new Error(`No schedule found for provider: ${provider}`);
    }

    const jobData: DiscoveryJobData = {
      _jobId: uuidv4(),
      _provider: provider,
      _config: config || schedule._config,
      _createdAt: new Date().toISOString(),
      triggeredBy: triggeredBy || 'manual',
    };

    const job = await this.queueManager.addJob(
      schedule._queueName,
      `discovery-${provider}-manual`,
      jobData,
      {
        priority: 10, // Higher priority for manual jobs
      }
    );

    logger.info(`Triggered immediate discovery for ${provider}`, {
      _jobId: job.id,
      triggeredBy,
    });

    return job.id!;
  }

  /**
   * Update schedule for a provider
   */
  async updateSchedule(
    provider: DiscoveryProvider,
    cronPattern: string
  ): Promise<void> {
    if (!this.schedules.has(provider)) {
      throw new Error(`No schedule found for provider: ${provider}`);
    }

    // Seed the store first so an unseeded schedule's first cron-only edit keeps its known
    // enabled/config defaults instead of the store's update() falling back to enabled=false.
    await this.refreshScheduleFromStore(provider);

    const persisted = await getScheduleConfigStore().update(SCHEDULE_KIND, provider, {
      cronExpression: cronPattern,
    });
    const schedule = this.schedules.get(provider)!;
    schedule._cronPattern = persisted.cronExpression;
    schedule._enabled = persisted.enabled;
    schedule._config = persisted.config;

    // A disabled schedule stores the new cron but stays real: no repeatable job is created
    // until the schedule is explicitly enabled. An enabled schedule gets its repeatable
    // replaced immediately so the live cadence matches the newly stored cron.
    if (schedule._enabled) {
      await this.removeSchedule(provider);
      await this.scheduleDiscoveryJob(schedule);
    }

    logger.info(`Updated schedule for ${provider}`, { cronPattern, enabled: schedule._enabled });
  }

  /**
   * Enable schedule for a provider
   */
  async enableSchedule(provider: DiscoveryProvider): Promise<void> {
    if (!this.schedules.has(provider)) {
      throw new Error(`No schedule found for provider: ${provider}`);
    }

    const schedule = await this.refreshScheduleFromStore(provider);
    if (schedule._enabled) {
      logger.warn(`Schedule for ${provider} already enabled`);
      return;
    }

    const persisted = await getScheduleConfigStore().update(SCHEDULE_KIND, provider, {
      enabled: true,
    });
    schedule._cronPattern = persisted.cronExpression;
    schedule._enabled = persisted.enabled;
    schedule._config = persisted.config;

    await this.scheduleDiscoveryJob(schedule);

    logger.info(`Enabled schedule for ${provider}`);
  }

  /**
   * Disable schedule for a provider
   */
  async disableSchedule(provider: DiscoveryProvider): Promise<void> {
    if (!this.schedules.has(provider)) {
      throw new Error(`No schedule found for provider: ${provider}`);
    }

    const schedule = await this.refreshScheduleFromStore(provider);
    if (!schedule._enabled) {
      logger.warn(`Schedule for ${provider} already disabled`);
      return;
    }

    const persisted = await getScheduleConfigStore().update(SCHEDULE_KIND, provider, {
      enabled: false,
    });
    schedule._cronPattern = persisted.cronExpression;
    schedule._enabled = persisted.enabled;
    schedule._config = persisted.config;

    await this.removeSchedule(provider);

    logger.info(`Disabled schedule for ${provider}`);
  }

  /**
   * Remove schedule for a provider
   */
  private async removeSchedule(provider: DiscoveryProvider): Promise<void> {
    const schedule = this.schedules.get(provider);
    if (!schedule) {
      return;
    }

    const queue = this.queueManager.getQueue(schedule._queueName);
    const repeatableJobs = await queue.getRepeatableJobs();

    for (const job of repeatableJobs) {
      if (job.name === `discovery-${provider}`) {
        await queue.removeRepeatableByKey(job.key);
        logger.info(`Removed repeatable job for ${provider}`, { key: job.key });
      }
    }
  }

  /**
   * Get all schedules
   */
  getSchedules(): DiscoverySchedule[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Get schedule for a provider
   */
  getSchedule(provider: DiscoveryProvider): DiscoverySchedule | undefined {
    return this.schedules.get(provider);
  }

  /**
   * Load the persisted schedule config for a provider from the shared Redis store, seeding it
   * with this instance's current in-memory schedule as the default the first time any process
   * asks for it. Mutates and returns the in-memory schedule so every caller in this class stays
   * on the shared truth instead of stale constructor defaults.
   */
  private async refreshScheduleFromStore(provider: DiscoveryProvider): Promise<DiscoverySchedule> {
    const schedule = this.schedules.get(provider);
    if (!schedule) {
      throw new Error(`No schedule found for provider: ${provider}`);
    }

    const persisted = await getScheduleConfigStore().seedIfAbsent(SCHEDULE_KIND, provider, {
      cronExpression: schedule._cronPattern,
      enabled: schedule._enabled,
      config: schedule._config,
    });

    schedule._cronPattern = persisted.cronExpression;
    schedule._enabled = persisted.enabled;
    schedule._config = persisted.config;

    return schedule;
  }

  /**
   * Hydrate every provider-level schedule from the shared Redis store. Called by start() before
   * it decides what to create or remove.
   */
  private async loadPersistedSchedules(): Promise<void> {
    for (const provider of this.schedules.keys()) {
      await this.refreshScheduleFromStore(provider as DiscoveryProvider);
    }
  }

  /**
   * Whether a BullMQ repeatable job actually exists for a queue/job name pair, independent of
   * any cached "enabled" flag.
   */
  private async hasRepeatableJob(queueName: string, jobName: string): Promise<boolean> {
    const queue = this.queueManager.getQueue(queueName);
    const repeatableJobs = await queue.getRepeatableJobs();
    return repeatableJobs.some((job) => job.name === jobName);
  }

  /**
   * Get the schedule for a provider resolved against the shared Redis-backed config and the
   * actual BullMQ repeatable job state. This is the source of truth for the schedules REST API:
   * unlike getSchedule(), it is never limited to whatever this process's in-memory map last held.
   */
  async getScheduleView(provider: DiscoveryProvider): Promise<DiscoverySchedule | undefined> {
    if (!this.schedules.has(provider)) {
      return undefined;
    }

    const schedule = await this.refreshScheduleFromStore(provider);
    schedule._enabled = await this.hasRepeatableJob(schedule._queueName, `discovery-${provider}`);
    return schedule;
  }

  /**
   * Get every provider-level schedule resolved against the shared Redis-backed config and
   * actual BullMQ repeatable job state.
   */
  async getSchedulesView(): Promise<DiscoverySchedule[]> {
    const views = await Promise.all(
      Array.from(this.schedules.keys()).map((provider) =>
        this.getScheduleView(provider as DiscoveryProvider)
      )
    );
    return views.filter((schedule): schedule is DiscoverySchedule => schedule !== undefined);
  }

  /**
   * Schedule a discovery definition by ID
   * Loads definition from database and creates repeatable job
   */
  async scheduleDefinition(definitionId: string): Promise<void> {
    const postgresClient = getPostgresClient();
    const pool = postgresClient['pool'];

    const result = await pool.query(
      'SELECT * FROM discovery_definitions WHERE id = $1',
      [definitionId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Discovery definition with ID '${definitionId}' not found`);
    }

    const definition = this.mapRowToDefinition(result.rows[0]);

    if (!definition.schedule) {
      throw new Error(`Discovery definition '${definition.name}' has no schedule configured`);
    }

    if (!definition.is_active) {
      logger.warn(`Skipping inactive definition: ${definition.name}`);
      return;
    }

    // Map provider to queue name
    const queueName = this.getQueueNameForProvider(definition.provider);

    const jobData: DiscoveryJobData = {
      _jobId: uuidv4(),
      _provider: definition.provider,
      _config: definition.config,
      _createdAt: new Date().toISOString(),
      triggeredBy: 'scheduler',
      definition_id: definitionId, // Include definition_id in job data
    };

    await this.queueManager.addRepeatableJob(
      queueName,
      `discovery-definition-${definitionId}`,
      jobData,
      {
        pattern: definition.schedule,
        immediately: false,
      }
    );

    // Get the job key from the repeatable jobs list
    const queue = this.queueManager.getQueue(queueName);
    const repeatableJobs = await queue.getRepeatableJobs();
    const jobKey = repeatableJobs.find(
      (j) => j.name === `discovery-definition-${definitionId}`
    )?.key;

    if (!jobKey) {
      throw new Error(`Failed to retrieve job key for definition ${definitionId}`);
    }

    // Store mapping
    this.definitionMappings.set(definitionId, {
      definitionId,
      jobKey,
      cronPattern: definition.schedule,
    });

    logger.info(`Scheduled discovery definition: ${definition.name}`, {
      definitionId,
      provider: definition.provider,
      schedule: definition.schedule,
      jobKey,
    });
  }

  /**
   * Unschedule a discovery definition by ID
   * Removes repeatable job for the definition
   */
  async unscheduleDefinition(definitionId: string): Promise<void> {
    const mapping = this.definitionMappings.get(definitionId);

    if (!mapping) {
      logger.warn(`No scheduled job found for definition: ${definitionId}`);
      return;
    }

    // Get definition to determine queue
    const postgresClient = getPostgresClient();
    const pool = postgresClient['pool'];

    const result = await pool.query(
      'SELECT provider FROM discovery_definitions WHERE id = $1',
      [definitionId]
    );

    if (result.rows.length === 0) {
      logger.warn(`Definition ${definitionId} not found in database, removing mapping anyway`);
      this.definitionMappings.delete(definitionId);
      return;
    }

    const provider = result.rows[0].provider;
    const queueName = this.getQueueNameForProvider(provider);
    const queue = this.queueManager.getQueue(queueName);

    await queue.removeRepeatableByKey(mapping.jobKey);
    this.definitionMappings.delete(definitionId);

    logger.info(`Unscheduled discovery definition: ${definitionId}`, {
      jobKey: mapping.jobKey,
    });
  }

  /**
   * Sync schedules with database
   * Reload definitions and add/remove/update schedules as needed
   */
  async syncSchedules(): Promise<void> {
    if (!this.useDatabaseDefinitions) {
      logger.debug('Database definitions disabled, skipping sync');
      return;
    }

    const postgresClient = getPostgresClient();
    const pool = postgresClient['pool'];

    try {
      // Load all active definitions with schedules
      const result = await pool.query(
        `SELECT * FROM discovery_definitions
         WHERE is_active = true AND schedule IS NOT NULL
         ORDER BY created_at ASC`
      );

      const currentDefinitions = new Map<string, DiscoveryDefinition>();
      for (const row of result.rows) {
        const definition = this.mapRowToDefinition(row);
        currentDefinitions.set(definition.id, definition);
      }

      // Find definitions to add (in DB but not scheduled)
      const toAdd: string[] = [];
      for (const [id, definition] of currentDefinitions.entries()) {
        const mapping = this.definitionMappings.get(id);
        if (!mapping) {
          toAdd.push(id);
        } else if (mapping.cronPattern !== definition.schedule) {
          // Schedule changed, need to reschedule
          await this.unscheduleDefinition(id);
          toAdd.push(id);
        }
      }

      // Find definitions to remove (scheduled but not in DB or inactive)
      const toRemove: string[] = [];
      for (const id of this.definitionMappings.keys()) {
        if (!currentDefinitions.has(id)) {
          toRemove.push(id);
        }
      }

      // Apply changes
      for (const id of toRemove) {
        await this.unscheduleDefinition(id);
      }

      for (const id of toAdd) {
        await this.scheduleDefinition(id);
      }

      if (toAdd.length > 0 || toRemove.length > 0) {
        logger.info('Schedules synced', {
          added: toAdd.length,
          removed: toRemove.length,
          total: this.definitionMappings.size,
        });
      }
    } catch (error) {
      logger.error('Failed to sync schedules', error);
      throw error;
    }
  }

  /**
   * Get queue name for a provider
   * NOTE: Cloud providers (AWS, Azure, GCP, Kubernetes) are NOT part of Discovery system.
   * They are for Connector use only.
   */
  private getQueueNameForProvider(provider: DiscoveryProvider): string {
    switch (provider) {
      case 'ssh':
        return QUEUE_NAMES._DISCOVERY_SSH;
      case 'nmap':
        return QUEUE_NAMES._DISCOVERY_NMAP;
      case 'active-directory':
      case 'snmp':
        throw new Error(`Discovery provider ${provider} not yet implemented`);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Map database row to DiscoveryDefinition object
   */
  private mapRowToDefinition(row: any): DiscoveryDefinition {
    return {
      id: row.id || row.definition_id,
      name: row.name,
      description: row.description,
      provider: row.provider,
      method: row.method,
      credential_id: row.credential_id,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      schedule: row.schedule,
      is_active: row.is_active,
      tags: row.tags || [],
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_run_at: row.last_run_at,
      last_run_status: row.last_run_status,
      last_job_id: row.last_job_id,
    };
  }

  /**
   * Stop scheduler (remove all repeatable jobs)
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      logger.warn('Discovery scheduler not started');
      return;
    }

    logger.info('Stopping discovery scheduler...');

    // Remove all definition-based schedules
    for (const definitionId of this.definitionMappings.keys()) {
      await this.unscheduleDefinition(definitionId);
    }

    // Remove all default schedules
    for (const provider of this.schedules.keys()) {
      await this.removeSchedule(provider as any);
    }

    this.isStarted = false;
    logger.info('Discovery scheduler stopped');
  }
}

// Singleton instance
let discoveryScheduler: DiscoveryScheduler | null = null;

/**
 * Get the singleton discovery scheduler
 */
export function getDiscoveryScheduler(
  customSchedules?: DiscoverySchedule[]
): DiscoveryScheduler {
  if (!discoveryScheduler) {
    discoveryScheduler = new DiscoveryScheduler(customSchedules);
  }
  return discoveryScheduler;
}
