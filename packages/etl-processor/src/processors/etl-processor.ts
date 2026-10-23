// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ETL Job Processor
 *
 * This module implements the worker processor for ETL jobs.
 * Handles sync, change detection, reconciliation, and full refresh operations.
 */

import { Job } from 'bullmq';
import neo4j, { type Record as Neo4jRecord } from 'neo4j-driver';
import { logger, getQueueManager } from '@cmdb/common';
import type { ETLJobData, JobResult, JobProgress } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { extractedCI, Neo4jToPostgresJob } from '../jobs/neo4j-to-postgres.job';
import { type ExtractedCI, withDimCiIds } from '../transformers/ci-organization';

/** CIs per load transaction, the neo4j-to-postgres default batch size. */
const LOAD_BATCH_SIZE = 100;

/**
 * ETL Job Processor
 */
export class ETLJobProcessor {
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();
  private queueManager = getQueueManager();

  /**
   * Process an ETL job
   */
  async process(job: Job<ETLJobData>): Promise<JobResult> {
    const { _jobId, _type, _config, triggeredBy } = job.data;
    const startTime = Date.now();

    logger.info(`Processing ETL job ${_jobId}`, { type: _type, triggeredBy });

    try {
      // Update progress: Starting
      await this.updateProgress(job, {
        _percent: 0,
        _currentStep: 'initializing',
        _totalSteps: 4,
        _itemsProcessed: 0,
        _startedAt: new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
      });

      // Execute ETL based on type
      let result;
      switch (_type) {
        case 'sync':
          result = await this.processSync(job, _config);
          break;
        case 'change-detection':
          result = await this.processChangeDetection(job, _config);
          break;
        case 'reconciliation':
          result = await this.processReconciliation(job, _config);
          break;
        case 'full-refresh':
          result = await this.processFullRefresh(job, _config);
          break;
        default:
          throw new Error(`Unknown ETL type: ${_type}`);
      }

      // Update progress: Completed
      await this.updateProgress(job, {
        _percent: 100,
        _currentStep: 'completed',
        _totalSteps: 4,
        _itemsProcessed: result._itemsProcessed,
        _startedAt: new Date(startTime).toISOString(),
        _updatedAt: new Date().toISOString(),
      });

      const jobResult: JobResult = {
        _jobId,
        _status: 'completed',
        ...result,
        _startedAt: new Date(startTime).toISOString(),
        _completedAt: new Date().toISOString(),
        _durationMs: Date.now() - startTime,
        metadata: {
          type: _type,
          triggeredBy,
        },
      };

      logger.info(`ETL job ${_jobId} completed successfully`, jobResult);

      return jobResult;
    } catch (err: any) {
      logger.error(`ETL job ${_jobId} failed`, err);

      // Re-throw for BullMQ retry
      throw err;
    }
  }

  /**
   * Process incremental sync job
   */
  private async processSync(
    _job: Job,
    _config: any
  ): Promise<{
    _itemsProcessed: number;
    _itemsCreated: number;
    _itemsUpdated: number;
    _itemsFailed: number;
  }> {
    logger.info('Processing incremental sync job');

    // Update progress: Extracting
    await this.updateProgress(_job, {
      _percent: 10,
      _currentStep: 'extracting',
      _totalSteps: 4,
      _itemsProcessed: 0,
      _startedAt: _job.processedOn ? new Date(_job.processedOn).toISOString() : new Date().toISOString(),
      _updatedAt: new Date().toISOString(),
    });

    // Get CIs from Neo4j that changed in last sync interval
    const session = this.neo4jClient.getSession();
    const batchSize = _config.batchSize || 1000;

    try {
      const result = await session.run(
        `
        MATCH (c:CI)
        WHERE c.updated_at > datetime($lastSync)
        RETURN c
        ORDER BY c.updated_at
        LIMIT $batchSize
        `,
        {
          lastSync: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // Last 5 minutes
          // A JS number reaches Neo4j as a Float, which LIMIT rejects.
          batchSize: neo4j.int(batchSize),
        }
      );

      const selected = result.records.length;
      const cis = withDimCiIds(
        result.records
          .map((record: Neo4jRecord) => extractedCI(record.get('c').properties, 'etl-sync'))
          .filter((ci: ExtractedCI | null): ci is ExtractedCI => ci !== null),
        (ci: ExtractedCI) => ci._id,
        'etl-sync'
      );

      // Update progress: Transforming
      await this.updateProgress(_job, {
        _percent: 40,
        _currentStep: 'transforming',
        _totalSteps: 4,
        _itemsProcessed: 0,
        totalItems: selected,
        _startedAt: _job.processedOn ? new Date(_job.processedOn).toISOString() : new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
      });

      // Update progress: Loading
      await this.updateProgress(_job, {
        _percent: 70,
        _currentStep: 'loading',
        _totalSteps: 4,
        _itemsProcessed: 0,
        totalItems: selected,
        _startedAt: _job.processedOn ? new Date(_job.processedOn).toISOString() : new Date().toISOString(),
        _updatedAt: new Date().toISOString(),
      });

      // Load through the neo4j-to-postgres SCD Type 2 writer: cmdb.dim_ci,
      // per-CI locks, each CI in its own organization (migration 011). A
      // batch that fails on anything but one CI's own values throws and fails
      // the job; batches already committed stay loaded.
      const loader = new Neo4jToPostgresJob(this.neo4jClient, this.postgresClient);
      let itemsLoaded = 0;
      let itemsCreated = 0;
      let itemsUpdated = 0;
      for (let i = 0; i < cis.length; i += LOAD_BATCH_SIZE) {
        const batch = await loader.processBatch(cis.slice(i, i + LOAD_BATCH_SIZE), false, _job.id);
        itemsLoaded += batch.cisProcessed;
        itemsCreated += batch.recordsInserted;
        itemsUpdated += batch.recordsUpdated;
      }

      return {
        // Loaded: current in cmdb.dim_ci after the run, new version or unchanged.
        _itemsProcessed: itemsLoaded,
        _itemsCreated: itemsCreated,
        _itemsUpdated: itemsUpdated,
        // Every other selected CI: an invalid id, metadata that is not JSON,
        // values that cannot be loaded, or a conflict with its stored organization.
        _itemsFailed: selected - itemsLoaded,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Process change detection job
   */
  private async processChangeDetection(
    _job: Job,
    _config: any
  ): Promise<{
    _itemsProcessed: number;
    _itemsCreated: number;
    _itemsUpdated: number;
    _itemsFailed: number;
  }> {
    logger.info('Processing change detection job');

    await this.updateProgress(_job, {
      _percent: 20,
      _currentStep: 'detecting-changes',
      _totalSteps: 4,
      _itemsProcessed: 0,
      _startedAt: _job.processedOn ? new Date(_job.processedOn).toISOString() : new Date().toISOString(),
      _updatedAt: new Date().toISOString(),
    });

    // Simplified implementation - detect changes and log to fact_changes
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (c:CI)
        WHERE c.updated_at > datetime($lastCheck)
        RETURN c, c.updated_at as changed_at
        ORDER BY c.updated_at
        `,
        {
          _lastCheck: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // Last 10 minutes
        }
      );

      const changes = result.records.length;

      return {
        _itemsProcessed: changes,
        _itemsCreated: changes,
        _itemsUpdated: 0,
        _itemsFailed: 0,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Process reconciliation job
   */
  private async processReconciliation(
    _job: Job,
    _config: any
  ): Promise<{
    _itemsProcessed: number;
    _itemsCreated: number;
    _itemsUpdated: number;
    _itemsFailed: number;
  }> {
    logger.info('Processing reconciliation job');

    await this.updateProgress(_job, {
      _percent: 20,
      _currentStep: 'reconciling',
      _totalSteps: 4,
      _itemsProcessed: 0,
      _startedAt: _job.processedOn ? new Date(_job.processedOn).toISOString() : new Date().toISOString(),
      _updatedAt: new Date().toISOString(),
    });

    // Simplified implementation - compare Neo4j and PostgreSQL data
    // Identify and fix discrepancies

    return {
      _itemsProcessed: 0,
      _itemsCreated: 0,
      _itemsUpdated: 0,
      _itemsFailed: 0,
    };
  }

  /**
   * Process full refresh job
   */
  private async processFullRefresh(
    _job: Job,
    _config: any
  ): Promise<{
    _itemsProcessed: number;
    _itemsCreated: number;
    _itemsUpdated: number;
    _itemsFailed: number;
  }> {
    logger.info('Processing full refresh job');

    await this.updateProgress(_job, {
      _percent: 10,
      _currentStep: 'full-refresh',
      _totalSteps: 4,
      _itemsProcessed: 0,
      _startedAt: _job.processedOn ? new Date(_job.processedOn).toISOString() : new Date().toISOString(),
      _updatedAt: new Date().toISOString(),
    });

    // Simplified implementation - full data reload
    // Truncate and reload all dimension/fact tables

    return {
      _itemsProcessed: 0,
      _itemsCreated: 0,
      _itemsUpdated: 0,
      _itemsFailed: 0,
    };
  }

  /**
   * Update job progress
   */
  private async updateProgress(job: Job, progress: JobProgress): Promise<void> {
    await this.queueManager.updateJobProgress(job, progress);
  }
}

// Export singleton instance
export const etlJobProcessor = new ETLJobProcessor();
