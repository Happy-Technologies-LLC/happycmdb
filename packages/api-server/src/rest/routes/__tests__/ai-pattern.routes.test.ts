// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for ai-pattern.routes.ts: every route requires
 * authentication (router-level authenticate()), the authenticated user
 * reaches the controller via req.user, mutating routes are gated on the
 * 'write' permission (or the 'admin' role for approve/activate given
 * their infrastructure execution risk), reads stay open to any
 * authenticated role, and the reject endpoint's required `reason` body
 * field is enforced only after the permission gate passes.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole } };

const mockRouteHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});

// Bearer-token -> role fixture, mirroring the shape a real access token's
// req.user carries. 'Bearer valid-token' keeps its historical meaning (a
// generically-authenticated admin) so the pre-existing tests below stay
// valid unchanged; the named tokens exist for the role-gating tests.
const TOKEN_ROLES: Record<string, UserRole> = {
  'Bearer valid-token': 'admin',
  'Bearer admin-token': 'admin',
  'Bearer operator-token': 'operator',
  'Bearer viewer-token': 'viewer',
};

const mockAuthenticate = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  const role = TOKEN_ROLES[req.get('authorization') ?? ''];
  if (!role) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as ReqWithUser).user = { _userId: 'route-user', _role: role };
  next();
});

// Mirrors AuthMiddleware.requirePermission/.requireRole (packages/api-server/
// src/middleware/auth.middleware.ts): 401 with no req.user (unreachable here
// since authenticate() always runs first), 403 when the role lacks the
// permission/isn't in the allowed set, else next().
const mockRequirePermission = jest.fn(
  (permission: Permission) => (req: Request, res: Response, next: () => void) => {
    const role = (req as ReqWithUser).user?._role;
    if (!role) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!ROLE_PERMISSIONS[role].includes(permission)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  }
);

const mockRequireRole = jest.fn(
  (...roles: string[]) =>
    (req: Request, res: Response, next: () => void) => {
      const role = (req as ReqWithUser).user?._role;
      if (!role) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!roles.includes(role)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      next();
    }
);

jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: jest.fn(() => ({
    authenticate: mockAuthenticate,
    requirePermission: mockRequirePermission,
    requireRole: mockRequireRole,
  })),
}));

jest.mock('../../controllers/ai-pattern.controller', () => ({
  AIPatternController: jest.fn(() => ({
    listPatterns: mockRouteHandler,
    getPattern: mockRouteHandler,
    deletePattern: mockRouteHandler,
    submitForReview: mockRouteHandler,
    approvePattern: mockRouteHandler,
    rejectPattern: mockRouteHandler,
    activatePattern: mockRouteHandler,
    deactivatePattern: mockRouteHandler,
    validatePattern: mockRouteHandler,
    getPatternUsage: mockRouteHandler,
    getPatternHistory: mockRouteHandler,
    compileAndSubmitPatterns: mockRouteHandler,
    listSessions: mockRouteHandler,
    getSession: mockRouteHandler,
    analyzeSession: mockRouteHandler,
    getCostAnalytics: mockRouteHandler,
    getLearningStats: mockRouteHandler,
  })),
}));

import { aiPatternRoutes } from '../ai-pattern.routes';

// Captured once at module scope (mirrors server.ts, which builds this
// middleware once via `authMiddleware.authenticate()` when the app is
// constructed). jest.config.unit.js sets `resetMocks: true`, which wipes
// `mockAuthenticate`'s implementation before every test; calling it fresh
// inside testApp() would return undefined once the suite is running.
const authenticateMiddleware = mockAuthenticate();

function testApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Mirrors server.ts: authentication is applied centrally on /api/v1
  // before any router, not by the router itself.
  app.use(authenticateMiddleware);
  app.use('/ai', aiPatternRoutes);
  return app;
}

describe('ai-pattern routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each([
    ['GET', '/ai/patterns', undefined],
    ['POST', '/ai/patterns/compile', {}],
    ['GET', '/ai/patterns/pat-1', undefined],
    ['DELETE', '/ai/patterns/pat-1', undefined],
    ['POST', '/ai/patterns/pat-1/submit', {}],
    ['POST', '/ai/patterns/pat-1/approve', {}],
    ['POST', '/ai/patterns/pat-1/reject', { reason: 'bad code' }],
    ['POST', '/ai/patterns/pat-1/activate', {}],
    ['POST', '/ai/patterns/pat-1/deactivate', {}],
    ['POST', '/ai/patterns/pat-1/validate', {}],
    ['GET', '/ai/patterns/pat-1/usage', undefined],
    ['GET', '/ai/patterns/pat-1/history', undefined],
    ['GET', '/ai/sessions', undefined],
    ['GET', '/ai/sessions/sess-1', undefined],
    ['POST', '/ai/sessions/sess-1/analyze', {}],
    ['GET', '/ai/analytics/cost', undefined],
    ['GET', '/ai/analytics/learning', undefined],
  ])('returns 401 before reaching %s %s without credentials', async (method, path, body) => {
    const app = testApp();
    const response =
      method === 'POST'
        ? await request(app).post(path).send(body)
        : method === 'DELETE'
          ? await request(app).delete(path)
          : await request(app).get(path);

    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it('passes the authenticated user through to the controller', async () => {
    const response = await request(testApp())
      .get('/ai/patterns/pat-1')
      .set('authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ actor: 'route-user' });
    expect(mockRouteHandler).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ _userId: 'route-user' }) }),
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects a reject-pattern request missing the required reason with 400', async () => {
    const response = await request(testApp())
      .post('/ai/patterns/pat-1/reject')
      .set('authorization', 'Bearer valid-token')
      .send({});

    expect(response.status).toBe(400);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it('accepts a reject-pattern request with a reason', async () => {
    const response = await request(testApp())
      .post('/ai/patterns/pat-1/reject')
      .set('authorization', 'Bearer valid-token')
      .send({ reason: 'fails validation' });

    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  describe('authorization tiers', () => {
    const mutatingRoutes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['POST', '/ai/patterns/compile', {}],
      ['DELETE', '/ai/patterns/pat-1', undefined],
      ['POST', '/ai/patterns/pat-1/submit', {}],
      ['POST', '/ai/patterns/pat-1/approve', {}],
      ['POST', '/ai/patterns/pat-1/reject', { reason: 'bad code' }],
      ['POST', '/ai/patterns/pat-1/activate', {}],
      ['POST', '/ai/patterns/pat-1/deactivate', {}],
    ];

    async function invoke(method: string, path: string, token: string, body?: Record<string, unknown>) {
      const app = testApp();
      const req =
        method === 'DELETE' ? request(app).delete(path) : request(app).post(path).send(body ?? {});
      return req.set('authorization', token);
    }

    it.each(mutatingRoutes)(
      'viewer (read-only) receives 403 on %s %s',
      async (method, path, body) => {
        const response = await invoke(method, path, 'Bearer viewer-token', body);

        expect(response.status).toBe(403);
        expect(mockRouteHandler).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['POST', '/ai/patterns/compile', {}],
      ['DELETE', '/ai/patterns/pat-1', undefined],
      ['POST', '/ai/patterns/pat-1/submit', {}],
      ['POST', '/ai/patterns/pat-1/deactivate', {}],
    ])('a write-permitted, non-admin role can call %s %s', async (method, path, body) => {
      const response = await invoke(method, path, 'Bearer operator-token', body);

      expect(response.status).toBe(200);
      expect(mockRouteHandler).toHaveBeenCalled();
    });

    it.each([
      ['POST', '/ai/patterns/pat-1/approve', {}],
      ['POST', '/ai/patterns/pat-1/activate', {}],
    ])(
      'a non-admin writer receives 403 on the admin-gated %s %s',
      async (method, path, body) => {
        const response = await invoke(method, path, 'Bearer operator-token', body);

        expect(response.status).toBe(403);
        expect(mockRouteHandler).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['POST', '/ai/patterns/pat-1/approve', {}],
      ['POST', '/ai/patterns/pat-1/activate', {}],
    ])('an admin can call the admin-gated %s %s', async (method, path, body) => {
      const response = await invoke(method, path, 'Bearer admin-token', body);

      expect(response.status).toBe(200);
      expect(mockRouteHandler).toHaveBeenCalled();
    });

    it('a viewer receives 403 on reject even without the required reason (permission gate precedes body validation)', async () => {
      const response = await invoke('POST', '/ai/patterns/pat-1/reject', 'Bearer viewer-token', {});

      expect(response.status).toBe(403);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    });

    it.each([
      ['GET', '/ai/patterns'],
      ['GET', '/ai/patterns/pat-1'],
      ['GET', '/ai/patterns/pat-1/usage'],
      ['GET', '/ai/patterns/pat-1/history'],
      ['GET', '/ai/sessions'],
      ['GET', '/ai/sessions/sess-1'],
      ['GET', '/ai/analytics/cost'],
      ['GET', '/ai/analytics/learning'],
    ])('a viewer can still reach the read-only %s %s', async (_method, path) => {
      const response = await request(testApp()).get(path).set('authorization', 'Bearer viewer-token');

      expect(response.status).toBe(200);
      expect(mockRouteHandler).toHaveBeenCalled();
    });

    it('a viewer can still call validate and analyze (no status transition, so no write gate)', async () => {
      const validateResponse = await request(testApp())
        .post('/ai/patterns/pat-1/validate')
        .set('authorization', 'Bearer viewer-token')
        .send({});
      const analyzeResponse = await request(testApp())
        .post('/ai/sessions/sess-1/analyze')
        .set('authorization', 'Bearer viewer-token')
        .send({});

      expect(validateResponse.status).toBe(200);
      expect(analyzeResponse.status).toBe(200);
    });
  });

  describe('array filters and synthetic-session opt-in', () => {
    it.each([['/ai/patterns'], ['/ai/sessions']])(
      'accepts a repeated status[]= array param (axios status[]=... serialization) on GET %s',
      async (path) => {
        const response = await request(testApp())
          .get(path)
          .query('status[]=completed&status[]=failed')
          .set('authorization', 'Bearer valid-token');

        expect(response.status).toBe(200);
        const query = (mockRouteHandler.mock.calls[0][0] as Request).query as Record<string, unknown>;
        expect(query['status']).toEqual(['completed', 'failed']);
      }
    );

    it.each([['/ai/patterns'], ['/ai/sessions']])(
      'accepts a comma-separated status= string param on GET %s',
      async (path) => {
        const response = await request(testApp())
          .get(path)
          .query({ status: 'completed,failed' })
          .set('authorization', 'Bearer valid-token');

        expect(response.status).toBe(200);
        const query = (mockRouteHandler.mock.calls[0][0] as Request).query as Record<string, unknown>;
        expect(query['status']).toBe('completed,failed');
      }
    );

    it('accepts includeSynthetic=true on GET /ai/sessions', async () => {
      const response = await request(testApp())
        .get('/ai/sessions')
        .query({ includeSynthetic: 'true' })
        .set('authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(mockRouteHandler).toHaveBeenCalled();
    });

    it('rejects an invalid includeSynthetic value on GET /ai/sessions with 400', async () => {
      const response = await request(testApp())
        .get('/ai/sessions')
        .query({ includeSynthetic: 'maybe' })
        .set('authorization', 'Bearer valid-token');

      expect(response.status).toBe(400);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    });
  });
});
