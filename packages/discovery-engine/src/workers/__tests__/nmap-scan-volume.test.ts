// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { setImmediate } from 'timers/promises';
import * as nmap from 'node-nmap';
import { NmapDiscoveryWorker } from '../nmap-discovery.worker';
import { DISCOVERY_TARGET_REFUSED } from '@cmdb/common';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node-nmap', () => ({ QuickScan: jest.fn(), NmapScan: jest.fn(), OsAndPortScan: jest.fn() }));

const ranges = Array.from({ length: 10 }, (_, i) => ({ range: `8.8.8.${i + 1}` }));

it('HAP-1079: a batch above 65,536 addresses is refused before any range is scanned', async () => {
  const worker = new NmapDiscoveryWorker();
  const scan = jest.spyOn(worker, 'scanNetwork').mockResolvedValue([]);
  const batch = [...Array.from({ length: 16 }, () => ({ range: '8.8.0.0/20' })), { range: '8.8.8.8' }];
  await expect(worker.scanNetworks('job', batch)).rejects.toThrow(new Error(DISCOVERY_TARGET_REFUSED));
  expect(scan).not.toHaveBeenCalled();
  expect(nmap.QuickScan).not.toHaveBeenCalled();
});

it('HAP-1079: at most 4 ranges are scanned at once and every range is still scanned', async () => {
  const worker = new NmapDiscoveryWorker();
  let active = 0;
  let peak = 0;
  const scan = jest.spyOn(worker, 'scanNetwork').mockImplementation(async (_job, range) => {
    peak = Math.max(peak, ++active);
    await setImmediate();
    active--;
    return [{ name: range } as never];
  });
  await expect(worker.scanNetworks('job', ranges)).resolves.toHaveLength(10);
  expect([peak, scan.mock.calls.length]).toEqual([4, 10]);
});

it('HAP-1079: no further range starts after a policy refusal', async () => {
  const worker = new NmapDiscoveryWorker();
  const scan = jest.spyOn(worker, 'scanNetwork').mockImplementation(async (_job, range) => {
    if (range === '8.8.8.1') throw new Error(DISCOVERY_TARGET_REFUSED);
    await setImmediate();
    return [];
  });
  await expect(worker.scanNetworks('job', ranges)).rejects.toThrow(new Error(DISCOVERY_TARGET_REFUSED));
  expect(scan).toHaveBeenCalledTimes(4);
});
