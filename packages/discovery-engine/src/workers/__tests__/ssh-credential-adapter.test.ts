// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-774 S3 (C-7/C-8): the SSH worker authenticates only from the in-memory SSHConfig.
import { Console } from 'console';
import { once } from 'events';
import type * as Fs from 'fs';
import type { AddressInfo } from 'net';
import { inspect } from 'util';
import { NodeSSH } from 'node-ssh';
import { Server, utils } from 'ssh2';
import { CredentialProtocolAdapter, logger } from '@cmdb/common';
import type { SSHConfig, UnifiedCredential } from '@cmdb/common';
import {
  ERR_HOSTKEY_ALGORITHM, ERR_SSH_AUTH, ERR_SSH_UNREACHABLE, SSHDiscoveryWorker, SshDiscoveryError,
} from '../ssh-discovery.worker';
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

// HAP-444 K3 (proposal §4.2-§4.4): error mapping, retry policy and server-side counts.
const PASSWORD_AUTH: SSHConfig = { host: '8.8.8.8', port: 22, username: 'svc', password: PASSWORD };
const EXPAND = { depth: null, maxArrayLength: null, maxStringLength: null };

/** discoverHost on a fake NodeSSH, capturing every log level, console and stdout/stderr (retry sleeps on fake timers). */
async function k3(connect: jest.Mock, { stdout = (_: string) => '', pin = PIN, fakeTimers = true } = {}) {
  const execCommand = jest.fn(async (command: string) => ({ stdout: stdout(command), stderr: '', code: 0, signal: null }));
  jest.mocked(NodeSSH).mockImplementation(() => ({ connect, dispose: jest.fn(), execCommand }) as never);
  const [jestConsole, level] = [global.console, logger.level];
  [global.console, logger.level] = [new Console(process.stdout, process.stderr), 'silly'];
  const sinks: jest.SpyInstance[] = [jest.spyOn(process.stdout, 'write'), jest.spyOn(process.stderr, 'write'),
    ...logger.transports.map(transport => jest.spyOn(transport as unknown as { log: () => void }, 'log'))];
  if (fakeTimers) jest.useFakeTimers();
  try {
    const settled = new SSHDiscoveryWorker().discoverHost('run-1', { host: '8.8.8.8', port: 22 }, PASSWORD_AUTH, pin)
      .catch((error: unknown) => error);
    if (fakeTimers) await jest.runAllTimersAsync();
    const result = await settled;
    const logged = sinks.flatMap(spy => spy.mock.calls).map(call => inspect(call, EXPAND)).join('\n');
    expect(logged).toContain(result instanceof Error ? 'SSH discovery failed' : 'SSH connection established'); // live sinks
    expect(`${inspect(result, EXPAND)}\n${logged}`).not.toMatch(new RegExp(`${MARKER}|Handshake failed|no matching`, 'i'));
    return { result, commands: execCommand.mock.calls.map(([command]) => command) };
  } finally {
    jest.useRealTimers();
    [global.console, logger.level] = [jestConsole, level];
  }
}

it.each([
  ['(a) an authentication failure is terminal after one connect', 'client-authentication', 1, ERR_SSH_AUTH],
  ['(b) a timeout is still retried up to 3 connects', 'client-timeout', 3, ERR_SSH_UNREACHABLE],
] as const)('%s, with a fixed code', async (_case, level, attempts, code) => {
  const connect = jest.fn().mockRejectedValue(Object.assign(new Error(MARKER), { level }));
  expect((await k3(connect)).result).toStrictEqual(new SshDiscoveryError(code));
  expect(connect).toHaveBeenCalledTimes(attempts);
});

it('(c) stores server-side counts only: no cron line, login or mount source reaches the metadata', async () => {
  const cronCount = "crontab -l 2>/dev/null | grep -cvE '^\\s*(#|$)'";
  const host: Record<string, string> = { who: `${MARKER} pts/0`, 'who | wc -l': '3', 'crontab -l': `* * * * * ${MARKER}`,
    [cronCount]: '2', mount: `${MARKER} on /mnt/share type cifs (rw,${MARKER})` }; // the marker is in raw output only
  const { result, commands } = await k3(jest.fn().mockResolvedValue(undefined), { stdout: command => host[command] ?? '' });
  expect(commands).toEqual(expect.arrayContaining(['who | wc -l', cronCount]));
  expect(commands.filter(command => command === 'who' || command === 'crontab -l')).toEqual([]);
  expect(result).toMatchObject({ metadata: { _users: { _count: 3 }, _automation: { _cron_job_count: 2 },
    _mounts: [{ _mount_point: '/mnt/share', _filesystem_type: 'cifs' }] } });
  expect(inspect(result, EXPAND)).not.toMatch(/\b(_cron_jobs|_logged_in|_device|_options)\b/);
});

it('(f1) a host unable to offer the pinned algorithm is refused once, before authentication', async () => {
  const methods: string[] = [];
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, client => client
    .on('error', () => undefined).on('authentication', context => { methods.push(context.method); context.reject(); }));
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const { NodeSSH: Real } = jest.requireActual<{ NodeSSH: typeof NodeSSH }>('node-ssh');
  const connect = jest.fn((config: object) => { // a real client, redirected to the loopback server
    const ssh = new Real();
    return ssh.connect({ ...config, host: '127.0.0.1', port: (server.address() as AddressInfo).port }).finally(() => ssh.dispose());
  });
  try {
    const pin = { keyType: HostKeyType.Rsa, fingerprint: PIN.fingerprint };
    expect((await k3(connect, { pin, fakeTimers: false })).result).toStrictEqual(new SshDiscoveryError(ERR_HOSTKEY_ALGORITHM));
    expect([connect.mock.calls.length, methods]).toEqual([1, []]);
  } finally {
    await once(server.close(), 'close');
  }
}, 20000); // a retrying mutant sleeps 2 s + 4 s
