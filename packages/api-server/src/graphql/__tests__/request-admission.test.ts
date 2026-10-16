// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import { connect, type Socket } from 'net';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse, print, visit, type OperationDefinitionNode } from 'graphql';
import type { ApolloServer } from '@apollo/server';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../middleware/auth.middleware';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const mockRun = jest.fn(async (_statement: string): Promise<{ records: never[] }> => ({ records: [] }));
const mockPgQuery = jest.fn(async (sql: string) => ({ rows: sql.includes('ci_reconciliation_epochs')
  ? [{ epoch: '0', pending: [] }] : [] }));

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
  ...jest.requireActual('@cmdb/database/neo4j/client'),
  getNeo4jClient: () => ({ getSession: () => ({ run: mockRun, close: async () => {} }) }),
  getPostgresClient: () => ({ query: mockPgQuery, pool: { query: mockPgQuery } }),
  getUnifiedCredentialService: () => ({}),
  queueManager: { getQueue: jest.fn() },
}));
jest.mock('@cmdb/identity-resolution', () => ({ getIdentityReconciliationEngine: () => ({}) }));
jest.mock('@cmdb/integration-framework', () => ({}));

import { createGraphQLServer } from '../server';

const app = express();
const slowResponses: Array<{ response: express.Response; closed: Promise<void> }> = [];
app.use('/graphql', (req, res, next) => {
  if (req.headers['x-test-slow-response']) {
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    res.once('close', close);
    slowResponses.push({ response: res, closed });
  }
  next();
});
let server: ApolloServer<any>;
let httpServer: Server;
const execute = (query: string, principal = 'a-owner') =>
  request(app).post('/graphql').set('authorization', `Bearer ${principal}`).send({ query });
const requestLimit = { errors: [{
  message: 'GraphQL request limit exceeded', extensions: { code: 'GRAPHQL_REQUEST_LIMIT_EXCEEDED' },
}] };
const concurrencyLimit = { errors: [{
  message: 'GraphQL concurrent request limit exceeded', extensions: { code: 'TOO_MANY_REQUESTS' },
}] };

beforeAll(async () => { ({ server, httpServer } = await createGraphQLServer(app)); });
afterAll(async () => { await server.stop(); });
beforeEach(() => {
  mockRun.mockImplementation(async () => ({ records: [] }));
  mockPgQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('ci_reconciliation_epochs')
    ? [{ epoch: '0', pending: [] }] : [] }));
});

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

it('rejects oversized first and _limit pages before nested connector or reconciliation work', async () => {
  const requests = [
    { query: `{ ${Array.from({ length: 4 }, (_, index) =>
      `c${index}: connectorConfigurations { runs(first: 1000) { id } }`).join(' ')} }` },
    { query: 'query($first: Int!) { connectorConfigurations { runs(first: $first) { id } } }',
      variables: { first: 1000 } },
    { query: 'query($first: Int = 1000) { connectorConfigurations { runs(first: $first) { id } } }' },
    { query: '{ _reconciliation { listConflicts(_limit: 1000) { _id } } }' },
  ];
  for (const body of requests) {
    const response = await request(app).post('/graphql')
      .set('authorization', 'Bearer a-pages').send(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual(requestLimit);
  }
  expect(mockRun).not.toHaveBeenCalled();
});

/** Exercise the shipped document, not a shortened stand-in for its selections. */
function shippedConnectorQuery(name: string): string {
  const source = readFileSync(join(__dirname, '../../../../../web-ui/src/services/connector.service.ts'), 'utf8');
  const prefix = `export const ${name} = gql\``;
  const start = source.indexOf(prefix);
  if (start < 0) throw new Error(`Missing shipped GraphQL operation: ${name}`);
  const end = source.indexOf('`;', start + prefix.length);
  if (end < 0) throw new Error(`Unterminated GraphQL operation: ${name}`);
  return source.slice(start + prefix.length, end);
}

function includingTypename(query: string): string {
  const typename = (parse('{ __typename }').definitions[0] as OperationDefinitionNode).selectionSet.selections[0]!;
  return print(visit(parse(query), {
    SelectionSet: node => ({ ...node, selections: [...node.selections, typename] }),
  }));
}

it('admits unchanged shipped ConnectorCatalog and documented CLI GraphQL operations with Apollo __typename', async () => {
  const documentation = readFileSync(join(__dirname, '../../../../../README.md'), 'utf8');
  const cliLine = documentation.split('\n').find(line => line.includes('-d \'{"query":"{ getCIs('));
  if (!cliLine) throw new Error('Missing documented GraphQL curl query');
  const cliQuery = (JSON.parse(cliLine.match(/-d '(.+)'/)![1]!) as { query: string }).query;
  const runbook = readFileSync(
    join(__dirname, '../../../../../doc-site/docs/operations/runbooks/api-server-down.md'), 'utf8'
  );
  const probe = (JSON.parse(runbook.match(/curl http:\/\/localhost:3000\/graphql -d '(.+)'/)![1]!) as {
    query: string;
  }).query;
  for (const [query, rootField] of [
    [shippedConnectorQuery('CONNECTOR_REGISTRY_QUERY'), 'connectorRegistry'],
    [shippedConnectorQuery('INSTALLED_CONNECTORS_QUERY'), 'installedConnectors'],
    [cliQuery, 'getCIs'],
    [probe, '__schema'],
  ]) {
    const response = await execute(includingTypename(query), 'a-shipped');
    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data).toHaveProperty(rootField);
  }
  const sixScalars = await execute(
    '{ getCIs(limit:100) { _id _name _type _status _environment _metadata __typename } }', 'a-shipped'
  );
  expect(sixScalars.status).toBe(200);
  expect(sixScalars.body).toEqual({ data: { getCIs: [] } });
});

it('runs both shipped ConnectorCatalog mount operations concurrently for one principal', async () => {
  let release!: () => void;
  let secondEntered!: () => void;
  let entered = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const bothEntered = new Promise<void>(resolve => { secondEntered = resolve; });
  mockPgQuery.mockImplementation(async () => {
    if (++entered === 2) secondEntered();
    await gate;
    return { rows: [] };
  });
  const registry = execute(shippedConnectorQuery('CONNECTOR_REGISTRY_QUERY'), 'a-catalog')
    .then(response => response);
  const installed = execute(shippedConnectorQuery('INSTALLED_CONNECTORS_QUERY'), 'a-catalog')
    .then(response => response);
  try {
    await Promise.race([
      bothEntered,
      registry.then(response => { throw new Error(`Registry finished early: ${JSON.stringify(response.body)}`); }),
      installed.then(response => { throw new Error(`Installed finished early: ${JSON.stringify(response.body)}`); }),
    ]);
    expect(entered).toBe(2);
  } finally {
    release();
  }
  expect((await registry).body).toEqual({ data: { connectorRegistry: [] } });
  expect((await installed).body).toEqual({ data: { installedConnectors: [] } });
});

it('charges resolver defaults for absent/null/unprovided list variables and wrapper items before DB access', async () => {
  const requests = [
    { query: `{ ${Array.from({ length: 20 }, (_, i) =>
      `a${i}:getCIs { itilAttributes { ciClass } }`).join(' ')} }` },
    { query: '{ getCIs(limit:null) { history(limit:null) { id } } }' },
    { query: 'query($limit:Int) { getCIs(limit:$limit) { history { id } } }', variables: {} },
    { query: `{ ${Array.from({ length: 3 }, (_, i) =>
      `a${i}:configurationItems(limit:100) { items { itilAttributes { ciClass } } }`).join(' ')} }` },
    { query: `{ ${Array.from({ length: 6 }, (_, i) =>
      `a${i}:configurationItems { items { itilAttributes { ciClass } } }`).join(' ')} }` },
  ];
  for (const body of requests) {
    const response = await request(app).post('/graphql').set('authorization', 'Bearer a-defaults').send(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual(requestLimit);
  }
  expect(mockRun).not.toHaveBeenCalled();
  expect(mockPgQuery).not.toHaveBeenCalled();
});

it('admits four parallel principal reads and eight tenant reads, rejecting only real overflow', async () => {
  const started = Array.from({ length: 8 }, () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  });
  const releases: Array<() => void> = [];
  mockRun.mockImplementation(async statement => {
    if (statement.includes('MATCH (ci:CI)')) {
      const index = releases.length;
      await new Promise<void>(resolve => {
        releases.push(resolve);
        started[index]?.resolve();
      });
    }
    return { records: [] };
  });
  const query = '{ getCIs { _id } }';
  const active: Array<Promise<request.Response>> = [];
  try {
    // Two ordinary mount requests are allowed to overlap for one authenticated principal.
    for (let i = 0; i < 4; i++) {
      active.push(i === 0
        ? request(app).get('/graphql').set('authorization', 'Bearer a-first')
          .set('apollo-require-preflight', 'true').query({ query }).then(response => response)
        : execute(query, 'a-first').then(response => response));
      await Promise.race([
        started[i]!.promise,
        active[i]!.then(response => { throw new Error(`Held request ${i}: ${JSON.stringify(response.body)}`); }),
      ]);
    }
    const samePrincipal = await execute(query, 'a-first');
    expect(samePrincipal.status).toBe(429);
    expect(samePrincipal.body).toEqual(concurrencyLimit);

    for (let i = 4; i < 8; i++) {
      active.push(execute(query, `a-tenant-${i}`).then(response => response));
      await Promise.race([
        started[i]!.promise,
        active[i]!.then(response => { throw new Error(`Tenant request ${i}: ${JSON.stringify(response.body)}`); }),
      ]);
    }
    const tenantOverflow = await execute(query, 'a-ninth');
    expect(tenantOverflow.status).toBe(429);
    expect(tenantOverflow.body).toEqual(concurrencyLimit);
    expect(releases).toHaveLength(8);
    const otherTenant = await execute('{ __typename }', 'b-independent');
    expect(otherTenant.body).toEqual({ data: { __typename: 'Query' } });
    expect(otherTenant.status).toBe(200);
  } finally {
    releases.forEach(release => release());
    for (const pending of active.slice(0, releases.length)) expect((await pending).status).toBe(200);
  }
  expect((await execute('{ __typename }', 'a-first')).status).toBe(200);
});

it('releases GraphQL slots after 30 seconds of a non-reading large response and admits a healthy client', async () => {
  const principal = 'a-nonreading';
  const metadata = { payload: 'x'.repeat(256 * 1024) };
  const records = Array.from({ length: 100 }, (_, index) => ({
    get: (field: string) => field === 'ci'
      ? { properties: { id: `large-${index}`, metadata } }
      : undefined,
  }));
  mockRun.mockImplementation(async () => ({ records: records as never[] }));
  slowResponses.length = 0;
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const clients: Socket[] = [];
  let deadlineTimer: NodeJS.Timeout | undefined;
  try {
    for (let index = 0; index < 4; index++) {
      const client = connect(port, '127.0.0.1');
      clients.push(client);
      client.on('error', () => {}); // Destroying an undrained TCP response resets the peer.
      client.pause();
      await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      });
      client.write(`GET /graphql?query=${encodeURIComponent('{ getCIs(limit:100) { _metadata } }')} HTTP/1.1\r\n`
        + `Host: 127.0.0.1\r\nAuthorization: Bearer ${principal}\r\n`
        + 'Apollo-Require-Preflight: true\r\nX-Test-Slow-Response: true\r\n\r\n');
    }
    const started = Date.now();
    while (slowResponses.length !== 4 || slowResponses.some(({ response }) => !response.headersSent)) {
      if (Date.now() - started > 5000) throw new Error('Large GraphQL responses did not begin writing');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(slowResponses.every(({ response }) => !response.writableFinished)).toBe(true);
    expect((await execute('{ __typename }', principal)).status).toBe(429);
    await Promise.race([
      Promise.all(slowResponses.map(({ closed }) => closed)),
      new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => reject(
          new Error('Non-reading GraphQL responses outlived the 30s write deadline')
        ), 33_000);
      }),
    ]);
    const followUp = await execute('{ __typename }', principal);
    expect(followUp.status).toBe(200);
    expect(followUp.body).toEqual({ data: { __typename: 'Query' } });
  } finally {
    clearTimeout(deadlineTimer);
    const clientClosed = clients.map(client => new Promise<void>(resolve => client.once('close', resolve)));
    clients.forEach(client => client.destroy());
    const closing = new Promise<void>((resolve, reject) =>
      httpServer.close(error => error ? reject(error) : resolve()));
    httpServer.closeAllConnections();
    await Promise.all([...clientClosed, closing]);
  }
}, 40_000);

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
