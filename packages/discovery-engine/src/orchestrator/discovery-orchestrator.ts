// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';
import { queueManager } from '@cmdb/database';
import { codedProcessor, getDiscoveryQueueNames, logger, type DiscoveryJob } from '@cmdb/common';

/** S3 drains pre-cutover Redis payloads; S5 owns admission and discovery execution. */
export class DiscoveryOrchestrator {
  private workersRegistered = false;

  async start(): Promise<void> {
    if (this.workersRegistered) return;
    this.registerWorkers();
    this.workersRegistered = true;
  }

  async stop(): Promise<void> {
    this.workersRegistered = false;
  }

  registerWorkers(): void {
    const drain = codedProcessor<Record<string, unknown>, { _refused: number }>(
      'discovery-legacy-drain', { _refused: 'count' }, async (job: Job) => {
        // Old jobs and repeatable occurrences can contain credentials, targets or
        // remote diagnostics. Never inspect or log their contents before scrubbing.
        await job.updateData({});
        return { _refused: 1 };
      }
    );
    for (const queue of getDiscoveryQueueNames()) {
      queueManager.registerWorker(queue, drain, { concurrency: 2 });
    }
    logger.info('Discovery queues registered for legacy payload draining');
  }

  async triggerDiscovery(_provider: string, _config: unknown, _actor: string, _org: string): Promise<string> {
    throw new Error('Discovery runs are unavailable until the journaled discovery cutover');
  }

  async triggerDiscoveryFromDefinition(_definitionId: string, _actor: string, _org: string): Promise<string> {
    throw new Error('Discovery runs are unavailable until the journaled discovery cutover');
  }

  async scheduleDiscovery(_job: DiscoveryJob): Promise<void> {
    throw new Error('Discovery runs are unavailable until the journaled discovery cutover');
  }

  async scheduleRecurringDiscovery(_provider: string, _config: unknown, _cron: string, _org: string): Promise<void> {
    throw new Error('Discovery schedules are unavailable until the journaled discovery cutover');
  }

  async getAllWorkerStatuses(): Promise<Array<{ name: string; running: boolean; concurrency: number }>> {
    return getDiscoveryQueueNames().map(name => ({
      name, running: this.workersRegistered, concurrency: 2,
    }));
  }
}
