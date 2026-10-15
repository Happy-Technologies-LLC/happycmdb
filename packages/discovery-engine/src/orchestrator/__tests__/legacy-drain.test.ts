// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';
import { queueManager } from '@cmdb/database';
import { DiscoveryOrchestrator } from '../discovery-orchestrator';

jest.mock('@cmdb/database', () => ({
  queueManager: { registerWorker: jest.fn() },
  QUEUE_NAMES: { _DISCOVERY_SSH: 'discovery-ssh', _DISCOVERY_NMAP: 'discovery-nmap' },
}));
jest.mock('@cmdb/common', () => ({
  codedProcessor: jest.requireActual('@cmdb/common/queues/coded-processor').codedProcessor,
  logger: { info: jest.fn() },
}));

it.each(['discovery-ssh', 'discovery-nmap', 'discovery-ai'])(
  'scrubs old %s secrets before completing a disabled discovery delivery', async queue => {
    jest.mocked(queueManager.registerWorker).mockClear();
    new DiscoveryOrchestrator().registerWorkers();
    const processor = jest.mocked(queueManager.registerWorker).mock.calls.find(([name]) => name === queue)?.[1];
    expect(processor).toBeDefined();
    const legacy = { config: { password: 'SENSITIVE-SECRET' }, provider: 'ssh' };
    const updateData = jest.fn(async () => { for (const key of Object.keys(legacy)) delete (legacy as any)[key]; });
    const job = { data: legacy, updateData } as unknown as Job;
    const result = await processor!(job, 'lock-token');
    expect(updateData).toHaveBeenCalledWith({});
    expect(job.data).toEqual({});
    expect(result).toEqual({ _refused: 1 });
    expect(JSON.stringify(result)).not.toContain('SENSITIVE-SECRET');
  }
);
