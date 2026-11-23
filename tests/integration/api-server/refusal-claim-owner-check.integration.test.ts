// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * #346 follow-up L2: the refusal-audit claim's owner check, run as the real Lua script on the integration suite's real
 * Redis (REDIS_HOST/REDIS_PORT from the global setup). The RateLimitMiddleware's own `claim` and `backoff` (the
 * SET NX PX and the EVAL of BACKOFF_CLAIM_SCRIPT) are taken from a real refusal, so no script text is copied here: a
 * backoff by anyone but the token's owner must answer false and leave the key and its TTL alone. Removing the owner
 * comparison from the script makes the non-owner, cross-user, absent-key and stale-owner tests fail.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import express from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import { RateLimitMiddleware, type Refusal } from '../../../packages/api-server/src/middleware/rate-limit.middleware';

const WINDOW_MS = 60_000;
const BACKOFF_MS = 5_000;
const budgetWindow = { windowMs: WINDOW_MS };
let redis: Redis;
const keys: string[] = [];
const refusals: Refusal[] = [];

const limiter = () => new RateLimitMiddleware(redis, {
  enabled: true,
  bypassHeader: 'X-Internal-Service',
  tierMultipliers: { standard: 1, premium: 1, enterprise: 1 },
  endpoints: {
    rest: { max: 100, ...budgetWindow }, graphql: { max: 100, ...budgetWindow }, health: { max: 0, ...budgetWindow },
    auth: { max: 1000, ...budgetWindow }, authAccount: { max: 1, ...budgetWindow },
    authAccountGlobal: { max: 1, ...budgetWindow }, discovery: { max: 100, ...budgetWindow }, admin: { max: 100, ...budgetWindow },
  },
  monitoring: { enabled: false, logRateLimitHits: false },
} as unknown as ConfigSchema['rateLimit']);

/** A user's second request in the window is refused by the per-user bucket; the hook hands out that refusal's claim and backoff. */
async function refusalFor(userId: string): Promise<Refusal> {
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => { (req as any).user = { _userId: userId }; next(); });
  app.put('/x', limiter().limit('auth', {
    perUser: true,
    failClosed: true,
    onRefused: async (_req, refusal) => { refusals.push(refusal); },
  }), (_req, res) => { res.sendStatus(204); });
  const send = () => request(app).put('/x').set('X-Forwarded-For', `198.51.100.${1 + Math.floor(Math.random() * 250)}`);
  await send().expect(204);
  await send().expect(429);
  return refusals.pop()!;
}

/** A claim key shaped like the controller's, for a user no other test touches. */
const claimKey = (userId: string) => {
  const key = `rate-limit:auth-user-refused:${userId}`;
  keys.push(key);
  return key;
};

beforeAll(() => {
  if (!process.env['REDIS_HOST'] || !process.env['REDIS_PORT']) throw new Error('REDIS_HOST/REDIS_PORT unset: the integration global setup did not start Redis');
  redis = new Redis({ host: process.env['REDIS_HOST'], port: Number(process.env['REDIS_PORT']), maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  if (keys.length > 0) await redis?.del(...keys);
  redis?.disconnect();
});

describe('BACKOFF_CLAIM_SCRIPT on a real Redis', () => {
  it('the owner\'s backoff cuts the claim to the backoff TTL, keeps its token and never extends it', async () => {
    const userId = randomUUID();
    const refusal = await refusalFor(userId);
    const key = claimKey(userId);
    const token = await refusal.claim(key);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await redis.pttl(key)).toBeGreaterThan(BACKOFF_MS);

    expect(await refusal.backoff(key, token!, BACKOFF_MS)).toBe(true);
    const cut = await redis.pttl(key);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThanOrEqual(BACKOFF_MS);
    expect(await redis.get(key)).toBe(token);

    // A longer backoff while the claim is already shorter leaves the TTL alone.
    expect(await refusal.backoff(key, token!, WINDOW_MS)).toBe(true);
    expect(await redis.pttl(key)).toBeLessThanOrEqual(cut);
  });

  it('a non-owner\'s backoff is rejected: the claim keeps its token and its window TTL, and is not released', async () => {
    const userId = randomUUID();
    const refusal = await refusalFor(userId);
    const key = claimKey(userId);
    const token = await refusal.claim(key);

    expect(await refusal.backoff(key, randomUUID(), BACKOFF_MS)).toBe(false);
    expect(await refusal.backoff(key, '', BACKOFF_MS)).toBe(false);
    expect(await redis.get(key)).toBe(token);
    expect(await redis.pttl(key)).toBeGreaterThan(WINDOW_MS - BACKOFF_MS);
    // Still held: nobody else can claim it.
    expect(await refusal.claim(key)).toBeNull();
    expect(await redis.get(key)).toBe(token);
  });

  it('one user\'s valid token cannot back off another user\'s claim, and each owner cuts only their own', async () => {
    const [userA, userB] = [randomUUID(), randomUUID()];
    const [refusalA, refusalB] = [await refusalFor(userA), await refusalFor(userB)];
    const [keyA, keyB] = [claimKey(userA), claimKey(userB)];
    const [tokenA, tokenB] = [await refusalA.claim(keyA), await refusalB.claim(keyB)];
    expect(tokenA).not.toBe(tokenB);
    expect(await redis.get(keyA)).toBe(tokenA);
    expect(await redis.get(keyB)).toBe(tokenB);

    expect(await refusalB.backoff(keyA, tokenB!, BACKOFF_MS)).toBe(false);
    expect(await refusalA.backoff(keyB, tokenA!, BACKOFF_MS)).toBe(false);
    expect([await redis.get(keyA), await redis.get(keyB)]).toEqual([tokenA, tokenB]);
    expect(await redis.pttl(keyA)).toBeGreaterThan(BACKOFF_MS);
    expect(await redis.pttl(keyB)).toBeGreaterThan(BACKOFF_MS);

    expect(await refusalA.backoff(keyA, tokenA!, BACKOFF_MS)).toBe(true);
    expect(await redis.pttl(keyA)).toBeLessThanOrEqual(BACKOFF_MS);
    expect(await redis.pttl(keyB)).toBeGreaterThan(BACKOFF_MS);
  });

  it('a backoff on a key nobody holds is rejected and creates nothing', async () => {
    const userId = randomUUID();
    const refusal = await refusalFor(userId);
    const key = claimKey(userId);
    expect(await refusal.backoff(key, randomUUID(), BACKOFF_MS)).toBe(false);
    expect(await redis.exists(key)).toBe(0);
  });

  it('a stale owner whose claim expired and was retaken leaves the newer claim alone', async () => {
    const userId = randomUUID();
    const refusal = await refusalFor(userId);
    const key = claimKey(userId);
    const stale = await refusal.claim(key);
    await redis.del(key); // the stale claim's window passed
    const current = await refusal.claim(key);
    expect(current).not.toBeNull();
    expect(current).not.toBe(stale);

    expect(await refusal.backoff(key, stale!, BACKOFF_MS)).toBe(false);
    expect(await redis.get(key)).toBe(current);
    expect(await redis.pttl(key)).toBeGreaterThan(BACKOFF_MS);
  });
});
