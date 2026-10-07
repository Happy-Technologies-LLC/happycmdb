// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import {
  DISCOVERY_TARGET_REFUSED, assertDiscoveryAddress, assertDiscoveryHostname,
  assertDiscoveryRange, resolveDiscoveryHost, connectDiscoveryHost,
} from '../discovery-egress';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
const mockedLookup = jest.mocked(lookup);

beforeEach(() => mockedLookup.mockReset());

it('refuses private, loopback, link-local, metadata, mapped IPv6 and platform names identically', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.1.2', '192.168.1.1',
    '169.254.169.254', '100.100.100.200', '168.63.129.16', '::1', 'fc00::1',
    'fe80::1', '::ffff:127.0.0.1']) {
    expect(() => assertDiscoveryAddress(address)).toThrow(DISCOVERY_TARGET_REFUSED);
  }
  for (const name of ['postgres', 'redis.default.svc', 'neo4j', 'api-server',
    'metadata.google.internal', 'localhost', 'db.internal']) {
    expect(() => assertDiscoveryHostname(name)).toThrow(DISCOVERY_TARGET_REFUSED);
  }
  expect(mockedLookup).not.toHaveBeenCalled();
});

it('refuses CIDRs with prohibited overlap, host lists and injected nmap syntax', () => {
  for (const range of ['0.0.0.0/0', '8.0.0.0/6', '10.0.0.0/8', '169.254.0.0/16',
    '192.168.1.0/24', 'fc00::/7', '8.8.8.8;touch /tmp/x', '8.8.8.8,127.0.0.1']) {
    expect(() => assertDiscoveryRange(range)).toThrow(DISCOVERY_TARGET_REFUSED);
  }
  expect(assertDiscoveryRange('8.8.8.0/24')).toBe('8.8.8.0/24');
  expect(assertDiscoveryRange('3001::1')).toBe('3001::1');
});

it('refuses DNS rebinding before connection instead of using the original hostname', async () => {
  mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '10.0.0.3', family: 4 }] as never);
  const pinned = await resolveDiscoveryHost('public.example');
  expect(pinned).toBe('8.8.8.8');
  await expect(connectDiscoveryHost('public.example', pinned)).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(mockedLookup).toHaveBeenCalledTimes(2);
});

it('rejects mixed public/private DNS answers before selecting any target', async () => {
  mockedLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 },
    { address: '169.254.169.254', family: 4 }] as never);
  await expect(resolveDiscoveryHost('public.example')).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
});
