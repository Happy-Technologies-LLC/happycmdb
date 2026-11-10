// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'events';
import * as nmap from 'node-nmap';
import { NmapDiscoveryWorker } from '../nmap-discovery.worker';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node-nmap', () => ({ QuickScan: jest.fn(), NmapScan: jest.fn(), OsAndPortScan: jest.fn() }));

// HAP-1759: nmap -O needs root and the worker runs as the nodejs user, so it must never ask for it.
function scannerCompleting(hosts: unknown[]) {
  const scanner = new EventEmitter() as EventEmitter & { startScan: () => void };
  scanner.startScan = () => scanner.emit('complete', hosts);
  return scanner;
}

const flagsOf = (call: unknown[]) => String(call[1] ?? '').split(/\s+/).filter(Boolean);
const host = { ip: '8.8.8.8', openPorts: [{ port: 22, protocol: 'tcp', service: 'ssh' }] };

beforeEach(() => {
  jest.mocked(nmap.NmapScan).mockReset().mockImplementation(() => scannerCompleting([host]) as never);
  jest.mocked(nmap.OsAndPortScan).mockReset();
});

it('scanHost with detectOS never passes -O, keeps the other requested flags, and reports OS as unsupported', async () => {
  const ci = await new NmapDiscoveryWorker().scanHost('job', '8.8.8.8', {
    detectOS: true, detectVersion: true, portRange: '22,443',
  });

  const flags = jest.mocked(nmap.NmapScan).mock.calls.flatMap(flagsOf);
  expect(flags).not.toContain('-O');
  expect(flags).toEqual(expect.arrayContaining(['-sV', '-p', '22,443']));
  expect(ci?.metadata.os).toMatchObject({ detection: 'unsupported', matches: [], classes: [] });
  expect(ci?.metadata.ports.open_count).toBe(1);
});

it("scanNetwork 'os' degrades to an unprivileged -sT scan instead of OsAndPortScan (-O)", async () => {
  const cis = await new NmapDiscoveryWorker().scanNetwork('job', '8.8.8.8', 'os');

  expect(nmap.OsAndPortScan).not.toHaveBeenCalled();
  const calls = jest.mocked(nmap.NmapScan).mock.calls;
  expect(calls).toHaveLength(1);
  expect(flagsOf(calls[0])).toEqual(['-sT']);
  expect(cis).toHaveLength(1);
  expect(cis[0].metadata.os.detection).toBe('unsupported');
  // An 'os' scan gets no confidence bonus: it yields no more than a plain scan.
  expect(cis[0].confidence_score).toBe(0.6);
});

it('OS data present in a scan result is still surfaced as detected', async () => {
  jest.mocked(nmap.NmapScan).mockImplementation(
    () => scannerCompleting([{ ...host, osNmap: 'Linux 5.x' }]) as never);

  const ci = await new NmapDiscoveryWorker().scanHost('job', '8.8.8.8');

  expect(ci?.metadata.os).toMatchObject({ detection: 'detected', nmap_guess: 'Linux 5.x' });
});
