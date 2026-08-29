// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/database/src/bullmq/queue-manager.ts

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '@cmdb/common';

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
      this.queues.set(name, new Queue(name, { connection }));
    }
    return this.queues.get(name)!;
  }

  registerWorker(
    queueName: string,
    processor: (job: Job) => Promise<any>,
    options?: { concurrency?: number }
  ): Worker {
    if (this.workers.has(queueName)) {
      throw new Error(`Worker for queue ${queueName} already registered`);
    }

    const worker = new Worker(queueName, processor, {
      connection,
      concurrency: options?.concurrency || 1,
    });

    worker.on('completed', (job) => {
      logger.info(`Job ${job.id} in queue ${queueName} completed`);
    });

    worker.on('failed', (job, err) => {
      logger.error(`Job ${job?.id} in queue ${queueName} failed`, err);
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

// Queue names (BullMQ v5.0.0 does not allow colons in queue names)
export const QUEUE_NAMES = {
  _DISCOVERY_AWS: 'discovery-aws',
  _DISCOVERY_AZURE: 'discovery-azure',
  _DISCOVERY_GCP: 'discovery-gcp',
  _DISCOVERY_SSH: 'discovery-ssh',
  _DISCOVERY_NMAP: 'discovery-nmap',
  _ETL_SYNC: 'etl-sync',
  _ETL_FULL_REFRESH: 'etl-full-refresh',
  _ETL_CHANGE_DETECTION: 'etl-change-detection',
  _ETL_RECONCILIATION: 'etl-reconciliation',
} as const;
