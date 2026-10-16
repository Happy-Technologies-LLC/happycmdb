// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { DelayedError, type Job } from 'bullmq';
import { codedProcessor } from '../coded-processor';

const schema = { processed: 'count', completedAt: 'timestamp' } as const;
const job = { id: 'test' } as Job;

it('accepts a valid timestamp with count-only completion result', async () => {
  const result = { processed: 2, completedAt: '2026-10-15T21:00:00.000Z' };
  expect(await codedProcessor('test', schema, async () => result)(job)).toEqual(result);
});

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
  const spoof = codedProcessor('test', schema, async (): Promise<never> => {
    throw Object.assign(new Error('marker-secret'), { name: 'DelayedError' });
  });
  await expect(spoof(job)).rejects.toMatchObject({ message: 'ERR_INTERNAL' });
});

it('validates terminal discovery outcomes without leaking result details', async () => {
  const refused = codedProcessor('discovery', [schema, { _refused: 'count' }], async () => ({ _refused: 1 }));
  expect(await refused(job)).toEqual({ _refused: 1 });
  const unsafe = codedProcessor('discovery', [schema, { _refused: 'count' }],
    async () => ({ _refused: 1, config: { password: 'marker-secret' } }));
  await expect(unsafe(job)).rejects.toMatchObject({ message: 'ERR_RESULT_SCHEMA' });
});
