// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * v16 §15 N-21 SEC12-02, real-store p99 measurement (operator Choice A,
 * approvals/cmdb-pr50-sec12-02-p99-realstore-choice-A.go):
 *   "Auth p99 is unchanged with 5 000 vs 10 users"
 * adjudicated as: median over >= 5 alternating rounds of p99(5000) / p99(10) <= 1.10, with p50/p95/p99 per round,
 * the spread, and the bcrypt spy at 0.
 *
 * Runs only when SEC12_02_P99=1, in the dedicated "SEC12-02 Auth p99 (real store)" CI job
 * (.github/workflows/test.yml). It uses the integration global setup's disposable neo4j:5.15.0 and
 * timescale/timescaledb:latest-pg15 with every migration applied. The normal integration run skips it.
 *
 * Path per request, identical to production: HTTP keep-alive loopback → express.json → AuthController →
 * AuthMiddleware.authenticate → AuthService.verifyToken / verifyApiKey / refreshToken → JWTService →
 * Neo4jAuthRepository (Neo4j findUserById; PostgreSQL api_keys lookup and last_used_at update).
 * Mix per 10 requests: 8 × GET /api/v1/auth/me with a Bearer JWT, 1 × GET /me with X-API-Key,
 * 1 × POST /refresh. Each request picks a uniformly random user of the current cohort and runs sequentially.
 *
 * Cohorts alternate each round by creating or deleting users 10..4999 in both stores, so the 10-user phase
 * holds 10 harness users (plus pre-existing nodes, reported as userCount). Each phase: 5 000 warm-up requests,
 * a PROFILE and EXPLAIN of the exact findUserById statement, 30 000 timed requests, and 5 000 timed
 * store-only findUserById calls, which attribute any scaling to the store lookup.
 *
 * Only APIs present at base 7d594eb are used (no credential-generation arguments, no api_keys.credential_epoch
 * column), so the CI job can run this same file at the base for attribution. Results go to
 * $P99_RESULT_FILE as JSON and to the job log as P99_ROWS / P99_SUMMARY.
 */

import { afterAll, beforeAll, expect, it, jest } from '@jest/globals';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { createHash } from 'crypto';
import express from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import neo4j, { Driver } from 'neo4j-driver';
import { dirname, resolve } from 'path';
import { performance } from 'perf_hooks';
import { Pool } from 'pg';

import { AuthService } from '../../../packages/api-server/src/auth/auth.service';
import { JWTService } from '../../../packages/api-server/src/auth/jwt.service';
import { Neo4jAuthRepository } from '../../../packages/api-server/src/auth/neo4j-auth.repository';
import { PasswordService } from '../../../packages/api-server/src/auth/password.service';
import { AuthMiddleware } from '../../../packages/api-server/src/middleware/auth.middleware';
import type { RateLimitMiddleware } from '../../../packages/api-server/src/middleware/rate-limit.middleware';
import { AuthController } from '../../../packages/api-server/src/rest/auth.controller';
import { ValidationMiddleware } from '../../../packages/api-server/src/rest/middleware/validation.middleware';

const ENABLED = process.env['SEC12_02_P99'] === '1';
const measure = ENABLED ? it : it.skip;

const authConfig = {
  jwt: { secret: 'p99-harness-secret-at-least-32-characters', accessTokenExpiresIn: '6h', refreshTokenExpiresIn: '7d', issuer: 'p99', audience: 'p99' },
  bcrypt: { rounds: 4 },
  apiKeys: { enabled: true, headerName: 'X-API-Key' },
};
const ORG = '11111111-1111-4111-8111-111111111111';
const SMALL = 10;
const LARGE = 5000;
// Choice A minimums, fixed here (not tunable) so a committed run cannot be weakened.
const WARMUP = 5000;
const SAMPLES = 30000;
const ROUNDS = 5;
const STORE_SAMPLES = 5000;
const THRESHOLD = 1.1;
/** neo4j-auth.repository.ts findUserById, byte-identical at base 7d594eb and at this head. */
const FIND_USER_BY_ID = 'MATCH (u:User) WHERE u._id = $id OR u.id = $id RETURN u';

type Credential = { id: string; access: string; refresh: string; key: string };
type PlanNode = { operatorType: string; identifiers?: string[]; arguments?: Record<string, unknown>; dbHits?: number; rows?: number; children: PlanNode[] };

let driver: Driver;
let pool: Pool;
let server: http.Server;
let port: number;
let creds: Credential[] = [];
let passwordHash: string;
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

const idOf = (i: number) => `p99-${String(i).padStart(4, '0')}`;
const keyHashOf = (key: string) => createHash('sha256').update(key).digest('hex');
const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const ms = (x: number) => +x.toFixed(3);

async function cypher(statement: string, params: Record<string, unknown> = {}) {
  const session = driver.session();
  try {
    return await session.run(statement, params);
  } finally {
    await session.close();
  }
}

async function addUsers(from: number, to: number): Promise<void> {
  const rows = creds.slice(from, to).map(c => ({ _id: c.id, _username: c.id, _email: `${c.id}@p99.invalid`,
    _passwordHash: passwordHash, _role: 'operator', _enabled: true, _organizationId: ORG }));
  for (let i = 0; i < rows.length; i += 1000) {
    await cypher('UNWIND $rows AS row CREATE (u:User) SET u = row', { rows: rows.slice(i, i + 1000) });
  }
  const batch = creds.slice(from, to);
  await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, name, role)
     SELECT u, h, 'p99', 'operator' FROM unnest($1::text[], $2::text[]) AS t(u, h)`,
    [batch.map(c => c.id), batch.map(c => keyHashOf(c.key))]
  );
}

async function removeUsers(from: number): Promise<void> {
  const ids = creds.slice(from).map(c => c.id);
  await cypher('MATCH (u:User) WHERE u._id IN $ids DETACH DELETE u', { ids });
  await pool.query('DELETE FROM api_keys WHERE user_id = ANY($1::text[])', [ids]);
}

/** PROFILE (and EXPLAIN) of the exact findUserById statement: operator chain with details, rows and db hits. */
async function plan(id: string) {
  const flatten = (node: PlanNode, out: Array<Record<string, unknown>>) => {
    out.push({ operator: node.operatorType, details: node.arguments?.['Details'] ?? null,
      rows: node.rows === undefined ? null : Number(node.rows), dbHits: node.dbHits === undefined ? null : Number(node.dbHits) });
    node.children.forEach(child => flatten(child, out));
    return out;
  };
  const profiled = flatten((await cypher(`PROFILE ${FIND_USER_BY_ID}`, { id })).summary.profile as unknown as PlanNode, []);
  const explained = flatten((await cypher(`EXPLAIN ${FIND_USER_BY_ID}`, { id })).summary.plan as unknown as PlanNode, [])
    .map(({ operator, details }) => ({ operator, details }));
  return { profile: profiled, totalDbHits: profiled.reduce((sum, n) => sum + Number(n['dbHits'] ?? 0), 0), explain: explained };
}

function call(method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      res.resume();
      res.on('end', () => resolveStatus(res.statusCode ?? 0));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function timedRequest(cohort: number, i: number): Promise<number> {
  const c = creds[Math.floor(Math.random() * cohort)]!;
  const kind = i % 10;
  const t0 = performance.now();
  const status = kind < 8 ? await call('GET', '/api/v1/auth/me', { authorization: `Bearer ${c.access}` })
    : kind === 8 ? await call('GET', '/api/v1/auth/me', { 'x-api-key': c.key })
    : await call('POST', '/api/v1/auth/refresh', {}, JSON.stringify({ refreshToken: c.refresh }));
  const elapsed = performance.now() - t0;
  if (status !== 200) throw new Error(`unexpected status ${status} (cohort ${cohort}, kind ${kind})`);
  return elapsed;
}

async function timedStoreLookups(cohort: number): Promise<number[]> {
  const session = driver.session();
  try {
    const samples: number[] = [];
    for (let i = 0; i < STORE_SAMPLES; i++) {
      const id = creds[Math.floor(Math.random() * cohort)]!.id;
      const t0 = performance.now();
      await session.run(FIND_USER_BY_ID, { id });
      samples.push(performance.now() - t0);
    }
    return samples.sort((a, b) => a - b);
  } finally {
    await session.close();
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  process.env['NODE_ENV'] = 'production';
  for (const level of ['info', 'debug', 'warn'] as const) jest.spyOn(logger, level).mockImplementation(() => logger);
  driver = neo4j.driver(process.env['NEO4J_URI']!, neo4j.auth.basic(process.env['NEO4J_USERNAME']!, process.env['NEO4J_PASSWORD']!));
  pool = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']), database: process.env['POSTGRES_DB'],
    user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
  passwordHash = await new PasswordService(authConfig.bcrypt as never).hash('p99-harness-password');
  const jwt = new JWTService(authConfig.jwt as never);
  creds = Array.from({ length: LARGE }, (_, i) => {
    const id = idOf(i);
    return { id, access: jwt.generateAccessToken(id, id, 'operator', ORG), refresh: jwt.generateRefreshToken(id, id, 'operator'), key: `p99-key-${id}` };
  });
  await removeUsers(0);
  await addUsers(0, SMALL);

  const service = new AuthService(authConfig as never, new Neo4jAuthRepository());
  const limiter = { limit: () => (_q: unknown, _s: unknown, next: () => void) => next() } as unknown as RateLimitMiddleware;
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', new AuthController(service, new ValidationMiddleware(), new AuthMiddleware(service, authConfig as never), limiter).getRouter());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(ready => server.once('listening', () => ready()));
  port = (server.address() as AddressInfo).port;
}, 600_000);

afterAll(async () => {
  if (!ENABLED) return;
  server?.close();
  agent.destroy();
  if (creds.length > 0) await removeUsers(0);
  await pool?.end();
  await driver?.close();
  await getNeo4jClient().close();
  await getPostgresClient().close();
});

measure('SEC12-02: auth p99 with 5 000 vs 10 users on real Neo4j and PostgreSQL', async () => {
  const verify = jest.spyOn(PasswordService.prototype, 'verify');
  const hash = jest.spyOn(PasswordService.prototype, 'hash');
  const rows: Array<Record<string, unknown>> = [];
  const plans: Array<Record<string, unknown>> = [];
  const p99: Record<number, number[]> = { [SMALL]: [], [LARGE]: [] };
  const storeP99: Record<number, number[]> = { [SMALL]: [], [LARGE]: [] };
  let present = SMALL;

  for (let round = 0; round < ROUNDS; round++) {
    for (const cohort of round % 2 === 0 ? [SMALL, LARGE] : [LARGE, SMALL]) {
      if (cohort === LARGE && present === SMALL) await addUsers(SMALL, LARGE);
      if (cohort === SMALL && present === LARGE) await removeUsers(SMALL);
      present = cohort;
      const userCount = neo4j.integer.toNumber((await cypher('MATCH (u:User) RETURN count(u) AS n')).records[0]!.get('n'));
      for (let i = 0; i < WARMUP; i++) await timedRequest(cohort, i);
      if (round === 0) plans.push({ cohort, userCount, ...(await plan(idOf(cohort - 1))) });

      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i++) samples.push(await timedRequest(cohort, i));
      samples.sort((a, b) => a - b);
      const store = await timedStoreLookups(cohort);
      p99[cohort]!.push(pct(samples, 0.99));
      storeP99[cohort]!.push(pct(store, 0.99));
      rows.push({ round, cohort, userCount, n: samples.length, p50: ms(pct(samples, 0.5)), p95: ms(pct(samples, 0.95)),
        p99: ms(pct(samples, 0.99)), max: ms(samples[samples.length - 1]!),
        storeFindUserById: { n: store.length, p50: ms(pct(store, 0.5)), p99: ms(pct(store, 0.99)) } });
    }
  }

  const perRoundRatio = p99[LARGE]!.map((large, round) => +(large / p99[SMALL]![round]!).toFixed(4));
  const ratio = median(p99[LARGE]!) / median(p99[SMALL]!);
  const summary = {
    label: process.env['P99_LABEL'] ?? 'unlabelled',
    p99_10_median_ms: ms(median(p99[SMALL]!)), p99_5000_median_ms: ms(median(p99[LARGE]!)), ratio: +ratio.toFixed(4),
    per_round_ratio: perRoundRatio, spread: { min: Math.min(...perRoundRatio), max: Math.max(...perRoundRatio) },
    store_find_user_by_id_p99_median_ms: { [SMALL]: ms(median(storeP99[SMALL]!)), [LARGE]: ms(median(storeP99[LARGE]!)) },
    threshold: THRESHOLD, verdict: ratio <= THRESHOLD ? 'PASS' : 'EXCEEDS',
    bcrypt_verify_calls: verify.mock.calls.length, bcrypt_hash_calls: hash.mock.calls.length,
    warmup_per_phase: WARMUP, samples_per_round_per_cohort: SAMPLES, rounds: ROUNDS, node: process.version,
  };
  process.stdout.write(`P99_PLANS ${JSON.stringify(plans)}\nP99_ROWS ${JSON.stringify(rows)}\nP99_SUMMARY ${JSON.stringify(summary)}\n`);
  const file = resolve(process.env['P99_RESULT_FILE'] ?? 'test-results/sec12-02-p99/result.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ summary, rows, plans }, null, 2));

  // Hard requirements of the harness itself; the ratio verdict is attributed by the CI job (see test.yml).
  expect(verify).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
}, 7_200_000);
