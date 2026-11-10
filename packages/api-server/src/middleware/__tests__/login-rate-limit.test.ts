// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1091: POST /auth/login rate limiting through the real AuthController wiring and the real
 * RateLimitMiddleware over an in-memory Redis. Buckets key on req.ip (Express `trust proxy`), never on a raw
 * X-Forwarded-For; login adds an account+client bucket and fails closed when the limiter store errors.
 * HAP-1368: PUT /auth/password gets the client bucket plus a per-user bucket across all clients, fail closed.
 * HAP-1764: `trust proxy` comes from TRUST_PROXY through applyTrustProxy; login adds a per-account bucket across all
 * clients; a fail-closed refusal is fixed (body, no-store, no X-RateLimit-*) and every limiter logs a store error by
 * class only.
 */

import { describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { inspect } from 'util';
import type { ConfigSchema } from '@cmdb/common';
import { getLogger, logger } from '@cmdb/common';
import { AuthController } from '../../rest/auth.controller';
import { applyTrustProxy } from '../../rest/trust-proxy';
import { AUTH_HEADER, AUTH_HEADER_VALUE } from '../../rest/middleware/refresh-cookie';
import { ValidationMiddleware } from '../../rest/middleware/validation.middleware';
import { AuthFailureError, AuthService, CurrentPasswordIncorrectError } from '../../auth/auth.service';
import { AuthMiddleware } from '../auth.middleware';
import { RateLimitMiddleware } from '../rate-limit.middleware';

const CLIENT_MAX = 4;
const ACCOUNT_MAX = 2;
const ACCOUNT_GLOBAL_MAX = 3;

/** A store message that quotes a credential, as a Redis connection error can. */
const STORE_NEEDLE = `needle-${randomUUID()}`;
const STORE_MESSAGE = `Connection is closed. redis://default:${STORE_NEEDLE}@redis.internal:6379`;

/** Sorted sets as the sliding-window limiter uses them. `down` fails every command the way ioredis does after its
 * retries (exec() resolves, each entry carrying the error); `rejects` makes exec() reject; `failKey` fails only the
 * pipelines on matching keys. */
class FakeRedis {
  down = false;
  rejects = false;
  failKey: (key: string) => boolean = () => false;
  private sets = new Map<string, number[]>();

  pipeline() {
    const ops: Array<() => unknown> = [];
    const keys: string[] = [];
    const set = (key: string) => this.sets.get(key) ?? this.sets.set(key, []).get(key)!;
    const pipe = {
      zremrangebyscore: (key: string, _min: string, max: string) => {
        keys.push(key);
        ops.push(() => this.sets.set(key, set(key).filter(score => score > Number(max))));
      },
      zcard: (key: string) => ops.push(() => set(key).length),
      zadd: (key: string, score: string) => ops.push(() => set(key).push(Number(score))),
      expire: () => ops.push(() => 1),
      exec: async () => {
        if (this.rejects) throw new Error(STORE_MESSAGE);
        if (this.down || keys.some(this.failKey)) return ops.map(() => [new Error(STORE_MESSAGE), null]);
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
      authAccountGlobal: { max: ACCOUNT_GLOBAL_MAX, ...window },
      discovery: { max: 100, ...window },
      admin: { max: 100, ...window },
    },
    monitoring: { enabled: false, logRateLimitHits: false },
  } as unknown as ConfigSchema['rateLimit'];
}

/**
 * Every login reaches the service as a wrong password (401) unless the limiter answers first. `trustProxy` is the
 * raw TRUST_PROXY value, applied as server.ts does; omitted = unset.
 */
function loginApp(redis: FakeRedis, trustProxy?: unknown) {
  const reached: string[] = [];
  const authService = {
    login: async ({ username }: { username: string }) => {
      reached.push(username);
      throw new AuthFailureError('invalid');
    },
  } as unknown as AuthService;
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  const authMiddleware = new Proxy({}, { get: () => pass }) as unknown as AuthMiddleware;
  const limiter = new RateLimitMiddleware(redis as never, rateLimitConfig());
  const app = express();
  applyTrustProxy(app, trustProxy);
  app.use(express.json());
  app.use('/api/v1/auth', new AuthController(authService, new ValidationMiddleware(), authMiddleware, limiter).getRouter());
  return Object.assign(app, { reached });
}

const login = (app: express.Express, username: string, headers: Record<string, string> = {}) =>
  request(app).post('/api/v1/auth/login').set(headers).send({ username, password: 'wrong-password' });

/** Captures every log call of both loggers (the limiter's getLogger() and the shared winston logger). */
async function capturingLogs<T>(run: () => Promise<T>): Promise<{ result: T; limiterErrors: unknown[][]; text: string }> {
  const targets = [getLogger(), logger] as unknown as Array<Record<string, (...args: unknown[]) => unknown>>;
  const spies = targets.flatMap(target =>
    (['error', 'warn', 'info', 'debug'] as const).map(level =>
      jest.spyOn(target, level).mockImplementation(() => undefined)));
  try {
    const result = await run();
    const limiterErrors = spies[0]!.mock.calls as unknown[][];
    const text = inspect(spies.map(spy => spy.mock.calls), { depth: null, maxStringLength: null });
    return { result, limiterErrors, text };
  } finally {
    spies.forEach(spy => spy.mockRestore());
  }
}

describe('POST /auth/login rate limiting (HAP-1091, HAP-1764)', () => {
  it.each([['unset', undefined], ['empty', ''], ['0', '0'], ['true (refused)', 'true']])(
    'TRUST_PROXY %s: rotating X-Forwarded-For / X-Real-IP from one socket client shares one bucket',
    async (_label, trustProxy) => {
      const app = loginApp(new FakeRedis(), trustProxy);
      const statuses: number[] = [];
      for (let i = 0; i <= CLIENT_MAX; i++) {
        const res = await login(app, `user${i}`, { 'X-Forwarded-For': `198.51.100.${i}`, 'X-Real-IP': `203.0.113.${i}` });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([...Array(CLIENT_MAX).fill(401), 429]);
      expect(app.reached).toHaveLength(CLIENT_MAX);
    });

  it('TRUST_PROXY=1 (one nginx hop): distinct clients get separate buckets and a forged leftmost entry stays in its client bucket', async () => {
    const app = loginApp(new FakeRedis(), '1');
    for (let i = 0; i < CLIENT_MAX; i++) {
      expect((await login(app, `user${i}`, { 'X-Forwarded-For': `192.0.2.${i}, 198.51.100.1` })).status).toBe(401);
    }
    expect((await login(app, 'carol', { 'X-Forwarded-For': '192.0.2.99, 198.51.100.1' })).status).toBe(429);
    expect((await login(app, 'carol', { 'X-Forwarded-For': '198.51.100.2' })).status).toBe(401);
  });

  it('TRUST_PROXY=loopback (trusted proxy address): the client address nginx appended is the key, a forged entry before it is not', async () => {
    const app = loginApp(new FakeRedis(), 'loopback');
    for (let i = 0; i < CLIENT_MAX; i++) {
      expect((await login(app, `user${i}`, { 'X-Forwarded-For': `192.0.2.${i}, 198.51.100.3` })).status).toBe(401);
    }
    expect((await login(app, 'dave', { 'X-Forwarded-For': '198.51.100.3' })).status).toBe(429);
    expect((await login(app, 'dave', { 'X-Forwarded-For': '198.51.100.4' })).status).toBe(401);
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

  it('one account from many client addresses is refused (429) past the per-account budget; other accounts are not', async () => {
    const app = loginApp(new FakeRedis(), 1);
    // ' Erin ' fails validation (400) after the limiter, but trimmed and lowercased it spent erin's budget.
    const names = ['erin', ' Erin ', 'ERIN', 'erin'];
    const statuses: number[] = [];
    for (const [i, name] of names.entries()) {
      statuses.push((await login(app, name, { 'X-Forwarded-For': `198.51.100.${20 + i}` })).status);
    }
    expect(statuses).toEqual([401, 400, 401, 429]);
    expect(app.reached).toEqual(['erin', 'ERIN']);
    expect((await login(app, 'frank', { 'X-Forwarded-For': '198.51.100.30' })).status).toBe(401);
  });

  it.each([
    ['every command fails (Redis down)', (redis: FakeRedis) => { redis.down = true; }],
    ['exec() rejects', (redis: FakeRedis) => { redis.rejects = true; }],
    ['only the account bucket fails, after the client bucket answered',
      (redis: FakeRedis) => { redis.failKey = key => key.includes('-account'); }],
  ])('a limiter store error (%s) on login fails closed: fixed 503, no-store, never the password check, logged by class only',
    async (_label, breakStore) => {
      const redis = new FakeRedis();
      breakStore(redis);
      const app = loginApp(redis, 1);
      const { result: res, limiterErrors, text } = await capturingLogs(() => login(app, 'alice'));

      expect([res.status, res.body]).toEqual([503, {
        _error: 'Service Unavailable',
        _message: 'Rate limiting is unavailable. Try again later',
      }]);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.headers).filter(name => name.startsWith('x-ratelimit'))).toEqual([]);
      expect(app.reached).toEqual([]);
      expect(limiterErrors).toEqual([[expect.any(String), undefined, { endpoint: 'auth', errorClass: 'Error' }]]);
      expect(text).not.toContain(STORE_NEEDLE);
      expect(text).not.toContain('Connection is closed');
    });
});

describe('limiter store errors outside login (HAP-1764)', () => {
  it('a failClosed limiter sets no-store itself, wherever it is mounted', async () => {
    const redis = new FakeRedis();
    redis.down = true;
    const limiter = new RateLimitMiddleware(redis as never, rateLimitConfig());
    let reached = false;
    const app = express();
    app.post('/probe', limiter.limit('auth', { failClosed: true }), (_req, res) => {
      reached = true;
      res.json({});
    });
    const { result: res, text } = await capturingLogs(() => request(app).post('/probe'));
    expect([res.status, res.headers['cache-control'], reached]).toEqual([503, 'no-store', false]);
    expect(text).not.toContain(STORE_NEEDLE);
  });

  it('the refresh limiter keeps failing open (reaches the refresh check) and logs the store error by class only', async () => {
    const redis = new FakeRedis();
    redis.down = true;
    const app = loginApp(redis, 1);
    const { result: res, limiterErrors, text } = await capturingLogs(() =>
      request(app).post('/api/v1/auth/refresh').set(AUTH_HEADER, AUTH_HEADER_VALUE));
    expect([res.status, res.body]).toEqual([401, { success: false, error: 'Authentication failed' }]);
    expect(limiterErrors).toEqual([[expect.any(String), undefined, { endpoint: 'auth-refresh', errorClass: 'Error' }]]);
    expect(text).not.toContain(STORE_NEEDLE);
  });
});

/** Every password change reaches the service as a wrong current password (400) unless the limiter answers first. */
function passwordApp(redis: FakeRedis) {
  const reached: string[] = [];
  const authService = {
    login: async () => {
      throw new AuthFailureError('invalid');
    },
    auditChainReady: () => true,
    auditPasswordChange: async () => undefined,
    changePassword: async (userId: string) => {
      reached.push(userId);
      throw new CurrentPasswordIncorrectError();
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

  it('logins and password changes from one client address spend one shared client budget', async () => {
    const { app } = passwordApp(new FakeRedis());
    for (let i = 0; i < CLIENT_MAX; i++) {
      expect((await login(app, `user${i}`, { 'X-Forwarded-For': '198.51.100.9' })).status).toBe(401);
    }
    expect((await changePassword(app, 'user-a', '198.51.100.9')).status).toBe(429);
  });

  it('a limiter store error fails closed with a no-store 503, never reaching the password check, logged by class only', async () => {
    const redis = new FakeRedis();
    redis.down = true;
    const { app, reached } = passwordApp(redis);
    const { result: res, text } = await capturingLogs(() => changePassword(app, 'user-a', '198.51.100.1'));
    expect([res.status, res.headers['cache-control']]).toEqual([503, 'no-store']);
    expect(reached).toEqual([]);
    expect(text).not.toContain(STORE_NEEDLE);
  });
});
