// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';
import { queueManager } from '@cmdb/database';
import { getDiscoveryQueueNames } from '@cmdb/common';
import { DiscoveryOrchestrator } from '../discovery-orchestrator';

jest.mock('@cmdb/database', () => ({
  queueManager: { registerWorker: jest.fn() },
}));
jest.mock('@cmdb/common', () => ({
  codedProcessor: jest.requireActual('@cmdb/common/queues/coded-processor').codedProcessor,
  getDiscoveryQueueNames: jest.requireActual('@cmdb/common/queues/queue-config').getDiscoveryQueueNames,
  logger: { info: jest.fn() },
}));

it('registers every configured discovery queue and scrubs legacy credentials before completion', async () => {
  new DiscoveryOrchestrator().registerWorkers();
  const registrations = jest.mocked(queueManager.registerWorker).mock.calls;
  expect(registrations.map(([name]) => name).sort()).toEqual(getDiscoveryQueueNames().sort());
  const processor = registrations.find(([name]) => name === 'discovery-ssh')?.[1];
  expect(processor).toBeDefined();
  const legacy = { config: { password: 'SENSITIVE-SECRET' }, provider: 'ssh' };
  const updateData = jest.fn(async () => { for (const key of Object.keys(legacy)) delete (legacy as any)[key]; });
  const job = { data: legacy, updateData } as unknown as Job;
  const result = await processor!(job, 'lock-token');
  expect(updateData).toHaveBeenCalledWith({});
  expect(job.data).toEqual({});
  expect(result).toEqual({ _refused: 1 });
  expect(JSON.stringify(result)).not.toContain('SENSITIVE-SECRET');
});
