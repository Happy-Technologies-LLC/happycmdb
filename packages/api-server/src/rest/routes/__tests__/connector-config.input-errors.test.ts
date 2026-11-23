// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Real connector-config router and controllers against a mocked pool: malformed
 * UUID path ids answer the existing 404 without a query, unique-name violations
 * answer 409 without echoing the driver detail, empty runs report 0/0 counts,
 * and over-length schedule / resource_id are rejected by validation.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const ORG = '11111111-1111-4111-8111-111111111111';
const CFG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DETAIL = 'Key (organization_id, name)=(secret-org, dup) already exists.';

type Row = Record<string, unknown>;
type Call = [string, unknown[]];

const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>>();
const mockPool = { query: (sql: string, params?: unknown[]) => mockQuery(sql, params) };

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: mockPool }),
  getNeo4jClient: () => ({}),
}));
jest.mock('../../../middleware/audit.middleware', () => ({
  auditMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    authenticate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  }),
}));

import { connectorConfigRoutes } from '../connector-config.routes';

const app = express();
app.use(express.json());
app.use((req: Request, _res: Response, next: () => void) => {
  (req as Request & { user?: unknown }).user = { _userId: 'u', _role: 'admin', _organizationId: ORG };
  next();
});
app.use('/connector-configs', connectorConfigRoutes);

const NOT_FOUND_CONFIG = { success: false, error: 'Not Found', message: 'Configuration not found' };
const NOT_FOUND_RUN = { success: false, error: 'Not Found', message: 'Run not found' };
const sqlCalls = (): Call[] => mockQuery.mock.calls.map(c => [c[0], c[1] ?? []] as Call);
const pgError = (code: string, detail?: string) => Object.assign(new Error('pg'), { code, detail });

/** Postgres stand-in: a malformed uuid literal fails like the driver does. */
function pool(handler: (sql: string, params: unknown[]) => Row[] | Error): void {
  mockQuery.mockImplementation(async (sql, params = []) => {
    if (params.some(p => typeof p === 'string' && /^z/.test(p))) throw pgError('22P02');
    const out = handler(sql, params);
    if (out instanceof Error) throw out;
    return { rows: out };
  });
}

beforeEach(() => {
  pool(() => []);
});

describe('malformed uuid path ids', () => {
  it.each([
    ['GET', '/connector-configs/zzz', NOT_FOUND_CONFIG],
    ['GET', '/connector-configs/zzz/metrics', NOT_FOUND_CONFIG],
    ['GET', '/connector-configs/zzz/runs', NOT_FOUND_CONFIG],
    ['GET', '/connector-configs/zzz/resources/r1/metrics', NOT_FOUND_CONFIG],
    ['PUT', '/connector-configs/zzz', NOT_FOUND_CONFIG],
    ['DELETE', '/connector-configs/zzz', NOT_FOUND_CONFIG],
    ['POST', '/connector-configs/zzz/enable', NOT_FOUND_CONFIG],
    ['POST', '/connector-configs/zzz/run', NOT_FOUND_CONFIG],
    ['GET', '/connector-configs/runs/zzz', NOT_FOUND_RUN],
    ['POST', '/connector-configs/runs/zzz/cancel', NOT_FOUND_RUN],
  ])('%s %s answers 404 without a query', async (method, path, body) => {
    const res = await request(app)[method.toLowerCase() as 'get' | 'put' | 'delete' | 'post'](path).send(
      method === 'PUT' ? { enabled: false } : undefined
    );
    expect([res.status, res.body]).toEqual([404, body]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still reaches the pool for a valid uuid', async () => {
    pool(() => [{ id: CFG, name: 'c' }]);
    const res = await request(app).get(`/connector-configs/${CFG}`);
    expect(res.status).toBe(200);
    expect(sqlCalls()).toHaveLength(1);
    expect(sqlCalls()[0][1][0]).toBe(CFG);

    pool(() => [{ id: RUN, status: 'running' }]);
    const run = await request(app).get(`/connector-configs/runs/${RUN}`);
    expect(run.status).toBe(200);
  });

  it('does not capture the static runs/all segment as an id', async () => {
    pool(sql => (/COUNT/i.test(sql) ? [{ count: '0' }] : []));
    const res = await request(app).get('/connector-configs/runs/all');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(0);
  });
});

describe('unique name violations', () => {
  it('update onto an existing name answers 409 without the driver detail', async () => {
    pool(sql => (/^\s*UPDATE/i.test(sql) ? pgError('23505', DETAIL) : [{ id: CFG }]));
    const res = await request(app).put(`/connector-configs/${CFG}`).send({ name: 'dup' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: 'Conflict',
      message: "Configuration with name 'dup' already exists",
    });
    expect(JSON.stringify(res.body)).not.toContain(DETAIL);
  });

  it('create racing a concurrent insert answers 409 without the driver detail', async () => {
    pool(sql => {
      if (/installed_connectors/i.test(sql)) return [{ connector_type: 'aws' }];
      if (/^\s*INSERT/i.test(sql)) return pgError('23505', DETAIL);
      return [];
    });
    const res = await request(app)
      .post('/connector-configs')
      .send({ name: 'dup', connector_type: 'aws', connection: {} });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false,
      error: 'Conflict',
      message: "Configuration with name 'dup' already exists",
    });
    expect(JSON.stringify(res.body)).not.toContain(DETAIL);
  });

  it('a non-unique database failure on update stays 500', async () => {
    pool(sql => (/^\s*UPDATE/i.test(sql) ? pgError('08006', DETAIL) : [{ id: CFG }]));
    const res = await request(app).put(`/connector-configs/${CFG}`).send({ name: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(DETAIL);
  });
});

describe('metrics on a config with no runs', () => {
  it('reports zero successful and failed runs', async () => {
    pool(sql =>
      /FROM connector_run_history/i.test(sql)
        ? [{ total_runs: '0', successful_runs: null, failed_runs: null, avg_duration_ms: null,
            total_records_extracted: null, total_records_loaded: null }]
        : [{ id: CFG }]
    );
    const res = await request(app).get(`/connector-configs/${CFG}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      total_runs: 0, successful_runs: 0, failed_runs: 0, success_rate: 0,
    });
  });

  it('keeps counts and success rate for a config with runs', async () => {
    pool(sql =>
      /FROM connector_run_history/i.test(sql)
        ? [{ total_runs: '4', successful_runs: '3', failed_runs: '1', avg_duration_ms: '10',
            total_records_extracted: '5', total_records_loaded: '6' }]
        : [{ id: CFG }]
    );
    const res = await request(app).get(`/connector-configs/${CFG}/metrics`);
    expect(res.body.data).toMatchObject({
      total_runs: 4, successful_runs: 3, failed_runs: 1, success_rate: 75,
    });
  });
});

describe('length bounds', () => {
  const long = 'x'.repeat(101);
  const max = 'x'.repeat(100);
  const createBody = (schedule: string) => ({ name: 'n', connector_type: 'aws', connection: {}, schedule });

  function createPool() {
    pool(sql => {
      if (/installed_connectors/i.test(sql)) return [{ connector_type: 'aws' }];
      if (/^\s*INSERT/i.test(sql)) return [{ id: CFG }];
      return [];
    });
  }
  const inserts = () => sqlCalls().filter(([sql]) => /^\s*INSERT/i.test(sql));
  const updates = () => sqlCalls().filter(([sql]) => /^\s*UPDATE/i.test(sql));

  it('rejects a 101 character schedule on create and accepts 100', async () => {
    createPool();
    const bad = await request(app).post('/connector-configs').send(createBody(long));
    expect(bad.status).toBe(400);
    expect(inserts()).toHaveLength(0);
    const ok = await request(app).post('/connector-configs').send(createBody(max));
    expect(ok.status).toBe(201);
    expect(inserts()).toHaveLength(1);
  });

  it('rejects a 101 character schedule on update and accepts 100', async () => {
    pool(() => [{ id: CFG }]);
    const bad = await request(app).put(`/connector-configs/${CFG}`).send({ schedule: long });
    expect(bad.status).toBe(400);
    expect(updates()).toHaveLength(0);
    const ok = await request(app).put(`/connector-configs/${CFG}`).send({ schedule: max });
    expect(ok.status).toBe(200);
    expect(updates()).toHaveLength(1);
  });

  it('stores an empty update schedule as NULL', async () => {
    pool(() => [{ id: CFG }]);
    const res = await request(app).put(`/connector-configs/${CFG}`).send({ schedule: '' });
    expect(res.status).toBe(200);
    const [sql, params] = updates()[0];
    expect(sql).toMatch(/schedule = \$1/);
    expect(params[0]).toBeNull();
  });

  it('rejects a 101 character resource_id on run without a query and accepts 100', async () => {
    pool(sql => (/INSERT/i.test(sql) ? [{ id: RUN }] : [{ id: CFG, enabled: true, credential_id: null }]));
    const bad = await request(app).post(`/connector-configs/${CFG}/run`).send({ resource_id: long });
    expect(bad.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    const ok = await request(app).post(`/connector-configs/${CFG}/run`).send({ resource_id: max });
    expect(ok.status).toBe(202);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][1]).toContain(max);
  });
});
