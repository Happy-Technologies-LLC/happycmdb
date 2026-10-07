// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import * as nmap from 'node-nmap';
import { NodeSSH } from 'node-ssh';
import { NmapDiscoveryWorker } from '../nmap-discovery.worker';
import { SSHDiscoveryWorker } from '../ssh-discovery.worker';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node-nmap', () => ({ QuickScan: jest.fn(), NmapScan: jest.fn(), OsAndPortScan: jest.fn() }));
jest.mock('node-ssh', () => ({ NodeSSH: jest.fn() }));
const mockedLookup = jest.mocked(lookup);

beforeEach(() => { mockedLookup.mockReset(); jest.mocked(nmap.QuickScan).mockClear(); jest.mocked(NodeSSH).mockClear(); });

it('nmap refuses private and overlapping ranges before scanner construction', async () => {
  const worker = new NmapDiscoveryWorker();
  for (const target of ['10.0.0.0/8', '8.0.0.0/6', '127.0.0.1', 'metadata.google.internal']) {
    await expect(worker.scanNetwork('job', target)).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  }
  expect(nmap.QuickScan).not.toHaveBeenCalled();
  expect(mockedLookup).not.toHaveBeenCalled();
});

it('refuses a mixed nmap batch without scanning its otherwise-public member', async () => {
  await expect(new NmapDiscoveryWorker().scanNetworks('job', [
    { range: '8.8.8.8' }, { range: '192.168.1.0/24' },
  ])).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(nmap.QuickScan).not.toHaveBeenCalled();
});

it('refuses secondary nmap script egress even for a public primary target', async () => {
  await expect(new NmapDiscoveryWorker().scanHost('job', '8.8.8.8', { scriptScan: true }))
    .rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(nmap.NmapScan).not.toHaveBeenCalled();
});

it('propagates a policy refusal after nmap batch preflight despite another successful scan', async () => {
  mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const worker = new NmapDiscoveryWorker();
  jest.spyOn(worker, 'scanNetwork').mockImplementation(async (_job, range) => {
    if (range === 'public.example') throw new Error(DISCOVERY_TARGET_REFUSED);
    return [];
  });
  await expect(worker.scanNetworks('job', [
    { range: 'public.example' }, { range: '8.8.8.8' },
  ])).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
});

it('returns only a fixed refusal when all nmap scans reject after preflight', async () => {
  mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const worker = new NmapDiscoveryWorker();
  jest.spyOn(worker, 'scanNetwork').mockRejectedValue(new Error(DISCOVERY_TARGET_REFUSED));
  await expect(worker.scanNetworks('job', [{ range: 'public.example' }]))
    .rejects.toThrow(new Error(DISCOVERY_TARGET_REFUSED));
});

it('nmap hostname DNS rebind and SSH rebind never construct scan or socket clients', async () => {
  mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }] as never);
  await expect(new NmapDiscoveryWorker().scanHost('job', 'public.example')).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
  await expect(new SSHDiscoveryWorker().discoverHost('job', 'public.example', 'user', undefined, 'unused'))
    .rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(nmap.NmapScan).not.toHaveBeenCalled();
  expect(NodeSSH).not.toHaveBeenCalled();
});

it('never retries nmap or SSH after a refused DNS rebind, even if DNS becomes public again', async () => {
  const publicAnswer = [{ address: '8.8.8.8', family: 4 }] as never;
  const privateAnswer = [{ address: '169.254.169.254', family: 4 }] as never;
  mockedLookup.mockResolvedValueOnce(publicAnswer).mockResolvedValueOnce(privateAnswer)
    .mockResolvedValue(publicAnswer);
  await expect(new NmapDiscoveryWorker().scanNetwork('job', 'public.example'))
    .rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(mockedLookup).toHaveBeenCalledTimes(2);
  expect(nmap.QuickScan).not.toHaveBeenCalled();
  mockedLookup.mockReset().mockResolvedValueOnce(publicAnswer).mockResolvedValueOnce(privateAnswer)
    .mockResolvedValue(publicAnswer);
  await expect(new SSHDiscoveryWorker().discoverHost('job', 'public.example', 'user', undefined, 'unused'))
    .rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(mockedLookup).toHaveBeenCalledTimes(2);
  expect(NodeSSH).not.toHaveBeenCalled();
});

it('does not disclose credentials while reporting an empty SSH target list', async () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const config = { _jobId: 'job', _targets: [], password: 'SENSITIVE-TEST-VALUE',
    privateKeyPath: 'SENSITIVE-TEST-VALUE' };
  try {
    expect(await new SSHDiscoveryWorker().discover(config)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('No SSH targets provided in config',
      { jobId: 'job', targetCount: 0 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENSITIVE-TEST-VALUE');
  } finally {
    warn.mockRestore();
  }
});
