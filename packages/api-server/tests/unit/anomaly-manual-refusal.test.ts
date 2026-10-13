// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';

const detectAnomalies = jest.fn();
jest.mock('@cmdb/database', () => ({ getPostgresClient: () => ({}), getNeo4jClient: () => ({}) }));
jest.mock('@cmdb/ai-ml-engine', () => ({ getAnomalyDetectionEngine: () => ({ detectAnomalies }) }));
jest.mock('../../src/auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    requireOrganization: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.get('x-test-organization') === 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa') next();
      else res.status(403).json({ error: 'Forbidden' });
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }),
}));
import { anomalyRoutes } from '../../src/rest/routes/anomaly.routes';

it('refuses manual global detection even to a tenant-bearing writer without starting the engine', async () => {
  const app = express();
  app.use('/api/v1/anomalies', anomalyRoutes);
  const uri = '/api/v1/anomalies/detect';
  expect((await request(app).post(uri)).status).toBe(403);
  expect((await request(app).post(uri).set('x-test-organization', 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')).body)
    .toEqual({ success: false, error: 'Forbidden' });
  expect(detectAnomalies).not.toHaveBeenCalled();
});
