// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Global REST error handler (RestAPIServer.setupErrorHandling), exercised
 * through the real RestAPIServer middleware stack. Body parsers run before
 * /api/v1 authenticate(), so a bad or oversized body reaches the handler with
 * or without credentials; an undecodable path parameter reaches it once a
 * router matches, after authentication. The handler must answer with the
 * client status and fixed text, never err.message, and must not log request
 * bodies.
 *
 * Substitutions: Neo4jAuthRepository -> in-memory user; database getters ->
 * stubs (no route here reaches a database); jobs routes and the rate limiter
 * -> pass-throughs (they open Redis connections/timers at construction).
 */

import { randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
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

// bcrypt's native binding is only used for password hashing/login, never by token verification.
jest.mock('bcrypt', () => ({}));

const ORG = '00000000-0000-0000-0000-000000000000';
jest.mock('../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: function Neo4jAuthRepository() {
    return {
      findUserById: async (userId: string) => (userId === 'user-a'
        ? { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG }
        : null),
    };
  },
}));

jest.mock('../routes/jobs.routes', () => ({
  __esModule: true,
  default: jest.requireActual('express').Router(),
}));

jest.mock('../../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    RateLimitMiddleware: function RateLimitMiddleware() {
      return new Proxy({}, { get: () => () => pass });
    },
  };
});

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig, logger } from '@cmdb/common';
import { JWTService } from '../../auth/jwt.service';
import { RestAPIServer } from '../server';

const SECRET = 'hunter2-db-password';

// Built as index.ts does: routes, extra mounts (GraphQL there, fault routes
// here), then the catch-all error handler.
const server = new RestAPIServer();
server.getApp().get('/test/throw', () => {
  throw new Error(`connect ECONNREFUSED pg-internal.svc:5432 user=cmdb password=${SECRET}`);
});
server.getApp().get('/test/conflict', (_req: Request, _res: Response, next: NextFunction) => {
  next(Object.assign(new Error(`row owned by tenant ${SECRET}`), { status: 409 }));
});
server.setupErrorHandling();
const app = server.getApp();

const AUTH = {
  Authorization: `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken('user-a', 'alice', 'operator', ORG)}`,
};

describe('global error handler', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  });

  it('malformed JSON returns 400 without echoing the parser message', async () => {
    // Not JSON at all: body-parser's strict-mode error message (and stack)
    // quotes the body verbatim, so echoing or logging it would leak SECRET.
    for (const headers of [{}, AUTH]) {
      const res = await request(app).post('/api/v1/business-services').set(headers)
        .set('Content-Type', 'application/json').send(SECRET);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ _error: 'Bad Request', _message: 'Malformed request body' });
      expect(res.text).not.toContain(SECRET);
    }
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain(SECRET);
  });

  it('oversized body returns 413', async () => {
    // server.ts: json({ limit: '10mb' }).
    const res = await request(app).post('/api/v1/business-services').set(AUTH)
      .set('Content-Type', 'application/json').send(`{"a":"${'x'.repeat(10 * 1024 * 1024)}"}`);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ _error: 'Payload Too Large', _message: 'Request body too large' });
  });

  it('undecodable path param returns 400', async () => {
    const res = await request(app).get('/api/v1/business-services/bs-%E0%A4%A').set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ _error: 'Bad Request', _message: 'Malformed URL encoding' });
    expect(res.text).not.toContain('%E0');
  });

  it('unexpected error returns 500 with no err.message in the body', async () => {
    const res = await request(app).get('/test/throw');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ _error: 'Internal Server Error', _message: 'An unexpected error occurred' });
    for (const part of ['ECONNREFUSED', 'pg-internal', '5432', SECRET]) expect(res.text).not.toContain(part);
    // Diagnostics stay server-side.
    expect(error).toHaveBeenCalledWith('API Error', expect.objectContaining({ error: expect.stringContaining('pg-internal') }));
  });

  it('a 4xx err.status is honoured', async () => {
    const res = await request(app).get('/test/conflict');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ _error: 'Conflict', _message: 'Request could not be processed' });
    expect(res.text).not.toContain(SECRET);
  });
});
