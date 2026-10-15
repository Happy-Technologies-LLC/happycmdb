// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ETL Processor Package
 *
 * Provides ETL jobs and transformers for the CMDB platform.
 * Handles data synchronization between Neo4j graph database and PostgreSQL data mart.
 */

import { Worker, Job } from 'bullmq';
import { getNeo4jClient, getPostgresClient, getRedisClient, QUEUE_NAMES } from '@cmdb/database';
import { logger, codedProcessor } from '@cmdb/common';
import {
  processNeo4jToPostgresJob,
  type Neo4jToPostgresJobData,
  type ETLJobResult
} from './jobs/neo4j-to-postgres.job';
import {
  processReconciliationJob,
  type ReconciliationJobData,
  type ReconciliationResult
} from './jobs/reconciliation.job';
import {
  processChangeDetectionJob,
  type ChangeDetectionJobData,
  type ChangeDetectionResult
} from './jobs/change-detection.job';
import {
  processFullRefreshJob,
  type FullRefreshJobData,
  type FullRefreshResult
} from './jobs/full-refresh.job';

// Job exports
export {
  Neo4jToPostgresJob,
  processNeo4jToPostgresJob,
  type Neo4jToPostgresJobData,
  type ETLJobResult
} from './jobs/neo4j-to-postgres.job';

export {
  ReconciliationJob,
  processReconciliationJob,
  type ReconciliationJobData,
  type ReconciliationResult,
  type Conflict,
  type ConflictType,
  type ConflictResolutionStrategy
} from './jobs/reconciliation.job';

export {
  ChangeDetectionJob,
  processChangeDetectionJob,
  type ChangeDetectionJobData,
  type ChangeDetectionResult,
  type ChangeEvent,
  type ChangeType
} from './jobs/change-detection.job';

export {
  FullRefreshJob,
  processFullRefreshJob,
  type FullRefreshJobData,
  type FullRefreshResult
} from './jobs/full-refresh.job';

// Transformer exports
export {
  CITransformer,
  type Neo4jNode,
  type PostgresRow,
  type CIDTO,
  type DataQualityResult,
  type ExtractedMetadata
} from './transformers/ci-transformer';

export {
  DimensionTransformer,
  type CIDimension,
  type LocationDimension,
  type DateDimension,
  type DiscoveryFact,
  type RelationshipFact,
  type ChangeFact
} from './transformers/dimension-transformer';

/**
 * ETL Worker Manager
 * Manages all ETL BullMQ workers for the CMDB platform
 */
export class ETLWorkerManager {
  private workers: Worker[] = [];
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();
  private redisClient = getRedisClient();

  /**
   * Start all ETL workers
   */
  async startWorkers(): Promise<void> {
    return this.start();
  }

  /**
   * Start all ETL workers (alias for startWorkers)
   */
  async start(): Promise<void> {
    logger.info('Starting ETL workers...');

    try {
      // Neo4j to PostgreSQL sync worker
      const syncWorker = new Worker(
        QUEUE_NAMES._ETL_SYNC,
        codedProcessor('etl-sync', {
          cisProcessed: 'count', relationshipsProcessed: 'count', recordsInserted: 'count',
          recordsUpdated: 'count', errors: 'count', durationMs: 'count', completedAt: 'timestamp',
        }, async (job: Job<Neo4jToPostgresJobData>) => {
          logger.info('Processing Neo4j to PostgreSQL sync job', { jobId: job.id });
          return processNeo4jToPostgresJob(job, this.neo4jClient, this.postgresClient);
        }),
        {
          connection: this.redisClient.getConnection(),
          concurrency: 2, // Process 2 sync jobs concurrently
          limiter: {
            max: 10, // Max 10 jobs
            duration: 60000 // Per minute
          }
        }
      );

      syncWorker.on('completed', (job, result: ETLJobResult) => {
        logger.info('Sync job completed', {
          _jobId: job.id,
          _cisProcessed: result.cisProcessed,
          _durationMs: result.durationMs
        });
      });

      syncWorker.on('failed', (job, error) => {
        logger.error('Sync job failed', {
          _jobId: job?.id,
          _error: error.message
        });
      });

      this.workers.push(syncWorker);

      // Reconciliation worker
      const reconciliationWorker = new Worker(
        QUEUE_NAMES._ETL_RECONCILIATION,
        codedProcessor('etl-reconciliation', {
          _cisChecked: 'count', _conflictsDetected: 'count', _conflictsResolved: 'count',
          _manualReviewRequired: 'count', _durationMs: 'count', _completedAt: 'timestamp',
        }, async (job: Job<ReconciliationJobData>) => {
          logger.info('Processing reconciliation job', { jobId: job.id });
          return processReconciliationJob(job, this.neo4jClient, this.postgresClient);
        }),
        {
          connection: this.redisClient.getConnection(),
          concurrency: 1, // Process one reconciliation at a time
          limiter: {
            max: 5,
            duration: 60000
          }
        }
      );

      reconciliationWorker.on('completed', (job, result: ReconciliationResult) => {
        logger.info('Reconciliation job completed', {
          _jobId: job.id,
          _cisChecked: result._cisChecked,
          _conflictsDetected: result._conflictsDetected,
          _conflictsResolved: result._conflictsResolved
        });
      });

      reconciliationWorker.on('failed', (job, error) => {
        logger.error('Reconciliation job failed', {
          _jobId: job?.id,
          _error: error.message
        });
      });

      this.workers.push(reconciliationWorker);

      // Change detection worker
      const changeDetectionWorker = new Worker(
        QUEUE_NAMES._ETL_CHANGE_DETECTION,
        codedProcessor('etl-change-detection', {
          cisChecked: 'count', changesDetected: 'count', changesRecorded: 'count',
          durationMs: 'count', completedAt: 'timestamp',
        }, async (job: Job<ChangeDetectionJobData>) => {
          logger.info('Processing change detection job', { jobId: job.id });
          return processChangeDetectionJob(job, this.neo4jClient, this.postgresClient);
        }),
        {
          connection: this.redisClient.getConnection(),
          concurrency: 3, // Process 3 change detection jobs concurrently
          limiter: {
            max: 20,
            duration: 60000
          }
        }
      );

      changeDetectionWorker.on('completed', (job, result: ChangeDetectionResult) => {
        logger.info('Change detection job completed', {
          _jobId: job.id,
          _cisChecked: result.cisChecked,
          _changesDetected: result.changesDetected
        });
      });

      changeDetectionWorker.on('failed', (job, error) => {
        logger.error('Change detection job failed', {
          _jobId: job?.id,
          _error: error.message
        });
      });

      this.workers.push(changeDetectionWorker);

      // Full refresh worker
      const fullRefreshWorker = new Worker(
        QUEUE_NAMES._ETL_FULL_REFRESH,
        codedProcessor('etl-full-refresh', {
          cisProcessed: 'count', relationshipsProcessed: 'count', dimensionsCreated: 'count',
          factsCreated: 'count', durationMs: 'count', completedAt: 'timestamp', stagesCompleted: 'stages',
        }, async (job: Job<FullRefreshJobData>) => {
          logger.info('Processing full refresh job', { jobId: job.id });
          return processFullRefreshJob(job, this.neo4jClient, this.postgresClient);
        }),
        {
          connection: this.redisClient.getConnection(),
          concurrency: 1, // Process one full refresh at a time
          limiter: {
            max: 1,
            duration: 300000 // One per 5 minutes
          }
        }
      );

      fullRefreshWorker.on('completed', (job, result: FullRefreshResult) => {
        logger.info('Full refresh job completed', {
          jobId: job.id,
          cisProcessed: result.cisProcessed,
          dimensionsCreated: result.dimensionsCreated,
          factsCreated: result.factsCreated,
          durationMs: result.durationMs
        });
      });

      fullRefreshWorker.on('failed', (job, error) => {
        logger.error('Full refresh job failed', {
          jobId: job?.id,
          error: error.message
        });
      });

      this.workers.push(fullRefreshWorker);

      // Register event listeners for all workers
      this.workers.forEach(worker => {
        worker.on('active', (job) => {
          logger.debug('Job started', {
            _jobId: job.id,
            _queue: job.queueName
          });
        });

        worker.on('progress', (job, progress) => {
          logger.debug('Job progress', {
            _jobId: job.id,
            _progress: `${progress}%`
          });
        });

        worker.on('stalled', (jobId) => {
          logger.warn('Job stalled', { jobId });
        });

        worker.on('error', (error) => {
          logger.error('Worker error', { error });
        });
      });

      logger.info(`Started ${this.workers.length} ETL workers successfully`, {
        _queues: this.workers.map(w => w.name)
      });

    } catch (error) {
      logger.error('Failed to start ETL workers', { error });
      throw error;
    }
  }

  /**
   * Stop all ETL workers gracefully
   */
  async stopWorkers(): Promise<void> {
    return this.stop();
  }

  /**
   * Stop all ETL workers (alias for stopWorkers)
   */
  async stop(): Promise<void> {
    logger.info('Stopping ETL workers...');

    try {
      await Promise.all(
        this.workers.map(async worker => {
          await worker.close();
          logger.info('Worker stopped', { queue: worker.name });
        })
      );

      this.workers = [];
      logger.info('All ETL workers stopped successfully');

    } catch (error) {
      logger.error('Error stopping ETL workers', { error });
      throw error;
    }
  }

  /**
   * Get all worker statuses (alias for getHealthStatus)
   */
  async getAllWorkerStatuses(): Promise<WorkerHealthStatus> {
    return this.getHealthStatus();
  }

  /**
   * Get worker health status
   */
  async getHealthStatus(): Promise<WorkerHealthStatus> {
    const status: WorkerHealthStatus = {
      healthy: true,
      workers: []
    };

    for (const worker of this.workers) {
      const isRunning = await worker.isRunning();
      const workerStatus = {
        name: worker.name,
        running: isRunning,
        concurrency: worker.opts.concurrency || 1
      };

      status.workers.push(workerStatus);

      if (!isRunning) {
        status.healthy = false;
      }
    }

    return status;
  }

  /**
   * Pause all workers
   */
  async pauseWorkers(): Promise<void> {
    logger.info('Pausing all ETL workers...');
    await Promise.all(this.workers.map(w => w.pause()));
    logger.info('All workers paused');
  }

  /**
   * Resume all workers
   */
  async resumeWorkers(): Promise<void> {
    logger.info('Resuming all ETL workers...');
    await Promise.all(this.workers.map(w => w.resume()));
    logger.info('All workers resumed');
  }
}

/**
 * Worker health status
 */
export interface WorkerHealthStatus {
  healthy: boolean;
  workers: {
    name: string;
    running: boolean;
    concurrency: number;
  }[];
}

/**
 * Singleton instance for ETL worker manager
 */
let workerManager: ETLWorkerManager | null = null;

/**
 * Get the ETL worker manager singleton instance
 */
export function getETLWorkerManager(): ETLWorkerManager {
  if (!workerManager) {
    workerManager = new ETLWorkerManager();
  }
  return workerManager;
}

// Export ETL Scheduler from the schedulers module
export { getETLScheduler, ETLScheduler } from './schedulers/etl-scheduler';

// v3.0 ETL Imports (needed for initializeV3ETL/shutdownV3ETL)
import { getV3ETLScheduler, V3ETLScheduler } from './schedulers/v3-etl-scheduler';
import { getV3ETLWorkerManager, V3ETLWorkerManager, CISyncWorker, CostValidationWorker, IncidentSyncWorker } from './workers/v3-etl.worker';

// v3.0 ETL Exports
export {
  getV3ETLScheduler,
  V3ETLScheduler,
};

export {
  getV3ETLWorkerManager,
  V3ETLWorkerManager,
  CISyncWorker,
  CostValidationWorker,
  IncidentSyncWorker,
};

export {
  processSyncCIsToDatamart,
  syncCIsJobConfig,
  type SyncCIsJobData,
  type SyncCIsJobResult,
} from './jobs/sync-cis-to-datamart.job';

export {
  processSyncCostsToDatamart,
  syncCostsJobConfig,
  type SyncCostsJobData,
  type SyncCostsJobResult,
} from './jobs/sync-costs-to-datamart.job';

export {
  processSyncIncidentsToDatamart,
  syncIncidentsJobConfig,
  type SyncIncidentsJobData,
  type SyncIncidentsJobResult,
} from './jobs/sync-incidents-to-datamart.job';

/**
 * Initialize and start all ETL workers
 * Call this when starting the ETL processor service
 */
export async function initializeETLWorkers(): Promise<ETLWorkerManager> {
  const manager = getETLWorkerManager();
  await manager.startWorkers();
  return manager;
}

/**
 * Initialize and start all v3.0 ETL workers and scheduler
 * Call this when starting the discovery engine or ETL processor service for v3.0
 */
export async function initializeV3ETL(): Promise<{
  scheduler: V3ETLScheduler;
  workerManager: V3ETLWorkerManager;
}> {
  logger.info('[initializeV3ETL] Starting v3.0 ETL pipeline...');

  const scheduler = getV3ETLScheduler();
  const workerManager = getV3ETLWorkerManager();

  await scheduler.start();
  await workerManager.start();

  logger.info('[initializeV3ETL] v3.0 ETL pipeline started successfully');

  return { scheduler, workerManager };
}

/**
 * Graceful shutdown handler
 * Call this when shutting down the ETL processor service
 */
export async function shutdownETLWorkers(): Promise<void> {
  if (workerManager) {
    await workerManager.stopWorkers();
    workerManager = null;
  }
}

/**
 * Shutdown v3.0 ETL pipeline gracefully
 */
export async function shutdownV3ETL(): Promise<void> {
  logger.info('[shutdownV3ETL] Stopping v3.0 ETL pipeline...');

  const scheduler = getV3ETLScheduler();
  const workerManager = getV3ETLWorkerManager();

  await scheduler.stop();
  await workerManager.stop();

  logger.info('[shutdownV3ETL] v3.0 ETL pipeline stopped');
}
