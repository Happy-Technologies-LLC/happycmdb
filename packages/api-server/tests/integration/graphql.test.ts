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
    await getNeo4jClient().createCI({
      _id: id,
      external_id: overrides._externalId,
      name: overrides._name ?? `ci-${id}`,
      _type: overrides._type ?? 'server',
      status: overrides._status ?? 'active',
      environment: overrides._environment ?? 'production',
      metadata: overrides._metadata ?? {},
    });
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

  it('creates a CI with metadata and persists canonical fields', async () => {
    const ciId = uuidv4();
    const metadata = { ipAddress: '10.0.1.100', tags: ['web', 'production'] };
    const response = await execute(
      `mutation CreateCI($input: CreateCIInput!) {
        createCI(input: $input) { _id _externalId _name _type _status _environment _metadata }
      }`,
      {
        input: {
          _id: ciId,
          _externalId: 'server-001',
          _name: 'production-server',
          _type: 'SERVER',
          _status: 'ACTIVE',
          _environment: 'PRODUCTION',
          _metadata: metadata,
        },
      }
    );
    expect(expectSuccess(response).createCI).toMatchObject({
      _id: ciId,
      _externalId: 'server-001',
      _name: 'production-server',
      _type: 'SERVER',
      _status: 'ACTIVE',
      _environment: 'PRODUCTION',
      _metadata: metadata,
    });

    const persisted = await execute('{ getCIs { _id _metadata } }');
    expect(expectSuccess(persisted).getCIs).toEqual([
      expect.objectContaining({ _id: ciId, _metadata: metadata }),
    ]);
  });

  it('updates an existing CI and persists the update', async () => {
    const ciId = await createCI({ _name: 'old-name', _status: 'inactive' });
    const response = await execute(
      `mutation UpdateCI($id: ID!, $input: UpdateCIInput!) {
        updateCI(id: $id, input: $input) { _id _name _status _environment _metadata }
      }`,
      {
        id: ciId,
        input: {
          _name: 'updated-server',
          _status: 'ACTIVE',
          _environment: 'STAGING',
          _metadata: { version: '2.0' },
        },
      }
    );
    expect(expectSuccess(response).updateCI).toMatchObject({
      _id: ciId,
      _name: 'updated-server',
      _status: 'ACTIVE',
      _environment: 'STAGING',
      _metadata: { version: '2.0' },
    });

    const persisted = await execute('query($id: ID!) { getCI(id: $id) { _name _status _environment _metadata } }', { id: ciId });
    expect(expectSuccess(persisted).getCI).toMatchObject({
      _name: 'updated-server',
      _status: 'ACTIVE',
      _environment: 'STAGING',
      _metadata: { version: '2.0' },
    });
  });

  it('deletes an existing CI and rejects a second deletion', async () => {
    const ciId = await createCI();
    const deleted = await execute('mutation($id: ID!) { deleteCI(id: $id) }', { id: ciId });
    expect(expectSuccess(deleted).deleteCI).toBe(true);

    const missing = await execute('mutation($id: ID!) { deleteCI(id: $id) }', { id: ciId });
    expect(missing.body.errors?.[0]).toMatchObject({ extensions: { code: 'NOT_FOUND' } });
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
    const serverId = uuidv4();
    const appId = uuidv4();
    const created = await execute(
      `mutation Create($server: CreateCIInput!, $app: CreateCIInput!) {
        server: createCI(input: $server) { _id }
        app: createCI(input: $app) { _id }
      }`,
      {
        server: { _id: serverId, _name: 'workflow-server', _type: 'SERVER' },
        app: { _id: appId, _name: 'workflow-app', _type: 'APPLICATION' },
      }
    );
    expect(expectSuccess(created)).toMatchObject({
      server: { _id: serverId },
      app: { _id: appId },
    });

    const relationship = await execute(
      'mutation($input: CreateRelationshipInput!) { createRelationship(input: $input) }',
      { input: { _fromId: appId, _toId: serverId, _type: 'DEPENDS_ON' } }
    );
    expect(expectSuccess(relationship).createRelationship).toBe(true);

    const updated = await execute(
      'mutation($id: ID!, $input: UpdateCIInput!) { updateCI(id: $id, input: $input) { _status } }',
      { id: serverId, input: { _status: 'MAINTENANCE' } }
    );
    expect(expectSuccess(updated).updateCI).toEqual({ _status: 'MAINTENANCE' });

    const dependencies = await execute(
      'query($id: ID!) { getCIDependencies(id: $id) { _id } }',
      { id: appId }
    );
    expect(expectSuccess(dependencies).getCIDependencies).toEqual([{ _id: serverId }]);
  });
});
