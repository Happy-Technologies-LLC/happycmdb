// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import supertest from 'supertest';
import { connectorsRouter } from '../connectors.routes';
import { IntegrationHubServer } from '../../index';
import { getPostgresClient } from '@cmdb/database';
import { getConnectorRegistry } from '@cmdb/integration-framework';
import { getIntegrationManager } from '@cmdb/integration-framework/dist/core/integration-manager';
const mockCredentialLookup = jest.fn();

jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn(() => ({ query: (...args: unknown[]) => query(...args) })) }));
jest.mock('@cmdb/integration-framework/dist/core/integration-manager', () => ({
  getIntegrationManager: jest.fn(() => ({
    runConnector: (...args: unknown[]) => runConnector(...args),
    unregisterConnector: (...args: unknown[]) => unregisterConnector(...args),
    registerConnector: jest.fn(),
    testConnector: jest.fn(),
  })),
}));
jest.mock('@cmdb/integration-framework', () => ({
  getConnectorRegistry: jest.fn(() => ({
    hasConnectorType: () => true,
    getAllConnectorTypes: () => getAllConnectorTypes(),
    getConnectorMetadata: (type: string) => getConnectorMetadata(type),
  })),
}));
jest.mock('@cmdb/api-server/auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    authenticate: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.headers.authorization !== 'Bearer verified') return res.status(401).json({ error: 'Unauthorized' });
      Object.assign(req, { user: { organizationId: orgA, _role: 'operator' } });
      return next();
    },
    optionalAuthenticate: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      if (req.headers.authorization || req.headers['x-api-key']) mockCredentialLookup();
      if (['Bearer verified', 'Bearer verified-b', 'Bearer platform'].includes(req.headers.authorization ?? '') ||
          req.headers['x-api-key'] === 'verified-test-key') {
        Object.assign(req, { user: {
          organizationId: req.headers.authorization === 'Bearer verified-b' ? orgB : orgA,
          _role: 'operator', _platformAdmin: req.headers.authorization === 'Bearer platform',
        } });
      }
      next();
    },
  }),
}), { virtual: true });
jest.mock('@cmdb/api-server/auth/connector-scope', () => ({
  requireConnectorScope: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!(req as express.Request & { user?: object }).user) return res.status(403).json({ error: 'Forbidden' });
    return next();
  },
  connectorScope: (user: { organizationId?: string; legacy?: boolean }) => ({ organizationId: user.organizationId ?? null, legacy: user.legacy === true }),
  scopeValues: (user: { organizationId?: string; legacy?: boolean }) => [user.organizationId ?? null, user.legacy === true],
  connectorPredicate: (alias: string, first: number) => `(${alias}.organization_id = $${first} OR (${alias}.organization_id IS NULL AND $${first + 1}::boolean))`,
  PUBLIC_CONFIG: 'id, organization_id, name, description, connector_type, enabled, schedule, schedule_enabled, enabled_resources, max_retries, retry_delay_seconds, continue_on_error, notification_on_success, notification_on_failure, created_at, updated_at, created_by, updated_by',
  PUBLIC_RUN: 'id, organization_id, config_id, connector_type, config_name, resource_id, started_at, completed_at, status, records_extracted, records_transformed, records_loaded, records_failed, duration_ms, triggered_by',
  CONFIG_NOT_FOUND: { success: false, error: 'Not Found', message: 'Configuration not found' },
  RUN_NOT_FOUND: { success: false, error: 'Not Found', message: 'Run not found' },
}), { virtual: true });

const orgA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const orgB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const marker = 'client_secret=NEVER_RETURN_ME';
const row = { id: 'cfg-A', organization_id: orgA, name: 'shared', enabled: true };
const query = jest.fn();
const runConnector = jest.fn();
const unregisterConnector = jest.fn();

const getAllConnectorTypes = jest.fn();
const getConnectorMetadata = jest.fn();

async function request(method: string, path: string, user?: { organizationId?: string; legacy?: boolean }, body?: object) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    Object.assign(req, { user: { _role: 'operator', ...user } });
    if (!user.organizationId && !user.legacy) return res.status(403).json({ error: 'Forbidden' });
    return next();
  });
  app.use('/api/v1/connectors', connectorsRouter);
  const http = supertest(app);
  const response = body
    ? await http[method.toLowerCase() as 'post' | 'put'](path).send(body)
    : await http[method.toLowerCase() as 'get' | 'post'](path);
  return { status: response.status, body: response.text };
}

describe('standalone connector routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getPostgresClient as jest.Mock).mockReturnValue({ query });
  });

  it('mounts authentication before every standalone connector GET and POST', async () => {
    const app = Reflect.get(new IntegrationHubServer(), 'app') as express.Application;
    expect((await supertest(app).get('/api/v1/connectors/shared')).status).toBe(401);
    expect((await supertest(app).post('/api/v1/connectors').send({ name: 'shared' })).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses every transformation and lookup endpoint identically for anonymous, tenant and platform callers', async () => {
    const app = Reflect.get(new IntegrationHubServer(), 'app') as express.Application;
    query.mockResolvedValue({ rows: [{ id: 'global-rule', field_mappings: { token: marker } }] });
    const routes = [
      ['get', '/api/v1/transformation-rules'],
      ['get', '/api/v1/transformation-rules/global-rule'],
      ['post', '/api/v1/transformation-rules'],
      ['put', '/api/v1/transformation-rules/global-rule'],
      ['delete', '/api/v1/transformation-rules/global-rule'],
      ['post', '/api/v1/transformation-rules/global-rule/test'],
      ['post', '/api/v1/transformation-rules/global-rule/clone'],
      ['get', '/api/v1/transformation-rules/lookups'],
      ['post', '/api/v1/transformation-rules/lookups'],
    ] as const;
    const denial = { error: 'TRANSFORMATION_RULES_UNAVAILABLE' };
    for (const authorization of [undefined, 'Bearer verified', 'Bearer verified-b', 'Bearer platform']) {
      for (const [method, path] of routes) {
        const req = supertest(app)[method](path);
        if (authorization) req.set('Authorization', authorization);
        const response = await req.send({ name: 'rule', connector_type: 'test', sample_data: {} });
        expect([response.status, response.body]).toEqual([403, denial]);
      }
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the same denial for preflight and malformed JSON before global middleware can respond', async () => {
    const app = Reflect.get(new IntegrationHubServer(), 'app') as express.Application;
    const denial = { error: 'TRANSFORMATION_RULES_UNAVAILABLE' };
    for (const authorization of [undefined, 'Bearer verified', 'Bearer verified-b', 'Bearer platform']) {
      const preflight = supertest(app).options('/api/v1/transformation-rules/lookups')
        .set('Origin', 'https://tenant.invalid').set('Access-Control-Request-Method', 'POST');
      const malformed = supertest(app).post('/api/v1/transformation-rules')
        .set('Content-Type', 'application/json');
      if (authorization) {
        preflight.set('Authorization', authorization);
        malformed.set('Authorization', authorization);
      }
      const [preflightResponse, malformedResponse] = await Promise.all([
        preflight, malformed.send('{\"incomplete\":'),
      ]);
      expect([preflightResponse.status, preflightResponse.body]).toEqual([403, denial]);
      expect([malformedResponse.status, malformedResponse.body]).toEqual([403, denial]);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses bearer and API-key traffic before a failing credential store can run', async () => {
    const app = Reflect.get(new IntegrationHubServer(), 'app') as express.Application;
    mockCredentialLookup.mockImplementation(() => { throw new Error('Credential store unavailable'); });
    query.mockRejectedValue(new Error('Postgres unavailable'));
    for (const headers of [
      { Authorization: 'Bearer verified' },
      { 'x-api-key': 'verified-test-key' },
    ]) {
      const response = await supertest(app).post('/api/v1/transformation-rules/lookups')
        .set(headers).send({ name: 'lookup' });
      expect([response.status, response.body]).toEqual([403, { error: 'TRANSFORMATION_RULES_UNAVAILABLE' }]);
    }
    expect(mockCredentialLookup).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('never exposes custom descriptor defaults or extra metadata to authenticated tenants', async () => {
    const metadata = {
      type: 'test', name: 'Test', version: '1.0', description: 'Test descriptor',
      author: 'operator', category: 'connector', verified: true,
      configuration_schema: { properties: { client_secret: {
        type: 'string', description: 'Credential field', default: marker,
      } }, default: marker },
      resources: [{ id: 'items', name: 'Items', description: 'Read items', ci_type: 'Device',
        enabled_by_default: true, configuration_schema: { default: marker },
        metadata: { token: marker } }],
      metadata: { token: marker },
    };
    getAllConnectorTypes.mockReturnValue([metadata]);
    getConnectorMetadata.mockReturnValue(metadata);
    const user = { organizationId: orgA };
    const list = await request('GET', '/api/v1/connectors/types', user);
    const detail = await request('GET', '/api/v1/connectors/types/test', user);
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(JSON.parse(list.body).types).toEqual([JSON.parse(detail.body).metadata]);
    expect(list.body + detail.body).not.toContain(marker);
    expect(JSON.parse(detail.body).metadata.configuration_schema.properties.client_secret)
      .toEqual({ type: 'string', description: 'Credential field', required: false });
  });

  it('makes a foreign name indistinguishable from a missing name for reads, updates and runs', async () => {
    query.mockResolvedValue({ rows: [] });
    const missing = await request('GET', '/api/v1/connectors/missing', { organizationId: orgA });
    const foreign = await request('GET', '/api/v1/connectors/shared', { organizationId: orgA });
    expect(foreign).toEqual(missing);
    expect((await request('PUT', '/api/v1/connectors/shared', { organizationId: orgA }, { enabled: false })).status).toBe(404);
    expect((await request('POST', '/api/v1/connectors/shared/run', { organizationId: orgA })).status).toBe(404);
    expect(query.mock.calls.every(([, params]) => params.includes(orgA))).toBe(true);
    expect(unregisterConnector).not.toHaveBeenCalled();
    expect(runConnector).not.toHaveBeenCalled();
  });

  it('returns only own safe config and run fields, and scopes aggregate/run queries', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM connector_configurations c WHERE c.name') && sql.includes('SELECT c.id, c.organization_id')) return Promise.resolve({ rows: [row] });
      if (sql.includes('FROM connector_run_history r')) return Promise.resolve({ rows: [{ id: 'run-A', organization_id: orgA, status: 'completed' }] });
      return Promise.resolve({ rows: [{ ...row, total_runs: '1', successful_runs: '1' }] });
    });
    const user = { organizationId: orgA };
    const list = await request('GET', '/api/v1/connectors', user);
    const own = await request('GET', '/api/v1/connectors/shared', user);
    const runs = await request('GET', '/api/v1/connectors/shared/runs', user);
    expect(query.mock.calls[0][0]).not.toContain('SELECT *');
    expect(query.mock.calls[0][0]).toContain('r.organization_id IS NOT DISTINCT FROM c.organization_id');
    expect(query.mock.calls.find(([sql]) => sql.includes('connector_run_history r') && sql.includes('LIMIT $4'))?.[1]).toEqual(['cfg-A', orgA, false, 50, 0]);
    for (const response of [list, own, runs]) {
      expect(response.status).toBe(200);
      expect(response.body).not.toContain(marker);
    }
    expect(query.mock.calls.map(([sql]) => sql).join(' ')).not.toMatch(/\b(connection|options|resource_configs|errors|error_message|job_id)\b/);
  });

  it('does not echo nested write secrets or raw execution errors', async () => {
    query.mockResolvedValue({ rows: [{ id: 'cfg-A', organization_id: orgA, name: 'shared' }] });
    const user = { organizationId: orgA };
    const created = await request('POST', '/api/v1/connectors', user, { name: 'shared', type: 'test', connection: { client_secret: marker } });
    expect(created.body).not.toContain(marker);
    runConnector.mockRejectedValue(new Error(marker));
    const executed = await request('POST', '/api/v1/connectors/shared/run', user);
    expect(executed.status).toBe(500);
    expect(executed.body).not.toContain(marker);
    expect(JSON.stringify(query.mock.calls)).not.toContain('SELECT *');
  });

  it('returns only status fields for a successful run, not its job identifier or errors', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT c.id, c.organization_id')) return Promise.resolve({ rows: [row] });
      return Promise.resolve({ rows: [{ id: 'run-A', organization_id: orgA, status: 'completed' }] });
    });
    runConnector.mockResolvedValue({ run_id: 'secret-bearing-job-id', errors: [marker] });
    const response = await request('POST', '/api/v1/connectors/shared/run', { organizationId: orgA });
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('secret-bearing-job-id');
    expect(response.body).not.toContain(marker);
    expect(query.mock.calls[1][0]).toContain('r.config_id = $1 AND r.job_id = $2');
    expect(query.mock.calls[1][1]).toEqual(['cfg-A', 'secret-bearing-job-id', orgA, false]);
  });

  it('does not expose stored log message bytes', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT c.id, c.organization_id')) return Promise.resolve({ rows: [row] });
      if (sql.includes('SELECT r.id')) return Promise.resolve({ rows: [{ id: 'run-A' }] });
      return Promise.resolve({ rows: [{ id: 'log-A', level: 'error' }] });
    });
    const result = await request('GET', '/api/v1/connectors/shared/runs/run-A/logs', { organizationId: orgA });
    expect(result.status).toBe(200);
    expect(query.mock.calls[2][0]).not.toContain('message');
    expect(result.body).not.toContain(marker);
    expect(query.mock.calls[1][1]).toEqual(['run-A', 'cfg-A', orgA, false]);
  });
});
