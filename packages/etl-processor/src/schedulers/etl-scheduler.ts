// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ETL Job Scheduler
 *
 * This module implements scheduled ETL jobs using BullMQ repeatable jobs.
 * Supports different ETL job types: sync, change detection, reconciliation, full refresh.
 */

import { getQueueManager, QUEUE_NAMES, logger } from '@cmdb/common';
import type { ETLJobData, ETLJobType } from '@cmdb/common';
import { getScheduleConfigStore } from '@cmdb/database';
import { v4 as uuidv4 } from 'uuid';

/**
 * ETL Schedule configuration
 */
interface ETLSchedule {
  _type: ETLJobType;
  _queueName: string;
  _cronPattern: string;
  _enabled: boolean;
  _config: any;
}

/**
 * Default ETL schedules
 */
const DEFAULT_SCHEDULES: ETLSchedule[] = [
  {
    _type: 'sync',
    _queueName: QUEUE_NAMES._ETL_SYNC,
    _cronPattern: '*/5 * * * *', // Every 5 minutes (incremental sync)
    _enabled: true,
    _config: {
      _source: 'neo4j',
      _target: 'postgres',
      _batchSize: 1000,
    },
  },
  {
    _type: 'change-detection',
    _queueName: QUEUE_NAMES._ETL_CHANGE_DETECTION,
    _cronPattern: '*/10 * * * *', // Every 10 minutes
    _enabled: true,
    _config: {
      _source: 'neo4j',
      _batchSize: 500,
    },
  },
  {
    _type: 'reconciliation',
    _queueName: QUEUE_NAMES._ETL_RECONCILIATION,
    _cronPattern: '0 * * * *', // Every hour
    _enabled: true,
    _config: {
      _source: 'neo4j',
      _target: 'postgres',
      _batchSize: 2000,
    },
  },
  {
    _type: 'full-refresh',
    _queueName: QUEUE_NAMES._ETL_FULL_REFRESH,
    _cronPattern: '0 2 * * *', // Daily at 2 AM
    _enabled: true,
    _config: {
      _source: 'neo4j',
      _target: 'postgres',
      _batchSize: 5000,
      _tables: ['dim_ci', 'dim_location', 'dim_owner', 'fact_discovery', 'fact_changes'],
    },
  },
];

/**
 * Redis "kind" discriminator this scheduler's persisted schedule configs are stored under.
 * Paired with the ETL type as the persisted key's id: cmdb:schedule-config:v1:etl:<type>.
 */
const SCHEDULE_KIND = 'etl';

/**
 * ETL Scheduler
 */
export class ETLScheduler {
  private queueManager = getQueueManager();
  private schedules: Map<ETLJobType, ETLSchedule> = new Map();
  private isStarted = false;

  constructor(customSchedules?: ETLSchedule[]) {
    // Load default schedules
    const schedules = customSchedules || DEFAULT_SCHEDULES;
    schedules.forEach((schedule) => {
      this.schedules.set(schedule._type, schedule);
    });

    logger.info('ETL scheduler initialized', {
      _scheduleCount: this.schedules.size,
    });
  }

  /**
   * Start all scheduled ETL jobs
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn('ETL scheduler already started');
      return;
    }

    logger.info('Starting ETL scheduler...');

    // Hydrate every ETL schedule from the shared Redis-backed config before deciding what to
    // create or remove, so this process agrees with whatever the last process to mutate a
    // schedule (API server or worker) actually persisted.
    await this.loadPersistedSchedules();

    for (const [type, schedule] of this.schedules.entries()) {
      if (!schedule._enabled) {
        logger.info(`Skipping disabled schedule for ${type}`);
        await this.removeSchedule(type);
        continue;
      }

      await this.scheduleETLJob(schedule);
    }

    this.isStarted = true;
    logger.info('ETL scheduler started successfully');
  }

  /**
   * Schedule an ETL job
   */
  private async scheduleETLJob(schedule: ETLSchedule): Promise<void> {
    const { _type: type, _queueName: queueName, _cronPattern: cronPattern, _config: config } = schedule;

    try {
      const jobData: ETLJobData = {
        _jobId: uuidv4(),
        _type: type,
        _config: config,
        _createdAt: new Date().toISOString(),
        triggeredBy: 'scheduler',
      };

      await this.queueManager.addRepeatableJob(
        queueName,
        `etl-${type}`,
        jobData,
        {
          pattern: cronPattern,
          immediately: false,
        }
      );

      logger.info(`Scheduled ETL job for ${type}`, {
        cronPattern,
        queueName,
      });
    } catch (err) {
      logger.error(`Failed to schedule ETL job for ${type}`, err);
      throw err;
    }
  }

  /**
   * Trigger immediate ETL job
   */
  async triggerETL(
    type: ETLJobType,
    config?: any,
    triggeredBy?: string
  ): Promise<string> {
    const schedule = this.schedules.get(type);
    if (!schedule) {
      throw new Error(`No schedule found for ETL type: ${type}`);
    }

    const jobData: ETLJobData = {
      _jobId: uuidv4(),
      _type: type,
      _config: config || schedule._config,
      _createdAt: new Date().toISOString(),
      triggeredBy: triggeredBy || 'manual',
    };

    const job = await this.queueManager.addJob(
      schedule._queueName,
      `etl-${type}-manual`,
      jobData,
      {
        _priority: type === 'full-refresh' ? 1 : 10, // Lower priority for full refresh
      }
    );

    logger.info(`Triggered immediate ETL job for ${type}`, {
      _jobId: job.id,
      triggeredBy,
    });

    return job.id!;
  }

  /**
   * Update schedule for an ETL type
   */
  async updateSchedule(type: ETLJobType, cronPattern: string): Promise<void> {
    if (!this.schedules.has(type)) {
      throw new Error(`No schedule found for ETL type: ${type}`);
    }

    // Seed the store first so an unseeded schedule's first cron-only edit keeps its known
    // enabled/config defaults instead of the store's update() falling back to enabled=false.
    await this.refreshScheduleFromStore(type);

    const persisted = await getScheduleConfigStore().update(SCHEDULE_KIND, type, {
      cronExpression: cronPattern,
    });
    const schedule = this.schedules.get(type)!;
    schedule._cronPattern = persisted.cronExpression;
    schedule._enabled = persisted.enabled;
    schedule._config = persisted.config;

    // A disabled schedule stores the new cron but stays real: no repeatable job is created
    // until the schedule is explicitly enabled. An enabled schedule gets its repeatable
    // replaced immediately so the live cadence matches the newly stored cron.
    if (schedule._enabled) {
      await this.removeSchedule(type);
      await this.scheduleETLJob(schedule);
    }

    logger.info(`Updated schedule for ${type}`, { cronPattern, enabled: schedule._enabled });
  }

  /**
   * Enable schedule for an ETL type
   */
  async enableSchedule(type: ETLJobType): Promise<void> {
    if (!this.schedules.has(type)) {
      throw new Error(`No schedule found for ETL type: ${type}`);
    }

    const schedule = await this.refreshScheduleFromStore(type);
    if (schedule._enabled) {
      logger.warn(`Schedule for ${type} already enabled`);
      return;
    }

    const persisted = await getScheduleConfigStore().update(SCHEDULE_KIND, type, {
      enabled: true,
    });
    schedule._cronPattern = persisted.cronExpression;
    schedule._enabled = persisted.enabled;
    schedule._config = persisted.config;

    await this.scheduleETLJob(schedule);

    logger.info(`Enabled schedule for ${type}`);
  }

  /**
   * Disable schedule for an ETL type
   */
  async disableSchedule(type: ETLJobType): Promise<void> {
    if (!this.schedules.has(type)) {
      throw new Error(`No schedule found for ETL type: ${type}`);
    }

    const schedule = await this.refreshScheduleFromStore(type);
    if (!schedule._enabled) {
      logger.warn(`Schedule for ${type} already disabled`);
      return;
    }

    const persisted = await getScheduleConfigStore().update(SCHEDULE_KIND, type, {
      enabled: false,
    });
    schedule._cronPattern = persisted.cronExpression;
    schedule._enabled = persisted.enabled;
    schedule._config = persisted.config;

    await this.removeSchedule(type);

    logger.info(`Disabled schedule for ${type}`);
  }

  /**
   * Remove schedule for an ETL type
   */
  private async removeSchedule(type: ETLJobType): Promise<void> {
    const schedule = this.schedules.get(type);
    if (!schedule) {
      return;
    }

    const queue = this.queueManager.getQueue(schedule._queueName);
    const repeatableJobs = await queue.getRepeatableJobs();

    for (const job of repeatableJobs) {
      if (job.name === `etl-${type}`) {
        await queue.removeRepeatableByKey(job.key);
        logger.info(`Removed repeatable job for ${type}`, { key: job.key });
      }
    }
  }

  /**
   * Get all schedules
   */
  getSchedules(): ETLSchedule[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Get schedule for an ETL type
   */
  getSchedule(type: ETLJobType): ETLSchedule | undefined {
    return this.schedules.get(type);
  }

  /**
   * Load the persisted schedule config for an ETL type from the shared Redis store, seeding it
   * with this instance's current in-memory schedule as the default the first time any process
   * asks for it. Mutates and returns the in-memory schedule so every caller in this class stays
   * on the shared truth instead of stale constructor defaults.
   */
  private async refreshScheduleFromStore(type: ETLJobType): Promise<ETLSchedule> {
    const schedule = this.schedules.get(type);
    if (!schedule) {
      throw new Error(`No schedule found for ETL type: ${type}`);
    }

    const persisted = await getScheduleConfigStore().seedIfAbsent(SCHEDULE_KIND, type, {
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
   * Hydrate every ETL schedule from the shared Redis store. Called by start() before it decides
   * what to create or remove.
   */
  private async loadPersistedSchedules(): Promise<void> {
    for (const type of this.schedules.keys()) {
      await this.refreshScheduleFromStore(type);
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
   * Get the schedule for an ETL type resolved against the shared Redis-backed config and the
   * actual BullMQ repeatable job state. This is the source of truth for the schedules REST API:
   * unlike getSchedule(), it is never limited to whatever this process's in-memory map last held.
   */
  async getScheduleView(type: ETLJobType): Promise<ETLSchedule | undefined> {
    if (!this.schedules.has(type)) {
      return undefined;
    }

    const schedule = await this.refreshScheduleFromStore(type);
    schedule._enabled = await this.hasRepeatableJob(schedule._queueName, `etl-${type}`);
    return schedule;
  }

  /**
   * Get every ETL schedule resolved against the shared Redis-backed config and actual BullMQ
   * repeatable job state.
   */
  async getSchedulesView(): Promise<ETLSchedule[]> {
    const views = await Promise.all(
      Array.from(this.schedules.keys()).map((type) => this.getScheduleView(type))
    );
    return views.filter((schedule): schedule is ETLSchedule => schedule !== undefined);
  }

  /**
   * Stop scheduler (remove all repeatable jobs)
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      logger.warn('ETL scheduler not started');
      return;
    }

    logger.info('Stopping ETL scheduler...');

    for (const type of this.schedules.keys()) {
      await this.removeSchedule(type);
    }

    this.isStarted = false;
    logger.info('ETL scheduler stopped');
  }
}

// Singleton instance
let etlScheduler: ETLScheduler | null = null;

/**
 * Get the singleton ETL scheduler
 */
export function getETLScheduler(customSchedules?: ETLSchedule[]): ETLScheduler {
  if (!etlScheduler) {
    etlScheduler = new ETLScheduler(customSchedules);
  }
  return etlScheduler;
}
