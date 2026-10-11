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
  expect(queueConstructor).toHaveBeenCalledTimes(initial);
  const cache: unknown = Reflect.get(manager, 'queues');
  expect(cache).toBeInstanceOf(Map);
  if (!(cache instanceof Map)) throw new Error('Queue cache missing');
  expect(cache.size).toBe(initial);
  manager.getQueue(QUEUE_NAMES._DISCOVERY_NMAP);
  expect(queueConstructor).toHaveBeenCalledTimes(initial);
});
