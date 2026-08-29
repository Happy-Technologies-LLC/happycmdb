// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for architecture.routes.ts. Authentication is applied
 * centrally by server.ts (`authMiddleware.authenticate()` mounted on every
 * /api/v1 route before any router), so this suite simulates that by
 * mounting the captured mock middleware ahead of `architectureRoutes`,
 * The recommendations GET is read-only. Both analysis endpoints persist
 * expensive output and therefore require the `write` permission.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole } };

const TOKEN_ROLES: Record<string, UserRole> = {
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

jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: jest.fn(() => ({
    authenticate: mockAuthenticate,
    requirePermission: mockRequirePermission,
  })),
}));

jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockAnalyzeBusinessService = jest.fn(async () => ({ score: 0.9 }));
const mockAnalyzeArchitecture = jest.fn(async () => ({ score: 0.8 }));
const mockGetArchitectureOptimizationEngine = jest.fn(() => ({
  analyzeBusinessService: mockAnalyzeBusinessService,
  analyzeArchitecture: mockAnalyzeArchitecture,
}));

jest.mock('@cmdb/ai-ml-engine', () => ({
  getArchitectureOptimizationEngine: mockGetArchitectureOptimizationEngine,
}));

import { architectureRoutes } from '../architecture.routes';

// Captured once at module scope (mirrors server.ts, which builds this
// middleware once via `authMiddleware.authenticate()` when the app is
// constructed). jest.config.unit.js sets `resetMocks: true`, which wipes
// `mockAuthenticate`'s implementation before every test; calling it fresh
// inside testApp() would return undefined once the suite is running.
const authenticateMiddleware = mockAuthenticate();

function testApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authenticateMiddleware);
  app.use('/architecture', architectureRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [['GET', '/architecture/recommendations', undefined]];

const writeRoutes: RouteCase[] = [
  ['GET', '/architecture/business-services/bs-1/analysis', undefined],
  ['POST', '/architecture/analyze', { ci_ids: ['ci-1', 'ci-2'] }],
];

async function invoke(app: express.Express, method: string, path: string, body: unknown, token?: string) {
  const req = method === 'GET' ? request(app).get(path) : request(app).post(path).send(body ?? {});
  return token ? req.set('authorization', token) : req;
}

describe('architecture routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAnalyzeBusinessService.mockImplementation(async () => ({ score: 0.9 }));
    mockAnalyzeArchitecture.mockImplementation(async () => ({ score: 0.8 }));
    mockGetArchitectureOptimizationEngine.mockImplementation(() => ({
      analyzeBusinessService: mockAnalyzeBusinessService,
      analyzeArchitecture: mockAnalyzeArchitecture,
    }));
  });

  it.each([...readRoutes, ...writeRoutes])(
    'returns 401 before reaching %s %s without credentials',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body);
      expect(response.status).toBe(401);
      expect(mockAnalyzeBusinessService).not.toHaveBeenCalled();
      expect(mockAnalyzeArchitecture).not.toHaveBeenCalled();
    }
  );

  it.each(readRoutes)('a viewer (read-only) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it.each(writeRoutes)('a viewer (read-only) receives 403 on %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(403);
    expect(mockAnalyzeArchitecture).not.toHaveBeenCalled();
    expect(mockAnalyzeBusinessService).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('an operator (write) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer operator-token');
    expect(response.status).toBe(200);
    if (method === 'GET') {
      expect(mockAnalyzeBusinessService).toHaveBeenCalledWith('bs-1');
    } else {
      expect(mockAnalyzeArchitecture).toHaveBeenCalledWith(['ci-1', 'ci-2']);
    }
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(
      testApp(),
      'GET',
      '/architecture/recommendations',
      undefined,
      'Bearer garbage-token'
    );
    expect(response.status).toBe(401);
  });
});
