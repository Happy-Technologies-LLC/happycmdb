// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1444 (AAI S2): schedules the repeatable C4 release fan-out. Its job data is `{}`: the fan-out reads the
 * organizations from the credential store when it runs, so no tenant id or credential sits in a repeatable job.
 */
import type { Queue } from 'bullmq';
import { logger } from '@cmdb/common';
import { C4_FANOUT_JOB } from '../ai-sync/c4-release-sync';

/** Every 15 minutes (C4 has no change feed; the sync reads the approved list each run). */
export const C4_SYNC_CRON = '*/15 * * * *';

export class AISyncScheduler {
  constructor(private readonly queue: Pick<Queue, 'add'>) {}

  async start(): Promise<void> {
    await this.queue.add(C4_FANOUT_JOB, {}, { repeat: { pattern: C4_SYNC_CRON }, jobId: `${C4_FANOUT_JOB}-repeatable`,
      removeOnComplete: true, removeOnFail: true });
    logger.info('[AISyncScheduler] Scheduled C4 release sync', { schedule: C4_SYNC_CRON });
  }
}
