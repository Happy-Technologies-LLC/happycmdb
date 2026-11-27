// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { assertPlanRepresentable, enc, PLAN_LIMITS } from '../../../database/src/journal/encoding';
import { getRedisClient } from '@cmdb/database';
import {
  DISCOVERY_BODY_TRUNCATED, DISCOVERY_PATTERN_MAX_TOTAL_BYTES, DISCOVERY_PATTERN_MAX_TOTAL_MS,
  DISCOVERY_SKIPPED_KEY, DISCOVERY_STORED_BODY_MAX_BYTES, DISCOVERY_STORED_MAX_DEPTH,
  DISCOVERY_STORED_METADATA_MAX_BYTES, DISCOVERY_UNSTORED_KEY, PatternMatcher,
} from '../pattern-matcher';
import {
  DISCOVERY_HTTP_MAX_BYTES, DISCOVERY_RESPONSE_DEADLINE, DISCOVERY_RESPONSE_TOO_LARGE, DiscoveryHttpError, safeDiscoveryHttp,
} from '../tools/safe-http';
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
/** A transport result: the mock reports decodedBytes the way the transport does (the serialized size of the fixture). */
const reply = (data: unknown) => ({
  status: 200, data, decodedBytes: Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data)),
});

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
    http.mockResolvedValue(reply('a'.repeat(MIB)) as never);
    const ci = await run(paths(64));
    const requested = DISCOVERY_PATTERN_MAX_TOTAL_BYTES / MIB;
    expect(http).toHaveBeenCalledTimes(requested);
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'bytes-budget', endpoints: paths(64).slice(requested) });
    expect(Object.keys(ci.metadata).filter(key => /^e\d+$/.test(key))).toHaveLength(requested);
  });

  it('clips each request to the bytes left and treats a cut at that limit as budget spent', async () => {
    // Every body is one byte under the ceiling: a transport cuts it only when the request's limit is lower.
    http.mockImplementation((async (_url: string, options: { maxContentLength: number }) => {
      if (DISCOVERY_HTTP_MAX_BYTES - 1 > options.maxContentLength) throw new Error(DISCOVERY_RESPONSE_TOO_LARGE);
      return reply('a'.repeat(DISCOVERY_HTTP_MAX_BYTES - 1));
    }) as never);
    const ci = await run(paths(10));
    // 4 x (ceiling - 1) bytes spent leaves 4: the 5th request is clipped to 4 bytes and cut.
    const limits = http.mock.calls.map(call => (call[1] as { maxContentLength: number }).maxContentLength);
    expect(limits).toEqual([...Array(4).fill(DISCOVERY_HTTP_MAX_BYTES), 4]);
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'bytes-budget', endpoints: paths(10).slice(5) });
  });

  it('counts every response cut at the per-request ceiling against the total byte budget', async () => {
    // Each endpoint is larger than the ceiling, so it is cut at the ceiling with the full budget left.
    http.mockImplementation((async (_url: string, options: { maxContentLength: number }) => {
      if (2 * MIB > options.maxContentLength) throw new Error(DISCOVERY_RESPONSE_TOO_LARGE);
      return reply('a'.repeat(2 * MIB));
    }) as never);
    const ci = await run(paths(64));
    const requested = DISCOVERY_PATTERN_MAX_TOTAL_BYTES / DISCOVERY_HTTP_MAX_BYTES;
    expect(http).toHaveBeenCalledTimes(requested);
    expect(http.mock.calls.map(call => (call[1] as { maxContentLength: number }).maxContentLength))
      .toEqual(Array(requested).fill(DISCOVERY_HTTP_MAX_BYTES));
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'bytes-budget', endpoints: paths(64).slice(requested) });
  });

  describe('a request that fails without a decoded-byte count', () => {
    const limits = () => http.mock.calls.map(call => (call[1] as { maxContentLength: number }).maxContentLength);
    const requested = DISCOVERY_PATTERN_MAX_TOTAL_BYTES / DISCOVERY_HTTP_MAX_BYTES;

    it.each(['ECONNRESET', 'ECONNABORTED', undefined])('spends the limit it was requested with (%s)', async code => {
      http.mockRejectedValue(new DiscoveryHttpError(code));
      const ci = await run(paths(64));
      expect(limits()).toEqual(Array(requested).fill(DISCOVERY_HTTP_MAX_BYTES));
      expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'bytes-budget', endpoints: paths(64).slice(requested) });
    });

    it('spends the limit on a deadline that may have cut a body', async () => {
      http.mockRejectedValue(new Error(DISCOVERY_RESPONSE_DEADLINE));
      const ci = await run(paths(64));
      expect(limits()).toEqual(Array(requested).fill(DISCOVERY_HTTP_MAX_BYTES));
      expect(ci.metadata[DISCOVERY_SKIPPED_KEY].reason).toBe('bytes-budget');
    });

    it.each(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'])(
      'is free when %s: no body can have arrived', async code => {
        http.mockRejectedValue(new DiscoveryHttpError(code));
        const ci = await run(paths(64));
        expect(http).toHaveBeenCalledTimes(64);
        expect(ci.metadata).not.toHaveProperty(DISCOVERY_SKIPPED_KEY);
      });
  });

  it('skips the remaining endpoints once the total time budget is spent, and clips request deadlines', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    http.mockImplementation((async () => { now += 12_000; return reply('ok'); }) as never);
    const ci = await run(paths(6));
    expect(http).toHaveBeenCalledTimes(3);
    expect(ci.metadata[DISCOVERY_SKIPPED_KEY]).toEqual({ reason: 'time-budget', endpoints: ['/e3', '/e4', '/e5'] });
    const totals = http.mock.calls.map(call => (call[1] as { totalMs: number }).totalMs);
    expect(totals).toEqual([DISCOVERY_PATTERN_MAX_TOTAL_MS, DISCOVERY_PATTERN_MAX_TOTAL_MS - 12_000,
      DISCOVERY_PATTERN_MAX_TOTAL_MS - 24_000]);
  });

  it('lists a body too deeply nested to re-serialize as unstored instead of dropping it silently', async () => {
    // JSON.parse accepts this depth; JSON.stringify of the result overflows the stack.
    let deep: unknown[] = [];
    for (let level = 0; level < 300_000; level++) deep = [deep];
    http.mockImplementation((async (url: string) => new URL(url).pathname === '/deep'
      ? { status: 200, data: deep, decodedBytes: 600_000 } : reply({ ok: true })) as never);
    const ci = await run(['/deep', '/ok']);
    expect(ci.metadata).not.toHaveProperty('deep');
    expect(ci.metadata.ok).toEqual({ ok: true });
    expect(ci.metadata[DISCOVERY_UNSTORED_KEY]).toEqual({ reason: 'metadata-budget', endpoints: ['/deep'] });
  });

  it('records nothing as skipped when every endpoint fits', async () => {
    http.mockResolvedValue(reply({ healthy: true }) as never);
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
    http.mockImplementation((async (url: string) => reply(bodies[new URL(url).pathname])) as never);
    const ci = await run(Object.keys(bodies));
    for (const key of ['big', 'quotes', 'obj']) {
      expect(typeof ci.metadata[key]).toBe('string');
      expect(ci.metadata[key].endsWith(DISCOVERY_BODY_TRUNCATED)).toBe(true);
      expect(encoded(ci.metadata[key])).toBeLessThanOrEqual(DISCOVERY_STORED_BODY_MAX_BYTES);
    }
    expect(ci.metadata.quotes.length).toBeGreaterThan(DISCOVERY_BODY_TRUNCATED.length + 1000);
    expect(ci.metadata.small).toEqual({ small: true });
  });

  describe('stored metadata stays journal-representable', () => {
    /** The create plan `Neo4jClient.createCI` derives: metadata is one JSON-string leaf, carried again in the audit change. */
    const createPlan = (ci: any) => {
      const props = { name: ci.name, type: ci._type, metadata: JSON.stringify(ci.metadata) };
      return {
        graph: { kind: 'create', label: 'application', params: enc({ id: 'ci-1', props }) },
        audit: { action: 'CREATE', changes: enc([{ field: 'metadata', old_value: null, new_value: props.metadata }]) },
      };
    };
    const longPaths = (count: number) => Array.from({ length: count }, (_, i) => `/${'p'.repeat(240)}${i}`);
    const leaf = (ci: any) => Buffer.byteLength(JSON.stringify(JSON.stringify(ci.metadata)));

    it('64 endpoints each returning a cap-sized body make a plan the journal accepts', async () => {
      // Varied bodies; the escaping-heavy ones expand the most when the metadata is re-encoded as a leaf.
      http.mockImplementation((async (url: string) => {
        const index = Number(new URL(url).pathname.slice(-2).replace(/\D/g, ''));
        const data = [
          'x'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES),
          '"\n'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES),
          { rows: '\\"'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES) },
          'é'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES),
        ][index % 4];
        return reply(data);
      }) as never);
      const ci = await run(longPaths(64));
      expect(() => assertPlanRepresentable(createPlan(ci) as never)).not.toThrow();
      expect(leaf(ci)).toBeLessThanOrEqual(DISCOVERY_STORED_METADATA_MAX_BYTES);
      expect(leaf(ci)).toBeLessThan(PLAN_LIMITS.valueBytes);
      // Later endpoints did not fit: they are named, not silently dropped.
      const stored = Object.keys(ci.metadata).filter(key => key.startsWith('p'));
      expect(stored.length).toBeGreaterThan(0);
      expect(ci.metadata[DISCOVERY_UNSTORED_KEY].reason).toBe('metadata-budget');
      const unstored: string[] = ci.metadata[DISCOVERY_UNSTORED_KEY].endpoints;
      expect(unstored.length).toBeGreaterThan(0);
      expect(stored.length + unstored.length).toBe(64);
      for (const endpoint of unstored) expect(ci.metadata).not.toHaveProperty(endpoint.slice(1));
    });

    it('truncates one body to the room left, then names the endpoints that no longer fit', async () => {
      http.mockImplementation((async () => reply('y'.repeat(DISCOVERY_STORED_BODY_MAX_BYTES))) as never);
      const ci = await run(paths(12));
      const keys = paths(12).map(path => path.slice(1));
      const full = ci.metadata.e0.length;
      const stored = keys.filter(key => key in ci.metadata);
      const partial = stored.filter(key => ci.metadata[key].length < full);
      expect(partial).toEqual([stored[stored.length - 1]]);
      expect(ci.metadata[partial[0]].endsWith(DISCOVERY_BODY_TRUNCATED)).toBe(true);
      expect(ci.metadata[DISCOVERY_UNSTORED_KEY].endpoints).toEqual(paths(12).slice(stored.length));
      expect(leaf(ci)).toBeLessThanOrEqual(DISCOVERY_STORED_METADATA_MAX_BYTES);
    });

    it('stores a body nested past the depth cap as text, keeping a shallow one as structure', async () => {
      const nest = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>(inner => ({ a: inner }), 1);
      const depthOf = (value: unknown): number => value !== null && typeof value === 'object'
        ? 1 + Math.max(0, ...Object.values(value).map(depthOf)) : 0;
      const bodies: Record<string, unknown> = {
        '/deep': nest(DISCOVERY_STORED_MAX_DEPTH + 1),
        '/edge': nest(DISCOVERY_STORED_MAX_DEPTH),
        '/gone': nest(200),
      };
      http.mockImplementation((async (url: string) => reply(bodies[new URL(url).pathname])) as never);
      const ci = await run(Object.keys(bodies));
      expect(typeof ci.metadata.deep).toBe('string');
      expect(JSON.parse(ci.metadata.deep)).toEqual(bodies['/deep']);
      expect(depthOf(ci.metadata.edge)).toBe(DISCOVERY_STORED_MAX_DEPTH);
      expect(typeof ci.metadata.gone).toBe('string');
      expect(() => assertPlanRepresentable(createPlan(ci) as never)).not.toThrow();
    });
  });
});
