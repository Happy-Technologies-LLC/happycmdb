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
const [restOwn, gqlOwn, foreign, bounds] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const snapshot = () => rows('SELECT * FROM itil_changes WHERE organization_id = ANY($1::uuid[]) ORDER BY id', [[A, B]]);
let gql: { server: { stop(): Promise<void> } };

beforeAll(async () => {
  gql = await createGraphQLServer(app);
  await rows(`INSERT INTO itil_changes(id, change_number, title, change_type, affected_ci_ids, requested_by,
      scheduled_start, scheduled_end, implementation_plan, status, organization_id)
    SELECT id, 'CHG-hap922-' || id, 'hap922 change', 'normal', ARRAY['hap922-ci'], 'alice',
      '2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z', 'planned work', 'approved', org
    FROM unnest($1::uuid[], $2::uuid[]) AS t(id, org)`, [[restOwn, gqlOwn, foreign, bounds], [A, A, B, A]]);
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

// Operator receipt §6/§7 M2: GraphQL bypasses Joi and REST Joi has no upper/storability bounds, so without the
// controller bounds REST returns 500 or writes a lone surrogate and GraphQL writes "" / lone surrogates.
it('REST PATCH rejects out-of-bound implementedBy/actualDuration with a public 400 and writes nothing in either org', async () => {
  // Joi rejects some shapes first; the rest pass Joi and must stop at the controller bounds.
  const joi = expect.objectContaining({ _success: false, _error: 'Validation Error' });
  const bound = { success: false, error: 'Bad Request', message: 'Invalid request' };
  const invalid: [Record<string, unknown>, unknown][] = [[{ actualDuration: 0 }, joi], [{ actualDuration: -1 }, joi],
    [{ actualDuration: 1.5 }, joi], [{ actualDuration: 2147483648 }, bound], [{ actualDuration: 'abc' }, joi],
    [{ implementedBy: '' }, joi], [{ implementedBy: 'x'.repeat(256) }, bound], [{ implementedBy: 'nul\u0000' }, bound],
    [{ implementedBy: '\ud800' }, bound], [{ implementedBy: 5 }, joi]];
  const patch = (id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/v1/itil/changes/${id}`).set(auth('a')).send(body);
  const before = await snapshot();
  const observed = [];
  const expected = [];
  for (const [body, publicBody] of invalid) {
    const [own, crossed, missing] = [await patch(bounds, body), await patch(foreign, body), await patch(randomUUID(), body)];
    observed.push([body, own.status, own.body, crossed.status, crossed.body, missing.status]);
    expected.push([body, 400, publicBody, 400, missing.body, 400]);
  }
  const after = await snapshot();
  const edge = await patch(bounds, { implementedBy: 'y'.repeat(255), actualDuration: 2147483647 });
  expect(observed).toEqual(expected);
  expect(after).toEqual(before);
  expect([edge.status, edge.body.data?.implemented_by, edge.body.data?.actual_duration])
    .toEqual([200, 'y'.repeat(255), 2147483647]);
});

it('GraphQL updateChange rejects out-of-bound input as BAD_USER_INPUT and writes nothing in either org', async () => {
  const update = (id: string, input: Record<string, unknown>) => request(app).post('/graphql').set(auth('a')).send({
    query: `mutation ($id: ID!, $input: UpdateChangeInput!) { updateChange(id: $id, input: $input)
      { id implementedBy actualDuration } }`, variables: { id, input } });
  const outcome = (body: { data?: unknown; errors?: { message: string; extensions?: { code?: string } }[] }) =>
    [body.errors?.[0]?.extensions?.code, body.errors?.[0]?.message, body.data ?? null];
  // Controller-bound: reach updateChange and must be rejected there.
  const controllerBound = [{ actualDuration: 0 }, { actualDuration: -5 }, { implementedBy: '' },
    { implementedBy: 'x'.repeat(256) }, { implementedBy: 'nul\u0000' }, { implementedBy: '\ud800' }];
  // Schema-bound: GraphQL Int/String coercion rejects these before the resolver.
  const schemaBound = [{ actualDuration: 1.5 }, { actualDuration: 2147483648 }, { implementedBy: 5 }];
  const before = await snapshot();
  const own = [];
  const concealed = [];
  for (const input of controllerBound) {
    own.push(outcome((await update(bounds, input)).body));
    concealed.push([(await update(foreign, input)).body, (await update(randomUUID(), input)).body]);
  }
  const coerced = [];
  for (const input of schemaBound) coerced.push(outcome((await update(bounds, input)).body)[0]);
  const after = await snapshot();
  expect(own).toEqual(controllerBound.map(() => ['BAD_USER_INPUT', 'Invalid ITIL record request', null]));
  for (const [crossed, missing] of concealed) {
    expect([outcome(crossed), crossed]).toEqual([['BAD_USER_INPUT', 'Invalid ITIL record request', null], missing]);
  }
  expect(coerced).toEqual(['BAD_USER_INPUT', 'BAD_USER_INPUT', 'BAD_USER_INPUT']);
  expect(after).toEqual(before);
});
