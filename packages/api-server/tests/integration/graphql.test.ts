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
import { getNeo4jClient, UNSCOPED_CI_ACCESS } from '@cmdb/database';
import { authRoutes } from '../../src/rest/routes/auth.routes';
import { createGraphQLServer } from '../../src/graphql/server';
import type { ApolloServer } from '@apollo/server';

interface GraphQLBody {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

describe('GraphQL API Integration Tests', () => {
  let app: Express;
  let server: ApolloServer<any>;
  let authToken: string;
  const userId = uuidv4();
  const username = `gqladmin${uuidv4().replace(/-/g, '').slice(0, 20)}`;
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
    }> = {}
  ) => {
    const id = overrides._id ?? uuidv4();
    // GraphQL CI reads are not tenant-scoped yet, so fixtures are written unscoped (no organization).
    await getNeo4jClient().createCI({
      _id: id,
      external_id: overrides._externalId,
      name: overrides._name ?? `ci-${id}`,
      _type: overrides._type ?? 'server',
      status: overrides._status ?? 'active',
      environment: overrides._environment ?? 'production',
      metadata: overrides._metadata ?? {},
    }, UNSCOPED_CI_ACCESS);
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
      await session.run(
        `CREATE (u:User {
          _id: $id,
          _username: $username,
          _email: $email,
          _passwordHash: $passwordHash,
          _role: 'admin',
          _enabled: true,
          _createdAt: datetime(),
          _updatedAt: datetime()
        })`,
        { id: userId, username, email: `${username}@example.com`, passwordHash }
      );
    } finally {
      await session.close();
    }

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ username, password })
      .expect(200);
    authToken = login.body.data._accessToken;

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
      await session.run('MATCH (u:User {_id: $id}) DETACH DELETE u', { id: userId });
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

  // /api/v1/cis is organization-scoped and GraphQL has no CI tenant scoping
  // yet, so the CI mutations fail closed and write nothing.
  it('refuses createCI, updateCI and deleteCI with FORBIDDEN until GraphQL CI tenant scoping lands', async () => {
    const newId = uuidv4();
    const created = await execute(
      `mutation CreateCI($input: CreateCIInput!) {
        createCI(input: $input) { _id }
      }`,
      { input: { _id: newId, _name: 'production-server', _type: 'SERVER' } }
    );
    expect(created.body.errors?.[0]).toMatchObject({
      message: 'CI tenant scoping for GraphQL is pending',
      extensions: { code: 'FORBIDDEN' },
    });

    const ciId = await createCI({ _name: 'old-name', _status: 'inactive' });
    const updated = await execute(
      `mutation UpdateCI($id: ID!, $input: UpdateCIInput!) {
        updateCI(id: $id, input: $input) { _id }
      }`,
      { id: ciId, input: { _name: 'updated-server' } }
    );
    expect(updated.body.errors?.[0]).toMatchObject({ extensions: { code: 'FORBIDDEN' } });

    const deleted = await execute('mutation($id: ID!) { deleteCI(id: $id) }', { id: ciId });
    expect(deleted.body.errors?.[0]).toMatchObject({ extensions: { code: 'FORBIDDEN' } });

    const persisted = await execute('{ getCIs { _id _name } }');
    expect(expectSuccess(persisted).getCIs).toEqual([{ _id: ciId, _name: 'old-name' }]);
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
