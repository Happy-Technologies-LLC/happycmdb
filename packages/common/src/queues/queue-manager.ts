// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Enhanced Queue Manager
 *
 * This module provides an enhanced queue manager with advanced features:
 * - Queue creation and management
 * - Worker registration
 * - Progress tracking
 * - Event handling
 * - Graceful shutdown
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger';
import { getQueueConfig, QUEUE_CONFIGS } from './queue-config';
import { jobErrorCode } from './coded-processor';
import type { JobProgress, WorkerConfig } from '../types/job.types';
export class ScrubbedJobRetryError extends Error {
  constructor() { super('Job input unavailable; resubmit the original workload'); }
}

/**
 * Redis connection for BullMQ
 */
const getRedisConnection = (): IORedis => {
  return new IORedis({
    host: process.env['REDIS_HOST'] || 'localhost',
    port: parseInt(process.env['REDIS_PORT'] || '6379'),
    password: process.env['REDIS_PASSWORD'],
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
};

/**
 * Enhanced Queue Manager
 */
export class EnhancedQueueManager {
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();
  private connection: IORedis;
  private isShuttingDown = false;

  constructor() {
    this.connection = getRedisConnection();

    // Handle connection errors
    this.connection.on('error', () => {
      logger.error('Redis connection error', { code: 'ERR_UNAVAILABLE' });
    });

    this.connection.on('connect', () => {
      logger.info('Redis connected for queue manager');
    });
  }

  /**
   * Get or create a queue
   */
  getQueue<T = any>(queueName: string): Queue<T> {
    if (!Object.hasOwn(QUEUE_CONFIGS, queueName)) {
      throw new Error('Unknown queue');
    }
    if (!this.queues.has(queueName)) {
      const config = getQueueConfig(queueName);
      const queue = new Queue<T>(queueName, {
        connection: this.connection,
        defaultJobOptions: config._defaultJobOptions,
      });

      this.queues.set(queueName, queue);
      logger.info(`Queue created: ${queueName}`);
    }
    return this.queues.get(queueName) as Queue<T>;
  }

  /**
   * Register a worker for a queue
   */
  registerWorker<T = any>(
    _config: WorkerConfig,
    _processor: (job: Job<T>) => Promise<any>
  ): Worker<T> {
    const { name, _queueName, _concurrency, gracefulShutdown, shutdownTimeout } = _config;

    if (this.workers.has(name)) {
      throw new Error(`Worker ${name} already registered`);
    }

    const worker = new Worker<T>(_queueName, _processor, {
      connection: this.connection,
      concurrency: _concurrency || 1,
    });

    // Event handlers
    worker.on('ready', () => {
      logger.info(`Worker ${name} ready for queue ${_queueName}`);
    });

    worker.on('active', () => {
      logger.info(`Worker ${name} processing job`);
    });

    worker.on('completed', () => {
      logger.info(`Worker ${name} completed job`);
    });

    worker.on('failed', (_job, err) => {
      logger.error(`Worker ${name} failed job`, { code: jobErrorCode(err) });
    });

    worker.on('error', () => {
      logger.error(`Worker ${name} error`, { code: 'ERR_INTERNAL' });
    });

    worker.on('stalled', () => {
      logger.warn(`Worker ${name} job stalled`);
    });

    // Setup graceful shutdown if enabled
    if (gracefulShutdown) {
      this.setupGracefulShutdown(worker, name, shutdownTimeout);
    }

    this.workers.set(name, worker);
    logger.info(`Worker ${name} registered for queue ${_queueName} with concurrency ${_concurrency}`);

    return worker;
  }

  /**
   * Setup queue events listener
   */
  setupQueueEvents(queueName: string): QueueEvents {
    if (!this.queueEvents.has(queueName)) {
      const queueEvents = new QueueEvents(queueName, {
        connection: this.connection,
      });

      queueEvents.on('waiting', () => {
        logger.debug(`Job waiting in queue ${queueName}`);
      });

      queueEvents.on('active', () => {
        logger.debug(`Job active in queue ${queueName}`);
      });

      queueEvents.on('completed', () => {
        logger.info(`Job completed in queue ${queueName}`);
      });

      queueEvents.on('failed', () => {
        logger.error(`Job failed in queue ${queueName}`, { code: 'ERR_INTERNAL' });
      });

      queueEvents.on('progress', () => {
        logger.debug(`Job progress in queue ${queueName}`);
      });

      this.queueEvents.set(queueName, queueEvents);
    }

    return this.queueEvents.get(queueName)!;
  }

  /**
   * Add a job to a queue
   */
  async addJob<T>(
    _queueName: string,
    _jobName: string,
    _data: T,
    options?: any
  ): Promise<Job<T>> {
    const queue = this.getQueue<T>(_queueName);
    const job = await queue.add(_jobName as any, _data as any, options);
    logger.info(`Job added to queue ${_queueName}`);
    return job as Job<T>;
  }

  /**
   * Add a repeatable job (scheduled/cron)
   */
  async addRepeatableJob<T>(
    _queueName: string,
    _jobName: string,
    _data: T,
    _repeatOptions: {
      pattern?: string; // Cron pattern
      every?: number;   // Interval in milliseconds
      immediately?: boolean;
    }
  ): Promise<Job<T>> {
    const queue = this.getQueue<T>(_queueName);
    const job = await queue.add(_jobName as any, _data as any, {
      repeat: _repeatOptions,
    });
    logger.info(`Repeatable job ${job.id} added to queue ${_queueName}`, {
      _jobName,
      _repeatOptions,
    });
    return job as Job<T>;
  }

  /**
   * Update job progress
   */
  async updateJobProgress(job: Job, progress: JobProgress): Promise<void> {
    await job.updateProgress(progress);
    logger.debug(`Job ${job.id} progress updated: ${progress._percent}%`);
  }

  /**
   * Get job by ID
   */
  async getJob(queueName: string, jobId: string): Promise<Job | undefined> {
    const queue = this.getQueue(queueName);
    return await queue.getJob(jobId);
  }

  /**
   * Remove a job
   */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getJob(queueName, jobId);
    if (job) {
      await job.remove();
      logger.info(`Job ${jobId} removed from queue ${queueName}`);
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: string): Promise<{
    queueName: string;
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  }> {
    const queue = this.getQueue(queueName);
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused'
    );

    return {
      queueName,
      waiting: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      completed: counts['completed'] ?? 0,
      failed: counts['failed'] ?? 0,
      delayed: counts['delayed'] ?? 0,
      paused: counts['paused'] ?? 0,
    };
  }

  /**
   * Get all failed jobs
   */
  async getFailedJobs(queueName: string, start = 0, end = 99): Promise<Job[]> {
    const queue = this.getQueue(queueName);
    return await queue.getFailed(start, end);
  }

  /**
   * Retry a failed job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    const job = await this.getJob(queueName, jobId);
    if (job) {
      if (job.data?.__dlq !== undefined || job.data?._legacy === true) {
        throw new ScrubbedJobRetryError();
      }
      await job.retry();
      logger.info(`Job ${jobId} retried in queue ${queueName}`);
    }
  }

  /**
   * Get worker status
   */
  getWorkerStatus(workerName: string) {
    const worker = this.workers.get(workerName);
    if (!worker) {
      return null;
    }

    return {
      workerName,
      _isRunning: worker.isRunning(),
      _isPaused: worker.isPaused(),
    };
  }

  /**
   * Pause a worker
   */
  async pauseWorker(workerName: string): Promise<void> {
    const worker = this.workers.get(workerName);
    if (worker) {
      await worker.pause();
      logger.info(`Worker ${workerName} paused`);
    }
  }

  /**
   * Resume a worker
   */
  async resumeWorker(workerName: string): Promise<void> {
    const worker = this.workers.get(workerName);
    if (worker) {
      await worker.resume();
      logger.info(`Worker ${workerName} resumed`);
    }
  }

  /**
   * Setup graceful shutdown for a worker
   */
  private setupGracefulShutdown(
    _worker: Worker,
    _name: string,
    __timeout: number = 30000
  ): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info(`${signal} received, shutting down worker ${_name} gracefully...`);

      try {
        await _worker.close();
        logger.info(`Worker ${_name} shut down successfully`);
        process.exit(0);
      } catch {
        logger.error(`Error shutting down worker ${_name}`, { code: 'ERR_INTERNAL' });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  /**
   * Close all queues, workers, and events
   */
  async closeAll(): Promise<void> {
    logger.info('Closing all queues, workers, and events...');

    const promises: Promise<void>[] = [];

    // Close all workers
    for (const [name, worker] of this.workers.entries()) {
      promises.push(
        worker.close().then(() => {
          logger.info(`Worker ${name} closed`);
        })
      );
    }

    // Close all queues
    for (const [name, queue] of this.queues.entries()) {
      promises.push(
        queue.close().then(() => {
          logger.info(`Queue ${name} closed`);
        })
      );
    }

    // Close all queue events
    for (const [name, queueEvents] of this.queueEvents.entries()) {
      promises.push(
        queueEvents.close().then(() => {
          logger.info(`Queue events ${name} closed`);
        })
      );
    }

    await Promise.all(promises);

    // Close Redis connection
    await this.connection.quit();
    logger.info('All queues, workers, and events closed');
  }

  /**
   * Clean old jobs from queue
   */
  async cleanQueue(
    _queueName: string,
    _grace: number = 3600000, // 1 hour
    _limit: number = 1000,
    _type: 'completed' | 'failed' = 'completed'
  ): Promise<void> {
    const queue = this.getQueue(_queueName);
    await queue.clean(_grace, _limit, _type);
    logger.info(`Cleaned ${_type} jobs from queue ${_queueName}`, { _grace, _limit });
  }
}

// Singleton instance
let queueManager: EnhancedQueueManager | null = null;

/**
 * Get the singleton queue manager instance
 */
export function getQueueManager(): EnhancedQueueManager {
  if (!queueManager) {
    queueManager = new EnhancedQueueManager();
  }
  return queueManager;
}
