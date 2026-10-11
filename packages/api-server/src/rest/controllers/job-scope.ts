// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Request } from 'express';
import type { Job } from 'bullmq';
import { optionalRequestOrganizationId } from '../../middleware/auth.middleware';

export const JOB_NOT_FOUND = { success: false, error: 'Not Found', message: 'Job not found' };

/** Legacy jobs have no trusted owner; never infer one from the queue name or job ID. */
export function ownsJob(req: Request, job: Pick<Job, 'data'>): boolean {
  const organizationId = optionalRequestOrganizationId(req);
  return organizationId !== null && job.data?.organizationId === organizationId;
}

/** BullMQ data, result, failures, progress and logs are untrusted secret-bearing worker output. */
export async function publicJob(job: Job, queueName: string): Promise<object> {
  return {
    id: job.id, name: job.name, queueName, state: await job.getState(),
    attemptsMade: job.attemptsMade, maxAttempts: job.opts?.attempts ?? 1,
    timestamp: job.timestamp, processedOn: job.processedOn, finishedOn: job.finishedOn,
  };
}
