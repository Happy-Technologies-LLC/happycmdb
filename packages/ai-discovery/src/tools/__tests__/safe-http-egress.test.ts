// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import axios from 'axios';
import { safeDiscoveryHttp } from '../safe-http';
import { DISCOVERY_TARGET_REFUSED } from '@cmdb/common';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('axios', () => jest.fn());
const mockedLookup = jest.mocked(lookup);
const mockedAxios = jest.mocked(axios);

beforeEach(() => { mockedLookup.mockReset(); mockedAxios.mockReset(); });

it('refuses metadata URLs and platform service names before axios is invoked', async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://redis:6379/',
    'http://[::1]/', 'http://metadata.google.internal/']) {
    await expect(safeDiscoveryHttp(url)).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  }
  expect(mockedAxios).not.toHaveBeenCalled();
});

it('accepts public numeric IPv6 without DNS or a proxy', async () => {
  mockedAxios.mockResolvedValueOnce({ status: 200, data: 'ok' } as never);
  const response = await safeDiscoveryHttp('https://[3001::1]/');
  expect([response.status, response.data]).toEqual([200, 'ok']);
  expect(mockedLookup).not.toHaveBeenCalled();
  expect(mockedAxios.mock.calls[0]?.[0]?.proxy).toBe(false);
});

it('pins a public hostname at actual socket lookup and refuses rebind without a network request', async () => {
  mockedLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
    .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never);
  mockedAxios.mockImplementationOnce(async config => {
    expect(config?.maxRedirects).toBe(0);
    expect(config?.proxy).toBe(false);
    const agent = config?.httpAgent;
    const address = await new Promise<string>((resolve, reject) => {
      agent.options.lookup('public.example', {}, (error: Error | null, ip: string) =>
        error ? reject(error) : resolve(ip));
    });
    return { data: address } as never;
  });
  await expect(safeDiscoveryHttp('http://public.example/test', { maxRedirects: 10 }))
    .rejects.toThrow(DISCOVERY_TARGET_REFUSED);
  expect(mockedLookup).toHaveBeenCalledTimes(2);
});
