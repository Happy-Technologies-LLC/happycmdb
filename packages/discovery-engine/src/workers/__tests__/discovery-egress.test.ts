// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import * as nmap from 'node-nmap';
import { NodeSSH } from 'node-ssh';
import { NmapDiscoveryWorker } from '../nmap-discovery.worker';
import { SSHDiscoveryWorker } from '../ssh-discovery.worker';
import { DISCOVERY_TARGET_REFUSED } from '@cmdb/common';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node-nmap', () => ({ QuickScan: jest.fn(), NmapScan: jest.fn(), OsAndPortScan: jest.fn() }));
jest.mock('node-ssh', () => ({ NodeSSH: jest.fn() }));
jest.mock('@cmdb/common', () => ({ ...jest.requireActual('@cmdb/common'), withRetry: (operation: () => Promise<unknown>) => operation() }));
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
