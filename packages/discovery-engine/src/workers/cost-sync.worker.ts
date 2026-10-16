// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Sync Worker
 *
 * BullMQ worker that processes cloud cost sync jobs for AWS, Azure, and GCP.
 */

import { Worker, Job } from 'bullmq';
import { codedProcessor, jobErrorCode, JobErrorHandler, logger } from '@cmdb/common';
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
interface SafeCostResult {
  success: boolean;
  costsImported: number;
  errorCount: number;
  errorCodes: Record<string, number>;
  startDate: string;
  endDate: string;
}
const costResultSchema = {
  success: 'flag', costsImported: 'count', errorCount: 'count',
  errorCodes: 'errorCounts', startDate: 'timestamp', endDate: 'timestamp',
} as const;
function safeCostResult(result: AWSCostSyncResult | AzureCostSyncResult | GCPCostSyncResult): SafeCostResult {
  const errorCount = result.errors?.length ?? 0;
  return {
    success: result.success, costsImported: result.costsImported,
    errorCount, errorCodes: errorCount ? { ERR_INTERNAL: errorCount } : {},
    startDate: new Date(result.startDate).toISOString(),
    endDate: new Date(result.endDate).toISOString(),
  };
}

/**
 * AWS Cost Sync Worker
 */
export class AWSCostSyncWorker {
  private worker: Worker<AWSCostSyncJobData, SafeCostResult>;
  private connection = getRedisClient().getConnection().duplicate({ maxRetriesPerRequest: null });

  constructor() {
    const connection = this.connection;

    this.worker = new Worker<AWSCostSyncJobData, SafeCostResult>(
      'cost-sync-aws',
      codedProcessor('cost-sync-aws', costResultSchema, async (job: Job<AWSCostSyncJobData>) => {
        logger.info('[AWSCostSyncWorker] Processing AWS cost sync job', {
          attempt: job.attemptsMade + 1,
        });
        return safeCostResult(await processAWSCostSync(job));
      }),
      {
        connection,
        concurrency: 1, // Process one AWS job at a time to avoid API rate limits
        limiter: {
          max: 10, // Max 10 jobs
          duration: 60000, // Per 60 seconds
        },
      }
    );

    this.worker.on('completed', (_job, result) => {
      logger.info('[AWSCostSyncWorker] Job completed', {
        costsImported: result.costsImported,
        errorCount: result.errorCount,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[AWSCostSyncWorker] Job failed', { code: jobErrorCode(error) });
      if (job) void JobErrorHandler.handleJobFailure(job, error).catch(() =>
        logger.error('[AWSCostSyncWorker] Dead-letter handling failed', { code: 'ERR_INTERNAL' }));
    });
    this.worker.on('error', error => {
      logger.error('[AWSCostSyncWorker] Worker error', { code: jobErrorCode(error) });
    });

    logger.info('[AWSCostSyncWorker] Worker initialized and listening');
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
    logger.info('[AWSCostSyncWorker] Worker closed');
  }

  getWorker(): Worker<AWSCostSyncJobData, SafeCostResult> {
    return this.worker;
  }
}

/**
 * Azure Cost Sync Worker
 */
export class AzureCostSyncWorker {
  private worker: Worker<AzureCostSyncJobData, SafeCostResult>;
  private connection = getRedisClient().getConnection().duplicate({ maxRetriesPerRequest: null });

  constructor() {
    const connection = this.connection;

    this.worker = new Worker<AzureCostSyncJobData, SafeCostResult>(
      'cost-sync-azure',
      codedProcessor('cost-sync-azure', costResultSchema, async (job: Job<AzureCostSyncJobData>) => {
        logger.info('[AzureCostSyncWorker] Processing Azure cost sync job', {
          attempt: job.attemptsMade + 1,
        });
        return safeCostResult(await processAzureCostSync(job));
      }),
      {
        connection,
        concurrency: 1, // Process one Azure job at a time
        limiter: {
          max: 10,
          duration: 60000,
        },
      }
    );

    this.worker.on('completed', (_job, result) => {
      logger.info('[AzureCostSyncWorker] Job completed', {
        costsImported: result.costsImported,
        errorCount: result.errorCount,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[AzureCostSyncWorker] Job failed', { code: jobErrorCode(error) });
      if (job) void JobErrorHandler.handleJobFailure(job, error).catch(() =>
        logger.error('[AzureCostSyncWorker] Dead-letter handling failed', { code: 'ERR_INTERNAL' }));
    });
    this.worker.on('error', error => {
      logger.error('[AzureCostSyncWorker] Worker error', { code: jobErrorCode(error) });
    });

    logger.info('[AzureCostSyncWorker] Worker initialized and listening');
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
    logger.info('[AzureCostSyncWorker] Worker closed');
  }

  getWorker(): Worker<AzureCostSyncJobData, SafeCostResult> {
    return this.worker;
  }
}

/**
 * GCP Cost Sync Worker
 */
export class GCPCostSyncWorker {
  private worker: Worker<GCPCostSyncJobData, SafeCostResult>;
  private connection = getRedisClient().getConnection().duplicate({ maxRetriesPerRequest: null });

  constructor() {
    const connection = this.connection;

    this.worker = new Worker<GCPCostSyncJobData, SafeCostResult>(
      'cost-sync-gcp',
      codedProcessor('cost-sync-gcp', costResultSchema, async (job: Job<GCPCostSyncJobData>) => {
        logger.info('[GCPCostSyncWorker] Processing GCP cost sync job', {
          attempt: job.attemptsMade + 1,
        });
        return safeCostResult(await processGCPCostSync(job));
      }),
      {
        connection,
        concurrency: 1, // Process one GCP job at a time
        limiter: {
          max: 10,
          duration: 60000,
        },
      }
    );

    this.worker.on('completed', (_job, result) => {
      logger.info('[GCPCostSyncWorker] Job completed', {
        costsImported: result.costsImported,
        errorCount: result.errorCount,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[GCPCostSyncWorker] Job failed', { code: jobErrorCode(error) });
      if (job) void JobErrorHandler.handleJobFailure(job, error).catch(() =>
        logger.error('[GCPCostSyncWorker] Dead-letter handling failed', { code: 'ERR_INTERNAL' }));
    });
    this.worker.on('error', error => {
      logger.error('[GCPCostSyncWorker] Worker error', { code: jobErrorCode(error) });
    });

    logger.info('[GCPCostSyncWorker] Worker initialized and listening');
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.connection.quit();
    logger.info('[GCPCostSyncWorker] Worker closed');
  }

  getWorker(): Worker<GCPCostSyncJobData, SafeCostResult> {
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
