// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../../auth/auth.service';
import type { ConfigSchema } from '@cmdb/common';
import type { UserRole } from '../../../auth/types';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const touched = jest.fn();
jest.mock('../../controllers/reconciliation.controller', () => ({
  ReconciliationController: jest.fn().mockImplementation(() => ({
    findMatches: touched, mergeCI: touched, listConflicts: touched, resolveConflict: touched,
    listRules: touched, writeRule: touched, listSourceAuthorities: touched, updateSourceAuthority: touched,
    getCILineage: touched, getCIFieldSources: touched,
  })),
}));
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>('../../../middleware/auth.middleware');
  const authService = {
    verifyToken: async (token: string) => {
      const [organizationId, role] = token.split(':');
      if (!['org-a', 'org-b'].includes(organizationId!) || !['viewer', 'operator', 'admin'].includes(role!)) throw new Error('Invalid token');
      return { _role: role as UserRole, _organizationId: organizationId === 'org-a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222' };
    },
  } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(authService, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']) };
});
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { reconciliationRoutes } from '../reconciliation.routes';
import healthRoutes from '../../../health/health.routes';

const app = express();
app.use(express.json());
// Production mounts health before /api/v1 authentication; policy routes after it.
app.use('/api/v1/cmdb-health', healthRoutes);
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/reconciliation', reconciliationRoutes);

// Tenants manage their own policy (HP1-S4b); the legacy NULL-org global rows stay unreadable.
const policy = [['get', '/reconciliation/rules?scope=global'], ['get', '/reconciliation/source-authorities?scope=global']] as const;
const health = ['/cmdb-health/metrics', '/cmdb-health/timeseries?hours=24'];

beforeEach(() => {
  touched.mockImplementation((_req: express.Request, res: express.Response) => res.status(200).json({ success: true, data: [{ name: 'foreign-policy' }] }));
});

test('legacy global policy refuses both verified organizations and all roles identically, without reads', async () => {
  const replies = [];
  for (const org of ['org-a', 'org-b']) {
    for (const role of ['viewer', 'operator', 'admin']) {
      for (const [method, path] of policy) {
        const response = await request(app)[method](`/api/v1${path}`).set('authorization', `Bearer ${org}:${role}`).send({
          name: 'policy', identification_rules: [], authority_score: 8,
        });
        replies.push({ status: response.status, body: response.body });
      }
    }
  }
  expect(replies).toEqual(Array(replies.length).fill({ status: 403, body: { success: false, error: 'Global reconciliation policy unavailable' } }));
  expect(touched).not.toHaveBeenCalled();
});

test('global health aggregates require auth and refuse both organizations and every role; public liveness remains available', async () => {
  for (const path of health) {
    expect((await request(app).get(`/api/v1${path}`)).status).toBe(401);
    const replies = [];
    for (const org of ['org-a', 'org-b']) for (const role of ['viewer', 'operator', 'admin']) {
      const response = await request(app).get(`/api/v1${path}`).set('authorization', `Bearer ${org}:${role}`);
      replies.push({ status: response.status, body: response.body });
    }
    expect(replies).toEqual(Array(replies.length).fill({ status: 403, body: { success: false, error: 'Global health metrics unavailable' } }));
  }
  expect((await request(app).get('/api/v1/cmdb-health/alive')).status).toBe(200);
});
