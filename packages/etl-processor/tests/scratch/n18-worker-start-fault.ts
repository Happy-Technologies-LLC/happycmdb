// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';
import { logger } from '@cmdb/common';

const START_MESSAGES: Record<string, string> = {
  'etl-cis': '[CISyncWorker] Processing CI sync job',
  'etl-costs': '[CostValidationWorker] Processing cost validation job',
  'etl-incidents': '[IncidentSyncWorker] Processing incident sync job',
};

/** Fail only the named registered worker's entry for this N18 job. */
export function installWorkerStartFault(job: Job): { injected: () => boolean; restore: () => void } {
  const message = START_MESSAGES[job.queueName];
  if (!message) throw new Error('Unknown N18 v3 queue');
  const info = logger.info;
  let injected = false;
  const fault = jest.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
    const [text, meta] = args;
    if (!injected && text === message && meta && typeof meta === 'object' &&
      'jobId' in meta && meta.jobId === job.id) {
      injected = true;
      throw new Error('n18-injected-worker-entry-fault');
    }
    return Reflect.apply(info, logger, args);
  });
  return { injected: () => injected, restore: () => fault.mockRestore() };
}
