// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { queueManager } from '@cmdb/database';
import { UnrecoverableError } from '@cmdb/common';
import { DiscoveryOrchestrator } from '../discovery-orchestrator';
import { NmapDiscoveryWorker } from '../../workers/nmap-discovery.worker';

jest.mock('@cmdb/database', () => ({
  queueManager: { registerWorker: jest.fn() },
  QUEUE_NAMES: { _DISCOVERY_SSH: 'discovery:ssh', _DISCOVERY_NMAP: 'discovery:nmap' },
}));
jest.mock('@cmdb/ai-discovery', () => ({
  HybridDiscoveryOrchestrator: jest.fn(), PatternStorageService: jest.fn(), getDefaultLLMConfig: jest.fn(),
}));
jest.mock('../../workers/ssh-discovery.worker', () => ({ SSHDiscoveryWorker: jest.fn() }));
jest.mock('../../workers/nmap-discovery.worker', () => ({ NmapDiscoveryWorker: jest.fn() }));
jest.mock('../../workers/active-directory-discovery.worker', () => ({ ActiveDirectoryDiscoveryWorker: jest.fn() }));
jest.mock('../../api/internal-api-client', () => ({ getInternalAPIClient: jest.fn() }));
jest.mock('../../enrichment/itil-enricher', () => ({ ITILEnricher: jest.fn() }));
jest.mock('../../enrichment/tbm-enricher', () => ({ TBMEnricher: jest.fn() }));
jest.mock('../../enrichment/bsm-enricher', () => ({ BSMEnricher: jest.fn() }));

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
    await expect(worker(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ targetHost: '8.8.8.8' }));
    expect(persist).not.toHaveBeenCalled();
    expect(job.updateProgress).not.toHaveBeenCalledWith(100);
    expect(status.mock.calls).toEqual([
      ['definition-1', 'job-1', 'running'],
      ['definition-1', 'job-1', 'failed', 0, expect.objectContaining({ message: error })],
    ]);
  }
);

it.each([
  { name: 'discovery:ssh', config: { targets: [{ host: 'redis' }] } },
  { name: 'discovery:nmap', config: { range: '10.0.0.0/8' } },
])('makes $name policy refusal terminal without persisting', async ({ name, config }) => {
  if (name === 'discovery:nmap') {
    jest.mocked(NmapDiscoveryWorker).mockImplementation(() => ({
      scanNetwork: jest.fn().mockRejectedValue(new Error('Discovery target refused')),
    }) as never);
  }
  const orchestrator = Object.create(DiscoveryOrchestrator.prototype) as DiscoveryOrchestrator;
  const persist = jest.spyOn(orchestrator as any, 'persistCIs').mockResolvedValue(undefined);
  const status = jest.spyOn(orchestrator as any, 'updateDefinitionRunStatus').mockResolvedValue(undefined);
  orchestrator.registerWorkers();
  const worker = jest.mocked(queueManager.registerWorker).mock.calls
    .find(([queue]) => queue === name)?.[1] as (job: any) => Promise<unknown>;
  const job = { data: { jobId: 'job-2', definition_id: 'definition-2', config },
    updateProgress: jest.fn().mockResolvedValue(undefined) };
  await expect(worker(job)).rejects.toBeInstanceOf(UnrecoverableError);
  expect(persist).not.toHaveBeenCalled();
  expect(job.updateProgress).not.toHaveBeenCalledWith(100);
  expect(status.mock.calls).toEqual([
    ['definition-2', 'job-2', 'running'],
    ['definition-2', 'job-2', 'failed', 0, expect.objectContaining({ message: 'Discovery target refused' })],
  ]);
});
