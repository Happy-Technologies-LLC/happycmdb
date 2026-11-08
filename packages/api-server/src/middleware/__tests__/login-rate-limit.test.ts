// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1091: POST /auth/login rate limiting through the real AuthController wiring and the real
 * RateLimitMiddleware over an in-memory Redis. Buckets key on req.ip (Express `trust proxy`), never on a raw
 * X-Forwarded-For; login adds an account+client bucket and fails closed when the limiter store errors.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import { AuthController } from '../../rest/auth.controller';
import { ValidationMiddleware } from '../../rest/middleware/validation.middleware';
import { AuthFailureError, AuthService } from '../../auth/auth.service';
import { AuthMiddleware } from '../auth.middleware';
import { RateLimitMiddleware } from '../rate-limit.middleware';

const CLIENT_MAX = 4;
const ACCOUNT_MAX = 2;

/** Sorted sets as the sliding-window limiter uses them; `down` makes every pipeline fail like a lost connection. */
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
      exec: async () => {
        if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
        return ops.map(op => [null, op()]);
      },
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
