// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { connectDiscoveryHost, resolveDiscoveryHost } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import { DISCOVERY_PATTERN_MAX_TOTAL_BYTES, DISCOVERY_SKIPPED_KEY, PatternMatcher } from '../pattern-matcher';
import { DISCOVERY_HTTP_MAX_BYTES } from '../tools/safe-http';
import type { PatternStorageService } from '../pattern-storage';
import type { DiscoveryPattern } from '../types';

// Real PatternMatcher, real safeDiscoveryHttp, real axios and a loopback server. Only the policy
// resolver is replaced, so the transport can reach the fixture (egress refusal: safe-http-egress.test.ts).
jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'),
  resolveDiscoveryHost: jest.fn(),
  connectDiscoveryHost: jest.fn(),
}));
jest.mock('@cmdb/database', () => ({ getRedisClient: jest.fn(), getPostgresClient: jest.fn(() => ({})) }));

const MIB = 1024 * 1024;
const ENDPOINTS = Array.from({ length: 64 }, (_, index) => `/e${index}`);
const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
const storage = {
  loadPatterns: jest.fn(), createExecutionSession: jest.fn().mockResolvedValue(undefined),
  recordUsage: jest.fn().mockResolvedValue(undefined),
};

let server: Server;
let requests: string[];

beforeEach(async () => {
  requests = [];
  jest.mocked(resolveDiscoveryHost).mockResolvedValue('127.0.0.1');
  jest.mocked(connectDiscoveryHost).mockResolvedValue('127.0.0.1');
  (getRedisClient as jest.Mock).mockReturnValue(redis);
  // Every endpoint inflates to twice the per-request ceiling from a few KiB on the wire.
  const wire = gzipSync(Buffer.alloc(2 * DISCOVERY_HTTP_MAX_BYTES, 97));
  server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': wire.length });
    response.end(wire);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function pattern(): DiscoveryPattern {
  return {
    id: 'pattern-1', patternId: 'web-service', name: 'Web service', version: '1.0.0',
    category: 'web', author: 'fixture', license: 'MIT', confidenceScore: 0.9,
    usageCount: 0, successCount: 0, failureCount: 0, status: 'draft', isActive: false,
    createdAt: new Date(), updatedAt: new Date(),
    detectionCode: JSON.stringify({ kind: 'detection-v1', ports: [], headers: [], endpoints: ENDPOINTS, serviceNames: [] }),
    discoveryCode: JSON.stringify({ kind: 'discovery-v1', name: 'Web service', category: 'web',
      serviceType: 'application', endpoints: ENDPOINTS }),
    testCases: [],
  };
}

describe('executeDiscovery byte budget against real oversize responses', () => {
  it('stops after the budget when all 64 endpoints are gzip bombs cut at the per-request ceiling', async () => {
    storage.loadPatterns.mockResolvedValue([pattern()]);
    const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
    const port = (server.address() as AddressInfo).port;
    const [ci] = await matcher.executePattern('web-service',
      { targetHost: 'probe-target.example', targetPort: port, scanResult: { services: [{ port }] } });
    const requested = DISCOVERY_PATTERN_MAX_TOTAL_BYTES / MIB;
    expect(requests).toEqual(ENDPOINTS.slice(0, requested));
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'bytes-budget', endpoints: ENDPOINTS.slice(requested) });
  });
});
