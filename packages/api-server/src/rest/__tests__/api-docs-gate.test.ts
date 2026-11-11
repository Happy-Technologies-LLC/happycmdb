// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-900: /api-docs serves the full OpenAPI spec without authentication, so the
 * real RestAPIServer mounts it only when API_DOCS_ENABLED is exactly `true`.
 * Requests go through the app the server builds; only its database/auth/queue
 * collaborators are replaced (same substitutions as server.listen.test.ts).
 */

import { randomBytes } from 'crypto';
import { join } from 'path';
import request from 'supertest';
import YAML from 'yamljs';

// Placeholder config so loadConfig() validates; no database server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({}),
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
  getUnifiedCredentialService: () => ({}),
  getCredentialSetService: () => ({}),
  getRedisClient: () => ({ getConnection: () => ({}) }),
}));

jest.mock('../../auth/auth-bootstrap', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  const middleware = new Proxy({}, { get: () => () => pass });
  return { getAuthMiddleware: () => middleware, getAuthService: () => ({}) };
});

// JobsController opens a BullMQ Redis connection at import.
jest.mock('../routes/jobs.routes', () => ({
  __esModule: true,
  default: jest.requireActual('express').Router(),
}));

// RateLimitMiddleware starts a cleanup interval that would keep Jest alive.
jest.mock('../../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    RateLimitMiddleware: function RateLimitMiddleware() {
      return new Proxy({}, { get: () => () => pass });
    },
  };
});

const SPEC_FILE = join(__dirname, '../../openapi/openapi.yaml');
const KNOWN_PATH = '/auth/login';
const SPEC_ERROR = 'Failed to load OpenAPI specification';

type Built = {
  app: import('express').Express;
  specLoads: jest.SpyInstance;
  errors: jest.SpyInstance;
};

// loadConfig() memoises, so each case builds the server in a fresh module registry
// with the env value it is testing.
function buildServer(apiDocsEnabled: string | undefined): Built {
  if (apiDocsEnabled === undefined) delete process.env['API_DOCS_ENABLED'];
  else process.env['API_DOCS_ENABLED'] = apiDocsEnabled;

  let built!: Built;
  jest.isolateModules(() => {
    const yaml = require('yamljs');
    const { logger } = require('@cmdb/common');
    const specLoads = jest.spyOn(yaml, 'load');
    const errors = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const { RestAPIServer } = require('../server');
    built = { app: new RestAPIServer(0).getApp(), specLoads, errors };
  });
  return built;
}

const SUB_PATHS = ['/api-docs', '/api-docs/', '/api-docs/openapi.json', '/api-docs/openapi.yaml', '/api-docs/health'];

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env['API_DOCS_ENABLED'];
});

describe('/api-docs gate (API_DOCS_ENABLED)', () => {
  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['empty', ''],
    ['TRUE (not exactly true)', 'TRUE'],
    ['1', '1'],
    ['yes', 'yes'],
  ])('is not mounted when API_DOCS_ENABLED is %s', async (_label, value) => {
    const { app, specLoads, errors } = buildServer(value);

    for (const path of SUB_PATHS) {
      const res = await request(app).get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    expect(specLoads).not.toHaveBeenCalled();
    expect(errors.mock.calls.some(([message]) => message === SPEC_ERROR)).toBe(false);
  });

  it('serves the real spec when API_DOCS_ENABLED=true', async () => {
    const { app, errors } = buildServer('true');
    const onDisk = YAML.load(SPEC_FILE);

    const ui = await request(app).get('/api-docs/');
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toMatch(/html/);

    const json = await request(app).get('/api-docs/openapi.json');
    expect(json.status).toBe(200);
    expect(Object.keys(json.body.paths)).toContain(KNOWN_PATH);
    expect(Object.keys(json.body.paths)).toEqual(Object.keys(onDisk.paths));
    expect(json.body.info.description).not.toMatch(/currently unavailable/);

    const health = await request(app).get('/api-docs/health');
    expect(health.body.paths_count).toBe(Object.keys(onDisk.paths).length);
    expect(errors.mock.calls.some(([message]) => message === SPEC_ERROR)).toBe(false);
  });
});
