// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Authenticated anomaly routes against disposable PostgreSQL and Neo4j stores. */
import express from 'express';
import request from 'supertest';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const users = {
  a: { _id: 'anomaly-a', _username: 'alice', _role: 'admin' as const, _enabled: true, _organizationId: A },
  b: { _id: 'anomaly-b', _username: 'bob', _role: 'admin' as const, _enabled: true, _organizationId: B },
  none: { _id: 'anomaly-none', _username: 'none', _role: 'admin' as const, _enabled: true },
  invalid: { _id: 'anomaly-invalid', _username: 'invalid', _role: 'admin' as const, _enabled: true, _organizationId: 'not-a-uuid' },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
  })),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { anomalyRoutes } from '../../src/rest/routes/anomaly.routes';

const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/anomalies', anomalyRoutes);
const auth = (key: keyof typeof users) => {
  const user = users[key];
  return { authorization: `Bearer ${jwt.generateAccessToken(user._id, user._username, user._role, '_organizationId' in user ? user._organizationId : undefined)}` };
};
const uri = '/api/v1/anomalies';
const get = (user: keyof typeof users, path: string) => request(app).get(uri + path).set(auth(user));
const patch = (user: keyof typeof users, id: string) => request(app).patch(`${uri}/${id}/status`).set(auth(user)).send({ status: 'resolved' });
const detect = (user: keyof typeof users) => request(app).post(`${uri}/detect`).set(auth(user));
const cypher = async (query: string, params: Record<string, unknown> = {}) => {
  const session = graph.getSession();
  try { return await session.run(query, params); } finally { await session.close(); }
};
const OWN = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const LEGACY = '33333333-3333-4333-8333-333333333333';
const MISSING = '44444444-4444-4444-8444-444444444444';
const REUSED = '55555555-5555-4555-8555-555555555555';
let firstIncarnation: string;

beforeAll(async () => {
  await cypher(`CREATE (:CI {id:'anomaly-own', organization_id:$a, incarnation_id:randomUUID()})
    CREATE (:CI {id:'anomaly-foreign', organization_id:$b, incarnation_id:randomUUID()})
    CREATE (:CI {id:'anomaly-reused', organization_id:$a, incarnation_id:randomUUID()})`, { a: A, b: B });
  const own = (await graph.getCI('anomaly-own', A))?._incarnation_id;
  const foreign = (await graph.getCI('anomaly-foreign', B))?._incarnation_id;
  firstIncarnation = (await graph.getCI('anomaly-reused', A))?._incarnation_id ?? '';
  await sql.query(`INSERT INTO anomalies
    (id, ci_id, anomaly_type, severity, confidence_score, detected_at, status, organization_id, ci_incarnation_id)
    VALUES ($1, 'anomaly-own', 'test', 'high', 90, now(), 'detected', $5, $6),
      ($2, 'anomaly-foreign', 'test', 'critical', 90, now(), 'detected', $7, $8),
      ($3, 'anomaly-own', 'test', 'low', 90, now(), 'detected', NULL, NULL),
      ($4, 'anomaly-reused', 'test', 'high', 90, now(), 'detected', $5, $9)`,
    [OWN, FOREIGN, LEGACY, REUSED, A, own, B, foreign, firstIncarnation]);
});
afterAll(async () => {
  await sql.query('DELETE FROM anomalies WHERE id = ANY($1::uuid[])', [[OWN, FOREIGN, LEGACY, REUSED]]);
  await cypher("MATCH (ci:CI) WHERE ci.id STARTS WITH 'anomaly-' DETACH DELETE ci");
});

it('denies missing or invalid organization before reads or detection', async () => {
  for (const user of ['none', 'invalid'] as const) {
    for (const path of ['/recent', '/ci/anomaly-own', '/stats']) expect((await get(user, path)).status).toBe(403);
    expect((await patch(user, OWN)).status).toBe(403);
    expect((await detect(user)).status).toBe(403);
  }
});

it('separates owned current anomalies from foreign and unproven rows across all reads', async () => {
  expect((await get('a', '/recent')).body.data.map((row: { id: string }) => row.id).sort()).toEqual([OWN, REUSED].sort());
  expect((await get('a', '/ci/anomaly-own')).body.data.map((row: { id: string }) => row.id)).toEqual([OWN]);
  expect((await get('a', '/stats')).body.data).toMatchObject({ total: 2, by_severity: { high: 2 }, by_type: { test: 2 }, by_status: { detected: 2 } });
  expect((await get('b', '/recent')).body.data.map((row: { id: string }) => row.id)).toEqual([FOREIGN]);
  expect((await get('b', '/stats')).body.data).toMatchObject({ total: 1, by_severity: { critical: 1 } });
  expect((await get('b', '/ci/anomaly-own')).body).toEqual((await get('b', '/ci/anomaly-missing')).body);
  expect((await get('a', '/ci/anomaly-foreign')).body).toEqual((await get('a', '/ci/anomaly-missing')).body);
  expect((await patch('a', FOREIGN)).body).toEqual((await patch('a', MISSING)).body);
  expect((await sql.query('SELECT status FROM anomalies WHERE id=$1', [FOREIGN])).rows[0].status).toBe('detected');
  expect((await patch('a', LEGACY)).status).toBe(404);
  expect((await detect('a')).status).toBe(403);
  expect((await detect('b')).status).toBe(403);
});

it('fences prior incarnation after a CI ID is reused by another tenant', async () => {
  await cypher("MATCH (ci:CI {id:'anomaly-reused'}) DETACH DELETE ci");
  await cypher("CREATE (:CI {id:'anomaly-reused', organization_id:$b, incarnation_id:randomUUID()})", { b: B });
  const newIncarnation = (await graph.getCI('anomaly-reused', B))?._incarnation_id;
  expect(newIncarnation).not.toBe(firstIncarnation);
  expect((await get('a', '/ci/anomaly-reused')).body).toEqual((await get('a', '/ci/anomaly-missing')).body);
  expect((await get('b', '/ci/anomaly-reused')).body.data).toEqual([]);
  expect((await get('a', '/recent')).body.data.map((row: { id: string }) => row.id)).toEqual([OWN]);
  expect((await get('a', '/stats')).body.data.total).toBe(1);
  expect((await patch('a', REUSED)).body).toEqual((await patch('a', MISSING)).body);
  expect((await patch('b', REUSED)).body).toEqual((await patch('b', MISSING)).body);
  expect((await patch('a', OWN)).status).toBe(200);
  expect((await sql.query('SELECT status FROM anomalies WHERE id=$1', [REUSED])).rows[0].status).toBe('detected');
});
