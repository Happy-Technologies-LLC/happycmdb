// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-922 on the integration suite's disposable PostgreSQL/Timescale (all migrations, including 040):
 * REST PATCH /itil/changes/:id and GraphQL updateChange persist implementedBy and actualDuration,
 * and same-org reads return them. Before 040 both writes failed with 42703 (operator receipt at cead7e9).
 * Mounted REST and /graphql with real JWTs; only the identity directory is stubbed.
 */
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import { getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = randomUUID();
const B = randomUUID();
const users = {
  a: { _id: 'hap922-a', _username: 'hap922-a', _role: 'admin' as const, _enabled: true, _organizationId: A },
  b: { _id: 'hap922-b', _username: 'hap922-b', _role: 'admin' as const, _enabled: true, _organizationId: B },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
  })),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { itilRoutes } from '../../src/rest/routes/itil.routes';
import { createGraphQLServer } from '../../src/graphql/server';

const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/itil', itilRoutes);
const auth = (user: keyof typeof users) => ({ authorization: `Bearer ${jwt.generateAccessToken(users[user]._id,
  users[user]._username, users[user]._role, users[user]._organizationId)}` });
const rows = async (text: string, params: unknown[] = []) => (await sql.query(text, params)).rows;
const [restOwn, gqlOwn, foreign] = [randomUUID(), randomUUID(), randomUUID()];
let gql: { server: { stop(): Promise<void> } };

beforeAll(async () => {
  gql = await createGraphQLServer(app);
  await rows(`INSERT INTO itil_changes(id, change_number, title, change_type, affected_ci_ids, requested_by,
      scheduled_start, scheduled_end, implementation_plan, status, organization_id)
    SELECT id, 'CHG-hap922-' || id, 'hap922 change', 'normal', ARRAY['hap922-ci'], 'alice',
      '2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z', 'planned work', 'approved', org
    FROM unnest($1::uuid[], $2::uuid[]) AS t(id, org)`, [[restOwn, gqlOwn, foreign], [A, A, B]]);
});
afterAll(async () => {
  await gql?.server.stop();
  await rows('DELETE FROM itil_changes WHERE organization_id = ANY($1::uuid[])', [[A, B]]);
});

it('REST PATCH persists implementedBy and actualDuration; GET reads them back; foreign is a no-write 404', async () => {
  const patched = await request(app).patch(`/api/v1/itil/changes/${restOwn}`).set(auth('a'))
    .send({ implementedBy: 'alice', actualDuration: 45 });
  const read = await request(app).get(`/api/v1/itil/changes/${restOwn}`).set(auth('a'));
  const before = await rows('SELECT * FROM itil_changes WHERE id = $1', [foreign]);
  const crossed = await request(app).patch(`/api/v1/itil/changes/${foreign}`).set(auth('a'))
    .send({ implementedBy: 'mallory', actualDuration: 5 });
  const missing = await request(app).patch(`/api/v1/itil/changes/${randomUUID()}`).set(auth('a'))
    .send({ implementedBy: 'mallory', actualDuration: 5 });
  expect([patched.status, patched.body.data?.implemented_by, patched.body.data?.actual_duration, patched.body.data?.status,
    read.status, read.body.data?.implemented_by, read.body.data?.actual_duration])
    .toEqual([200, 'alice', 45, 'approved', 200, 'alice', 45]);
  expect([crossed.status, crossed.body]).toEqual([404, missing.body]);
  expect(await rows('SELECT * FROM itil_changes WHERE id = $1', [foreign])).toEqual(before);
});

it('GraphQL updateChange persists implementedBy and actualDuration; change reads them back; foreign is NOT_FOUND', async () => {
  const update = (id: string, user: keyof typeof users) => request(app).post('/graphql').set(auth(user)).send({
    query: `mutation ($id: ID!) { updateChange(id: $id, input: { implementedBy: "bob", actualDuration: 90 })
      { id implementedBy actualDuration } }`, variables: { id } });
  const updated = await update(gqlOwn, 'a');
  const read = await request(app).post('/graphql').set(auth('a')).send({
    query: 'query ($id: ID!) { change(id: $id) { implementedBy actualDuration } }', variables: { id: gqlOwn } });
  const before = await rows('SELECT * FROM itil_changes WHERE id = $1', [foreign]);
  const crossed = await update(foreign, 'a');
  const afterCrossed = await rows('SELECT * FROM itil_changes WHERE id = $1', [foreign]);
  const own = await update(foreign, 'b'); // positive control: B's own record
  expect([updated.body, read.body]).toEqual([
    { data: { updateChange: { id: gqlOwn, implementedBy: 'bob', actualDuration: 90 } } },
    { data: { change: { implementedBy: 'bob', actualDuration: 90 } } }]);
  expect([crossed.body.errors?.[0]?.extensions?.code, crossed.body.data, afterCrossed]).toEqual(['NOT_FOUND', null, before]);
  expect(own.body).toEqual({ data: { updateChange: { id: foreign, implementedBy: 'bob', actualDuration: 90 } } });
});
