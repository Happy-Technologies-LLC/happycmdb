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
    if (token !== 'viewer' && token !== 'operator') throw new Error('Invalid token');
    return { _userId: token, _username: token, _role: token, _organizationId: ORG, _type: 'access' };
  } } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => ({ getCI }) }));
jest.mock('@cmdb/ai-ml-engine', () => ({
  getArchitectureOptimizationEngine: () => ({ analyzeArchitecture, analyzeBusinessService }),
}));

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
