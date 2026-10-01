// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * RestAPIServer bind address.
 *
 * The CO-1 acceptance runner sets SERVER_HOST=127.0.0.1 and refuses
 * non-loopback listeners, so the api-server must bind to SERVER_HOST when it
 * is set. Unset/empty must keep Node's default (no host argument) bind.
 */

import { randomBytes } from 'crypto';
import { once } from 'events';
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

// No database is contacted: route modules only need the client getters to exist.
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({}),
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
  getUnifiedCredentialService: () => ({}),
  getCredentialSetService: () => ({}),
  getRedisClient: () => ({ getConnection: () => ({}) }),
}));

// Plain functions (not jest.fn): the unit config resets mock implementations.
// Every AuthMiddleware factory (authenticate, requireRole, requirePermission, ...)
// yields a pass-through handler; no request is served in this suite, so the
// AuthService is never called.
jest.mock('../../auth/auth-bootstrap', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  const middleware = new Proxy({}, { get: () => () => pass });
  return { getAuthMiddleware: () => middleware, getAuthService: () => ({}) };
});

// JobsController opens a BullMQ Redis connection at import; replace the router
// so no socket to 127.0.0.1:6379 is attempted.
jest.mock('../routes/jobs.routes', () => ({
  __esModule: true,
  default: jest.requireActual('express').Router(),
}));

// RateLimitMiddleware starts an un-unref'd cleanup interval in its constructor,
// which would keep Jest alive; every limiter factory yields a pass-through.
jest.mock('../../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    RateLimitMiddleware: function RateLimitMiddleware() {
      return new Proxy({}, { get: () => () => pass });
    },
  };
});

// Imported after mocks are registered (jest hoists jest.mock).
import { RestAPIServer, listenTargetFromEnv } from '../server';

const open: Server[] = [];

// Resolves with the bound address; rejects on a listen 'error'.
async function listening(server: Server): Promise<AddressInfo> {
  open.push(server);
  await once(server, 'listening');
  return server.address() as AddressInfo;
}

// Built through the same helper index.ts uses to read PORT/SERVER_HOST.
function startFromEnv(env: NodeJS.ProcessEnv): Promise<AddressInfo> {
  const { port, host } = listenTargetFromEnv(env);
  return listening(new RestAPIServer(port, host).start());
}

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe('RestAPIServer listen address', () => {
  it('binds to SERVER_HOST when set', async () => {
    const address = await startFromEnv({ PORT: '0', SERVER_HOST: '127.0.0.1' });

    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
  });

  it.each([
    ['unset', {}],
    ['empty', { SERVER_HOST: '' }],
  ])('keeps the default bind when SERVER_HOST is %s', async (_label, extra) => {
    const control = await listening(express().listen(0));
    const address = await startFromEnv({ PORT: '0', ...extra });

    expect({ address: address.address, family: address.family }).toEqual({
      address: control.address,
      family: control.family,
    });
  });
});
