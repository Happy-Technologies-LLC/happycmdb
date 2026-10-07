// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import * as ldap from 'ldapjs';
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
