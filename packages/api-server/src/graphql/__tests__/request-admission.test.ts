// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';
import type { ApolloServer } from '@apollo/server';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../middleware/auth.middleware';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const mockRun = jest.fn(async (_statement: string): Promise<{ records: never[] }> => ({ records: [] }));

jest.mock('../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../middleware/auth.middleware'
  );
  const verifier = { verifyToken: async (token: string) => ({
    _userId: token, _username: token, _role: 'viewer',
    _organizationId: token === 'without-org' ? undefined : token.startsWith('b-') ? ORG_B : ORG_A, _type: 'access',
  }) } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: () => ({ run: mockRun, close: async () => {} }) }),
  getPostgresClient: () => ({ pool: { query: jest.fn() } }),
  getUnifiedCredentialService: () => ({}),
  queueManager: { getQueue: jest.fn() },
}));
jest.mock('@cmdb/identity-resolution', () => ({ getIdentityReconciliationEngine: () => ({}) }));
jest.mock('@cmdb/integration-framework', () => ({}));

import { createGraphQLServer } from '../server';

const app = express();
let server: ApolloServer<any>;
const execute = (query: string, principal = 'a-owner') =>
  request(app).post('/graphql').set('authorization', `Bearer ${principal}`).send({ query });
const requestLimit = { errors: [{
  message: 'GraphQL request limit exceeded', extensions: { code: 'GRAPHQL_REQUEST_LIMIT_EXCEEDED' },
}] };
const concurrencyLimit = { errors: [{
  message: 'GraphQL concurrent request limit exceeded', extensions: { code: 'TOO_MANY_REQUESTS' },
}] };

beforeAll(async () => { ({ server } = await createGraphQLServer(app)); });
afterAll(async () => { await server.stop(); });
beforeEach(() => { mockRun.mockImplementation(async () => ({ records: [] })); });

it('rejects excessive aliases, fields, nested depth, and amplified complexity before graph access', async () => {
  const requests = [
    `{ ${Array.from({ length: 21 }, (_, index) => `a${index}: __typename`).join(' ')} }`,
    `{ ${Array.from({ length: 101 }, () => '__typename').join(' ')} }`,
    '{ __type(name:"CI") { fields { type { ofType { ofType { ofType { ofType { ofType { name } } } } } } } } }',
    '{ __schema { types { fields { args { type { name } } } } } }',
    `{ ${Array.from({ length: 21 }, () => '...Repeated').join(' ')} }
      fragment Repeated on Query { alias: __typename }`,
  ];
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  for (const query of requests) {
    const response = await execute(query);
    statuses.push(response.status);
    bodies.push(response.body);
  }
  expect(statuses).toEqual([400, 400, 400, 400, 400]);
  for (const body of bodies) expect(body).toEqual(requestLimit);
  const getAliases = await request(app).get('/graphql').set('authorization', 'Bearer a-owner')
    .set('apollo-require-preflight', 'true')
    .query({ query: requests[0] });
  expect(getAliases.status).toBe(400);
  expect(getAliases.body).toEqual(requestLimit);
  expect(mockRun).not.toHaveBeenCalled();
});

it('rejects oversized list limits passed through variables before resolver work', async () => {
  const response = await request(app).post('/graphql').set('authorization', 'Bearer a-page')
    .send({ query: 'query($limit: Int!) { getCIs(limit: $limit) { _id } }', variables: { limit: 1000 } });
  expect(response.status).toBe(400);
  expect(response.body).toEqual(requestLimit);
  expect(mockRun).not.toHaveBeenCalled();
});

it('holds one verified-principal slot and two tenant slots until mounted GraphQL responses finish', async () => {
  const entered: Array<() => void> = [];
  const releases: Array<() => void> = [];
  const firstStarted = new Promise<void>(resolve => { entered.push(resolve); });
  const secondStarted = new Promise<void>(resolve => { entered.push(resolve); });
  const thirdStarted = new Promise<void>(resolve => { entered.push(resolve); });
  mockRun.mockImplementation(async statement => {
    if (statement.includes('MATCH (ci:CI)')) {
      const index = releases.length;
      await new Promise<void>(resolve => {
        releases.push(resolve);
        entered[index]();
      });
    }
    return { records: [] };
  });
  const query = '{ getCIs { _id } }';
  const first = request(app).get('/graphql').set('authorization', 'Bearer a-first')
    .set('apollo-require-preflight', 'true')
    .query({ query }).then(response => response);
  try {
    await firstStarted;
    const samePrincipalRequest = execute(query, 'a-first').then(response => response);
    await Promise.race([samePrincipalRequest, secondStarted]);
    if (releases[1]) releases[1]();
    const samePrincipal = await samePrincipalRequest;
    expect(samePrincipal.status).toBe(429);
    expect(samePrincipal.body).toEqual(concurrencyLimit);

    const second = execute(query, 'a-second').then(response => response);
    try {
      await secondStarted;
      const overflowRequest = execute(query, 'a-third').then(response => response);
      await Promise.race([overflowRequest, thirdStarted]);
      if (releases[2]) releases[2]();
      const tenantOverflow = await overflowRequest;
      expect(tenantOverflow.status).toBe(429);
      expect(tenantOverflow.body).toEqual(concurrencyLimit);
      expect(releases).toHaveLength(2);
      // A distinct tenant is unaffected by org A's two occupied slots.
      const otherTenant = await execute('{ __typename }', 'b-independent');
      expect(otherTenant.status).toBe(200);
      expect(otherTenant.body).toEqual({ data: { __typename: 'Query' } });
    } finally {
      releases.forEach(release => release());
      expect((await second).status).toBe(200);
    }
    expect((await execute('{ __typename }', 'a-first')).status).toBe(200);
  } finally {
    releases.forEach(release => release());
    expect((await first).status).toBe(200);
  }
});

it('leaves unauthenticated denial and ordinary owner-scoped reads unchanged', async () => {
  const unauthenticated = await request(app).post('/graphql').send({ query: '{ __typename }' });
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.body).toMatchObject({ _error: 'Unauthorized', _message: 'Authentication failed' });
  expect((await execute('{ getCIs { _id } }', 'b-owner')).body).toEqual({ data: { getCIs: [] } });
  mockRun.mockClear();
  const missingTenant = await execute('{ getCIs { _id } }', 'without-org');
  expect(missingTenant.status).toBe(403);
  expect(missingTenant.body.errors[0]).toMatchObject({
    message: 'Organization claim required', extensions: { code: 'FORBIDDEN' },
  });
  expect(mockRun).not.toHaveBeenCalled();
});

it('returns a principal slot after Apollo rejects a malformed JSON operation', async () => {
  const invalid = await request(app).post('/graphql')
    .set('authorization', 'Bearer a-malformed').send({});
  expect(invalid.status).toBe(400);
  const next = await execute('{ __typename }', 'a-malformed');
  expect(next.status).toBe(200);
  expect(next.body).toEqual({ data: { __typename: 'Query' } });
});
