// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring tests for discovery-agent.routes.ts. Authentication is
 * applied centrally by server.ts (`authMiddleware.authenticate()` mounted
 * on every /api/v1 route before any router), so this suite simulates that
 * by mounting the captured mock middleware ahead of
 * `discoveryAgentRoutes`, mirroring production. Registering, heartbeating,
 * and deleting an agent mutate agent state and additionally require the
 * 'write' permission (`authMiddleware.requirePermission('write')`); the
 * 'agent' role has 'write' (ROLE_PERMISSIONS), so a discovery agent
 * authenticating with an API-key-shaped credential can register/heartbeat
 * itself alongside operator/admin. Finding the best agent and
 * listing/reading agents are read-like and only need to be authenticated.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ROLE_PERMISSIONS, type Permission, type UserRole } from '../../../auth/types';

type ReqWithUser = Request & { user?: { _userId?: string; _role?: UserRole; _organizationId?: string } };

const mockRouteHandler = jest.fn((req: Request, res: Response) => {
  res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
});

const TOKEN_ROLES: Record<string, UserRole> = {
  'Bearer admin-token': 'admin',
  'Bearer operator-token': 'operator',
  'Bearer viewer-token': 'viewer',
  // API-key-shaped credential a discovery agent authenticates with in
  // production: the 'agent' role has 'write' (ROLE_PERMISSIONS), so it
  // can register/heartbeat itself alongside operator/admin.
  'Bearer agent-token': 'agent',
};

const mockAuthenticate = jest.fn(() => (req: Request, res: Response, next: () => void) => {
  const role = TOKEN_ROLES[req.get('authorization') ?? ''];
  if (!role) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (req as ReqWithUser).user = { _userId: 'route-user', _role: role, _organizationId: '11111111-1111-4111-8111-111111111111' };
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
    requireOrganization: () => (_req: Request, _res: Response, next: () => void) => next(),
  })),
}));

jest.mock('../../controllers/discovery-agent.controller', () => ({
  DiscoveryAgentController: jest.fn(() => ({
    registerAgent: mockRouteHandler,
    updateHeartbeat: mockRouteHandler,
    findBestAgent: mockRouteHandler,
    listAgents: mockRouteHandler,
    getAgent: mockRouteHandler,
    deleteAgent: mockRouteHandler,
  })),
}));

const mockAgentService = {
  updateHeartbeat: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  listAgents: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  getAgent: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  deleteAgent: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
};

// Plain class (not jest.fn) so `resetMocks: true` cannot wipe its behavior.
jest.mock('../../../services/discovery-agent.service', () => ({
  AGENT_NOT_FOUND: 'Agent not found',
  DiscoveryAgentService: class {
    constructor() {
      return mockAgentService;
    }
  },
}));

import { logger } from '@cmdb/common';
import { discoveryAgentRoutes } from '../discovery-agent.routes';

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
  app.use('/agents', discoveryAgentRoutes);
  return app;
}

type RouteCase = [string, string, Record<string, unknown> | undefined];

const readRoutes: RouteCase[] = [
  ['POST', '/agents/find-best', { targetNetworks: ['10.0.0.0/24'], provider: 'nmap' }],
  ['GET', '/agents', undefined],
  ['GET', '/agents/agent-1', undefined],
];

const writeRoutes: RouteCase[] = [
  [
    'POST',
    '/agents/register',
    {
      agent_id: 'agent-1',
      hostname: 'agent-host',
      provider_capabilities: ['nmap'],
      reachable_networks: ['10.0.0.0/24'],
    },
  ],
  ['POST', '/agents/heartbeat', { agent_id: 'agent-1', status: 'active' }],
  ['DELETE', '/agents/agent-1', undefined],
];

async function invoke(app: express.Express, method: string, path: string, body: unknown, token?: string) {
  const req =
    method === 'GET'
      ? request(app).get(path)
      : method === 'DELETE'
        ? request(app).delete(path)
        : request(app).post(path).send(body ?? {});
  return token ? req.set('authorization', token) : req;
}

describe('discovery agent routes', () => {
  beforeEach(() => {
    mockRouteHandler.mockImplementation((req: Request, res: Response) => {
      res.status(200).json({ actor: (req as ReqWithUser).user?._userId });
    });
  });

  it.each([...readRoutes, ...writeRoutes])(
    'returns 401 before reaching %s %s without credentials',
    async (method, path, body) => {
      const response = await invoke(testApp(), method, path, body);
      expect(response.status).toBe(401);
      expect(mockRouteHandler).not.toHaveBeenCalled();
    }
  );

  it.each(readRoutes)('a viewer (read-only) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(writeRoutes)('a viewer (read-only) receives 403 on %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer viewer-token');
    expect(response.status).toBe(403);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });

  it.each(writeRoutes)('an operator (write) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer operator-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it.each(writeRoutes)('a discovery agent (API-key-shaped req.user, write) can reach %s %s', async (method, path, body) => {
    const response = await invoke(testApp(), method, path, body, 'Bearer agent-token');
    expect(response.status).toBe(200);
    expect(mockRouteHandler).toHaveBeenCalled();
  });

  it('rejects an invalid/unrecognized bearer token with 401', async () => {
    const response = await invoke(testApp(), 'GET', '/agents', undefined, 'Bearer garbage-token');
    expect(response.status).toBe(401);
    expect(mockRouteHandler).not.toHaveBeenCalled();
  });
});

describe('discovery agent controller failure responses', () => {
  const MARKERS = [
    'error-host.invalid',
    '192.0.2.77',
    'cn=svc-synthetic,ou=people,dc=example,dc=invalid',
  ];
  const FAILURE_TEXT = `backend failure for ${MARKERS.join(' ')}`;

  // The route-wiring suite above mocks the controller; failure handling lives in
  // the real controller, so mount its actual handlers behind the same auth stub.
  function failureApp(): express.Express {
    const { DiscoveryAgentController: RealController } = jest.requireActual<
      typeof import('../../controllers/discovery-agent.controller')
    >('../../controllers/discovery-agent.controller');
    const controller = new RealController();
    const app = express();
    app.use(express.json());
    app.use(authenticateMiddleware);
    app.post('/agents/heartbeat', (req, res) => controller.updateHeartbeat(req, res));
    app.get('/agents', (req, res) => controller.listAgents(req, res));
    app.get('/agents/:agentId', (req, res) => controller.getAgent(req, res));
    app.delete('/agents/:agentId', (req, res) => controller.deleteAgent(req, res));
    return app;
  }

  const cases: Array<[keyof typeof mockAgentService, string, string, Record<string, unknown> | undefined, string]> = [
    ['updateHeartbeat', 'POST', '/agents/heartbeat', { agent_id: 'agent-1', status: 'active' }, 'Failed to update heartbeat'],
    ['listAgents', 'GET', '/agents', undefined, 'Failed to list agents'],
    ['getAgent', 'GET', '/agents/agent-1', undefined, 'Failed to get agent'],
    ['deleteAgent', 'DELETE', '/agents/agent-1', undefined, 'Failed to delete agent'],
  ];

  it.each(cases)('%s returns a fixed 500 and logs only fixed text and error class', async (serviceMethod, method, path, body, fixedError) => {
    const logSpies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(logger, level).mockImplementation(() => logger)
    );
    mockAgentService[serviceMethod].mockRejectedValue(
      new Error(FAILURE_TEXT, { cause: new Error(MARKERS.join(' ')) })
    );

    const response = await invoke(failureApp(), method, path, body, 'Bearer operator-token');

    expect(mockAgentService[serviceMethod]).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error: fixedError });
    expect(logSpies[3]).toHaveBeenCalledWith(`Error in ${serviceMethod} controller`, { errorClass: 'Error' });

    const everything = JSON.stringify([response.body, response.text, ...logSpies.map((spy) => spy.mock.calls)]);
    for (const marker of [...MARKERS, FAILURE_TEXT]) {
      expect(everything).not.toContain(marker);
    }
  });

  it('logs only the type for a non-Error rejection', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    mockAgentService.listAgents.mockRejectedValue({ detail: FAILURE_TEXT });

    const response = await invoke(failureApp(), 'GET', '/agents', undefined, 'Bearer operator-token');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error: 'Failed to list agents' });
    expect(error).toHaveBeenCalledWith('Error in listAgents controller', { errorClass: 'object' });
    expect(JSON.stringify(error.mock.calls)).not.toContain(FAILURE_TEXT);
  });
});
