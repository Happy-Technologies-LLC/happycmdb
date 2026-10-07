// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { queueManager } from '@cmdb/database';
import { DiscoveryOrchestrator } from '../../src/orchestrator/discovery-orchestrator';

jest.mock('@cmdb/database', () => ({
  queueManager: { registerWorker: jest.fn() },
  QUEUE_NAMES: { _DISCOVERY_SSH: 'discovery:ssh', _DISCOVERY_NMAP: 'discovery:nmap' },
}));
jest.mock('@cmdb/ai-discovery', () => ({
  HybridDiscoveryOrchestrator: jest.fn(), PatternStorageService: jest.fn(), getDefaultLLMConfig: jest.fn(),
}));
jest.mock('../../src/workers/ssh-discovery.worker', () => ({ SSHDiscoveryWorker: jest.fn() }));
jest.mock('../../src/workers/nmap-discovery.worker', () => ({ NmapDiscoveryWorker: jest.fn() }));
jest.mock('../../src/workers/active-directory-discovery.worker', () => ({ ActiveDirectoryDiscoveryWorker: jest.fn() }));
jest.mock('../../src/api/internal-api-client', () => ({ getInternalAPIClient: jest.fn() }));
jest.mock('../../src/enrichment/itil-enricher', () => ({ ITILEnricher: jest.fn() }));
jest.mock('../../src/enrichment/tbm-enricher', () => ({ TBMEnricher: jest.fn() }));
jest.mock('../../src/enrichment/bsm-enricher', () => ({ BSMEnricher: jest.fn() }));

beforeEach(() => jest.clearAllMocks());

it.each([
  { error: 'Discovery target refused', success: false },
  { error: 'UNSUPPORTED_PATTERN_PLAN', success: true },
])(
  'fails the queued AI job on $error before persisting or marking completion', async ({ error, success }) => {
    const orchestrator = Object.create(DiscoveryOrchestrator.prototype) as DiscoveryOrchestrator;
    const discover = jest.fn().mockResolvedValue({ success, error, discoveredCIs: [],
      method: 'fallback', confidence: 0, cost: 0 });
    (orchestrator as any).hybridOrchestrator = { discover };
    const persist = jest.spyOn(orchestrator as any, 'persistCIs').mockResolvedValue(undefined);
    const status = jest.spyOn(orchestrator as any, 'updateDefinitionRunStatus').mockResolvedValue(undefined);
    orchestrator.registerWorkers();
    const worker = jest.mocked(queueManager.registerWorker).mock.calls
      .find(([name]) => name === 'discovery-ai')?.[1] as (job: any) => Promise<unknown>;
    expect(worker).toBeDefined();
    const job = { data: { jobId: 'job-1', definition_id: 'definition-1',
      config: { targetHost: '8.8.8.8', targetPort: 443 } },
      updateProgress: jest.fn().mockResolvedValue(undefined) };
    await expect(worker(job)).rejects.toThrow(error);
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ targetHost: '8.8.8.8' }));
    expect(persist).not.toHaveBeenCalled();
    expect(job.updateProgress).not.toHaveBeenCalledWith(100);
    expect(status.mock.calls).toEqual([
      ['definition-1', 'job-1', 'running'],
      ['definition-1', 'job-1', 'failed', 0, expect.objectContaining({ message: error })],
    ]);
  }
);
