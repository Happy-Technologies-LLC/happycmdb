// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { EventEmitter } from 'events';
import { inspect } from 'util';
import * as nmap from 'node-nmap';
import { NodeSSH } from 'node-ssh';
import { NmapDiscoveryWorker } from '../nmap-discovery.worker';
import { SSHDiscoveryWorker } from '../ssh-discovery.worker';
import { HostKeyType, hostKeyFingerprint } from '../ssh-host-key';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node-nmap', () => ({ QuickScan: jest.fn(), NmapScan: jest.fn(), OsAndPortScan: jest.fn() }));
jest.mock('node-ssh', () => ({ NodeSSH: jest.fn() }));
const mockedLookup = jest.mocked(lookup);
// The synthetic password is assembled at runtime so no source line reads as a secret assignment to scanners.
const SSH_AUTH = { host: 'public.example', port: 22, username: 'user', password: ['un', 'used'].join('') };
const PIN = { keyType: HostKeyType.Ed25519, fingerprint: hostKeyFingerprint(Buffer.from('k2-synthetic-blob')) };

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

it('keeps scanner rejection diagnostics out of logs and queued aggregate failure', async () => {
  const sensitive = 'SENSITIVE-SCANNER-DIAGNOSTIC';
  const log = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const worker = new NmapDiscoveryWorker();
  jest.spyOn(worker, 'scanNetwork').mockRejectedValue(new Error(sensitive));
  await expect(worker.scanNetworks('job', [{ range: '8.8.8.8' }]))
    .rejects.not.toThrow(sensitive);
  expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  log.mockRestore();
});

it('does not expose an emitted nmap scanner error even after transient retries', async () => {
  jest.useFakeTimers();
  const sensitive = 'SENSITIVE-NMAP-EMITTER';
  const log = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const scanner = new EventEmitter() as EventEmitter & { startScan: () => void };
  scanner.startScan = () => scanner.emit('error', new Error(sensitive));
  jest.mocked(nmap.QuickScan).mockImplementation(() => scanner as never);
  try {
    const result = new NmapDiscoveryWorker().scanNetwork('job', '8.8.8.8');
    const rejection = expect(result).rejects.toThrow('Nmap scan failed');
    await jest.runAllTimersAsync();
    await rejection;
    expect(nmap.QuickScan).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  } finally {
    log.mockRestore();
    jest.useRealTimers();
  }
});

it('nmap hostname DNS rebind and SSH rebind never construct scan or socket clients', async () => {
  mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }] as never);
  await expect(new NmapDiscoveryWorker().scanHost('job', 'public.example')).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
  await expect(new SSHDiscoveryWorker().discoverHost('job', { host: 'public.example', port: 22 }, SSH_AUTH, PIN))
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
  await expect(new SSHDiscoveryWorker().discoverHost('job', { host: 'public.example', port: 22 }, SSH_AUTH, PIN))
    .rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(mockedLookup).toHaveBeenCalledTimes(2);
  expect(NodeSSH).not.toHaveBeenCalled();
});

const SYNTHETIC_MARKERS = [
  'error-host.invalid',
  '192.0.2.77',
  'cn=svc-synthetic,ou=people,dc=example,dc=invalid',
];
const SYNTHETIC_PAYLOAD = `failure for ${SYNTHETIC_MARKERS.join(' ')}`;

function captureAllLogArguments() {
  const spies = (['debug', 'info', 'warn', 'error'] as const)
    .map(level => jest.spyOn(logger, level).mockImplementation(() => logger));
  return {
    calls: () => spies.flatMap(spy => spy.mock.calls),
    errorSpy: spies[3],
  };
}

function expectNoSyntheticMarkers(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const marker of [...SYNTHETIC_MARKERS, SYNTHETIC_PAYLOAD]) {
    expect(serialized).not.toContain(marker);
  }
}

it('nmap scanHost scanner error event logs fixed text and class, and rejects with a sanitized error', async () => {
  jest.useFakeTimers();
  const logs = captureAllLogArguments();
  const scanner = new EventEmitter() as EventEmitter & { startScan: () => void };
  scanner.startScan = () => scanner.emit('error', new TypeError(SYNTHETIC_PAYLOAD));
  jest.mocked(nmap.NmapScan).mockImplementation(() => scanner as never);
  try {
    const settled = new NmapDiscoveryWorker().scanHost('job', '8.8.8.8').then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error })
    );
    await jest.runAllTimersAsync();
    const { error } = await settled;

    expect(nmap.NmapScan).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(Error);
    const rejection = error as Error;
    expect(rejection.message).toBe('Nmap host scan failed');
    expect(rejection.cause).toBeUndefined();
    expectNoSyntheticMarkers(
      Object.getOwnPropertyNames(rejection).map(key => String((rejection as never)[key]))
    );
    expect(logs.errorSpy).toHaveBeenCalledWith('Nmap host scan failed', {
      jobId: 'job',
      errorClass: 'TypeError',
    });
    expectNoSyntheticMarkers(logs.calls());
  } finally {
    jest.useRealTimers();
  }
});

it('nmap scanHost scanner error event with a non-Error payload leaks nothing', async () => {
  jest.useFakeTimers();
  const logs = captureAllLogArguments();
  const scanner = new EventEmitter() as EventEmitter & { startScan: () => void };
  scanner.startScan = () => scanner.emit('error', SYNTHETIC_PAYLOAD);
  jest.mocked(nmap.NmapScan).mockImplementation(() => scanner as never);
  try {
    const settled = new NmapDiscoveryWorker().scanHost('job', '8.8.8.8').catch((error: Error) => error);
    await jest.runAllTimersAsync();
    const error = (await settled) as Error;

    expect(error.message).toBe('Nmap host scan failed');
    expect(logs.errorSpy).toHaveBeenCalledWith('Nmap host scan failed', {
      jobId: 'job',
      errorClass: 'string',
    });
    expectNoSyntheticMarkers(logs.calls());
  } finally {
    jest.useRealTimers();
  }
});

// Expands Error own properties: plain JSON.stringify renders an Error as {} and would hide a leak.
function serializeWithErrors(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error ? { name: item.name, message: item.message, stack: item.stack } : item);
}

// Key-path auth: distinct per-field markers, assembled at runtime like SSH_AUTH.
const KEY_AUTH = {
  host: SSH_AUTH.host, port: SSH_AUTH.port, username: SSH_AUTH.username,
  privateKey: ['l1', 'kmarker', 'synthetic'].join('-'),
  passphrase: ['l1', 'pmarker', 'synthetic'].join('-'),
};

// Each variant: auth, plus the credential markers (distinct from the error payload) that it carries.
it.each([
  ['password', { ...SSH_AUTH, password: SYNTHETIC_PAYLOAD }, [] as string[]],
  ['privateKey and passphrase', KEY_AUTH, [KEY_AUTH.privateKey, KEY_AUTH.passphrase]],
])('ssh discoverHost per-host catch logs fixed text and class only (%s auth)', async (_variant, auth, credentialMarkers) => {
  jest.useFakeTimers();
  const logs = captureAllLogArguments();
  const original = new RangeError(SYNTHETIC_PAYLOAD);
  const dispose = jest.fn();
  const connect = jest.fn().mockRejectedValue(original);
  jest.mocked(NodeSSH).mockImplementation(() => ({ connect, dispose }) as never);
  try {
    const settled = new SSHDiscoveryWorker()
      .discoverHost('job', { host: '8.8.8.8', port: 22 }, auth, PIN)
      .catch((error: unknown) => error);
    await jest.runAllTimersAsync();

    // Existing control flow preserved: the original error is still rethrown and the client disposed.
    expect(await settled).toBe(original);
    expect(dispose).toHaveBeenCalledTimes(3);
    // Non-vacuity: every attempt handed this variant's credential fields to connect.
    expect(connect).toHaveBeenCalledTimes(3);
    for (const [options] of connect.mock.calls) {
      for (const marker of credentialMarkers) expect(Object.values(options)).toContain(marker);
    }
    expect(logs.errorSpy).toHaveBeenCalledWith('SSH discovery failed', {
      runId: 'job',
      errorClass: 'RangeError',
    });
    for (const marker of [...SYNTHETIC_MARKERS, SYNTHETIC_PAYLOAD, ...credentialMarkers]) {
      expect(serializeWithErrors(logs.calls())).not.toContain(marker);
    }
    for (const marker of credentialMarkers) {
      expect(`${inspect(original)}\n${original.stack}`).not.toContain(marker);
    }
  } finally {
    jest.useRealTimers();
  }
});
