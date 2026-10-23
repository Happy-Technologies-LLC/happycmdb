// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-850 (X-29): per verified organization read gate through the real routers; organization A work is
// held on promises and `entered` records each entry. Real time: the gate's 5 s wait and 50 ms pacing.
import express from 'express';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../auth.middleware';

type Sent = Array<Promise<request.Response>>;
const ORG_A = '11111111-1111-4111-8111-111111111111', COUNT = { records: [{ get: () => ({ toNumber: () => 0 }) }] };
const held: Array<() => void> = [], entered: string[] = [];
let active = 0, maxActive = 0, arrivals = 0;
const hold = <T>(tag: string, value: T) => new Promise<T>(resolve => {
  entered.push(tag); maxActive = Math.max(maxActive, ++active); held.push(() => { active--; resolve(value); });
});
const run = async (cypher: string, params: { organizationId: string; search?: string }) => !cypher.includes('count(')
  ? { records: [] } : params.organizationId === ORG_A ? hold(params.search ?? 'search', COUNT) : COUNT;
const buildDependencyGraph = () => hold('graph', { nodes: [], edges: [] });

jest.mock('../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>('../auth.middleware');
  const verifier = { verifyToken: async (token: string) => ({ _userId: token, _username: token, _role: 'viewer',
    _organizationId: token.startsWith('b-') ? '22222222-2222-4222-8222-222222222222' : ORG_A, _type: 'access' }) };
  const config = { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth'];
  return { getAuthMiddleware: () => new AuthMiddleware(verifier as unknown as AuthService, config) };
});
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getCI: async () => ({ id: 'ci-1' }), getSession: () => ({ run, close: async () => {} }) }),
  getPostgresClient: () => ({ pool: { query: async () => ({ rows: [{ epoch: '0', pending: [] }] }) } }),
}));
jest.mock('@cmdb/ai-ml-engine', () => ({
  ...jest.requireActual('@cmdb/ai-ml-engine'), ARCHITECTURE_REQUEST_TIMEOUT_MS: 200,
  getConfigurationDriftDetector: () => ({}), getImpactPredictionEngine: () => ({ buildDependencyGraph }),
}));

import { getAuthMiddleware } from '../../auth/auth-bootstrap';
import { CI_LIST_UNAVAILABLE_RESPONSE } from '../../read-admission';
import { ciRoutes } from '../../rest/routes/ci.routes';
import { searchRoutes } from '../../rest/routes/search.routes';
import { impactRoutes } from '../../rest/routes/drift-impact.routes';

const app = express().use(express.json(), (_req, _res, next) => { arrivals++; next(); });
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes).use('/api/v1/search', searchRoutes).use('/api/v1/impact', impactRoutes);
const LIST_503 = JSON.stringify(CI_LIST_UNAVAILABLE_RESPONSE);
const IMPACT_429 = '{"success":false,"error":"Impact analysis rate limit exceeded"}';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const list = (token: string, tag = token) => request(app).get(`/api/v1/cis?search=${tag}`).set(auth(token));
const graph = (token: string) => request(app).get('/api/v1/impact/graph/ci-1').set(auth(token)).then();
const releaseAll = () => held.splice(0).forEach(release => release());
const until = async (done: () => boolean) => { while (!done()) await wait(5); };
/** Send organization A list reads; wait until they arrived and their async auth/validation reached the gate. */
async function send(running: Sent, ...tokens: string[]): Promise<void> {
  const target = arrivals + tokens.length;
  running.push(...tokens.map(token => list(token, token.slice(2)).then()));
  await until(() => arrivals >= target);
  await wait(30);
}

afterEach(async () => {
  while (held.length > 0 || active > 0) { releaseAll(); await wait(60); }
  entered.length = 0; maxActive = 0; arrivals = 0;
});

it('enters two organization A list reads, queues the rest FIFO, and serves organization B meanwhile', async () => {
  const running: Sent = [];
  for (const tokens of [['a-1', 'a-2'], ['a-3'], ['a-4']]) await send(running, ...tokens);
  expect((await list('b-1')).status).toBe(200);
  expect(entered).toHaveLength(2);
  for (const count of [3, 4]) { held.shift()!(); await until(() => entered.length === count); }
  expect([entered.slice(2), maxActive]).toEqual([['3', '4'], 2]);
  releaseAll();
  for (const response of await Promise.all(running)) expect(response.status).toBe(200);
});

it('rejects overflow and expired waiters with the existing static bodies and no controller entry', async () => {
  const [running, queued]: Sent[] = [[], []];
  await send(running, 'a-h1', 'a-h2');
  await send(queued, ...Array.from({ length: 64 }, (_, index) => `a-q${index}`));
  expect(entered).toHaveLength(2);
  const overflow = await list('a-overflow');
  const fulltext = await request(app).post('/api/v1/search/fulltext').set(auth('a-ft')).send({ query: 'x' });
  const impact = await graph('a-graph');
  expect([overflow.status, overflow.text, fulltext.status, fulltext.text]).toEqual([503, LIST_503, 503, LIST_503]);
  expect([impact.status, impact.text]).toEqual([429, IMPACT_429]);
  for (const response of await Promise.all(queued)) expect([response.status, response.text]).toEqual([503, LIST_503]);
  expect(entered).toHaveLength(2);
  releaseAll();
  for (const response of await Promise.all(running)) expect(response.status).toBe(200);
}, 15_000);

it('removes a waiter whose client disconnected, so it never reaches the controller', async () => {
  const running: Sent = [];
  await send(running, 'a-h1', 'a-h2');
  expect(await list('a-gone', 'gone').timeout(100).then(() => null, (error: Error) => error)).toBeInstanceOf(Error);
  await send(running, 'a-live');
  expect(entered).toHaveLength(2);
  held.shift()!(); await until(() => entered.length === 3);
  expect(entered[2]).toBe('live');
  releaseAll();
  for (const response of await Promise.all(running)) expect(response.status).toBe(200);
  await wait(100);
  expect(entered).not.toContain('gone');
});

it('holds an impact slot until timed-out work settles, queueing the next read and never exceeding two', async () => {
  const timedOut = (await Promise.all([graph('a-t1'), graph('a-t2')])).map(({ status, body }) => [status, body]);
  expect(timedOut).toEqual(Array(2).fill([504, { success: false, error: 'Impact analysis timed out' }]));
  const next = graph('a-t3');
  const first = await Promise.race([next.then(() => 'answered'), wait(300).then(() => 'queued')]);
  expect([first, entered]).toEqual(['queued', ['graph', 'graph']]);
  held.shift()!(); await until(() => entered.length === 3);
  releaseAll();
  expect((await next).status).toBe(200);
  expect(maxActive).toBe(2);
});
