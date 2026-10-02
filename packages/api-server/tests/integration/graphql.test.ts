// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Tests - GraphQL API
 *
 * Exercises the production GraphQL server over HTTP, including the mandatory
 * authenticated context. CIs are persisted in the shared Neo4j container.
 */

import request from 'supertest';
import express, { type Express } from 'express';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { startTestContainers, stopTestContainers } from '../helpers/test-containers';
import { getNeo4jClient } from '@cmdb/database';
import { authRoutes } from '../../src/rest/routes/auth.routes';
import { createGraphQLServer } from '../../src/graphql/server';
import type { ApolloServer } from '@apollo/server';

interface GraphQLBody {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

describe('GraphQL API Integration Tests', () => {
  let app: Express;
  let server: ApolloServer<any>;
  // authToken belongs to an ORG_A admin, orgBToken to an ORG_B admin.
  let authToken: string;
  let orgBToken: string;
  const users = [ORG_A, ORG_B].map(organizationId => ({
    organizationId,
    id: uuidv4(),
    username: `gqladmin${uuidv4().replace(/-/g, '').slice(0, 20)}`,
  }));
  const password = 'GraphqlIntegrationPassword123!';

  const execute = async (
    query: string,
    variables?: Record<string, unknown>,
    token: string | null | undefined = authToken
  ) => {
    const requestBuilder = request(app).post('/graphql').send({ query, variables });
    return token ? requestBuilder.set('Authorization', `Bearer ${token}`) : requestBuilder;
  };

  const expectSuccess = (response: request.Response): Record<string, unknown> => {
    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data).toBeDefined();
    return response.body.data as Record<string, unknown>;
  };

  const createCI = async (
    overrides: Partial<{
      _id: string;
      _externalId: string;
      _name: string;
      _type: 'server' | 'application' | 'database';
      _status: 'active' | 'inactive';
      _environment: 'production' | 'staging' | 'development';
      _metadata: Record<string, unknown>;
    }> = {},
    organizationId: string = ORG_A
  ) => {
    const id = overrides._id ?? uuidv4();
    await getNeo4jClient().createCI({
      _id: id,
      external_id: overrides._externalId,
      name: overrides._name ?? `ci-${id}`,
      _type: overrides._type ?? 'server',
      status: overrides._status ?? 'active',
      environment: overrides._environment ?? 'production',
      metadata: overrides._metadata ?? {},
    }, organizationId);
    return id;
  };

  beforeAll(async () => {
    await startTestContainers();

    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRoutes);

    const passwordHash = await bcrypt.hash(password, 10);
    const session = getNeo4jClient().getSession();
    try {
      for (const user of users) {
        await session.run(
          `CREATE (u:User {
            _id: $id,
            _username: $username,
            _email: $email,
            _passwordHash: $passwordHash,
            _role: 'admin',
            _enabled: true,
            _organizationId: $organizationId,
            _createdAt: datetime(),
            _updatedAt: datetime()
          })`,
          { ...user, email: `${user.username}@example.com`, passwordHash }
        );
      }
    } finally {
      await session.close();
    }

    const login = async (username: string): Promise<string> => {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ username, password })
        .expect(200);
      return response.body.data._accessToken;
    };
    authToken = await login(users[0].username);
    orgBToken = await login(users[1].username);

    ({ server } = await createGraphQLServer(app));
  }, 120000);

  afterEach(async () => {
    const session = getNeo4jClient().getSession();
    try {
      await session.run('MATCH (ci:CI) DETACH DELETE ci');
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    const session = getNeo4jClient().getSession();
    try {
      await session.run('MATCH (u:User) WHERE u._id IN $ids DETACH DELETE u', { ids: users.map(user => user.id) });
    } finally {
      await session.close();
    }
    await stopTestContainers();
  }, 30000);

  it('fails closed when no GraphQL authentication credential is supplied', async () => {
    const response = await execute('{ getCIs { _id } }', undefined, null);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      _error: 'Unauthorized',
      _message: 'No authentication credentials provided',
    });
  });

  it('retrieves a CI by ID and returns null for an unknown ID', async () => {
    const ciId = await createCI({ _name: 'test-server' });

    const response = await execute(
      `query GetCI($id: ID!) {
        getCI(id: $id) { _id _name _type _status _environment }
      }`,
      { id: ciId }
    );
    const data = expectSuccess(response);
    expect(data.getCI).toMatchObject({
      _id: ciId,
      _name: 'test-server',
      _type: 'SERVER',
      _status: 'ACTIVE',
      _environment: 'PRODUCTION',
    });

    const missing = await execute('{ getCI(id: "does-not-exist") { _id } }');
    expect(expectSuccess(missing).getCI).toBeNull();
  });

  it('filters and paginates CIs using canonical GraphQL filter fields', async () => {
    await createCI({ _name: 'production-server', _type: 'server', _environment: 'production' });
    await createCI({ _name: 'staging-server', _type: 'server', _environment: 'staging' });
    await createCI({ _name: 'production-app', _type: 'application', _environment: 'production' });

    const filtered = await execute(
      `query Filtered($filter: SearchCIFilter!) {
        getCIs(filter: $filter) { _name _type _environment }
      }`,
      { filter: { _type: 'SERVER', _environment: 'PRODUCTION' } }
    );
    expect(expectSuccess(filtered).getCIs).toEqual([
      expect.objectContaining({ _name: 'production-server', _type: 'SERVER', _environment: 'PRODUCTION' }),
    ]);

    const paged = await execute(
      '{ getCIs(limit: 1, offset: 1) { _id } }'
    );
    expect(expectSuccess(paged).getCIs).toHaveLength(1);
  });

  it('creates, updates and deletes a CI in the caller organization', async () => {
    const ciId = uuidv4();
    const created = await execute(
      `mutation CreateCI($input: CreateCIInput!) {
        createCI(input: $input) { _id _name _type }
      }`,
      { input: { _id: ciId, _name: 'production-server', _type: 'SERVER' } }
    );
    expect(expectSuccess(created).createCI).toEqual({ _id: ciId, _name: 'production-server', _type: 'SERVER' });

    const session = getNeo4jClient().getSession();
    try {
      const stored = await session.run('MATCH (ci:CI {id: $id}) RETURN ci.organization_id AS org', { id: ciId });
      expect(stored.records.map(record => record.get('org'))).toEqual([ORG_A]);
    } finally {
      await session.close();
    }

    const updated = await execute(
      `mutation UpdateCI($id: ID!, $input: UpdateCIInput!) {
        updateCI(id: $id, input: $input) { _id _name _status }
      }`,
      { id: ciId, input: { _name: 'updated-server', _status: 'MAINTENANCE' } }
    );
    expect(expectSuccess(updated).updateCI).toEqual({ _id: ciId, _name: 'updated-server', _status: 'MAINTENANCE' });

    const deleted = await execute('mutation($id: ID!) { deleteCI(id: $id) }', { id: ciId });
    expect(expectSuccess(deleted).deleteCI).toBe(true);
    expect(expectSuccess(await execute('{ getCIs { _id } }')).getCIs).toEqual([]);
  });

  it("isolates two organizations: another organization's CIs read and mutate like missing ones", async () => {
    const appA = await createCI({ _name: 'org-a-app', _type: 'application' });
    const dbA = await createCI({ _name: 'org-a-db', _type: 'database' });
    const serverB = await createCI({ _name: 'org-b-server' }, ORG_B);
    const session = getNeo4jClient().getSession();
    try {
      // appA -> dbA inside ORG_A, plus a cross-organization edge appA -> serverB that
      // no ORG_A traversal may follow.
      await session.run(
        `MATCH (app:CI {id: $appA}), (db:CI {id: $dbA}), (server:CI {id: $serverB})
         CREATE (app)-[:DEPENDS_ON]->(db), (app)-[:DEPENDS_ON]->(server)`,
        { appA, dbA, serverB }
      );
    } finally {
      await session.close();
    }
    const asB = (query: string, variables?: Record<string, unknown>) => execute(query, variables, orgBToken);

    // Reads as ORG_B: only ORG_B's CI, and ORG_A's CIs look missing.
    expect(expectSuccess(await asB('{ getCIs { _id } }')).getCIs).toEqual([{ _id: serverB }]);
    expect(expectSuccess(await asB('{ searchCIs(query: "org-") { _id } }')).searchCIs).toEqual([{ _id: serverB }]);
    const foreignReads = expectSuccess(await asB(
      `query($a: ID!, $db: ID!) {
        getCI(id: $a) { _id }
        getCIRelationships(id: $a) { _type }
        getCIDependencies(id: $a) { _id }
        getImpactAnalysis(id: $db) { _distance }
      }`,
      { a: appA, db: dbA }
    ));
    expect(foreignReads).toEqual({ getCI: null, getCIRelationships: [], getCIDependencies: [], getImpactAnalysis: [] });
    // ORG_B's own server has an incoming edge from ORG_A: not visible to ORG_B.
    expect(expectSuccess(await asB(
      'query($id: ID!) { getImpactAnalysis(id: $id) { _distance } getCIRelationships(id: $id) { _type } }',
      { id: serverB }
    ))).toEqual({ getImpactAnalysis: [], getCIRelationships: [] });

    // Traversals as ORG_A never reach ORG_B's server.
    const ownReads = expectSuccess(await execute(
      'query($id: ID!) { getCIDependencies(id: $id) { _id } getCI(id: $id) { _relationships { _ci { _id } } } }',
      { id: appA }
    ));
    expect(ownReads).toEqual({
      getCIDependencies: [{ _id: dbA }],
      getCI: { _relationships: [{ _ci: { _id: dbA } }] },
    });

    // Mutations as ORG_B on ORG_A's CIs: the same NOT_FOUND as a missing id, nothing written.
    const notFound = { message: 'CI not found', extensions: expect.objectContaining({ code: 'NOT_FOUND' }) };
    const missingId = uuidv4();
    const mutations: Array<[string, (id: string) => Record<string, unknown>]> = [
      ['mutation($id: ID!) { deleteCI(id: $id) }', id => ({ id })],
      [
        'mutation($id: ID!, $input: UpdateCIInput!) { updateCI(id: $id, input: $input) { _id } }',
        id => ({ id, input: { _name: 'hijacked' } }),
      ],
      [
        'mutation($input: CreateRelationshipInput!) { createRelationship(input: $input) }',
        id => ({ input: { _fromId: serverB, _toId: id, _type: 'DEPENDS_ON' } }),
      ],
    ];
    for (const [mutation, variables] of mutations) {
      for (const id of [missingId, appA]) {
        const response = await asB(mutation, variables(id));
        expect(response.body.data ?? null).toBeNull();
        expect(response.body.errors?.[0]).toMatchObject(notFound);
      }
    }
    const foreignEdgeDelete = await asB(
      'mutation($from: ID!, $to: ID!) { deleteRelationship(fromId: $from, toId: $to, type: DEPENDS_ON) }',
      { from: appA, to: dbA }
    );
    expect(foreignEdgeDelete.body.errors?.[0]).toMatchObject({ extensions: { code: 'NOT_FOUND' } });

    const check = getNeo4jClient().getSession();
    try {
      const state = await check.run(
        `MATCH (app:CI {id: $appA})
         RETURN app.name AS name, app.organization_id AS org,
                COUNT { (app)-[:DEPENDS_ON]->(:CI {id: $dbA}) } AS internalEdges,
                COUNT { (:CI {id: $serverB})-[:DEPENDS_ON]->(app) } AS reverseEdges`,
        { appA, dbA, serverB }
      );
      expect(state.records).toHaveLength(1);
      const record = state.records[0]!;
      expect(record.get('name')).toBe('org-a-app');
      expect(record.get('org')).toBe(ORG_A);
      expect(record.get('internalEdges').toNumber()).toBe(1);
      expect(record.get('reverseEdges').toNumber()).toBe(0);
    } finally {
      await check.close();
    }
  });

  it('creates a relationship and returns it through the relationship query', async () => {
    const serverId = await createCI({ _name: 'app-server' });
    const appId = await createCI({ _name: 'web-application', _type: 'application' });

    const created = await execute(
      `mutation CreateRelationship($input: CreateRelationshipInput!) {
        createRelationship(input: $input)
      }`,
      { input: { _fromId: appId, _toId: serverId, _type: 'DEPENDS_ON', _properties: { critical: true } } }
    );
    expect(expectSuccess(created).createRelationship).toBe(true);

    const relationships = await execute(
      `query($id: ID!) {
        getCIRelationships(id: $id, direction: "out") { _type _properties _ci { _id _name } }
      }`,
      { id: appId }
    );
    expect(expectSuccess(relationships).getCIRelationships).toEqual([
      expect.objectContaining({
        _type: 'DEPENDS_ON',
        _properties: expect.objectContaining({ critical: true }),
        _ci: expect.objectContaining({ _id: serverId, _name: 'app-server' }),
      }),
    ]);
  });

  it('returns impacted CIs at the requested graph depth', async () => {
    const databaseId = await createCI({ _name: 'database', _type: 'database' });
    const appId = await createCI({ _name: 'application', _type: 'application' });
    const session = getNeo4jClient().getSession();
    try {
      await session.run(
        'MATCH (app:CI {id: $appId}), (database:CI {id: $databaseId}) CREATE (app)-[:DEPENDS_ON]->(database)',
        { appId, databaseId }
      );
    } finally {
      await session.close();
    }

    const response = await execute(
      'query($id: ID!) { getImpactAnalysis(id: $id, depth: 1) { _distance _ci { _id _name } } }',
      { id: databaseId }
    );
    expect(expectSuccess(response).getImpactAnalysis).toEqual([
      expect.objectContaining({ _distance: 1, _ci: expect.objectContaining({ _id: appId, _name: 'application' }) }),
    ]);
  });

  it('searches CIs by text and applies canonical filters', async () => {
    await createCI({ _name: 'web-server-01', _type: 'server' });
    await createCI({ _name: 'web-application', _type: 'application' });

    const response = await execute(
      `query Search($query: String!, $filter: SearchCIFilter!) {
        searchCIs(query: $query, filter: $filter) { _name _type }
      }`,
      { query: 'web', filter: { _type: 'SERVER' } }
    );
    expect(expectSuccess(response).searchCIs).toEqual([
      expect.objectContaining({ _name: 'web-server-01', _type: 'SERVER' }),
    ]);
  });

  it('supports a complete authenticated CI workflow', async () => {
    const serverId = await createCI({ _name: 'workflow-server' });
    const appId = await createCI({ _name: 'workflow-app', _type: 'application' });

    const relationship = await execute(
      'mutation($input: CreateRelationshipInput!) { createRelationship(input: $input) }',
      { input: { _fromId: appId, _toId: serverId, _type: 'DEPENDS_ON' } }
    );
    expect(expectSuccess(relationship).createRelationship).toBe(true);

    const dependencies = await execute(
      'query($id: ID!) { getCIDependencies(id: $id) { _id } }',
      { id: appId }
    );
    expect(expectSuccess(dependencies).getCIDependencies).toEqual([{ _id: serverId }]);
  });
});
