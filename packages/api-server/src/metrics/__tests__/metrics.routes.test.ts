// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Root GET /metrics (HAP-771) through the real RestAPIServer stack: only the holder of
 * METRICS_SCRAPE_TOKEN (>= 32 chars) gets the registry; unset/short tokens answer 404; no
 * token or collector error text is echoed or logged. Tokens are generated per run.
 * Substitutions as in rest/__tests__/error-handler.test.ts.
 */

import { randomBytes } from 'crypto';
import request from 'supertest';

Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({}), getNeo4jClient: () => ({}), getAuditService: () => ({}),
  getUnifiedCredentialService: () => ({}), getCredentialSetService: () => ({}),
  getRedisClient: () => ({ getConnection: () => ({}) }),
}));
jest.mock('bcrypt', () => ({}));
jest.mock('../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: function Neo4jAuthRepository() { return { findUserById: async () => null }; },
}));
jest.mock('../../rest/routes/jobs.routes', () => ({ __esModule: true, default: jest.requireActual('express').Router() }));
jest.mock('../../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    RateLimitMiddleware: function RateLimitMiddleware() {
      return new Proxy({}, { get: () => () => pass });
    },
  };
});

import { getMetricsRegistry, loadConfig, logger } from '@cmdb/common';
import { JWTService } from '../../auth/jwt.service';
import { RestAPIServer } from '../../rest/server';

const TOKEN = randomBytes(32).toString('hex');
const logs: jest.SpyInstance[] = [];

function appWith(token: string | undefined) {
  if (token === undefined) delete process.env['METRICS_SCRAPE_TOKEN'];
  else process.env['METRICS_SCRAPE_TOKEN'] = token;
  const server = new RestAPIServer(); // built as index.ts does
  server.setupErrorHandling();
  return server.getApp();
}

const logged = () => JSON.stringify(logs.map((spy) => spy.mock.calls));

beforeEach(() => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    logs.push(jest.spyOn(logger, level).mockImplementation(() => logger));
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  logs.length = 0;
  delete process.env['METRICS_SCRAPE_TOKEN'];
});

describe('GET /metrics scrape token', () => {
  // T3: fail-closed when the token is unset, empty or shorter than 32 characters.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['31 characters', TOKEN.slice(0, 31)],
  ])('token %s: 404 with or without a bearer, no registry', async (_label, token) => {
    const app = appWith(token);
    for (const auth of [undefined, `Bearer ${token ?? ''}`]) {
      const req = request(app).get('/metrics');
      const res = await (auth ? req.set('Authorization', auth) : req);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('cmdb_');
    }
    if (token) expect(logged()).not.toContain(token);
  });

  // T4: with a token configured, every other credential shape is 401.
  it('wrong, missing or misplaced credentials: 401 Bearer challenge, no registry, token not logged', async () => {
    const app = appWith(TOKEN);
    const adminJwt = new JWTService(loadConfig().auth.jwt)
      .generateAccessToken('admin-1', 'root', 'admin', '00000000-0000-0000-0000-000000000000');
    const attempts: Array<[string, Record<string, string>]> = [
      ['/metrics', {}],
      ['/metrics', { Authorization: `Bearer ${randomBytes(32).toString('hex')}` }],
      ['/metrics', { Authorization: `Bearer ${TOKEN}x` }],
      ['/metrics', { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
      ['/metrics', { Authorization: `Basic ${TOKEN}` }],
      ['/metrics', { Authorization: TOKEN }],
      ['/metrics', { 'X-API-Key': TOKEN }],
      [`/metrics?token=${TOKEN}`, {}],
      ['/metrics', { Authorization: `Bearer ${adminJwt}` }],
    ];
    for (const [path, headers] of attempts) {
      const res = await request(app).get(path).set(headers);
      expect([path, headers, res.status]).toEqual([path, headers, 401]);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).toEqual({ _error: 'Unauthorized' });
      expect(res.text).not.toContain('cmdb_');
    }
    expect(logged()).not.toContain(TOKEN);
  });

  // T5: the configured bearer token gets the registry.
  it('correct bearer token: 200 Prometheus text, token not logged', async () => {
    const res = await request(appWith(TOKEN)).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toContain('cmdb_process_cpu');
    expect(logged()).not.toContain(TOKEN);
  });

  // T6: a collector failure answers a fixed body; its message stays out of body and logs.
  it('collector failure: fixed 500 body, error message neither echoed nor logged', async () => {
    const detail = `collector-detail-${randomBytes(8).toString('hex')}`;
    const app = appWith(TOKEN);
    jest.spyOn(getMetricsRegistry(), 'getMetrics').mockRejectedValueOnce(new Error(detail));
    const res = await request(app).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ _error: 'Failed to collect metrics' });
    expect(res.text).not.toContain(detail);
    expect(logged()).not.toContain(detail);
  });
});
