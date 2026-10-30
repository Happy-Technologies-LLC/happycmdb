// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-774 S3 (C-7/C-8): the SSH worker authenticates only from the in-memory SSHConfig.
import { Console } from 'console';
import type * as Fs from 'fs';
import { inspect } from 'util';
import { NodeSSH } from 'node-ssh';
import { CredentialProtocolAdapter, logger } from '@cmdb/common';
import type { SSHConfig, UnifiedCredential } from '@cmdb/common';
import { SSHDiscoveryWorker } from '../ssh-discovery.worker';
import { HostKeyType, hostKeyFingerprint } from '../ssh-host-key';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node-ssh', () => ({ NodeSSH: jest.fn() }));

// Core modules are shared singletons, so these spies see any fs use by the worker.
const fs = jest.requireActual<typeof Fs>('fs');
// Synthetic markers are assembled at runtime so no source line reads as a secret assignment to scanners.
const MARKER = ['S3', 'MARKER'].join('');
const PEM_LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ');
const KEY = `-----BEGIN ${PEM_LABEL}-----\n${MARKER}-KEY\n-----END ${PEM_LABEL}-----\n`;
const PASSPHRASE = [MARKER, 'PASS'].join('-');
const PASSWORD = [MARKER, 'PW'].join('-');
const PIN = { keyType: HostKeyType.Ed25519, fingerprint: hostKeyFingerprint(Buffer.from('k2-synthetic-blob')) };
const TIMEOUTS = { readyTimeout: 10000, keepaliveInterval: 5000,
  hostVerifier: expect.any(Function), algorithms: { serverHostKey: [PIN.keyType] } };
const toAuth = (protocol: 'ssh_key' | 'ssh_password', credentials: Record<string, unknown>) =>
  CredentialProtocolAdapter.toSSHConfig({ protocol, credentials } as unknown as UnifiedCredential, '8.8.8.8');

/** Runs discoverHost against a fake NodeSSH while spying on fs and on the lowest log sinks (#142). */
async function discover(auth: SSHConfig) {
  const connect = jest.fn().mockResolvedValue(undefined);
  jest.mocked(NodeSSH).mockImplementation(() => ({
    connect, dispose: jest.fn(), execCommand: jest.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0, signal: null }),
  }) as never);
  const fsSpies = [jest.spyOn(fs, 'readFile'), jest.spyOn(fs, 'readFileSync'), jest.spyOn(fs, 'open'),
    jest.spyOn(fs, 'openSync'), jest.spyOn(fs, 'createReadStream'), jest.spyOn(fs.promises, 'readFile'),
    jest.spyOn(fs.promises, 'open')];
  expect(logger.transports.length).toBeGreaterThan(0);
  const [jestConsole, level] = [global.console, logger.level];
  global.console = new Console(process.stdout, process.stderr);
  logger.level = 'silly';
  const sinks: jest.SpyInstance[] = [jest.spyOn(process.stdout, 'write'), jest.spyOn(process.stderr, 'write'),
    ...logger.transports.map(transport => jest.spyOn(transport as unknown as { log: () => void }, 'log'))];
  try {
    await new SSHDiscoveryWorker().discoverHost('run-1', { host: auth.host, port: auth.port }, auth, PIN);
  } finally {
    [global.console, logger.level] = [jestConsole, level];
  }
  const logged = sinks.flatMap(spy => spy.mock.calls).map(call => inspect(call, { depth: 8 })).join('\n');
  expect(logged).toContain('SSH connection established'); // the sinks are live, so the marker check is not vacuous
  expect(logged).not.toContain(MARKER);
  for (const spy of fsSpies) expect(spy).not.toHaveBeenCalled();
  return connect.mock.calls;
}

it('passes the in-memory private key, passphrase and credential port, never a key path', async () => {
  const auth = toAuth('ssh_key', { username: 'svc', private_key: KEY, passphrase: PASSPHRASE, port: 2222 });
  expect(await discover(auth)).toStrictEqual([[{
    host: '8.8.8.8', port: 2222, username: 'svc', privateKey: KEY, passphrase: PASSPHRASE, ...TIMEOUTS,
  }]]);
});

it('passes only the password for a password credential, on the adapter default port', async () => {
  const auth = toAuth('ssh_password', { username: 'svc', password: PASSWORD });
  expect(await discover(auth)).toStrictEqual([[{
    host: '8.8.8.8', port: 22, username: 'svc', password: PASSWORD, ...TIMEOUTS,
  }]]);
});

it('exposes only the adapter entry point and refuses an auth without a secret before any connection', async () => {
  const worker = new SSHDiscoveryWorker() as unknown as Record<string, unknown>;
  expect(worker['discover']).toBeUndefined();
  expect(worker['discoverHosts']).toBeUndefined();
  await expect(new SSHDiscoveryWorker().discoverHost('run-1', { host: '8.8.8.8', port: 22 },
    { host: '8.8.8.8', port: 22, username: 'svc' }, PIN)).rejects.toThrow('SSH credential incomplete');
  expect(NodeSSH).not.toHaveBeenCalled();
});
