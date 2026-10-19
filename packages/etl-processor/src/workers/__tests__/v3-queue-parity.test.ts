// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import Redis from 'ioredis';
import { Queue } from 'bullmq';

const mockNames: string[] = [];
const mockConnection = new Redis({ lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
jest.mock('bullmq', () => ({
  ...jest.requireActual('bullmq'),
  Worker: class {
    name: string;
    constructor(name: string) { this.name = name; mockNames.push(name); }
    on(): void {}
    async close(): Promise<void> {}
  },
}));
jest.mock('@cmdb/database', () => ({
  getRedisClient: () => ({ getConnection: () => mockConnection }),
}));

import { V3ETLScheduler } from '../../schedulers/v3-etl-scheduler';
import { V3ETLWorkerManager } from '../v3-etl.worker';

it('constructs BullMQ queues matching every registered v3 worker and scheduler producer', async () => {
  const scheduler = new V3ETLScheduler();
  const workers = new V3ETLWorkerManager();
  const produced = [
    (scheduler as any).cisQueue.name,
    (scheduler as any).costsQueue.name,
    (scheduler as any).incidentsQueue.name,
  ];
  const registered = Object.values(workers.getWorkers()).map(worker => worker.name);
  expect(mockNames).toEqual(registered);
  expect(registered).toEqual(produced);
  expect(produced).toEqual(['etl-cis', 'etl-costs', 'etl-incidents']);
  const queues = registered.map(name => new Queue(name, { connection: mockConnection }));
  expect(queues.map(queue => queue.name)).toEqual(produced);
  for (const queue of queues) queue.on('error', () => undefined);
  for (const queue of [(scheduler as any).cisQueue, (scheduler as any).costsQueue,
    (scheduler as any).incidentsQueue] as Queue[]) queue.on('error', () => undefined);
  mockConnection.disconnect();
});
