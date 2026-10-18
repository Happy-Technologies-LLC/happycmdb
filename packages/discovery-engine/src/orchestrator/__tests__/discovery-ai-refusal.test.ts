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
jest.mock('../../workers/nmap-discovery.worker', () => ({ NmapDiscoveryWorker: jest.fn() }));
jest.mock('../../workers/active-directory-discovery.worker', () => ({ ActiveDirectoryDiscoveryWorker: jest.fn() }));
jest.mock('../../api/internal-api-client', () => ({ getInternalAPIClient: jest.fn() }));
jest.mock('../../enrichment/itil-enricher', () => ({ ITILEnricher: jest.fn() }));
jest.mock('../../enrichment/tbm-enricher', () => ({ TBMEnricher: jest.fn() }));
jest.mock('../../enrichment/bsm-enricher', () => ({ BSMEnricher: jest.fn() }));

beforeEach(() => jest.clearAllMocks());
it('rejects a queued definition with no matching owner before invoking any discovery worker', async () => {
  const orchestrator = Object.create(DiscoveryOrchestrator.prototype) as DiscoveryOrchestrator;
  const query = jest.fn().mockResolvedValue({ rows: [] });
  (orchestrator as any).postgresClient = { query };
  const discover = jest.fn();
  (orchestrator as any).hybridOrchestrator = { discover };
  orchestrator.registerWorkers();
  const worker = jest.mocked(queueManager.registerWorker).mock.calls
    .find(([name]) => name === 'discovery-ai')?.[1] as (job: any) => Promise<unknown>;
  const job = { data: { jobId: 'foreign-job', definition_id: 'foreign-definition',
    organizationId: '11111111-1111-4111-8111-111111111111', config: { targetHost: '8.8.8.8' } },
    updateProgress: jest.fn() };
  await expect(worker(job)).rejects.toThrow('Discovery definition not found');
  expect(query).toHaveBeenCalledWith(expect.stringContaining('organization_id = $2'),
    ['foreign-definition', '11111111-1111-4111-8111-111111111111']);
  expect(discover).not.toHaveBeenCalled();
  expect(job.updateProgress).not.toHaveBeenCalled();
});


it.each([
  { error: 'Discovery target refused', success: false },
  { error: 'UNSUPPORTED_PATTERN_PLAN', success: true },
])(
  'fails the queued AI job on $error before persisting or marking completion', async ({ error, success }) => {
    const orchestrator = Object.create(DiscoveryOrchestrator.prototype) as DiscoveryOrchestrator;
    Object.assign(orchestrator, { postgresClient: { query: jest.fn().mockResolvedValue({
      rows: [{ id: 'definition-1', config: { targets: ['8.8.8.8'] } }],
    }) } });
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
      organizationId: '11111111-1111-4111-8111-111111111111',
      config: { targetHost: '8.8.8.8', targetPort: 443 } },
      updateProgress: jest.fn().mockResolvedValue(undefined) };
    await expect(worker(job)).rejects.toThrow(error);
    expect(persist).not.toHaveBeenCalled();
    expect(job.updateProgress).not.toHaveBeenCalledWith(100);
    expect(status.mock.calls).toEqual([
      ['definition-1', 'job-1', 'running', '11111111-1111-4111-8111-111111111111'],
      ['definition-1', 'job-1', 'failed', '11111111-1111-4111-8111-111111111111', 0],
    ]);
  }
);

it('makes nmap policy refusal terminal without persisting', async () => {
  const name = 'discovery:nmap';
  const config = { range: '10.0.0.0/8' };
  jest.mocked(NmapDiscoveryWorker).mockImplementation(() => ({
    scanNetwork: jest.fn().mockRejectedValue(new Error('Discovery target refused')),
  }) as never);
  const orchestrator = Object.create(DiscoveryOrchestrator.prototype) as DiscoveryOrchestrator;
  Object.assign(orchestrator, { postgresClient: { query: jest.fn().mockResolvedValue({
    rows: [{ id: 'definition-2', config }],
  }) } });
  const persist = jest.spyOn(orchestrator as any, 'persistCIs').mockResolvedValue(undefined);
  const status = jest.spyOn(orchestrator as any, 'updateDefinitionRunStatus').mockResolvedValue(undefined);
  orchestrator.registerWorkers();
  const worker = jest.mocked(queueManager.registerWorker).mock.calls
    .find(([queue]) => queue === name)?.[1] as (job: any) => Promise<unknown>;
  const job = { data: { jobId: 'job-2', definition_id: 'definition-2', organizationId: '11111111-1111-4111-8111-111111111111', config },
    updateProgress: jest.fn().mockResolvedValue(undefined) };
  await expect(worker(job)).rejects.toThrow('Discovery target refused');
  expect(persist).not.toHaveBeenCalled();
  expect(job.updateProgress).not.toHaveBeenCalledWith(100);
  expect(status.mock.calls).toEqual([
    ['definition-2', 'job-2', 'running', '11111111-1111-4111-8111-111111111111'],
    ['definition-2', 'job-2', 'failed', '11111111-1111-4111-8111-111111111111', 0],
  ]);
});

it('terminally refuses queued legacy SSH without resolving credentials or scanning', async () => {
  const orchestrator = Object.create(DiscoveryOrchestrator.prototype) as DiscoveryOrchestrator;
  const query = jest.fn().mockResolvedValue({ rows: [{ id: 'definition-2' }] });
  Object.assign(orchestrator, { postgresClient: { query } });
  orchestrator.registerWorkers();
  const worker = jest.mocked(queueManager.registerWorker).mock.calls
    .find(([queue]) => queue === 'discovery:ssh')?.[1] as (job: any) => Promise<unknown>;
  const job = { data: { jobId: 'job-2', definition_id: 'definition-2',
    organizationId: '11111111-1111-4111-8111-111111111111',
    config: { targets: [{ host: '192.0.2.1', password: 'synthetic-secret' }] } },
    updateProgress: jest.fn() };
  await worker(job).then(
    () => { throw new Error('Expected terminal SSH refusal'); },
    (error: Error) => {
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error.message).toBe('Credential-backed discovery execution is unavailable');
    }
  );
  expect(query).not.toHaveBeenCalled();
  expect(job.updateProgress).not.toHaveBeenCalled();
});
