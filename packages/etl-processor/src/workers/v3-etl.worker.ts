// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * v3.0 ETL Workers
 *
 * BullMQ workers that process v3.0 ETL jobs:
 * - CI sync (with ITIL, TBM, BSM attributes)
 * - Cost validation and enrichment
 * - Incident/Change validation and SLA tracking
 *
 * These workers run continuously to process jobs from the ETL queues.
 */

import { Worker, Job } from 'bullmq';
import { logger, codedProcessor, jobErrorCode, JobErrorHandler } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import {
  processSyncCIsToDatamart,
  SyncCIsJobData,
  SyncCIsJobResult,
} from '../jobs/sync-cis-to-datamart.job';
import {
  processSyncCostsToDatamart,
  SyncCostsJobData,
  SyncCostsJobResult,
} from '../jobs/sync-costs-to-datamart.job';
import {
  processSyncIncidentsToDatamart,
  SyncIncidentsJobData,
  SyncIncidentsJobResult,
} from '../jobs/sync-incidents-to-datamart.job';
type SafeCIResult = Omit<SyncCIsJobResult, 'errors'> & { errorCount: number; errorCodes: Record<string, number> };
type SafeCostResult = Omit<SyncCostsJobResult,
  'validationErrors' | 'enrichmentErrors' | 'totalMonthlyCost' | 'totalAnnualCost'> &
  { errorCount: number; errorCodes: Record<string, number> };
type SafeIncidentResult = Omit<SyncIncidentsJobResult, 'validationErrors' | 'enrichmentErrors'> &
  { errorCount: number; errorCodes: Record<string, number> };

/**
 * CI Sync Worker
 * Processes jobs that sync CIs from Neo4j to PostgreSQL dim_ci table
 */
export class CISyncWorker {
  private worker: Worker<SyncCIsJobData, SafeCIResult>;
  private connection = getRedisClient().getConnection().duplicate({ maxRetriesPerRequest: null });

  constructor() {
    const connection = this.connection;

    this.worker = new Worker<SyncCIsJobData, SafeCIResult>(
      'etl-cis',
      codedProcessor('etl-cis', {
        success: 'flag', cisProcessed: 'count', cisInserted: 'count', cisUpdated: 'count',
        cisSkipped: 'count', errorCount: 'count', errorCodes: 'errorCounts',
        startTime: 'timestamp', endTime: 'timestamp', durationMs: 'count',
      }, async (job: Job<SyncCIsJobData>): Promise<SafeCIResult> => {
        logger.info('[CISyncWorker] Processing CI sync job', { jobId: job.id });
        const { errors, ...counts } = await processSyncCIsToDatamart(job);
        const errorCount = errors.length;
        return { ...counts, errorCount, errorCodes: errorCount ? { ERR_VALIDATION: errorCount } : {} };
      }),
      {
        connection,
        concurrency: 1, // Process one CI sync job at a time to avoid lock contention
        limiter: {
          max: 10, // Max 10 jobs
          duration: 60000, // Per 60 seconds
        },
      }
    );

    // Event handlers
    this.worker.on('completed', (job, result) => {
      logger.info('[CISyncWorker] Job completed', {
        jobId: job.id,
        cisProcessed: result.cisProcessed,
        cisInserted: result.cisInserted,
        cisUpdated: result.cisUpdated,
        durationMs: result.durationMs,
        success: result.success,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[CISyncWorker] Job failed', {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        code: jobErrorCode(error),
      });
      if (job) void JobErrorHandler.handleJobFailure(job, error).catch(() =>
        logger.error('[CISyncWorker] Dead-letter handling failed', { code: 'ERR_INTERNAL' }));
    });

    this.worker.on('error', (error) => {
      logger.error('[CISyncWorker] Worker error', {
        code: jobErrorCode(error),
      });
    });

    logger.info('[CISyncWorker] Initialized and ready to process jobs');
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    logger.info('[CISyncWorker] Stopping worker...');
    await this.worker.close();
    await this.connection.quit();
    logger.info('[CISyncWorker] Worker stopped');
  }

  /**
   * Get worker instance
   */
  getWorker(): Worker<SyncCIsJobData, SafeCIResult> {
    return this.worker;
  }
}

/**
 * Cost Validation Worker
 * Processes jobs that validate and enrich cost data
 */
export class CostValidationWorker {
  private worker: Worker<SyncCostsJobData, SafeCostResult>;

  private connection = getRedisClient().getConnection().duplicate({ maxRetriesPerRequest: null });
  constructor() {
    const connection = this.connection;

    this.worker = new Worker<SyncCostsJobData, SafeCostResult>(
      'etl-costs',
      codedProcessor('etl-costs', {
        success: 'flag', periodsProcessed: 'count', costPoolsValidated: 'count',
        costPoolsEnriched: 'count', errorCount: 'count', errorCodes: 'errorCounts',
        startTime: 'timestamp', endTime: 'timestamp', durationMs: 'count',
      }, async (job: Job<SyncCostsJobData>): Promise<SafeCostResult> => {
        logger.info('[CostValidationWorker] Processing cost validation job', { jobId: job.id });
        const { validationErrors, enrichmentErrors, totalMonthlyCost, totalAnnualCost, ...counts } =
          await processSyncCostsToDatamart(job);
        const errorCount = validationErrors.length + enrichmentErrors.length;
        return { ...counts, errorCount, errorCodes: errorCount ? { ERR_VALIDATION: errorCount } : {} };
      }),
      {
        connection,
        concurrency: 1, // Process one cost job at a time
        limiter: {
          max: 10,
          duration: 60000,
        },
      }
    );

    // Event handlers
    this.worker.on('completed', (job, result) => {
      logger.info('[CostValidationWorker] Job completed', {
        jobId: job.id,
        periodsProcessed: result.periodsProcessed,
        costPoolsValidated: result.costPoolsValidated,
        durationMs: result.durationMs,
        success: result.success,
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[CostValidationWorker] Job failed', {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        code: jobErrorCode(error),
      });
      if (job) void JobErrorHandler.handleJobFailure(job, error).catch(() =>
        logger.error('[CostValidationWorker] Dead-letter handling failed', { code: 'ERR_INTERNAL' }));
    });

    this.worker.on('error', (error) => {
      logger.error('[CostValidationWorker] Worker error', {
        code: jobErrorCode(error),
      });
    });

    logger.info('[CostValidationWorker] Initialized and ready to process jobs');
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    logger.info('[CostValidationWorker] Stopping worker...');
    await this.worker.close();
    await this.connection.quit();
    logger.info('[CostValidationWorker] Worker stopped');
  }

  /**
   * Get worker instance
   */
  getWorker(): Worker<SyncCostsJobData, SafeCostResult> {
    return this.worker;
  }
}

/**
 * Incident Sync Worker
 * Processes jobs that validate incidents, calculate SLAs, and enrich with CI data
 */
export class IncidentSyncWorker {
  private worker: Worker<SyncIncidentsJobData, SafeIncidentResult>;

  private connection = getRedisClient().getConnection().duplicate({ maxRetriesPerRequest: null });
  constructor() {
    const connection = this.connection;

    this.worker = new Worker<SyncIncidentsJobData, SafeIncidentResult>(
      'etl-incidents',
      codedProcessor('etl-incidents', {
        success: 'flag', incidentsProcessed: 'count', incidentsEnriched: 'count',
        changesProcessed: 'count', changesEnriched: 'count', slaViolations: 'count',
        errorCount: 'count', errorCodes: 'errorCounts',
        startTime: 'timestamp', endTime: 'timestamp', durationMs: 'count',
      }, async (job: Job<SyncIncidentsJobData>): Promise<SafeIncidentResult> => {
        logger.info('[IncidentSyncWorker] Processing incident sync job', { jobId: job.id });
        const { validationErrors, enrichmentErrors, ...counts } = await processSyncIncidentsToDatamart(job);
        const errorCount = validationErrors.length + enrichmentErrors.length;
        return { ...counts, errorCount, errorCodes: errorCount ? { ERR_VALIDATION: errorCount } : {} };
      }),
      {
        connection,
        concurrency: 2, // Can process 2 incident jobs concurrently for real-time ITSM
        limiter: {
          max: 20, // Higher limit for frequent incident updates
          duration: 60000,
        },
      }
    );

    // Event handlers
    this.worker.on('completed', (job, result) => {
      logger.info('[IncidentSyncWorker] Job completed', {
        jobId: job.id,
        incidentsProcessed: result.incidentsProcessed,
        changesProcessed: result.changesProcessed,
        slaViolations: result.slaViolations,
        durationMs: result.durationMs,
        success: result.success,
      });

      // Alert on SLA violations
      if (result.slaViolations > 0) {
        logger.warn('[IncidentSyncWorker] SLA violations detected', {
          violations: result.slaViolations,
        });
      }
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[IncidentSyncWorker] Job failed', {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        code: jobErrorCode(error),
      });
      if (job) void JobErrorHandler.handleJobFailure(job, error).catch(() =>
        logger.error('[IncidentSyncWorker] Dead-letter handling failed', { code: 'ERR_INTERNAL' }));
    });

    this.worker.on('error', (error) => {
      logger.error('[IncidentSyncWorker] Worker error', {
        code: jobErrorCode(error),
      });
    });

    logger.info('[IncidentSyncWorker] Initialized and ready to process jobs');
  }

  /**
   * Stop the worker gracefully
   */
  async stop(): Promise<void> {
    logger.info('[IncidentSyncWorker] Stopping worker...');
    await this.worker.close();
    await this.connection.quit();
    logger.info('[IncidentSyncWorker] Worker stopped');
  }

  /**
   * Get worker instance
   */
  getWorker(): Worker<SyncIncidentsJobData, SafeIncidentResult> {
    return this.worker;
  }
}

/**
 * v3.0 ETL Worker Manager
 * Manages all v3.0 ETL workers
 */
export class V3ETLWorkerManager {
  private ciSyncWorker: CISyncWorker;
  private costValidationWorker: CostValidationWorker;
  private incidentSyncWorker: IncidentSyncWorker;
  private isStarted: boolean = false;

  constructor() {
    this.ciSyncWorker = new CISyncWorker();
    this.costValidationWorker = new CostValidationWorker();
    this.incidentSyncWorker = new IncidentSyncWorker();

    logger.info('[V3ETLWorkerManager] Initialized all v3.0 ETL workers');
  }

  /**
   * Start all workers (they're already listening, this is a no-op but kept for consistency)
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn('[V3ETLWorkerManager] Workers already started');
      return;
    }

    this.isStarted = true;
    logger.info('[V3ETLWorkerManager] All v3.0 ETL workers are running');
  }

  /**
   * Stop all workers gracefully
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      logger.warn('[V3ETLWorkerManager] Workers not started');
      return;
    }

    logger.info('[V3ETLWorkerManager] Stopping all v3.0 ETL workers...');

    await Promise.all([
      this.ciSyncWorker.stop(),
      this.costValidationWorker.stop(),
      this.incidentSyncWorker.stop(),
    ]);

    this.isStarted = false;
    logger.info('[V3ETLWorkerManager] All v3.0 ETL workers stopped');
  }

  /**
   * Get worker instances (for monitoring or testing)
   */
  getWorkers(): {
    ciSync: Worker<SyncCIsJobData, SafeCIResult>;
    costValidation: Worker<SyncCostsJobData, SafeCostResult>;
    incidentSync: Worker<SyncIncidentsJobData, SafeIncidentResult>;
  } {
    return {
      ciSync: this.ciSyncWorker.getWorker(),
      costValidation: this.costValidationWorker.getWorker(),
      incidentSync: this.incidentSyncWorker.getWorker(),
    };
  }
}

// Singleton instance
let v3ETLWorkerManager: V3ETLWorkerManager | null = null;

/**
 * Get or create the v3.0 ETL worker manager singleton
 */
export function getV3ETLWorkerManager(): V3ETLWorkerManager {
  if (!v3ETLWorkerManager) {
    v3ETLWorkerManager = new V3ETLWorkerManager();
  }
  return v3ETLWorkerManager;
}
