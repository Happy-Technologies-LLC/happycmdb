// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { DelayedError, type Job } from 'bullmq';
import { codedProcessor } from '../coded-processor';

const schema = { processed: 'count', completedAt: 'timestamp' } as const;
const job = { id: 'test' } as Job;

it('rejects secret-bearing returnvalue and stores only a coded failure', async () => {
  const processor = codedProcessor('test', schema, async () => ({
    processed: 1, completedAt: new Date().toISOString(),
    changes: [{ oldValue: 'marker-secret', ciName: 'foreign-ci' }],
  }));
  await expect(processor(job)).rejects.toMatchObject({ message: 'ERR_RESULT_SCHEMA' });
});

it('normalizes thrown secrets, but preserves BullMQ control errors by identity', async () => {
  const failure = codedProcessor('test', schema, async (): Promise<never> => {
    throw new Error('marker-secret');
  });
  await expect(failure(job)).rejects.toMatchObject({ message: 'ERR_INTERNAL' });
  const control = new DelayedError();
  const delay = codedProcessor('test', schema, async (): Promise<never> => { throw control; });
  await expect(delay(job)).rejects.toBe(control);
});
