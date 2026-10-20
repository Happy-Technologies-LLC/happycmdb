// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for the tenant reconciliation routes, mounted as in
 * server.ts: the real AuthMiddleware.authenticate() on /api/v1, then
 * reconciliationRoutes on /api/v1/reconciliation, with the real
 * requirePermission/requireOrganization middleware (only token verification
 * is stubbed). Every tenant route needs credentials (401 before any handler);
 * the merge and conflict-resolve mutations also need the 'write' permission,
 * so a read-only viewer gets 403 before the handler runs.
 *
 * The per-organization policy routes (rules, source-authorities) are covered by
 * hp1-s4b-merge-conflicts.test.ts and t4-global-policy.test.ts.
 */

import express from 'express';
import request from 'supertest';
import type { AuthService } from '../../../auth/auth.service';
import type { ConfigSchema } from '@cmdb/common';
import type { UserRole } from '../../../auth/types';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const handler = jest.fn();
jest.mock('../../controllers/reconciliation.controller', () => ({
  ReconciliationController: jest.fn().mockImplementation(() => ({
    findMatches: handler, mergeCI: handler, listConflicts: handler, resolveConflict: handler,
    getCILineage: handler, getCIFieldSources: handler, listRules: handler, writeRule: handler,
    listSourceAuthorities: handler, updateSourceAuthority: handler,
  })),
}));
jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>('../../../middleware/auth.middleware');
  const authService = {
    verifyToken: async (token: string) => {
      const [organizationId, role] = token.split(':');
      if (!['org-a', 'org-b'].includes(organizationId!) || !['viewer', 'operator', 'admin'].includes(role!)) throw new Error('Invalid token');
      return { _userId: `${organizationId}-${role}`, _role: role as UserRole, _organizationId: organizationId === 'org-a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222' };
    },
    verifyApiKey: async () => { throw new Error('Invalid API key'); },
  } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(authService, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']) };
});
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { reconciliationRoutes } from '../reconciliation.routes';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/reconciliation', reconciliationRoutes);

type RouteCase = readonly ['get' | 'post', string, Record<string, unknown> | undefined];

const MERGE_BODY = { name: 'web-01', ci_type: 'server', source: 'aws', source_id: 'i-123', identifiers: { external_id: 'ext-1' } };
const writeRoutes: RouteCase[] = [
  ['post', '/reconciliation/merge', MERGE_BODY],
  ['post', '/reconciliation/conflicts/conflict-1/resolve', { resolution: 'accept_source', expected_revision: 'a'.repeat(64) }],
];
const readRoutes: RouteCase[] = [
  ['post', '/reconciliation/match', { identifiers: { external_id: 'ext-1' } }],
  ['get', '/reconciliation/conflicts', undefined],
  ['get', '/reconciliation/lineage/ci-1', undefined],
  ['get', '/reconciliation/field-sources/ci-1', undefined],
];

function call([method, path, body]: RouteCase, token?: string) {
  const req = request(app)[method](`/api/v1${path}`);
  if (token !== undefined) req.set('authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
}

beforeEach(() => {
  handler.mockImplementation((_req: express.Request, res: express.Response) => res.status(200).json({ success: true }));
});

describe('tenant reconciliation routes', () => {
  it.each([...writeRoutes, ...readRoutes])('returns 401 before reaching %s %s without credentials', async (...route) => {
    const response = await call(route);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('returns 401 for %s %s with an unrecognized bearer token', async (...route) => {
    const response = await call(route, 'garbage-token');
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('a viewer (read-only) of either organization gets 403 on %s %s before the handler', async (...route) => {
    for (const org of ['org-a', 'org-b']) {
      const response = await call(route, `${org}:viewer`);
      expect([org, response.status, response.body]).toEqual([
        org, 403, { _error: 'Forbidden', _message: "Permission 'write' required" },
      ]);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('an operator (write) reaches %s %s', async (...route) => {
    const response = await call(route, 'org-a:operator');
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(readRoutes)('a viewer reaches the read %s %s (the 403 above is the write gate, not the role)', async (...route) => {
    const response = await call(route, 'org-a:viewer');
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('refuses a 256-char merge source (T2 change_source VARCHAR(255)) before the handler', async () => {
    const merge = (source: string) => call(['post', '/reconciliation/merge', { ...MERGE_BODY, source }], 'org-a:operator');
    expect([(await merge('s'.repeat(256))).status, (await merge('s'.repeat(255))).status, handler.mock.calls.length]).toEqual([400, 200, 1]);
  });
});
