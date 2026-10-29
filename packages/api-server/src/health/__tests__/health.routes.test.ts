// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../auth/auth.service';
import type { ConfigSchema } from '@cmdb/common';
import { AuthMiddleware } from '../../middleware/auth.middleware';

const secret = 'internal-db:7687 password=private';
const mockRun = jest.fn<Promise<unknown>, [string]>();
const mockClose = jest.fn(async () => undefined);
const mockGetSession = jest.fn(() => ({ run: mockRun, close: mockClose }));
const mockGet = jest.fn<Promise<string | null>, [string]>();
const mockSet = jest.fn<Promise<unknown>, [string, string, number]>();
const mockPostgresQuery = jest.fn<Promise<{ rows: unknown[] }>, [string]>();

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: mockGetSession }),
  getPostgresClient: () => ({ query: mockPostgresQuery }),
  getRedisClient: () => ({ get: mockGet, set: mockSet }),
}));

jest.mock('../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => new AuthMiddleware({
    verifyToken: async (token: string) => {
      if (token !== 'valid') throw new Error('Invalid credential');
      return { _userId: 'user', _role: 'operator', _organizationId: '11111111-1111-4111-8111-111111111111' };
    },
  } as unknown as AuthService, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']),
}));

import healthRoutes from '../health.routes';

const app = express();
// Same order as RestAPIServer: health mounts above the shared /api/v1 auth gate.
app.use('/api/v1/cmdb-health', healthRoutes);
const path = '/api/v1/cmdb-health';
const authorized = () => request(app).get(`${path}/services`).set('authorization', 'Bearer valid');
let now = 100_000;

beforeEach(() => {
  now += 10000; // Expire the router singleton's cache between cases.
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockRun.mockResolvedValue({ records: [{ test: 1 }] });
  mockGetSession.mockImplementation(() => ({ run: mockRun, close: mockClose }));
  mockGet.mockImplementation(async key => key === '__health_check__' || key === '__readiness_check__' ? 'test' : 'ok');
  mockSet.mockResolvedValue(undefined);
  mockPostgresQuery.mockResolvedValue({ rows: [{ test: 1 }] });
});
afterEach(() => jest.restoreAllMocks());

test('anonymous services are refused before any probe, while public probes remain reachable', async () => {
  const response = await request(app).get(`${path}/services`);
  expect(response.status).toBe(401);
  expect(mockGetSession).not.toHaveBeenCalled();
  expect(mockSet).not.toHaveBeenCalled();
  expect(mockGet).not.toHaveBeenCalled();
  expect((await request(app).get(`${path}/alive`)).status).toBe(200);
  expect((await request(app).get(`${path}/ready`)).status).toBe(200);
  expect((await request(app).get(path)).status).toBe(200);
});

test('authorized concurrent and burst requests share a probe; expiry starts one fresh probe', async () => {
  const { promise: driverResult, resolve: finish } = Promise.withResolvers<unknown>();
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  mockRun.mockImplementationOnce(() => { signalStarted(); return driverResult; });
  const first = authorized();
  const second = authorized();
  const pending = Promise.all([first, second]);
  await started;
  expect(mockRun).toHaveBeenCalledTimes(1);
  finish({ records: [{ test: 1 }] });
  const [a, b] = await pending;
  expect(a.status).toBe(200);
  expect(b.body).toEqual(a.body);
  expect(a.body).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'Neo4j', status: 'healthy' }), expect.objectContaining({ service: 'Redis', status: 'healthy' })]));
  expect(mockClose).toHaveBeenCalledTimes(1);
  await authorized();
  now += 4999;
  await authorized();
  expect(mockRun).toHaveBeenCalledTimes(1);
  expect(mockSet).toHaveBeenCalledTimes(1);
  now += 1;
  const expired = await authorized();
  expect(expired.status).toBe(200);
  expect(mockRun).toHaveBeenCalledTimes(2);
  expect(mockSet).toHaveBeenCalledTimes(2);
});

test('failed probes close the session, return only safe status, and remain bounded until expiry', async () => {
  const { promise: failure, reject: fail } = Promise.withResolvers<unknown>();
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  mockRun.mockImplementationOnce(() => { signalStarted(); return failure; });
  mockRun.mockRejectedValue(new Error(secret));
  mockSet.mockRejectedValue(new Error(secret));
  const pending = Promise.all([authorized(), authorized()]);
  await started;
  fail(new Error(secret));
  const [first, concurrent] = await pending;
  expect(concurrent.body).toEqual(first.body);
  expect(first.body).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'Neo4j', status: 'down' }), expect.objectContaining({ service: 'Redis', status: 'down' })]));
  expect(JSON.stringify(first.body)).not.toContain(secret);
  expect(mockClose).toHaveBeenCalledTimes(1);
  const burst = await Promise.all([authorized(), authorized()]);
  expect(burst.every(response => response.status === 200)).toBe(true);
  expect(mockRun).toHaveBeenCalledTimes(1);
  expect(mockSet).toHaveBeenCalledTimes(1);
  now += 5000;
  await authorized();
  expect(mockRun).toHaveBeenCalledTimes(2);
  expect(mockClose).toHaveBeenCalledTimes(2);
});

const UNPROBED = ['PostgreSQL', 'Discovery Engine', 'ETL Processor'];

test('HAP-772: unprobed components report unknown, with no latency and no new I/O', async () => {
  const response = await authorized();
  expect(response.status).toBe(200);
  expect(response.body.map((row: { service: string }) => row.service)).toEqual(['Neo4j', 'Redis', ...UNPROBED]);
  for (const row of response.body.slice(0, 2)) expect(row).toEqual(expect.objectContaining({ status: 'healthy', response_time_ms: expect.any(Number) }));
  for (const [index, service] of UNPROBED.entries()) {
    const row = response.body[index + 2];
    expect(row).toEqual({ service, status: 'unknown', last_check: expect.any(String) });
    expect(new Date(row.last_check).toISOString()).toBe(row.last_check);
  }
  expect(mockPostgresQuery).not.toHaveBeenCalled();
});

test('HAP-772: when every probe fails, no component reports healthy', async () => {
  mockRun.mockRejectedValue(new Error(secret));
  mockSet.mockRejectedValue(new Error(secret));
  const response = await authorized();
  const statuses: string[] = response.body.map((row: { status: string }) => row.status);
  expect(statuses).not.toContain('healthy');
  expect([...statuses].sort()).toEqual(['down', 'down', 'unknown', 'unknown', 'unknown']);
});

test('unresolved Redis work times out without amplifying probes, then recovers after release', async () => {
  jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate'] });
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  mockSet.mockImplementationOnce(() => { signalStarted(); return held; });
  const first = authorized();
  const firstResponse = first.then(response => response);
  try {
    await started;
    await jest.advanceTimersByTimeAsync(2000);
    const timedOut = await firstResponse;
    expect(timedOut.status).toBe(200);
    expect(timedOut.body).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'Redis', status: 'down' })]));
    now += 5000;
    const next = await authorized();
    expect(next.status).toBe(200);
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(mockSet).toHaveBeenCalledTimes(1); // The original Redis operation is still pending.
    release();
    await Promise.resolve();
    expect((await authorized()).body).toEqual(next.body); // Old completion cannot overwrite cache.
    now += 5000;
    const recovered = await authorized();
    expect(recovered.body).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'Redis', status: 'healthy' })]));
    expect(mockSet).toHaveBeenCalledTimes(2);
  } finally {
    release();
    jest.useRealTimers();
  }
});

test.each(['run', 'close'] as const)('unresolved Neo4j %s is bounded and session is not duplicated', async step => {
  jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate'] });
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  if (step === 'run') mockRun.mockImplementationOnce(() => { signalStarted(); return held; });
  else mockClose.mockImplementationOnce(() => { signalStarted(); return held; });
  const first = authorized();
  const firstResponse = first.then(response => response);
  try {
    await started;
    expect(mockRun).toHaveBeenCalledWith('RETURN 1', {}, { timeout: 2000 });
    await jest.advanceTimersByTimeAsync(2000);
    const timedOut = await firstResponse;
    expect(timedOut.status).toBe(200);
    expect(timedOut.body).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'Neo4j', status: 'down' })]));
    now += 5000;
    const next = await authorized();
    expect(next.status).toBe(200);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    expect((await authorized()).body).toEqual(next.body);
    now += 5000;
    const recovered = await authorized();
    expect(recovered.body).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'Neo4j', status: 'healthy' })]));
    expect(mockGetSession).toHaveBeenCalledTimes(2);
  } finally {
    release();
    jest.useRealTimers();
  }
});

test('public health and readiness never echo injected dependency errors', async () => {
  mockRun.mockRejectedValue(new Error(secret));
  mockPostgresQuery.mockRejectedValue(new Error(secret));
  mockSet.mockRejectedValue(new Error(secret));
  for (const suffix of ['', '/ready', '/alive']) {
    const response = await request(app).get(`${path}${suffix}`);
    expect([200, 503]).toContain(response.status);
    expect(response.text).not.toContain(secret);
  }
});

test('public root and readiness share one probe burst and five-second completion TTL', async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<unknown>();
  const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
  mockPostgresQuery.mockImplementationOnce(() => { signalStarted(); return held as Promise<{ rows: unknown[] }>; });
  const burst = Promise.all(Array.from({ length: 12 }, (_, index) =>
    request(app).get(index % 2 ? `${path}/ready` : path)));
  await started;
  expect(mockPostgresQuery).toHaveBeenCalledTimes(1);
  expect(mockGetSession).toHaveBeenCalledTimes(1);
  expect(mockSet).toHaveBeenCalledTimes(1);
  release({ rows: [{ test: 1 }] });
  const responses = await burst;
  expect(responses.every(response => response.status === 200)).toBe(true);
  for (const response of responses) {
    expect(response.body).toEqual(response.req.path.endsWith('/ready') ? { _ready: true } : { _status: 'healthy' });
  }
  await request(app).get(path);
  now += 4999;
  await request(app).get(`${path}/ready`);
  expect(mockPostgresQuery).toHaveBeenCalledTimes(1);
  now += 1;
  await request(app).get(path);
  expect(mockPostgresQuery).toHaveBeenCalledTimes(2);
  expect(mockGetSession).toHaveBeenCalledTimes(2);
  expect(mockSet).toHaveBeenCalledTimes(2);
});

test('public failures are cached, sanitized and preserve mounted deploy probe status', async () => {
  mockRun.mockRejectedValue(new Error(secret));
  mockPostgresQuery.mockRejectedValue(new Error(secret));
  mockSet.mockRejectedValue(new Error(secret));
  for (const [suffix, status, body] of [
    ['', 503, { _status: 'unhealthy' }],
    ['/ready', 503, { _ready: false }],
    ['/alive', 200, { _alive: true }],
  ] as const) {
    const response = await request(app).get(`${path}${suffix}`);
    expect(response.status).toBe(status);
    expect(response.body).toEqual(body);
    expect(response.text).not.toContain(secret);
  }
  expect(mockGetSession).toHaveBeenCalledTimes(1);
  expect(mockPostgresQuery).toHaveBeenCalledTimes(1);
  expect(mockSet).toHaveBeenCalledTimes(1);
  now += 5000;
  mockRun.mockResolvedValue({ records: [{ test: 1 }] });
  mockPostgresQuery.mockResolvedValue({ rows: [{ test: 1 }] });
  mockSet.mockResolvedValue(undefined);
  expect((await request(app).get(`${path}/ready`)).body).toEqual({ _ready: true });
  // Credentials do not turn the public path into a diagnostic endpoint.
  expect((await request(app).get(path).set('authorization', 'Bearer valid')).body).toEqual({ _status: 'healthy' });
});

test.each(['run', 'close', 'postgres', 'redis-set', 'redis-get'] as const)(
  'public unresolved %s operation has a bounded deadline and cannot multiply after expiry', async step => {
    jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate'] });
    const { promise: held, resolve: release } = Promise.withResolvers<any>();
    const { promise: started, resolve: signalStarted } = Promise.withResolvers<void>();
    if (step === 'run') mockRun.mockImplementationOnce(() => { signalStarted(); return held; });
    if (step === 'close') mockClose.mockImplementationOnce(() => { signalStarted(); return held; });
    if (step === 'postgres') mockPostgresQuery.mockImplementationOnce(() => { signalStarted(); return held; });
    if (step === 'redis-set') mockSet.mockImplementationOnce(() => { signalStarted(); return held; });
    if (step === 'redis-get') mockGet.mockImplementationOnce(() => { signalStarted(); return held; });
    const first = request(app).get(path).then(response => response);
    try {
      await started;
      await jest.advanceTimersByTimeAsync(2000);
      expect((await first).body).toEqual({ _status: 'unhealthy' });
      const counts = [mockGetSession.mock.calls.length, mockPostgresQuery.mock.calls.length, mockSet.mock.calls.length, mockGet.mock.calls.length];
      now += 5000;
      const burst = await Promise.all(Array.from({ length: 8 }, () => request(app).get(`${path}/ready`)));
      expect(burst.every(response => response.status === 503 && response.body._ready === false)).toBe(true);
      const later = [mockGetSession.mock.calls.length, mockPostgresQuery.mock.calls.length, mockSet.mock.calls.length, mockGet.mock.calls.length];
      const heldIndex = step === 'run' || step === 'close' ? 0 : step === 'postgres' ? 1 : step === 'redis-set' ? 2 : 3;
      expect(later[heldIndex]).toBe(counts[heldIndex]);
      release(step === 'postgres' ? { rows: [{ test: 1 }] } : step === 'run' ? { records: [{ test: 1 }] } : step === 'redis-get' ? 'test' : undefined);
      await Promise.resolve();
      expect((await request(app).get(`${path}/ready`)).body).toEqual({ _ready: false });
      now += 5000;
      expect((await request(app).get(`${path}/ready`)).body).toEqual({ _ready: true });
      expect((step === 'run' || step === 'close' ? mockGetSession : step === 'postgres' ? mockPostgresQuery : step === 'redis-set' ? mockSet : mockGet).mock.calls.length).toBe(counts[heldIndex] + 1);
    } finally {
      release(undefined);
      jest.useRealTimers();
    }
  }
);
