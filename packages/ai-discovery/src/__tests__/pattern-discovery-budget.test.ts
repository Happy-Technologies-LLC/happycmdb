// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { getRedisClient } from '@cmdb/database';
import {
  DISCOVERY_BODY_TRUNCATED, DISCOVERY_PATTERN_MAX_TOTAL_BYTES, DISCOVERY_PATTERN_MAX_TOTAL_MS,
  DISCOVERY_SKIPPED_KEY, DISCOVERY_STORED_BODY_MAX_BYTES, PatternMatcher,
} from '../pattern-matcher';
import { DISCOVERY_HTTP_MAX_BYTES, DISCOVERY_RESPONSE_TOO_LARGE, safeDiscoveryHttp } from '../tools/safe-http';
import type { PatternStorageService } from '../pattern-storage';
import type { DiscoveryPattern } from '../types';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('@cmdb/database', () => ({ getRedisClient: jest.fn(), getPostgresClient: jest.fn(() => ({})) }));
jest.mock('../tools/safe-http', () => ({ ...jest.requireActual('../tools/safe-http'), safeDiscoveryHttp: jest.fn() }));

const MIB = 1024 * 1024;
const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
const storage = {
  loadPatterns: jest.fn(), createExecutionSession: jest.fn().mockResolvedValue(undefined),
  recordUsage: jest.fn().mockResolvedValue(undefined),
};
const context = { targetHost: 'public.example', targetPort: 443, scanResult: { services: [{ port: 443 }] } };
const http = jest.mocked(safeDiscoveryHttp);

function pattern(endpoints: string[]): DiscoveryPattern {
  return {
    id: 'pattern-1', patternId: 'web-service', name: 'Web service', version: '1.0.0',
    category: 'web', author: 'fixture', license: 'MIT', confidenceScore: 0.9,
    usageCount: 0, successCount: 0, failureCount: 0, status: 'draft', isActive: false,
    createdAt: new Date(), updatedAt: new Date(),
    detectionCode: JSON.stringify({ kind: 'detection-v1', ports: [443], headers: [], endpoints, serviceNames: [] }),
    discoveryCode: JSON.stringify({ kind: 'discovery-v1', name: 'Web service', category: 'web',
      serviceType: 'application', endpoints }),
    testCases: [],
  };
}

async function run(endpoints: string[]): Promise<any> {
  storage.loadPatterns.mockResolvedValue([pattern(endpoints)]);
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  const [ci] = await matcher.executePattern('web-service', context);
  return ci;
}

const paths = (count: number) => Array.from({ length: count }, (_, index) => `/e${index}`);

beforeEach(() => {
  jest.clearAllMocks();
  (getRedisClient as jest.Mock).mockReturnValue(redis);
  redis.get.mockReset().mockResolvedValue(null);
  (lookup as jest.Mock).mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});
afterEach(() => jest.restoreAllMocks());

describe('executeDiscovery budgets', () => {
  it('skips and records the endpoints left once the total byte budget is spent', async () => {
    http.mockResolvedValue({ status: 200, data: 'a'.repeat(MIB) } as never);
    const ci = await run(paths(64));
    const requested = DISCOVERY_PATTERN_MAX_TOTAL_BYTES / MIB;
    expect(http).toHaveBeenCalledTimes(requested);
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'bytes-budget', endpoints: paths(64).slice(requested) });
    expect(Object.keys(ci.metadata).filter(key => /^e\d+$/.test(key))).toHaveLength(requested);
  });

  it('clips each request to the bytes left and treats a cut at that limit as budget spent', async () => {
    http.mockImplementation((async (_url: string, options: { maxContentLength: number }) => {
      if (options.maxContentLength < DISCOVERY_HTTP_MAX_BYTES) throw new Error(DISCOVERY_RESPONSE_TOO_LARGE);
      return { status: 200, data: 'a'.repeat(DISCOVERY_HTTP_MAX_BYTES - 1) };
    }) as never);
    const ci = await run(paths(10));
    // 4 x (ceiling - 1) bytes spent leaves 4: the 5th request is clipped to 4 bytes and cut.
    const limits = http.mock.calls.map(call => (call[1] as { maxContentLength: number }).maxContentLength);
    expect(limits).toEqual([...Array(4).fill(DISCOVERY_HTTP_MAX_BYTES), 4]);
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'bytes-budget', endpoints: paths(10).slice(5) });
  });

  it('skips the remaining endpoints once the total time budget is spent, and clips request deadlines', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    http.mockImplementation((async () => { now += 12_000; return { status: 200, data: 'ok' }; }) as never);
    const ci = await run(paths(6));
    expect(http).toHaveBeenCalledTimes(3);
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'time-budget', endpoints: ['/e3', '/e4', '/e5'] });
    const totals = http.mock.calls.map(call => (call[1] as { totalMs: number }).totalMs);
    expect(totals).toEqual([DISCOVERY_PATTERN_MAX_TOTAL_MS, DISCOVERY_PATTERN_MAX_TOTAL_MS - 12_000,
      DISCOVERY_PATTERN_MAX_TOTAL_MS - 24_000]);
  });

  it('records nothing as skipped when every endpoint fits', async () => {
    http.mockResolvedValue({ status: 200, data: { healthy: true } } as never);
    const ci = await run(paths(3));
    expect(http).toHaveBeenCalledTimes(3);
    expect(ci.metadata).not.toHaveProperty(DISCOVERY_SKIPPED_KEY);
  });

  it('stores a truncated body whose JSON encoding fits the cap, and keeps small bodies untouched', async () => {
    const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const bodies: Record<string, unknown> = {
      '/big': 'é'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES),            // 2 bytes per character
      '/quotes': '"\n'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES),        // JSON escapes double the size
      '/obj': { rows: 'x'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES) },
      '/small': { small: true },
    };
    http.mockImplementation((async (url: string) => ({
      status: 200, data: bodies[new URL(url).pathname],
    })) as never);
    const ci = await run(Object.keys(bodies));
    for (const key of ['big', 'quotes', 'obj']) {
      expect(typeof ci.metadata[key]).toBe('string');
      expect(ci.metadata[key].endsWith(DISCOVERY_BODY_TRUNCATED)).toBe(true);
      expect(encoded(ci.metadata[key])).toBeLessThanOrEqual(DISCOVERY_STORED_BODY_MAX_BYTES);
    }
    expect(ci.metadata.quotes.length).toBeGreaterThan(DISCOVERY_BODY_TRUNCATED.length + 1000);
    expect(ci.metadata.small).toEqual({ small: true });
  });
});
