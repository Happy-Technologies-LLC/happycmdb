// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-444 K2: discoverHost verifies the pinned host key before authentication, against a real
// in-process ssh2 server on loopback. Keys and the credential marker are generated at runtime.
import { Console } from 'console';
import { createHash, randomUUID } from 'crypto';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { inspect } from 'util';
import { NodeSSH } from 'node-ssh';
import { Server, utils, type ParsedKey } from 'ssh2';
import { connectDiscoveryHost, logger, resolveDiscoveryHost } from '@cmdb/common';
import { SSHDiscoveryWorker } from '../ssh-discovery.worker';
import { ERR_HOSTKEY_MISMATCH, ERR_HOSTKEY_UNPINNED, HostKeyPin, HostKeyType } from '../ssh-host-key';

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'), resolveDiscoveryHost: jest.fn(), connectDiscoveryHost: jest.fn(),
}));
jest.setTimeout(20000); // a retrying mutant sleeps 2 s + 4 s before failing its assertions

const HOST = 'pinned-host.example';
const MARKER = randomUUID();
const [A, B, RSA] = [utils.generateKeyPairSync('ed25519'), utils.generateKeyPairSync('ed25519'),
  utils.generateKeyPairSync('rsa', { bits: 2048 })];
const pinOf = (publicKey: string, keyType: HostKeyType): HostKeyPin => ({ keyType, fingerprint: `SHA256:${createHash('sha256')
  .update((utils.parseKey(publicKey) as ParsedKey).getPublicSSH()).digest('base64').replace(/=+$/, '')}` });
const PINS = [pinOf(A.public, HostKeyType.Ed25519), pinOf(B.public, HostKeyType.Ed25519), pinOf(RSA.public, HostKeyType.Rsa)];

beforeEach(() => { // the unit config resets mocks, so the loopback destination is re-armed per test
  jest.mocked(resolveDiscoveryHost).mockResolvedValue('127.0.0.1');
  jest.mocked(connectDiscoveryHost).mockResolvedValue('127.0.0.1');
});

/** Runs discoverHost against a fresh loopback server while capturing every log sink. */
async function discover(hostKeys: string[], pin: unknown) {
  const seen = { connections: 0, auth: [] as unknown[], ready: 0 };
  const server = new Server({ hostKeys }, client => {
    seen.connections++;
    client.on('error', () => undefined).on('authentication', ctx => {
      seen.auth.push(ctx.method === 'password' ? ctx.password : ctx.method);
      if (ctx.method === 'password') ctx.accept(); else ctx.reject(['password']);
    }).on('ready', () => seen.ready++).on('session', accept => accept()
      .on('exec', run => { const stream = run(); stream.exit(0); stream.end(); }));
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const { port } = server.address() as AddressInfo;
  const connect = jest.spyOn(NodeSSH.prototype, 'connect');
  const [jestConsole, level] = [global.console, logger.level];
  [global.console, logger.level] = [new Console(process.stdout, process.stderr), 'silly'];
  const sinks: jest.SpyInstance[] = [jest.spyOn(process.stdout, 'write'), jest.spyOn(process.stderr, 'write'),
    ...logger.transports.map(transport => jest.spyOn(transport as unknown as { log: () => void }, 'log'))];
  try {
    const result = await new SSHDiscoveryWorker().discoverHost('run-k2', { host: HOST, port },
      { host: HOST, port, username: 'svc', password: MARKER }, pin as HostKeyPin).catch((error: Error) => error);
    const logged = sinks.flatMap(spy => spy.mock.calls)
      .map(call => inspect(call, { depth: null, maxArrayLength: null, maxStringLength: null })).join('\n');
    return { result, seen, logged, configs: connect.mock.calls.map(([config]) => config) };
  } finally {
    [global.console, logger.level] = [jestConsole, level];
    [connect, ...sinks].forEach(spy => spy.mockRestore());
    await new Promise(resolve => server.close(resolve));
  }
}

it('(a) refuses a host presenting another key before authentication, without retry', async () => {
  const { result, seen } = await discover([B.private], PINS[0]);
  expect(result).toEqual(new Error(ERR_HOSTKEY_MISMATCH));
  expect(seen).toEqual({ connections: 1, auth: [], ready: 0 });
  expect(connectDiscoveryHost).toHaveBeenCalledTimes(1);
});

it('(b) authenticates and discovers once the presented key matches the pin', async () => {
  const { result, seen } = await discover([A.private], PINS[0]);
  expect(result).toMatchObject({ _type: 'server' });
  expect(seen).toMatchObject({ connections: 1, ready: 1, auth: expect.arrayContaining([MARKER]) });
});

it.each([
  ['no pin', undefined],
  ['a non-pinnable ssh-dss type', { keyType: 'ssh-dss', fingerprint: PINS[0].fingerprint }],
  ['a malformed fingerprint', { keyType: HostKeyType.Ed25519, fingerprint: PINS[0].fingerprint.slice(1) }],
])('(c) refuses %s before any socket opens', async (_case, pin) => {
  const { result, seen, configs } = await discover([A.private], pin);
  expect(result).toEqual(new Error(ERR_HOSTKEY_UNPINNED));
  expect([seen.connections, configs, jest.mocked(connectDiscoveryHost).mock.calls]).toEqual([0, [], []]);
});

it('(d) restricts serverHostKey to the pinned RSA key on a host also holding ed25519', async () => {
  const { result, seen, configs } = await discover([A.private, RSA.private], PINS[2]);
  expect(result).toMatchObject({ _type: 'server' });
  expect(seen.ready).toBe(1);
  expect(configs).toEqual([expect.objectContaining({
    algorithms: { serverHostKey: ['rsa-sha2-512', 'rsa-sha2-256'] }, hostVerifier: expect.any(Function),
  })]);
  expect(configs[0]).not.toHaveProperty('hostHash');
});

it('(e) logs no fingerprint, host or credential marker on refusal or success', async () => {
  const [refused, accepted] = [await discover([B.private], PINS[0]), await discover([A.private], PINS[0])];
  expect(refused.logged).toContain(ERR_HOSTKEY_MISMATCH); // the sinks are live, so the checks below are not vacuous
  expect(accepted.logged).toContain('SSH connection established');
  for (const value of [...PINS.map(pin => pin.fingerprint.slice(7)), HOST, MARKER]) {
    expect(`${refused.logged}\n${accepted.logged}`).not.toContain(value);
  }
});
