// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Sync Worker
 *
 * BullMQ worker that processes cloud cost sync jobs for AWS, Azure, and GCP.
 */

import { Worker, Job } from 'bullmq';
import { logger } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import {
  processAWSCostSync,
  AWSCostSyncJobData,
  AWSCostSyncResult,
} from '../jobs/aws-cost-sync.job';
import {
  processAzureCostSync,
  AzureCostSyncJobData,
  AzureCostSyncResult,
} from '../jobs/azure-cost-sync.job';
import {
  processGCPCostSync,
  GCPCostSyncJobData,
  GCPCostSyncResult,
} from '../jobs/gcp-cost-sync.job';

/**
 * AWS Cost Sync Worker
 */
export class AWSCostSyncWorker {
  private worker: Worker<AWSCostSyncJobData, AWSCostSyncResult>;

  constructor() {
    const redisClient = getRedisClient();
    const connection = redisClient.getConnection();

    this.worker = new Worker<AWSCostSyncJobData, AWSCostSyncResult>(
      'cost-sync-aws',
      async (job: Job<AWSCostSyncJobData>) => {
        logger.info('[AWSCostSyncWorker] Processing AWS cost sync job', {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
        });

        return await processAWSCostSync(job);
      },
      {
        connection,
        concurrency: 1, // Process one AWS job at a time to avoid API rate limits
        limiter: {
          max: 10, // Max 10 jobs
          duration: 60000, // Per 60 seconds
        },
      }
    );

    this.worker.on('completed', (job, result) => {
      logger.info('[AWSCostSyncWorker] Job completed', {
        jobId: job.id,
        costsImported: result.costsImported,
        totalCost: result.totalCost,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[AWSCostSyncWorker] Job failed', {
        jobId: job?.id,
        error: error.message,
        stack: error.stack,
      });
    });

    logger.info('[AWSCostSyncWorker] Worker initialized and listening');
  }

  async close(): Promise<void> {
    await this.worker.close();
    logger.info('[AWSCostSyncWorker] Worker closed');
  }

  getWorker(): Worker<AWSCostSyncJobData, AWSCostSyncResult> {
    return this.worker;
  }
}

/**
 * Azure Cost Sync Worker
 */
export class AzureCostSyncWorker {
  private worker: Worker<AzureCostSyncJobData, AzureCostSyncResult>;

  constructor() {
    const redisClient = getRedisClient();
    const connection = redisClient.getConnection();

    this.worker = new Worker<AzureCostSyncJobData, AzureCostSyncResult>(
      'cost-sync-azure',
      async (job: Job<AzureCostSyncJobData>) => {
        logger.info('[AzureCostSyncWorker] Processing Azure cost sync job', {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
        });

        return await processAzureCostSync(job);
      },
      {
        connection,
        concurrency: 1, // Process one Azure job at a time
        limiter: {
          max: 10,
          duration: 60000,
        },
      }
    );

    this.worker.on('completed', (job, result) => {
      logger.info('[AzureCostSyncWorker] Job completed', {
        jobId: job.id,
        costsImported: result.costsImported,
        totalCost: result.totalCost,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[AzureCostSyncWorker] Job failed', {
        jobId: job?.id,
        error: error.message,
        stack: error.stack,
      });
    });

    logger.info('[AzureCostSyncWorker] Worker initialized and listening');
  }

  async close(): Promise<void> {
    await this.worker.close();
    logger.info('[AzureCostSyncWorker] Worker closed');
  }

  getWorker(): Worker<AzureCostSyncJobData, AzureCostSyncResult> {
    return this.worker;
  }
}

/**
 * GCP Cost Sync Worker
 */
export class GCPCostSyncWorker {
  private worker: Worker<GCPCostSyncJobData, GCPCostSyncResult>;

  constructor() {
    const redisClient = getRedisClient();
    const connection = redisClient.getConnection();

    this.worker = new Worker<GCPCostSyncJobData, GCPCostSyncResult>(
      'cost-sync-gcp',
      async (job: Job<GCPCostSyncJobData>) => {
        logger.info('[GCPCostSyncWorker] Processing GCP cost sync job', {
          jobId: job.id,
          attempt: job.attemptsMade + 1,
        });

        return await processGCPCostSync(job);
      },
      {
        connection,
        concurrency: 1, // Process one GCP job at a time
        limiter: {
          max: 10,
          duration: 60000,
        },
      }
    );

    this.worker.on('completed', (job, result) => {
      logger.info('[GCPCostSyncWorker] Job completed', {
        jobId: job.id,
        costsImported: result.costsImported,
        totalCost: result.totalCost,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[GCPCostSyncWorker] Job failed', {
        jobId: job?.id,
        error: error.message,
        stack: error.stack,
      });
    });

    logger.info('[GCPCostSyncWorker] Worker initialized and listening');
  }

  async close(): Promise<void> {
    await this.worker.close();
    logger.info('[GCPCostSyncWorker] Worker closed');
  }

  getWorker(): Worker<GCPCostSyncJobData, GCPCostSyncResult> {
    return this.worker;
  }
}

/**
 * Cost Sync Worker Manager
 * Manages all cost sync workers
 */
export class CostSyncWorkerManager {
  private awsWorker: AWSCostSyncWorker;
  private azureWorker: AzureCostSyncWorker;
  private gcpWorker: GCPCostSyncWorker;

  constructor() {
    this.awsWorker = new AWSCostSyncWorker();
    this.azureWorker = new AzureCostSyncWorker();
    this.gcpWorker = new GCPCostSyncWorker();

    logger.info('[CostSyncWorkerManager] All cost sync workers initialized');
  }

  async closeAll(): Promise<void> {
    await Promise.all([
      this.awsWorker.close(),
      this.azureWorker.close(),
      this.gcpWorker.close(),
    ]);

    logger.info('[CostSyncWorkerManager] All cost sync workers closed');
  }

  getWorkers() {
    return {
      aws: this.awsWorker.getWorker(),
      azure: this.azureWorker.getWorker(),
      gcp: this.gcpWorker.getWorker(),
    };
  }
}

/**
 * Singleton instance
 */
let workerManager: CostSyncWorkerManager | null = null;

/**
 * Get or create the cost sync worker manager
 */
export function getCostSyncWorkerManager(): CostSyncWorkerManager {
  if (!workerManager) {
    workerManager = new CostSyncWorkerManager();
  }
  return workerManager;
}

/**
 * Close all cost sync workers
 */
export async function closeCostSyncWorkers(): Promise<void> {
  if (workerManager) {
    await workerManager.closeAll();
    workerManager = null;
  }
}
