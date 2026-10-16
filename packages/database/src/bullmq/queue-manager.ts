// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/database/src/bullmq/queue-manager.ts

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger, DISCOVERY_RETENTION, JobErrorHandler } from '@cmdb/common';

const connection = new IORedis({
  host: process.env['REDIS_HOST'] || 'localhost',
  port: parseInt(process.env['REDIS_PORT'] || '6379'),
  maxRetriesPerRequest: null,
});

export class QueueManager {
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();

  getQueue(name: string): Queue {
    if (!this.queues.has(name)) {
      this.queues.set(name, new Queue(name, {
        connection,
        ...(name.startsWith('discovery-') ? { defaultJobOptions: DISCOVERY_RETENTION } : {}),
      }));
    }
    return this.queues.get(name)!;
  }

  registerWorker(
    queueName: string,
    processor: (job: Job, token?: string) => Promise<any>,
    options?: { concurrency?: number }
  ): Worker {
    if (this.workers.has(queueName)) {
      throw new Error(`Worker for queue ${queueName} already registered`);
    }

    const worker = new Worker(queueName, processor, {
      connection,
      concurrency: options?.concurrency || 1,
    });

    worker.on('completed', () => {
      logger.info(`Job in queue ${queueName} completed`);
    });

    worker.on('failed', (job, error) => {
      logger.error(`Job in queue ${queueName} failed`, { code: 'ERR_INTERNAL' });
      if (job) void JobErrorHandler.handleJobFailure(job, error).catch(() => {
        logger.error(`Dead-letter handling failed in queue ${queueName}`, { code: 'ERR_INTERNAL' });
      });
    });

    this.workers.set(queueName, worker);
    return worker;
  }

  async closeAll(): Promise<void> {
    await Promise.all([
      ...Array.from(this.queues.values()).map((q) => q.close()),
      ...Array.from(this.workers.values()).map((w) => w.close()),
    ]);
  }
}

export const queueManager = new QueueManager();

/**
 * Quit the shared BullMQ Redis connection. Merely importing this module (or
 * anything re-exported from `@cmdb/database`) opens this connection eagerly
 * at module load, even for callers that never touch BullMQ. Production
 * processes keep it open for their lifetime; integration test suites must
 * call this in `afterAll` (after every other cleanup) so Jest can exit
 * without a leaked socket.
 */
export async function closeQueueManagerConnection(): Promise<void> {
  await connection.quit();
}

export { QUEUE_NAMES } from '@cmdb/common';
