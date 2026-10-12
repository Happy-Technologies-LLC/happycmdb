// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Real route authorization and public architecture error boundary, with in-memory dependencies. */
import express from 'express';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const ORG = '11111111-1111-4111-8111-111111111111';
const getCI = jest.fn(async () => ({ id: 'ci-1' }));
const analyzeArchitecture = jest.fn(async (): Promise<never> => {
  throw new Error('driver internal secret');
});
const analyzeBusinessService = jest.fn(async (): Promise<never> => {
  throw new Error('driver internal secret');
});

jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../../middleware/auth.middleware'
  );
  const verifier = { verifyToken: async (token: string) => {
    if (token !== 'viewer' && !token.startsWith('operator')) throw new Error('Invalid token');
    return { _userId: token, _username: token, _role: token === 'viewer' ? 'viewer' : 'operator', _organizationId: ORG, _type: 'access' };
  } } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => ({ getCI }) }));
jest.mock('@cmdb/ai-ml-engine', () => ({
  ...jest.requireActual('@cmdb/ai-ml-engine'),
  getArchitectureOptimizationEngine: () => ({ analyzeArchitecture, analyzeBusinessService }),
}));

import { architectureRemainingMs } from '@cmdb/ai-ml-engine';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { architectureRoutes } from '../architecture.routes';

const app = express();
app.use(express.json());
app.use('/architecture', getAuthMiddleware().authenticate(), architectureRoutes);
const getAnalysis = () => request(app).get('/architecture/business-services/bs-1/analysis');
const postAnalysis = () => request(app).post('/architecture/analyze').send({ ci_ids: ['ci-1'] });

beforeEach(() => {
  getCI.mockImplementation(async () => ({ id: 'ci-1' }));
  analyzeArchitecture.mockImplementation(async () => { throw new Error('driver internal secret'); });
  analyzeBusinessService.mockImplementation(async () => { throw new Error('driver internal secret'); });
});

it('returns 401 to unauthenticated architecture analysis callers before ownership lookup', async () => {
  expect((await getAnalysis()).status).toBe(401);
  expect((await postAnalysis()).status).toBe(401);
  expect(getCI).not.toHaveBeenCalled();
  expect(analyzeBusinessService).not.toHaveBeenCalled();
});

it('returns 403 to read-only viewers on both architecture analysis routes', async () => {
  expect((await getAnalysis().set('authorization', 'Bearer viewer')).status).toBe(403);
  expect((await postAnalysis().set('authorization', 'Bearer viewer')).status).toBe(403);
  expect(getCI).not.toHaveBeenCalled();
  expect(analyzeBusinessService).not.toHaveBeenCalled();
});

it('returns only a generic 500 when analysis fails after authorizing an operator', async () => {
  for (const response of [
    await getAnalysis().set('authorization', 'Bearer operator'),
    await postAnalysis().set('authorization', 'Bearer operator'),
  ]) {
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error: 'Failed to analyze architecture' });
  }
  expect(getCI).toHaveBeenCalledTimes(1);
  expect(analyzeBusinessService).toHaveBeenCalledTimes(1);
  expect(analyzeArchitecture).toHaveBeenCalledTimes(1);
});

it('returns fixed timeout bodies without Neo4j diagnostics on both mounted routes', async () => {
  const timeout = Object.assign(new Error('driver internal secret'), {
    code: 'Neo.ClientError.Transaction.TransactionTimedOut',
  });
  analyzeArchitecture.mockRejectedValue(timeout);
  analyzeBusinessService.mockRejectedValue(timeout);
  for (const response of [
    await getAnalysis().set('authorization', 'Bearer operator'),
    await postAnalysis().set('authorization', 'Bearer operator'),
  ]) {
    expect(response.status).toBe(504);
    expect(response.body).toEqual({ success: false, error: 'Architecture analysis timed out' });
  }
});

it('rejects parallel analysis for one principal before preflight on either route', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  analyzeBusinessService.mockImplementation(async () => { entered(); await gate; return { id: 'done' } as never; });
  const running = getAnalysis().set('authorization', 'Bearer operator').then((response) => response);
  await started;
  const blocked = await postAnalysis().set('authorization', 'Bearer operator');
  release();
  await running;
  expect(blocked.status).toBe(429);
  expect(blocked.body).toEqual({ success: false, error: 'Architecture analysis rate limit exceeded' });
  expect(getCI).not.toHaveBeenCalled();
});

it('enforces tenant concurrency across distinct authorized principals', async () => {
  const releases: Array<() => void> = [];
  const entered: Array<() => void> = [];
  const firstStarted = new Promise<void>((resolve) => { entered.push(resolve); });
  const secondStarted = new Promise<void>((resolve) => { entered.push(resolve); });
  analyzeBusinessService.mockImplementation(() => {
    const index = releases.length;
    return new Promise<never>((resolve) => {
      releases.push(() => resolve({ id: 'done' }));
      entered[index]();
    });
  });
  const first = getAnalysis().set('authorization', 'Bearer operator-tenant-1').then((res) => res);
  await firstStarted;
  const second = getAnalysis().set('authorization', 'Bearer operator-tenant-2').then((res) => res);
  await secondStarted;
  const blocked = await getAnalysis().set('authorization', 'Bearer operator-tenant-3');
  releases.forEach((release) => release());
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(blocked.status).toBe(429);
  expect(blocked.body).toEqual({ success: false, error: 'Architecture analysis rate limit exceeded' });
  expect(analyzeBusinessService).toHaveBeenCalledTimes(2);
});

it('caps sequential analysis requests by verified principal across endpoints', async () => {
  analyzeBusinessService.mockResolvedValue({ id: 'ok' } as never);
  analyzeArchitecture.mockResolvedValue({ id: 'ok' } as never);
  for (let attempt = 0; attempt < 10; attempt++) {
    expect((await getAnalysis().set('authorization', 'Bearer operator-rate')).status).toBe(200);
  }
  const blocked = await postAnalysis().set('authorization', 'Bearer operator-rate');
  expect(blocked.status).toBe(429);
  expect(blocked.body).toEqual({ success: false, error: 'Architecture analysis rate limit exceeded' });
  expect(getCI).not.toHaveBeenCalled();
});

it('bounds the ownership preflight with the same deadline and maps database timeouts', async () => {
  getCI.mockRejectedValue(Object.assign(new Error('database diagnostics'), {
    code: 'Neo.ClientError.Transaction.TransactionTimedOut',
  }));
  const response = await postAnalysis().set('authorization', 'Bearer operator-preflight');
  expect(response.status).toBe(504);
  expect(response.body).toEqual({ success: false, error: 'Architecture analysis timed out' });
  expect(analyzeArchitecture).not.toHaveBeenCalled();
  expect(getCI).toHaveBeenCalledWith('ci-1', ORG, expect.any(Number));
  const timeout = getCI.mock.calls[0][2];
  expect(timeout).toBeGreaterThan(0);
  expect(timeout).toBeLessThanOrEqual(5000);
});

it('returns 504 when preflight spends the whole request budget before the engine', async () => {
  const started = Date.now();
  getCI.mockImplementation(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(started + 60_000);
    expect(() => architectureRemainingMs()).toThrow('Architecture analysis timed out');
    return { id: 'ci-1' };
  });
  try {
    const response = await postAnalysis().set('authorization', 'Bearer operator-budget');
    expect(response.status).toBe(504);
    expect(response.body).toEqual({ success: false, error: 'Architecture analysis timed out' });
    expect(analyzeArchitecture).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
});
