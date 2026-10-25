// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import * as ldap from 'ldapjs';
import { EventEmitter } from 'events';
import type { UnifiedCredential } from '@cmdb/common';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';
import { ActiveDirectoryDiscoveryWorker } from '../active-directory-discovery.worker';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('ldapjs', () => ({ createClient: jest.fn() }));
const mockedLookup = jest.mocked(lookup);
const credential: UnifiedCredential = {
  id: 'test', name: 'test', protocol: 'ldap', scope: 'network',
  credentials: { domain: 'public.example', base_dn: 'DC=example,DC=com', username: 'tester', password: 'not-used' },
  affinity: {}, tags: [], created_by: 'test', created_at: new Date(), updated_at: new Date(),
};

beforeEach(() => { mockedLookup.mockReset(); jest.mocked(ldap.createClient).mockClear(); });

it('refuses internal LDAP target before constructing client', async () => {
  const internalCredential: UnifiedCredential = {
    ...credential, credentials: { ...credential.credentials, domain: 'redis' },
  };
  const worker = new ActiveDirectoryDiscoveryWorker('redis', 'DC=example,DC=com', internalCredential);
  await expect(worker.discoverComputers('job')).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(ldap.createClient).not.toHaveBeenCalled();
  expect(mockedLookup).not.toHaveBeenCalled();
});

it('refuses DNS rebinding to metadata before constructing LDAP client', async () => {
  mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
  const worker = new ActiveDirectoryDiscoveryWorker('public.example', 'DC=example,DC=com', credential);
  await expect(worker.discoverComputers('job')).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(ldap.createClient).not.toHaveBeenCalled();
});

it('rejects aggregate LDAP discovery before dispatch when target is a platform service', async () => {
  const internalCredential: UnifiedCredential = {
    ...credential, credentials: { ...credential.credentials, domain: 'redis' },
  };
  const worker = new ActiveDirectoryDiscoveryWorker('redis', 'DC=example,DC=com', internalCredential);
  const computers = jest.spyOn(worker, 'discoverComputers');
  await expect(worker.discoverAll('job', {
    domain: 'redis', base_dn: 'DC=example,DC=com',
  })).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(computers).not.toHaveBeenCalled();
  expect(ldap.createClient).not.toHaveBeenCalled();
});

it('propagates aggregate policy refusal and never logs credentials', async () => {
  mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const worker = new ActiveDirectoryDiscoveryWorker('public.example', 'DC=example,DC=com', credential);
  jest.spyOn(worker, 'discoverComputers').mockRejectedValue(new Error(DISCOVERY_TARGET_REFUSED));
  jest.spyOn(worker, 'discoverUsers').mockResolvedValue([]);
  jest.spyOn(worker, 'discoverGroups').mockResolvedValue([]);
  jest.spyOn(worker, 'discoverOrganizationalUnits').mockResolvedValue([]);
  const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  const config = {
    domain: 'public.example', base_dn: 'DC=example,DC=com',
    credentials: { password: 'SENSITIVE-TEST-VALUE' },
  };
  await expect(worker.discoverAll('job', config)).rejects.toThrow(new Error(DISCOVERY_TARGET_REFUSED));
  expect(JSON.stringify(info.mock.calls)).not.toContain('SENSITIVE-TEST-VALUE');
});

it('never retries denied LDAP DNS rebind after DNS becomes public again', async () => {
  const publicAnswer = [{ address: '8.8.8.8', family: 4 }] as never;
  mockedLookup.mockResolvedValueOnce(publicAnswer)
    .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never)
    .mockResolvedValue(publicAnswer);
  const worker = new ActiveDirectoryDiscoveryWorker('public.example', 'DC=example,DC=com', credential);
  await expect(worker.discoverComputers('job')).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(mockedLookup).toHaveBeenCalledTimes(2);
  expect(ldap.createClient).not.toHaveBeenCalled();
});

it('keeps LDAP client failures and rejected resource reasons out of logs and errors', async () => {
  mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const sensitive = 'SENSITIVE-LDAP-DIAGNOSTIC';
  const log = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const client = new EventEmitter();
  (client as any).bind = jest.fn(() => client.emit('error', new Error(sensitive)));
  jest.mocked(ldap.createClient).mockReturnValue(client as never);
  const worker = new ActiveDirectoryDiscoveryWorker('public.example', 'DC=example,DC=com', credential);
  await expect((worker as any).createLDAPClient()).rejects.not.toThrow(sensitive);
  const bindFailure = new EventEmitter();
  (bindFailure as any).bind = jest.fn((_dn: string, _password: string, callback: (error: Error) => void) =>
    callback(new Error(sensitive)));
  jest.mocked(ldap.createClient).mockReturnValue(bindFailure as never);
  await expect((worker as any).createLDAPClient()).rejects.not.toThrow(sensitive);
  jest.spyOn(worker, 'discoverComputers').mockRejectedValue(new Error(sensitive));
  jest.spyOn(worker, 'discoverUsers').mockResolvedValue([]);
  jest.spyOn(worker, 'discoverGroups').mockResolvedValue([]);
  jest.spyOn(worker, 'discoverOrganizationalUnits').mockResolvedValue([]);
  await worker.discoverAll('job', { domain: 'public.example', base_dn: 'DC=example,DC=com' });
  expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
  log.mockRestore();
});

it('logs LDAP unbind failures with error class only and still resolves cleanup', async () => {
  const host = 'dc01.synthetic-directory.invalid';
  const bindDn = 'CN=svc-synthetic,OU=Service,DC=synthetic-directory,DC=invalid';
  class SyntheticUnbindError extends Error {
    constructor(message: string) { super(message); this.name = 'SyntheticUnbindError'; }
  }
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const unbind = jest.fn((callback: (error?: Error) => void) =>
    callback(new SyntheticUnbindError(`unbind ldaps://${host}:636 failed for ${bindDn}`)));
  const worker = new ActiveDirectoryDiscoveryWorker('public.example', 'DC=example,DC=com', credential);
  // closeLDAPClient is private; expose it by contract for the real-method call.
  const privateWorker = worker as unknown as { closeLDAPClient(client: unknown): Promise<void> };
  await expect(privateWorker.closeLDAPClient({ unbind })).resolves.toBeUndefined();
  expect(unbind).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls).toEqual([['LDAP unbind error', { error: 'SyntheticUnbindError' }]]);
  const serialized = JSON.stringify(warn.mock.calls);
  expect(serialized).not.toContain(host);
  expect(serialized).not.toContain(bindDn);
  expect(serialized).not.toContain('CN=');
  warn.mockRestore();
});

it('logs LDAP search errors with class only, rejects with the original error, and keeps discoverAll clean', async () => {
  const markers = ['error-host.invalid', '192.0.2.77', 'cn=svc-synthetic,ou=people,dc=example,dc=invalid'];
  const payload = `search ldaps://${markers[0]} (${markers[1]}) failed for ${markers[2]}`;
  class SyntheticLdapError extends Error {}
  // Expands Error own properties: plain JSON.stringify renders an Error as {} and would hide a leak.
  const serialize = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error ? { name: item.name, message: item.message, stack: item.stack } : item);
  const failingSearch = (error: () => Error) => jest.fn((_base: string, _opts: unknown,
    callback: (err: Error | null, res: EventEmitter) => void) => {
    const res = new EventEmitter();
    callback(null, res);
    res.emit('error', error());
  });
  const spies = (['debug', 'info', 'warn', 'error'] as const)
    .map(level => jest.spyOn(logger, level).mockImplementation(() => logger));
  const worker = new ActiveDirectoryDiscoveryWorker('public.example', 'DC=example,DC=com', credential);

  const original = new SyntheticLdapError(payload);
  const privateWorker = worker as unknown as { searchLDAP(client: unknown, base: string, opts: unknown): Promise<unknown> };
  await expect(privateWorker.searchLDAP({ search: failingSearch(() => original) }, 'DC=example,DC=com', {}))
    .rejects.toBe(original);
  expect(spies[3]).toHaveBeenCalledWith('LDAP search error', { errorClass: 'SyntheticLdapError' });
  // Real ldapjs result-code errors have anonymous constructors; their fixed `name` names the class.
  const { NoSuchObjectError } = jest.requireActual<typeof ldap>('ldapjs');
  await expect(privateWorker.searchLDAP({ search: failingSearch(() => new NoSuchObjectError(payload)) },
    'DC=example,DC=com', {})).rejects.toThrow(NoSuchObjectError);
  expect(spies[3]).toHaveBeenLastCalledWith('LDAP search error', { errorClass: 'NoSuchObjectError' });

  mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  const search = failingSearch(() => new SyntheticLdapError(payload));
  jest.mocked(ldap.createClient).mockImplementation(() => Object.assign(new EventEmitter(), {
    bind: jest.fn((_dn: string, _password: string, callback: (err: Error | null) => void) => callback(null)),
    search,
    unbind: jest.fn((callback: (err?: Error) => void) => callback()),
  }) as never);
  jest.useFakeTimers();
  try {
    const settled = worker.discoverAll('job', { domain: 'public.example', base_dn: 'DC=example,DC=com' });
    await jest.runAllTimersAsync();
    const cis = await settled;

    expect(cis).toEqual([]);
    expect(search).toHaveBeenCalled();
    const logged = serialize(spies.flatMap(spy => spy.mock.calls));
    for (const marker of [...markers, payload]) {
      expect(logged).not.toContain(marker);
    }
  } finally {
    jest.useRealTimers();
  }
});
