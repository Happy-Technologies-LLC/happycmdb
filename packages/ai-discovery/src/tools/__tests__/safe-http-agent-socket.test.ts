// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http';
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import { connectDiscoveryHost, resolveDiscoveryHost } from '@cmdb/common';
import { safeDiscoveryHttp } from '../safe-http';

// Exercise Axios, Node's real HTTP Agent, and Socket.connect against only an
// in-process loopback fixture. The policy resolver is replaced ONLY in this
// transport test; separate egress tests exercise actual loopback refusal.
jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'),
  resolveDiscoveryHost: jest.fn(),
  connectDiscoveryHost: jest.fn(),
}));

it('connects a hostname through the real all-address agent path without external egress', async () => {
  const previousAutoSelect = getDefaultAutoSelectFamily();
  const server = createServer((_request, response) => response.end('ready'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    setDefaultAutoSelectFamily(true);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local TCP server');
    jest.mocked(resolveDiscoveryHost).mockResolvedValue('127.0.0.1');
    jest.mocked(connectDiscoveryHost).mockResolvedValue('127.0.0.1');

    const result = await safeDiscoveryHttp(`http://public.example:${address.port}/health`);
    expect(result.data).toBe('ready');
    expect(connectDiscoveryHost).toHaveBeenCalledWith('public.example', '127.0.0.1');
  } finally {
    setDefaultAutoSelectFamily(previousAutoSelect);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
