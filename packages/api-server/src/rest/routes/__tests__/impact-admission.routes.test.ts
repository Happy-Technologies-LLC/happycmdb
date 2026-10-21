// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';
import { architectureRemainingMs } from '@cmdb/ai-ml-engine';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const getCI = jest.fn(async () => ({ id: 'ci-1' }));
const getCriticalityScore = jest.fn(async (): Promise<unknown> => ({ criticality_score: 55 }));
const buildDependencyGraph = jest.fn(async (): Promise<unknown> => ({ nodes: [], edges: [] }));
const predictChangeImpact = jest.fn(async (): Promise<unknown> => ({ blast_radius: 0 }));
const getImpactHistory = jest.fn(async (): Promise<unknown> => []);

jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../../middleware/auth.middleware'
  );
  const verifier = { verifyToken: async (token: string) => ({
    _userId: token, _username: token, _role: token.startsWith('writer-') ? 'operator' : 'viewer',
    _organizationId: token.startsWith('b-') ? ORG_B : ORG_A, _type: 'access',
  }) } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getCI }), getPostgresClient: () => ({ query: async () => ({ rows: [] }) }),
}));
jest.mock('@cmdb/ai-ml-engine', () => ({
  ...jest.requireActual('@cmdb/ai-ml-engine'),
  getConfigurationDriftDetector: () => ({}),
  getImpactPredictionEngine: () => ({
    getCriticalityScore, buildDependencyGraph, predictChangeImpact, getImpactHistory,
  }),
}));

import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { impactRoutes } from '../drift-impact.routes';

const app = express();
app.use(express.json());
app.use('/impact', getAuthMiddleware().authenticate(), impactRoutes);
const criticality = (principal: string) => request(app).get('/impact/criticality/ci-1')
  .set('authorization', `Bearer ${principal}`);
const history = (principal: string) => request(app).get('/impact/history/ci-1')
  .set('authorization', `Bearer ${principal}`);

beforeEach(() => {
  getCI.mockImplementation(async () => ({ id: 'ci-1' }));
  getCriticalityScore.mockImplementation(async () => ({ criticality_score: 55 }));
  getImpactHistory.mockImplementation(async () => []);
});

it('refuses concurrent requests for one verified principal before ownership lookup', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  getCriticalityScore.mockImplementationOnce(async () => { entered(); await gate; return { criticality_score: 55 }; });
  const running = criticality('a-concurrent').then(response => response);
  await started;
  const blocked = await history('a-concurrent');
  expect(blocked.status).toBe(429);
  expect(blocked.body).toEqual({ success: false, error: 'Impact analysis rate limit exceeded' });
  expect(getCI).toHaveBeenCalledTimes(1);
  release();
  expect((await running).status).toBe(200);
});

it('bounds tenant concurrency across distinct verified principals', async () => {
  const releases: Array<() => void> = [];
  const entered: Array<() => void> = [];
  const firstStarted = new Promise<void>(resolve => { entered.push(resolve); });
  const secondStarted = new Promise<void>(resolve => { entered.push(resolve); });
  getCriticalityScore.mockImplementation(() => new Promise(resolve => {
    const index = releases.length;
    releases.push(() => resolve({ criticality_score: 55 }));
    entered[index]();
  }));
  const first = criticality('a-first').then(response => response);
  await firstStarted;
  const second = criticality('a-second').then(response => response);
  await secondStarted;
  const blocked = await criticality('a-third');
  expect(blocked.status).toBe(429);
  expect(blocked.body).toEqual({ success: false, error: 'Impact analysis rate limit exceeded' });
  expect(getCI).toHaveBeenCalledTimes(2);
  const otherTenant = await history('b-independent');
  expect(otherTenant.status).toBe(200);
  releases.forEach(release => release());
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
});

it('caps aggregate impact GET and POST requests by verified principal', async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    expect((await history('writer-rate')).status).toBe(200);
  }
  const blocked = await request(app).post('/impact/predict').set('authorization', 'Bearer writer-rate')
    .send({ ci_id: 'ci-1', change_type: 'restart' });
  expect(blocked.status).toBe(429);
  expect(blocked.body).toEqual({ success: false, error: 'Impact analysis rate limit exceeded' });
  expect(getCI).toHaveBeenCalledTimes(10);
  expect(predictChangeImpact).not.toHaveBeenCalled();
});

it('applies the same end-to-end deadline to preflight and engine work', async () => {
  const started = Date.now();
  getCI.mockImplementation(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(started + 60_000);
    expect(() => architectureRemainingMs()).toThrow('Architecture analysis timed out');
    return { id: 'ci-1' };
  });
  try {
    const preflight = await criticality('a-timeout-preflight');
    expect(preflight.status).toBe(504);
    expect(preflight.body).toEqual({ success: false, error: 'Impact analysis timed out' });
    expect(getCriticalityScore).not.toHaveBeenCalled();
  } finally {
    jest.restoreAllMocks();
  }
  getCriticalityScore.mockRejectedValueOnce(Object.assign(new Error('Neo4j private diagnostics'), {
    code: 'Neo.ClientError.Transaction.TransactionTimedOut',
  }));
  const statement = await criticality('a-timeout-statement');
  expect(statement.status).toBe(504);
  expect(statement.body).toEqual({ success: false, error: 'Impact analysis timed out' });
  expect(getCI.mock.calls[0][2]).toBeGreaterThan(0);
  expect(getCI.mock.calls[0][2]).toBeLessThanOrEqual(10000);
});
