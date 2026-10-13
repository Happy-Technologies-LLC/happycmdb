// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { getRedisClient } from '@cmdb/database';
import { PatternMatcher } from '../pattern-matcher';
import { PatternValidator } from '../pattern-validator';
import { safeDiscoveryHttp } from '../tools/safe-http';
import { HybridDiscoveryOrchestrator } from '../hybrid-discovery-orchestrator';
import { UNSUPPORTED_PATTERN_PLAN } from '../pattern-plan';
import { PatternStorageService } from '../pattern-storage';
import type { DiscoveryPattern } from '../types';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('@cmdb/database', () => ({ getRedisClient: jest.fn(), getPostgresClient: jest.fn(() => ({})) }));
jest.mock('../tools/safe-http', () => ({ safeDiscoveryHttp: jest.fn() }));

const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
const storage = {
  loadPatterns: jest.fn(), createExecutionSession: jest.fn().mockResolvedValue(undefined),
  recordUsage: jest.fn().mockResolvedValue(undefined),
};
const context = { targetHost: 'public.example', targetPort: 443,
  scanResult: { services: [{ port: 443, version: '1.2' }], http: { endpoints: ['/status'] } } };

function validPattern(endpoints: string[] = ['/status']): DiscoveryPattern {
  return {
    id: 'pattern-1', patternId: 'web-service', name: 'Web service', version: '1.0.0',
    category: 'web', author: 'fixture', license: 'MIT', confidenceScore: 0.9,
    usageCount: 0, successCount: 0, failureCount: 0, status: 'draft', isActive: false,
    createdAt: new Date(), updatedAt: new Date(),
    detectionCode: JSON.stringify({
      kind: 'detection-v1', ports: [443], headers: [], endpoints, serviceNames: [],
    }),
    discoveryCode: JSON.stringify({
      kind: 'discovery-v1', name: 'Web service', category: 'web',
      serviceType: 'application', endpoints,
    }),
    testCases: [{
      name: 'Detection test',
      input: { services: [{ port: 443 }], http: { endpoints } },
      expected: { matches: true, confidenceMin: 0.5 },
    }],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getRedisClient as jest.Mock).mockReturnValue(redis);
  redis.get.mockReset().mockResolvedValue(null);
  redis.setex.mockReset().mockResolvedValue('OK');
  (lookup as jest.Mock).mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  (safeDiscoveryHttp as jest.Mock).mockResolvedValue({ status: 200, data: { healthy: true } });
});

afterEach(() => jest.restoreAllMocks());

it('accepts data-only plans and interprets detection and HTTP discovery', async () => {
  const pattern = validPattern();
  expect(await new PatternValidator().validate(pattern)).toMatchObject({ isValid: true });
  storage.loadPatterns.mockResolvedValue([pattern]);
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  const match = await matcher.match(context.scanResult);
  expect(match).toMatchObject({ patternId: pattern.patternId, confidence: 0.8 });
  const cis = await matcher.executePattern(pattern.patternId, context);
  expect(cis).toMatchObject([{ hostname: 'public.example', port: 443,
    metadata: { version: '1.2', status: { healthy: true } } }]);
  expect(safeDiscoveryHttp).toHaveBeenCalledWith('https://public.example:443/status',
    expect.objectContaining({ method: 'GET' }));
});

it('accepts and executes safe dotted endpoint paths without changing their target', async () => {
  const endpoints = ['/health.json', '/.well-known/status'];
  const sourceSession = { scanResult: {
    services: [{ port: 443 }], http: { endpoints },
  } };
  const pattern = validPattern(endpoints);
  expect(await new PatternValidator().validate(pattern)).toMatchObject({ isValid: true });
  storage.loadPatterns.mockResolvedValue([pattern]);
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  const match = await matcher.match(sourceSession.scanResult);
  expect(match).toMatchObject({ patternId: pattern.patternId, confidence: 0.8 });
  const cis = await matcher.executePattern(pattern.patternId, context, match!.activeSetHash);
  expect(cis).toMatchObject([{ metadata: {
    'health.json': { healthy: true }, '.well-known/status': { healthy: true },
  } }]);
  for (const path of ['/health.json', '/.well-known/status']) {
    expect(safeDiscoveryHttp).toHaveBeenCalledWith(`https://public.example:443${path}`,
      expect.objectContaining({ method: 'GET' }));
  }
});

it('rejects host-constructor escape payloads before execution, including legacy detection', async () => {
  const base = validPattern();
  const malicious = { ...base,
    detectionCode: `function detect() { console.constructor('return process')(); return {matches:true,confidence:1}; }`,
    discoveryCode: `async function discover() { fetch.constructor('return process')(); return []; }`,
  } as DiscoveryPattern;
  storage.loadPatterns.mockResolvedValue([malicious]);
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  expect((await new PatternValidator().quickValidate(malicious)).errors).toContain(UNSUPPORTED_PATTERN_PLAN);
  await expect(matcher.match(context.scanResult)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
  await expect(matcher.executePattern(malicious.patternId, context)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
  expect(safeDiscoveryHttp).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
});

it('refuses legacy discovery even with a valid detection plan; hybrid exposes the refusal', async () => {
  const base = validPattern();
  const malicious = { ...base,
    discoveryCode: `async function discover() { fetch.constructor('return process')(); return []; }`,
  } as DiscoveryPattern;
  storage.loadPatterns.mockResolvedValue([malicious]);
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await matcher.loadPatterns();
  await expect(matcher.executePattern(malicious.patternId, context)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
  jest.spyOn(PatternStorageService.prototype, 'loadPatterns').mockResolvedValue([malicious]);
  jest.spyOn(PatternStorageService.prototype, 'createExecutionSession').mockResolvedValue(undefined);
  jest.spyOn(PatternStorageService.prototype, 'recordUsage').mockResolvedValue(undefined);
  const hybrid = new HybridDiscoveryOrchestrator({ aiEnabled: false });
  const result = await hybrid.discover(context);
  expect(result).toMatchObject({ success: false, error: UNSUPPORTED_PATTERN_PLAN });
  expect(safeDiscoveryHttp).not.toHaveBeenCalled();
});

it('rejects legacy active plans before returning a stale cached negative match', async () => {
  const base = validPattern();
  storage.loadPatterns.mockResolvedValue([{ ...base, detectionCode: `function detect() {
    return {matches:true,confidence:1}; }` }]);
  redis.get.mockResolvedValueOnce('null');
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await expect(matcher.match(context.scanResult)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
});

it('rejects active legacy discovery plans even when detection does not match', async () => {
  const base = validPattern();
  const malformed = { ...base,
    discoveryCode: `async function discover() { fetch.constructor('return process')(); return []; }`,
  };
  storage.loadPatterns.mockResolvedValue([malformed]);
  const unmatched = { services: [{ port: 80 }], http: { endpoints: [] } };
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await expect(matcher.match(unmatched)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
  jest.spyOn(PatternStorageService.prototype, 'loadPatterns').mockResolvedValue([malformed]);
  const hybrid = new HybridDiscoveryOrchestrator({ aiEnabled: false });
  expect(await hybrid.discover({ ...context, scanResult: unmatched }))
    .toMatchObject({ success: false, error: UNSUPPORTED_PATTERN_PLAN });
  expect(safeDiscoveryHttp).not.toHaveBeenCalled();
});

it('refreshes active plans after a cached negative when storage changes to legacy code', async () => {
  const base = validPattern();
  let active: DiscoveryPattern[] = [base];
  storage.loadPatterns.mockImplementation(async () => active);
  const cached = new Map<string, string>();
  redis.get.mockImplementation(async (key: string) => cached.get(key) || null);
  redis.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
    cached.set(key, value);
    return 'OK';
  });
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  expect(await matcher.match({ services: [{ port: 80 }], http: { endpoints: [] } })).toBeNull();
  active = [{ ...base, discoveryCode: `async function discover() {
    fetch.constructor('return process')(); return []; }` }];
  await expect(matcher.match({ services: [{ port: 80 }], http: { endpoints: [] } }))
    .rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
  await expect(matcher.executePattern(base.patternId, context)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
  expect(safeDiscoveryHttp).not.toHaveBeenCalled();
});

it('invalidates cached positives on plan edits and refuses a subsequently deactivated pattern', async () => {
  const base = validPattern();
  let active: DiscoveryPattern[] = [base];
  storage.loadPatterns.mockImplementation(async () => active);
  const cached = new Map<string, string>();
  redis.get.mockImplementation(async (key: string) => cached.get(key) || null);
  redis.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
    cached.set(key, value);
    return 'OK';
  });
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  const originalMatch = await matcher.match(context.scanResult);
  expect(originalMatch).toMatchObject({ patternId: base.patternId });
  active = [{ ...base, detectionCode: JSON.stringify({ ...JSON.parse(base.detectionCode),
    ports: [80], endpoints: [] }) }];
  await expect(matcher.executePattern(base.patternId, context, originalMatch!.activeSetHash))
    .rejects.toThrow('PATTERN_NOT_ACTIVE');
  expect(await matcher.match(context.scanResult)).toBeNull();
  active = [];
  await expect(matcher.executePattern(base.patternId, context)).rejects.toThrow('PATTERN_NOT_ACTIVE');
  expect(safeDiscoveryHttp).not.toHaveBeenCalled();
});

it('does not fall back to AI when the active plan list cannot be verified', async () => {
  jest.spyOn(PatternStorageService.prototype, 'loadPatterns').mockRejectedValue(new Error('storage unavailable'));
  const hybrid = new HybridDiscoveryOrchestrator({ aiEnabled: false });
  expect(await hybrid.discover(context))
    .toMatchObject({ success: false, error: 'PATTERN_STATE_UNAVAILABLE' });
  expect(safeDiscoveryHttp).not.toHaveBeenCalled();
});

it('propagates a denied HTTP endpoint instead of returning a partial CI', async () => {
  const pattern = validPattern();
  storage.loadPatterns.mockResolvedValue([pattern]);
  (safeDiscoveryHttp as jest.Mock).mockRejectedValue(new Error('Discovery target refused'));
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await matcher.loadPatterns();
  await expect(matcher.executePattern(pattern.patternId, context)).rejects.toThrow('Discovery target refused');
});

it('refuses malformed endpoint plans and private targets without outbound HTTP', async () => {
  const base = validPattern();
  const malicious = { ...base, discoveryCode: JSON.stringify({ ...JSON.parse(base.discoveryCode),
    endpoints: ['//169.254.169.254/latest'] }) } as DiscoveryPattern;
  storage.loadPatterns.mockResolvedValue([malicious]);
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await matcher.loadPatterns();
  await expect(matcher.executePattern(malicious.patternId, context)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
  storage.loadPatterns.mockResolvedValue([base]);
  const publicMatcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await publicMatcher.loadPatterns();
  await expect(publicMatcher.executePattern(base.patternId, { ...context, targetHost: '127.0.0.1' }))
    .rejects.toThrow('Discovery target refused');
  expect(safeDiscoveryHttp).not.toHaveBeenCalled();
});
