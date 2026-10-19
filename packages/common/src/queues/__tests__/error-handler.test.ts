// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';
import { JobErrorHandler } from '../error-handler';

it('scrubs legacy discovery payload and error text before dead-letter persistence', async () => {
  const secret = 'worker-credential-secret';
  const job = {
    id: 'legacy', queueName: 'discovery-ssh', attemptsMade: 1, opts: { attempts: 1 },
    data: { _runId: secret, config: { credentials: secret } },
    log: jest.fn(async () => 1), updateData: jest.fn(async () => undefined),
  } as unknown as Job;
  await JobErrorHandler.handleJobFailure(job, new Error(secret));
  expect(job.log).toHaveBeenCalledWith('DEAD_LETTER:ERR_INTERNAL');
  expect(job.updateData).toHaveBeenCalledWith({ _legacy: true, __dlq: { _code: 'ERR_INTERNAL' } });
  expect(JSON.stringify([jest.mocked(job.log).mock.calls, jest.mocked(job.updateData).mock.calls])).not.toContain(secret);
});
