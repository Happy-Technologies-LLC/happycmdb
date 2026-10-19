// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { Job, Queue } from 'bullmq';
import { fullRefreshFailureWaitMs, settled } from '../../../tests/scratch/n18-settlement';

afterEach(() => jest.restoreAllMocks());

it('waits through the real full-refresh limiter window for a scheduled forced failure', async () => {
  let clock = 0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => {
    clock += 300_000; // next production worker slot after the B-normal job
    callback();
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout);

  const persisted = {
    id: '3', data: {},
    get attemptsStarted() { return clock >= 300_000 ? 1 : 0; },
    get processedOn() { return clock >= 300_000 ? clock : undefined; },
    getState: async () => clock >= 300_000 ? 'failed' : 'waiting',
  } as unknown as Job;
  jest.spyOn(Job, 'fromId').mockResolvedValue(persisted);
  const queue = {
    name: 'etl-full-refresh',
    getJobLogs: jest.fn(async () => ({ logs: [] })),
    getJobCounts: jest.fn(async () => ({ waiting: 0, failed: 1 })),
    isPaused: jest.fn(async () => false),
  } as unknown as Queue;

  const failed = await settled(queue, persisted, 'failed', fullRefreshFailureWaitMs);
  expect(failed.attemptsStarted).toBeGreaterThan(0);
  expect(failed.processedOn).toEqual(expect.any(Number));
});
