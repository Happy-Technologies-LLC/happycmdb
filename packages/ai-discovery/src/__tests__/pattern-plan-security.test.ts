// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { getRedisClient } from '@cmdb/database';
import { PatternMatcher } from '../pattern-matcher';
import { PatternCompiler } from '../pattern-compiler';
import { PatternValidator } from '../pattern-validator';
import { safeDiscoveryHttp } from '../tools/safe-http';
import { HybridDiscoveryOrchestrator } from '../hybrid-discovery-orchestrator';
import { UNSUPPORTED_PATTERN_PLAN } from '../pattern-plan';
import { PatternStorageService } from '../pattern-storage';
import type { DiscoveryPattern, AIDiscoverySession } from '../types';
import type { PatternAnalyzer, PatternCandidate } from '../pattern-analyzer';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('@cmdb/database', () => ({ getRedisClient: jest.fn(), getPostgresClient: jest.fn(() => ({})) }));
jest.mock('../tools/safe-http', () => ({ safeDiscoveryHttp: jest.fn() }));

const candidate: PatternCandidate = {
  suggestedName: 'Web service', suggestedCategory: 'web', readyForCompilation: true,
  signature: { signatureHash: 'hash', toolSequence: [], serviceIndicators: [],
    confidenceScore: 0.9, sessionCount: 1, sessions: ['one'] },
  commonElements: { ports: [443], headers: [], endpoints: ['/status'], serviceNames: [] },
};
const session = { aiModel: 'test-model', discoveredCIs: [] } as unknown as AIDiscoverySession;
const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };
const storage = {
  loadPatterns: jest.fn(), createExecutionSession: jest.fn().mockResolvedValue(undefined),
  recordUsage: jest.fn().mockResolvedValue(undefined),
};
const context = { targetHost: 'public.example', targetPort: 443,
  scanResult: { services: [{ port: 443, version: '1.2' }], http: { endpoints: ['/status'] } } };

beforeEach(() => {
  jest.clearAllMocks();
  (getRedisClient as jest.Mock).mockReturnValue(redis);
  redis.get.mockReset().mockResolvedValue(null);
  (lookup as jest.Mock).mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  (safeDiscoveryHttp as jest.Mock).mockResolvedValue({ status: 200, data: { healthy: true } });
});

afterEach(() => jest.restoreAllMocks());

it('compiles data-only plans and interprets detection and HTTP discovery', async () => {
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({ candidate }) };
  const compiler = new PatternCompiler(analyzer as unknown as PatternAnalyzer);
  const pattern = await compiler.compilePattern([session]);
  expect(await compiler.validatePattern(pattern)).toMatchObject({ isValid: true });
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

it('compiles and executes safe dotted endpoint paths without changing their target', async () => {
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({
    candidate: { ...candidate, commonElements: { ...candidate.commonElements,
      endpoints: ['/health.json', '/.well-known/status'] } },
  }) };
  const compiler = new PatternCompiler(analyzer as unknown as PatternAnalyzer);
  const sourceSession = { ...session, scanResult: {
    services: [{ port: 443 }], http: { endpoints: ['/health.json', '/.well-known/status'] },
  } };
  const pattern = await compiler.compilePattern([sourceSession]);
  expect(await compiler.validatePattern(pattern)).toMatchObject({ isValid: true });
  expect(await new PatternValidator().validate(pattern)).toMatchObject({ isValid: true });
  storage.loadPatterns.mockResolvedValue([pattern]);
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await matcher.loadPatterns();
  const cis = await matcher.executePattern(pattern.patternId, context);
  expect(cis).toMatchObject([{ metadata: {
    'health.json': { healthy: true }, '.well-known/status': { healthy: true },
  } }]);
  for (const path of ['/health.json', '/.well-known/status']) {
    expect(safeDiscoveryHttp).toHaveBeenCalledWith(`https://public.example:443${path}`,
      expect.objectContaining({ method: 'GET' }));
  }
});

it('rejects host-constructor escape payloads before execution, including legacy detection', async () => {
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({ candidate }) };
  const base = await new PatternCompiler(analyzer as unknown as PatternAnalyzer).compilePattern([session]);
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
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({ candidate }) };
  const base = await new PatternCompiler(analyzer as unknown as PatternAnalyzer).compilePattern([session]);
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
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({ candidate }) };
  const base = await new PatternCompiler(analyzer as unknown as PatternAnalyzer).compilePattern([session]);
  storage.loadPatterns.mockResolvedValue([{ ...base, detectionCode: `function detect() {
    return {matches:true,confidence:1}; }` }]);
  redis.get.mockResolvedValueOnce('null');
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await expect(matcher.match(context.scanResult)).rejects.toThrow(UNSUPPORTED_PATTERN_PLAN);
});

it('rejects active legacy discovery plans even when detection does not match', async () => {
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({ candidate }) };
  const base = await new PatternCompiler(analyzer as unknown as PatternAnalyzer).compilePattern([session]);
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

it('propagates a denied HTTP endpoint instead of returning a partial CI', async () => {
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({ candidate }) };
  const pattern = await new PatternCompiler(analyzer as unknown as PatternAnalyzer).compilePattern([session]);
  storage.loadPatterns.mockResolvedValue([pattern]);
  (safeDiscoveryHttp as jest.Mock).mockRejectedValue(new Error('Discovery target refused'));
  const matcher = new PatternMatcher(storage as unknown as PatternStorageService);
  await matcher.loadPatterns();
  await expect(matcher.executePattern(pattern.patternId, context)).rejects.toThrow('Discovery target refused');
});

it('refuses malformed endpoint plans and private targets without outbound HTTP', async () => {
  const analyzer = { analyzeSession: jest.fn().mockResolvedValue({ candidate }) };
  const base = await new PatternCompiler(analyzer as unknown as PatternAnalyzer).compilePattern([session]);
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
