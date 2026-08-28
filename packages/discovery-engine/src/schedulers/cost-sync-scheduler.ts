// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Sync Job Scheduler
 *
 * Registers and manages scheduled BullMQ jobs for cloud cost synchronization.
 * Supports AWS, Azure, and GCP cost data imports.
 */

import { Queue } from 'bullmq';
import { logger } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import {
  processAWSCostSync,
  awsCostSyncJobConfig,
  AWSCostSyncJobData,
} from '../jobs/aws-cost-sync.job';
import {
  processAzureCostSync,
  azureCostSyncJobConfig,
  AzureCostSyncJobData,
} from '../jobs/azure-cost-sync.job';
import {
  processGCPCostSync,
  gcpCostSyncJobConfig,
  GCPCostSyncJobData,
} from '../jobs/gcp-cost-sync.job';

/**
 * Cost Sync Scheduler
 * Manages repeatable BullMQ jobs for cloud cost synchronization
 */
export class CostSyncScheduler {
  private awsQueue: Queue<AWSCostSyncJobData>;
  private azureQueue: Queue<AzureCostSyncJobData>;
  private gcpQueue: Queue<GCPCostSyncJobData>;
  private isStarted = false;

  constructor() {
    const redisClient = getRedisClient();
    const connection = redisClient.getConnection();

    // Initialize BullMQ queues for each cloud provider
    this.awsQueue = new Queue<AWSCostSyncJobData>('cost-sync-aws', {
      connection,
      defaultJobOptions: awsCostSyncJobConfig.defaultOptions,
    });

    this.azureQueue = new Queue<AzureCostSyncJobData>('cost-sync-azure', {
      connection,
      defaultJobOptions: azureCostSyncJobConfig.defaultOptions,
    });

    this.gcpQueue = new Queue<GCPCostSyncJobData>('cost-sync-gcp', {
      connection,
      defaultJobOptions: gcpCostSyncJobConfig.defaultOptions,
    });

    logger.info('[CostSyncScheduler] Initialized cost sync queues', {
      queues: ['cost-sync-aws', 'cost-sync-azure', 'cost-sync-gcp'],
    });
  }

  /**
   * Start all scheduled cost sync jobs
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn('[CostSyncScheduler] Already started');
      return;
    }

    logger.info('[CostSyncScheduler] Starting cost sync scheduler...');

    try {
      // Remove any existing repeatable jobs (cleanup)
      await this.cleanupExistingJobs();

      // Schedule AWS cost sync (daily at 2:00 AM UTC)
      await this.awsQueue.add(
        awsCostSyncJobConfig.jobName,
        {}, // No default data, will be overridden by credential config
        {
          repeat: {
            pattern: awsCostSyncJobConfig.cronSchedule,
          },
          jobId: 'aws-cost-sync-repeatable',
        }
      );

      logger.info('[CostSyncScheduler] Scheduled AWS cost sync job', {
        schedule: awsCostSyncJobConfig.cronSchedule,
        jobId: 'aws-cost-sync-repeatable',
      });

      // Schedule Azure cost sync (daily at 2:30 AM UTC)
      await this.azureQueue.add(
        azureCostSyncJobConfig.jobName,
        {},
        {
          repeat: {
            pattern: azureCostSyncJobConfig.cronSchedule,
          },
          jobId: 'azure-cost-sync-repeatable',
        }
      );

      logger.info('[CostSyncScheduler] Scheduled Azure cost sync job', {
        schedule: azureCostSyncJobConfig.cronSchedule,
        jobId: 'azure-cost-sync-repeatable',
      });

      // Schedule GCP cost sync (daily at 3:00 AM UTC)
      await this.gcpQueue.add(
        gcpCostSyncJobConfig.jobName,
        {},
        {
          repeat: {
            pattern: gcpCostSyncJobConfig.cronSchedule,
          },
          jobId: 'gcp-cost-sync-repeatable',
        }
      );

      logger.info('[CostSyncScheduler] Scheduled GCP cost sync job', {
        schedule: gcpCostSyncJobConfig.cronSchedule,
        jobId: 'gcp-cost-sync-repeatable',
      });

      this.isStarted = true;

      logger.info('[CostSyncScheduler] Cost sync scheduler started successfully', {
        jobs: [
          { name: 'AWS', schedule: awsCostSyncJobConfig.cronSchedule },
          { name: 'Azure', schedule: azureCostSyncJobConfig.cronSchedule },
          { name: 'GCP', schedule: gcpCostSyncJobConfig.cronSchedule },
        ],
      });
    } catch (error) {
      logger.error('[CostSyncScheduler] Failed to start cost sync scheduler', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Stop all scheduled cost sync jobs
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      logger.warn('[CostSyncScheduler] Not started');
      return;
    }

    logger.info('[CostSyncScheduler] Stopping cost sync scheduler...');

    try {
      // Remove all repeatable jobs
      await this.cleanupExistingJobs();

      // Close queues
      await this.awsQueue.close();
      await this.azureQueue.close();
      await this.gcpQueue.close();

      this.isStarted = false;

      logger.info('[CostSyncScheduler] Cost sync scheduler stopped successfully');
    } catch (error) {
      logger.error('[CostSyncScheduler] Failed to stop cost sync scheduler', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Trigger immediate cost sync for a specific cloud provider
   */
  async triggerImmediateSync(
    provider: 'aws' | 'azure' | 'gcp',
    data?: AWSCostSyncJobData | AzureCostSyncJobData | GCPCostSyncJobData
  ): Promise<string> {
    logger.info('[CostSyncScheduler] Triggering immediate cost sync', {
      provider,
      data,
    });

    let job;

    switch (provider) {
      case 'aws':
        job = await this.awsQueue.add(
          `${awsCostSyncJobConfig.jobName}-immediate`,
          (data as AWSCostSyncJobData) || {},
          { priority: 1 } // High priority for manual triggers
        );
        break;

      case 'azure':
        job = await this.azureQueue.add(
          `${azureCostSyncJobConfig.jobName}-immediate`,
          (data as AzureCostSyncJobData) || {},
          { priority: 1 }
        );
        break;

      case 'gcp':
        job = await this.gcpQueue.add(
          `${gcpCostSyncJobConfig.jobName}-immediate`,
          (data as GCPCostSyncJobData) || {},
          { priority: 1 }
        );
        break;

      default:
        throw new Error(`Unknown cloud provider: ${provider}`);
    }

    logger.info('[CostSyncScheduler] Immediate cost sync triggered', {
      provider,
      jobId: job.id,
    });

    return job.id!;
  }

  /**
   * Get status of all cost sync jobs
   */
  async getJobStatus(): Promise<{
    aws: any;
    azure: any;
    gcp: any;
  }> {
    const [awsRepeatableJobs, azureRepeatableJobs, gcpRepeatableJobs] =
      await Promise.all([
        this.awsQueue.getRepeatableJobs(),
        this.azureQueue.getRepeatableJobs(),
        this.gcpQueue.getRepeatableJobs(),
      ]);

    const [awsJobCounts, azureJobCounts, gcpJobCounts] = await Promise.all([
      this.awsQueue.getJobCounts(),
      this.azureQueue.getJobCounts(),
      this.gcpQueue.getJobCounts(),
    ]);

    return {
      aws: {
        repeatableJobs: awsRepeatableJobs,
        jobCounts: awsJobCounts,
        queueName: 'cost-sync-aws',
      },
      azure: {
        repeatableJobs: azureRepeatableJobs,
        jobCounts: azureJobCounts,
        queueName: 'cost-sync-azure',
      },
      gcp: {
        repeatableJobs: gcpRepeatableJobs,
        jobCounts: gcpJobCounts,
        queueName: 'cost-sync-gcp',
      },
    };
  }

  /**
   * Cleanup existing repeatable jobs
   */
  private async cleanupExistingJobs(): Promise<void> {
    logger.info('[CostSyncScheduler] Cleaning up existing repeatable jobs...');

    const [awsJobs, azureJobs, gcpJobs] = await Promise.all([
      this.awsQueue.getRepeatableJobs(),
      this.azureQueue.getRepeatableJobs(),
      this.gcpQueue.getRepeatableJobs(),
    ]);

    // Remove AWS repeatable jobs
    for (const job of awsJobs) {
      await this.awsQueue.removeRepeatableByKey(job.key);
      logger.debug('[CostSyncScheduler] Removed AWS repeatable job', {
        key: job.key,
      });
    }

    // Remove Azure repeatable jobs
    for (const job of azureJobs) {
      await this.azureQueue.removeRepeatableByKey(job.key);
      logger.debug('[CostSyncScheduler] Removed Azure repeatable job', {
        key: job.key,
      });
    }

    // Remove GCP repeatable jobs
    for (const job of gcpJobs) {
      await this.gcpQueue.removeRepeatableByKey(job.key);
      logger.debug('[CostSyncScheduler] Removed GCP repeatable job', {
        key: job.key,
      });
    }

    logger.info('[CostSyncScheduler] Cleanup complete', {
      removedJobs: awsJobs.length + azureJobs.length + gcpJobs.length,
    });
  }

  /**
   * Get queue instances (for worker registration)
   */
  getQueues() {
    return {
      aws: this.awsQueue,
      azure: this.azureQueue,
      gcp: this.gcpQueue,
    };
  }
}

/**
 * Singleton instance
 */
let costSyncScheduler: CostSyncScheduler | null = null;

/**
 * Get or create the cost sync scheduler singleton
 */
export function getCostSyncScheduler(): CostSyncScheduler {
  if (!costSyncScheduler) {
    costSyncScheduler = new CostSyncScheduler();
  }
  return costSyncScheduler;
}

/**
 * Start the cost sync scheduler
 */
export async function startCostSyncScheduler(): Promise<void> {
  const scheduler = getCostSyncScheduler();
  await scheduler.start();
}

/**
 * Stop the cost sync scheduler
 */
export async function stopCostSyncScheduler(): Promise<void> {
  if (costSyncScheduler) {
    await costSyncScheduler.stop();
    costSyncScheduler = null;
  }
}
