// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1091: POST /auth/login rate limiting through the real AuthController wiring and the real
 * RateLimitMiddleware over an in-memory Redis. Buckets key on req.ip (Express `trust proxy`), never on a raw
 * X-Forwarded-For; login adds an account+client bucket and fails closed when the limiter store errors.
 * HAP-1368: PUT /auth/password gets the client bucket plus a per-user bucket across all clients, fail closed.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { ConfigSchema } from '@cmdb/common';
import { AuthController } from '../../rest/auth.controller';
import { ValidationMiddleware } from '../../rest/middleware/validation.middleware';
import { AuthFailureError, AuthService } from '../../auth/auth.service';
import { AuthMiddleware } from '../auth.middleware';
import { RateLimitMiddleware } from '../rate-limit.middleware';

const CLIENT_MAX = 4;
const ACCOUNT_MAX = 2;

/** Sorted sets as the sliding-window limiter uses them; `down` fails every command the way ioredis does after its
 * retries: exec() resolves, each entry carrying the error. */
class FakeRedis {
  down = false;
  private sets = new Map<string, number[]>();

  pipeline() {
    const ops: Array<() => unknown> = [];
    const set = (key: string) => this.sets.get(key) ?? this.sets.set(key, []).get(key)!;
    const pipe = {
      zremrangebyscore: (key: string, _min: string, max: string) =>
        ops.push(() => this.sets.set(key, set(key).filter(score => score > Number(max)))),
      zcard: (key: string) => ops.push(() => set(key).length),
      zadd: (key: string, score: string) => ops.push(() => set(key).push(Number(score))),
      expire: () => ops.push(() => 1),
      exec: async () =>
        this.down ? ops.map(() => [new Error('Connection is closed.'), null]) : ops.map(op => [null, op()]),
    };
    return pipe;
  }
}

function rateLimitConfig(): ConfigSchema['rateLimit'] {
  const window = { windowMs: 60_000 };
  return {
    enabled: true,
    bypassHeader: 'X-Internal-Service',
    tierMultipliers: { standard: 1, premium: 1, enterprise: 1 },
    endpoints: {
      rest: { max: 100, ...window },
      graphql: { max: 100, ...window },
      health: { max: 0, ...window },
      auth: { max: CLIENT_MAX, ...window },
      authAccount: { max: ACCOUNT_MAX, ...window },
      discovery: { max: 100, ...window },
      admin: { max: 100, ...window },
    },
    monitoring: { enabled: false, logRateLimitHits: false },
  } as unknown as ConfigSchema['rateLimit'];
}

/** Every login reaches the service as a wrong password (401) unless the limiter answers first. */
function loginApp(redis: FakeRedis, trustProxy?: number) {
  const authService = {
    login: async () => {
      throw new AuthFailureError('invalid');
    },
  } as unknown as AuthService;
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  const authMiddleware = new Proxy({}, { get: () => pass }) as unknown as AuthMiddleware;
  const limiter = new RateLimitMiddleware(redis as never, rateLimitConfig());
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(express.json());
  app.use('/api/v1/auth', new AuthController(authService, new ValidationMiddleware(), authMiddleware, limiter).getRouter());
  return app;
}

const login = (app: express.Express, username: string, headers: Record<string, string> = {}) =>
  request(app).post('/api/v1/auth/login').set(headers).send({ username, password: 'wrong-password' });

describe('POST /auth/login rate limiting (HAP-1091)', () => {
  it('trust proxy unset: rotating X-Forwarded-For / X-Real-IP from one socket client shares one bucket', async () => {
    const app = loginApp(new FakeRedis());
    const statuses: number[] = [];
    for (let i = 0; i <= CLIENT_MAX; i++) {
      const res = await login(app, `user${i}`, { 'X-Forwarded-For': `198.51.100.${i}`, 'X-Real-IP': `203.0.113.${i}` });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([...Array(CLIENT_MAX).fill(401), 429]);
  });

  it('one trusted hop: distinct clients get separate buckets and a forged leftmost entry stays in its client bucket', async () => {
    const app = loginApp(new FakeRedis(), 1);
    for (let i = 0; i < CLIENT_MAX; i++) {
      expect((await login(app, `user${i}`, { 'X-Forwarded-For': `192.0.2.${i}, 198.51.100.1` })).status).toBe(401);
    }
    expect((await login(app, 'carol', { 'X-Forwarded-For': '192.0.2.99, 198.51.100.1' })).status).toBe(429);
    expect((await login(app, 'carol', { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(401);
  });

  it('account+client bucket survives header rotation; another username from that client keeps the client budget', async () => {
    const app = loginApp(new FakeRedis(), 1);
    const from = (i: number) => ({ 'X-Forwarded-For': `192.0.2.${i}, 198.51.100.7` });
    expect((await login(app, 'alice', from(1))).status).toBe(401);
    expect((await login(app, 'ALICE', from(2))).status).toBe(401);
    expect((await login(app, 'alice', from(3))).status).toBe(429);
    expect((await login(app, 'bob', from(4))).status).toBe(401);
    expect((await login(app, 'alice', { 'X-Forwarded-For': '198.51.100.8' })).status).toBe(401);
  });

  it('a limiter store error on login fails closed with 503, never reaching the password check', async () => {
    const redis = new FakeRedis();
    redis.down = true;
    const res = await login(loginApp(redis), 'alice');
    expect(res.status).toBe(503);
  });
});

/** Every password change reaches the service as a wrong current password (400) unless the limiter answers first. */
function passwordApp(redis: FakeRedis) {
  const reached: string[] = [];
  const authService = {
    auditChainReady: () => true,
    auditPasswordChange: async () => undefined,
    changePassword: async (userId: string) => {
      reached.push(userId);
      throw new Error('Current password is incorrect');
    },
  } as unknown as AuthService;
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  // The verified subject comes from the test's X-Test-User header (stands in for the JWT).
  const authenticate = () => (req: express.Request, _res: unknown, next: () => void) => {
    (req as express.Request & { user?: unknown }).user = { _userId: req.header('X-Test-User') };
    next();
  };
  const authMiddleware = new Proxy({}, { get: (_target, name) => (name === 'authenticate' ? authenticate : pass) });
  const limiter = new RateLimitMiddleware(redis as never, rateLimitConfig());
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/auth', new AuthController(authService, new ValidationMiddleware(),
    authMiddleware as unknown as AuthMiddleware, limiter).getRouter());
  return { app, reached };
}

const changePassword = (app: express.Express, userId: string, clientAddress: string) =>
  request(app).put('/api/v1/auth/password').set({ 'X-Test-User': userId, 'X-Forwarded-For': clientAddress })
    .send({ currentPassword: randomUUID(), newPassword: randomUUID() });

describe('PUT /auth/password rate limiting (HAP-1368)', () => {
  it('one client address guessing for many users is refused (429) after the client budget', async () => {
    const { app } = passwordApp(new FakeRedis());
    const statuses: number[] = [];
    for (let i = 0; i <= CLIENT_MAX; i++) statuses.push((await changePassword(app, `user-${i}`, '198.51.100.9')).status);
    expect(statuses).toEqual([...Array(CLIENT_MAX).fill(400), 429]);
  });

  it('the per-user bucket holds across client addresses', async () => {
    const { app } = passwordApp(new FakeRedis());
    const statuses: number[] = [];
    for (let i = 0; i <= ACCOUNT_MAX; i++) statuses.push((await changePassword(app, 'user-a', `198.51.100.${i}`)).status);
    expect(statuses).toEqual([...Array(ACCOUNT_MAX).fill(400), 429]);
  });

  it('a limiter store error fails closed with 503, never reaching the password check', async () => {
    const redis = new FakeRedis();
    redis.down = true;
    const { app, reached } = passwordApp(redis);
    expect((await changePassword(app, 'user-a', '198.51.100.1')).status).toBe(503);
    expect(reached).toEqual([]);
  });
});
