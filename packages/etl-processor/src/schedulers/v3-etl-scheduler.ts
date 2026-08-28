// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * v3.0 ETL Job Scheduler
 *
 * Orchestrates ETL jobs for v3.0 features:
 * - CI sync with ITIL, TBM, and BSM attributes
 * - Cost data validation and enrichment
 * - Incident/Change data validation and SLA tracking
 *
 * This scheduler complements the base ETL scheduler with v3-specific jobs.
 */

import { Queue } from 'bullmq';
import { logger } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import {
  syncCIsJobConfig,
  SyncCIsJobData,
} from '../jobs/sync-cis-to-datamart.job';
import {
  syncCostsJobConfig,
  SyncCostsJobData,
} from '../jobs/sync-costs-to-datamart.job';
import {
  syncIncidentsJobConfig,
  SyncIncidentsJobData,
} from '../jobs/sync-incidents-to-datamart.job';

/**
 * v3.0 ETL Scheduler
 */
export class V3ETLScheduler {
  private cisQueue: Queue<SyncCIsJobData>;
  private costsQueue: Queue<SyncCostsJobData>;
  private incidentsQueue: Queue<SyncIncidentsJobData>;
  private isStarted: boolean = false;

  constructor() {
    const redisClient = getRedisClient();
    const connection = redisClient.getConnection();

    // Create BullMQ queues for v3 ETL jobs
    this.cisQueue = new Queue<SyncCIsJobData>('etl-cis', {
      connection,
      defaultJobOptions: {
        ...syncCIsJobConfig.defaultOptions,
      },
    });

    this.costsQueue = new Queue<SyncCostsJobData>('etl-costs', {
      connection,
      defaultJobOptions: {
        ...syncCostsJobConfig.defaultOptions,
      },
    });

    this.incidentsQueue = new Queue<SyncIncidentsJobData>('etl-incidents', {
      connection,
      defaultJobOptions: {
        ...syncIncidentsJobConfig.defaultOptions,
      },
    });

    logger.info('[V3ETLScheduler] Initialized v3.0 ETL job queues');
  }

  /**
   * Start all v3.0 ETL scheduled jobs
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn('[V3ETLScheduler] Already started');
      return;
    }

    logger.info('[V3ETLScheduler] Starting v3.0 ETL scheduler...');

    // Clean up any existing repeatable jobs before adding new ones
    await this.cleanupExistingJobs();

    // Schedule CI sync job (every 6 hours)
    await this.cisQueue.add(
      syncCIsJobConfig.jobName,
      {
        batchSize: 100,
        fullRefresh: false,
      },
      {
        repeat: {
          pattern: syncCIsJobConfig.cronSchedule, // '0 */6 * * *'
        },
        jobId: 'sync-cis-repeatable',
      }
    );

    logger.info('[V3ETLScheduler] Scheduled CI sync job', {
      schedule: syncCIsJobConfig.cronSchedule,
      queue: 'etl-cis',
    });

    // Schedule cost validation job (daily at 4:00 AM)
    await this.costsQueue.add(
      syncCostsJobConfig.jobName,
      {
        monthsToProcess: 1,
        validateAllocations: true,
      },
      {
        repeat: {
          pattern: syncCostsJobConfig.cronSchedule, // '0 4 * * *'
        },
        jobId: 'sync-costs-repeatable',
      }
    );

    logger.info('[V3ETLScheduler] Scheduled cost validation job', {
      schedule: syncCostsJobConfig.cronSchedule,
      queue: 'etl-costs',
    });

    // Schedule incident sync job (every 15 minutes for real-time ITSM)
    await this.incidentsQueue.add(
      syncIncidentsJobConfig.jobName,
      {
        includeChanges: true,
        calculateSLAs: true,
      },
      {
        repeat: {
          pattern: syncIncidentsJobConfig.cronSchedule, // '*/15 * * * *'
        },
        jobId: 'sync-incidents-repeatable',
      }
    );

    logger.info('[V3ETLScheduler] Scheduled incident sync job', {
      schedule: syncIncidentsJobConfig.cronSchedule,
      queue: 'etl-incidents',
    });

    this.isStarted = true;
    logger.info('[V3ETLScheduler] v3.0 ETL scheduler started successfully');
  }

  /**
   * Clean up existing repeatable jobs to avoid duplicates
   */
  private async cleanupExistingJobs(): Promise<void> {
    logger.info('[V3ETLScheduler] Cleaning up existing repeatable jobs...');

    const queues = [
      { queue: this.cisQueue, name: 'etl-cis' },
      { queue: this.costsQueue, name: 'etl-costs' },
      { queue: this.incidentsQueue, name: 'etl-incidents' },
    ];

    for (const { queue, name } of queues) {
      try {
        const repeatableJobs = await queue.getRepeatableJobs();
        logger.info(`[V3ETLScheduler] Found ${repeatableJobs.length} repeatable jobs in ${name}`);

        for (const job of repeatableJobs) {
          await queue.removeRepeatableByKey(job.key);
          logger.debug(`[V3ETLScheduler] Removed repeatable job: ${job.key} from ${name}`);
        }
      } catch (error) {
        logger.error(`[V3ETLScheduler] Error cleaning up ${name} queue`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[V3ETLScheduler] Cleanup complete');
  }

  /**
   * Trigger immediate CI sync (manual or on-demand)
   */
  async triggerCISync(data?: Partial<SyncCIsJobData>): Promise<string> {
    logger.info('[V3ETLScheduler] Triggering immediate CI sync', { data });

    const job = await this.cisQueue.add(
      `${syncCIsJobConfig.jobName}-manual`,
      {
        batchSize: data?.batchSize || 100,
        fullRefresh: data?.fullRefresh || false,
        incrementalSince: data?.incrementalSince,
        ciTypes: data?.ciTypes,
      },
      {
        priority: 5, // Higher priority for manual triggers
      }
    );

    logger.info('[V3ETLScheduler] CI sync job queued', { jobId: job.id });
    return job.id!;
  }

  /**
   * Trigger immediate cost validation (manual or on-demand)
   */
  async triggerCostValidation(data?: Partial<SyncCostsJobData>): Promise<string> {
    logger.info('[V3ETLScheduler] Triggering immediate cost validation', { data });

    const job = await this.costsQueue.add(
      `${syncCostsJobConfig.jobName}-manual`,
      {
        fiscalPeriod: data?.fiscalPeriod,
        monthsToProcess: data?.monthsToProcess || 1,
        validateAllocations: data?.validateAllocations !== false,
      },
      {
        priority: 5,
      }
    );

    logger.info('[V3ETLScheduler] Cost validation job queued', { jobId: job.id });
    return job.id!;
  }

  /**
   * Trigger immediate incident sync (manual or on-demand)
   */
  async triggerIncidentSync(data?: Partial<SyncIncidentsJobData>): Promise<string> {
    logger.info('[V3ETLScheduler] Triggering immediate incident sync', { data });

    const job = await this.incidentsQueue.add(
      `${syncIncidentsJobConfig.jobName}-manual`,
      {
        incrementalSince: data?.incrementalSince,
        includeChanges: data?.includeChanges !== false,
        calculateSLAs: data?.calculateSLAs !== false,
      },
      {
        priority: 10, // Highest priority for incidents
      }
    );

    logger.info('[V3ETLScheduler] Incident sync job queued', { jobId: job.id });
    return job.id!;
  }

  /**
   * Stop the scheduler and clean up all repeatable jobs
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      logger.warn('[V3ETLScheduler] Not started');
      return;
    }

    logger.info('[V3ETLScheduler] Stopping v3.0 ETL scheduler...');

    await this.cleanupExistingJobs();

    this.isStarted = false;
    logger.info('[V3ETLScheduler] v3.0 ETL scheduler stopped');
  }

  /**
   * Get queue statistics for monitoring
   */
  async getStats(): Promise<{
    cis: any;
    costs: any;
    incidents: any;
  }> {
    const [cisJobs, costsJobs, incidentsJobs] = await Promise.all([
      this.cisQueue.getJobCounts(),
      this.costsQueue.getJobCounts(),
      this.incidentsQueue.getJobCounts(),
    ]);

    return {
      cis: cisJobs,
      costs: costsJobs,
      incidents: incidentsJobs,
    };
  }

  /**
   * Get queues (for worker registration)
   */
  getQueues(): {
    cisQueue: Queue<SyncCIsJobData>;
    costsQueue: Queue<SyncCostsJobData>;
    incidentsQueue: Queue<SyncIncidentsJobData>;
  } {
    return {
      cisQueue: this.cisQueue,
      costsQueue: this.costsQueue,
      incidentsQueue: this.incidentsQueue,
    };
  }
}

// Singleton instance
let v3ETLScheduler: V3ETLScheduler | null = null;

/**
 * Get or create the v3.0 ETL scheduler singleton
 */
export function getV3ETLScheduler(): V3ETLScheduler {
  if (!v3ETLScheduler) {
    v3ETLScheduler = new V3ETLScheduler();
  }
  return v3ETLScheduler;
}
