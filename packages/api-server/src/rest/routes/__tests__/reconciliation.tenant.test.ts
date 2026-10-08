// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const query = jest.fn();
const run = jest.fn();
const close = jest.fn();
const emit = jest.fn();
const mockGetEngine = jest.fn();

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  sanitizeCITypeForLabel: (s: string) => s,
  validate: (schema: { validate: (input: unknown) => { value: unknown; error?: Error } }, input: unknown) => {
    const { value, error } = schema.validate(input);
    return { valid: !error, value, error: error?.message };
  },
}));
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: () => ({ run, close }) }),
  getPostgresClient: () => ({ query }),
  getAuditService: () => ({}),
  getUnifiedCredentialService: () => ({}),
  getCredentialSetService: () => ({}),
  getRedisClient: () => ({ getConnection: () => ({}) }),
}));
jest.mock('@cmdb/event-processor', () => ({ getEventProducer: () => ({ emit }), EventType: { CI_UPDATED: 'updated' } }));
jest.mock('@cmdb/identity-resolution', () => ({ getIdentityReconciliationEngine: () => mockGetEngine() }));
jest.mock('../../../auth/auth-bootstrap', () => ({ getAuthService: () => ({}), getAuthMiddleware: () => ({
  authenticate: () => (req: Request, res: Response, next: NextFunction) => {
    const org = req.get('authorization');
    if (!org) return res.status(401).json({ error: 'Unauthorized' });
    (req as Request & { user: object }).user = { _role: 'operator', _organizationId: org === 'Bearer org-a' ? ORG_A : org === 'Bearer org-b' ? ORG_B : undefined };
    next();
  },
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireOrganization: () => (req: Request, res: Response, next: NextFunction) => {
    if (!(req as Request & { user: { _organizationId?: string } }).user._organizationId) return res.status(403).json({ error: 'Forbidden' });
    next();
  },
}) }));
jest.mock('../../../middleware/audit.middleware', () => ({ auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next() }));
jest.mock('../jobs.routes', () => ({ __esModule: true, default: jest.requireActual('express').Router() }));
jest.mock('../auth.routes', () => ({ authRoutes: jest.requireActual('express').Router() }));
jest.mock('../../../middleware/rate-limit.middleware', () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return { RateLimitMiddleware: function RateLimitMiddleware() { return new Proxy({}, { get: () => () => pass }); } };
});

import { IdentityReconciliationEngine } from '../../../../../identity-resolution/src/engine/identity-reconciliation-engine';
mockGetEngine.mockImplementation(() => IdentityReconciliationEngine.getInstance());
import { RestAPIServer } from '../../server';

// The real server mounts authentication and reconciliation at /api/v1.
const app = new RestAPIServer().getApp();

const payload = { name: 'host', ci_type: 'server', source: 'test', source_id: 'source', identifiers: { serial_number: 'same' }, attributes: { status: 'changed' } };
let node: { id: string; organization_id: string | null; serial_number: string; status?: string } | null;
beforeEach(() => {
  jest.clearAllMocks();
  node = null;
  query.mockResolvedValue({ rows: [] });
  run.mockImplementation(async (cypher: string, params: { organizationId: string; ciId?: string; properties?: { status: string } }) => {
    const found = node && node.organization_id === params.organizationId &&
      (cypher.includes('ci.serial_number') ? node.serial_number === 'same' : node.id === params.ciId) ? node : null;
    if (found && cypher.includes('SET ci += $properties')) Object.assign(found, params.properties);
    return { records: found ? [{ get: (key: string) => key === 'ci_id' ? found.id : found }] : [] };
  });
});

it('merges own CI, but returns identical 404 for foreign, org-less and missing targets without writing', async () => {
  node = { id: 'target', organization_id: ORG_A, serial_number: 'same' };
  const success = await request(app).post('/api/v1/reconciliation/merge').set('authorization', 'Bearer org-a').send(payload);
  expect(success.status).toBe(200);
  expect(success.body.data.ci_id).toBe('target');
  expect(node.status).toBe('changed');

  node.status = undefined;
  const missing = await request(app).post('/api/v1/reconciliation/merge').set('authorization', 'Bearer org-b').send(payload);
  expect(missing.status).toBe(404);
  expect(node.status).toBeUndefined();
  node.organization_id = null;
  const orgless = await request(app).post('/api/v1/reconciliation/merge').set('authorization', 'Bearer org-a').send(payload);
  expect({ status: orgless.status, body: orgless.body }).toEqual({ status: missing.status, body: missing.body });
  expect(node.status).toBeUndefined();
  node = null;
  const absent = await request(app).post('/api/v1/reconciliation/merge').set('authorization', 'Bearer org-a').send(payload);
  expect({ status: absent.status, body: absent.body }).toEqual({ status: missing.status, body: missing.body });
  expect(run.mock.calls.filter(([cypher]) => String(cypher).includes('SET ci += $properties'))).toHaveLength(1);
  expect(emit).toHaveBeenCalledTimes(1);
});
