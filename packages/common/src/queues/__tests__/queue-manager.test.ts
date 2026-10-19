// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const queueConstructor = jest.fn();
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({ on: jest.fn() })));
jest.mock('bullmq', () => ({ Queue: class { constructor(name: string) { queueConstructor(name); } } }));
jest.mock('../../utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));

import IORedis from 'ioredis';
import { EnhancedQueueManager } from '../queue-manager';
import { QUEUE_NAMES } from '../queue-config';

test('only registered queue names allocate BullMQ queues; unknown names never grow the cache', () => {
  jest.mocked(IORedis).mockImplementation(() => ({ on: jest.fn() }) as never);
  const manager = new EnhancedQueueManager();
  for (const name of Object.values(QUEUE_NAMES)) manager.getQueue(name);
  const initial = queueConstructor.mock.calls.length;
  for (let index = 0; index < 200; index++) {
    expect(() => manager.getQueue(`attacker-${index}`)).toThrow('Unknown queue');
  }
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    expect(() => manager.getQueue(name)).toThrow('Unknown queue');
  }
  expect(queueConstructor).toHaveBeenCalledTimes(initial);
  const cache: unknown = Reflect.get(manager, 'queues');
  expect(cache).toBeInstanceOf(Map);
  if (!(cache instanceof Map)) throw new Error('Queue cache missing');
  expect(cache.size).toBe(initial);
  manager.getQueue(QUEUE_NAMES._DISCOVERY_NMAP);
  expect(queueConstructor).toHaveBeenCalledTimes(initial);
});

test('refuses a failed ETL retry after the original workload is scrubbed, but permits intact input', async () => {
  jest.mocked(IORedis).mockImplementation(() => ({ on: jest.fn() }) as never);
  const manager = new EnhancedQueueManager();
  const retry = jest.fn(async () => undefined);
  const job: { data: Record<string, unknown>; retry: jest.Mock } = {
    data: { _legacy: true, __dlq: { _code: 'ERR_INTERNAL' } }, retry,
  };
  jest.spyOn(manager, 'getJob').mockImplementation(async () => job as never);

  for (const data of [job.data, { _runId: 'retained-id', __dlq: { _code: 'ERR_INTERNAL' } }, { _legacy: true }]) {
    job.data = data;
    await expect(manager.retryJob(QUEUE_NAMES._ETL_FULL_REFRESH, 'failed-1')).rejects.toThrow('resubmit');
    expect(retry).not.toHaveBeenCalled();
  }
  job.data = { truncateTables: true };
  await manager.retryJob(QUEUE_NAMES._ETL_FULL_REFRESH, 'failed-1');
  expect(retry).toHaveBeenCalledTimes(1);
});
