// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import supertest from 'supertest';
import { connectorsRouter } from '../connectors.routes';
import { IntegrationHubServer } from '../../index';
import { getPostgresClient } from '@cmdb/database';
import { getIntegrationManager, getConnectorRegistry } from '@cmdb/integration-framework';

jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn(() => ({ query: (...args: unknown[]) => query(...args) })) }));
jest.mock('@cmdb/integration-framework', () => ({
  getIntegrationManager: jest.fn(() => ({
    runConnector: (...args: unknown[]) => runConnector(...args),
    unregisterConnector: (...args: unknown[]) => unregisterConnector(...args),
    mapRowToConfig: (value: object) => value,
    registerConnector: jest.fn(),
    testConnector: jest.fn(),
  })),
  getConnectorRegistry: jest.fn(() => ({ hasConnectorType: () => true })),
}));
jest.mock('@cmdb/api-server/auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    authenticate: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.headers.authorization !== 'Bearer verified') return res.status(401).json({ error: 'Unauthorized' });
      Object.assign(req, { user: { organizationId: orgA, _role: 'operator' } });
      return next();
    },
  }),
}), { virtual: true });
jest.mock('../transformation-rules.routes', () => ({ transformationRulesRouter: express.Router() }));
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
const marker = 'client_secret=NEVER_RETURN_ME';
const row = { id: 'cfg-A', organization_id: orgA, name: 'shared', enabled: true };
const query = jest.fn();
const runConnector = jest.fn();
const unregisterConnector = jest.fn();

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
