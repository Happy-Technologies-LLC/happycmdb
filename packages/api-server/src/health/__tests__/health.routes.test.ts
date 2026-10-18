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
