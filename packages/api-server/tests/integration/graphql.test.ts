// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Tests - GraphQL API
 *
 * Tests GraphQL queries and mutations for the CMDB platform.
 * Uses Apollo testing utilities and testcontainers for realistic testing.
 */

import { ApolloServer } from '@apollo/server';
import { v4 as uuidv4 } from 'uuid';
import { startTestContainers, stopTestContainers, cleanDatabases } from '../helpers/test-containers';
import { CI, CIType, CIStatus, Environment } from '@cmdb/common';
import { getNeo4jClient } from '@cmdb/database';

// GraphQL Schema
const typeDefs = `#graphql
  type CI {
    id: ID!
    external_id: String
    name: String!
    type: String!
    status: String!
    environment: String
    created_at: String!
    updated_at: String!
    discovered_at: String!
    metadata: JSON
  }

  type Relationship {
    type: String!
    from: CI!
    to: CI!
    properties: JSON
  }

  type CIConnection {
    nodes: [CI!]!
    totalCount: Int!
  }

  scalar JSON

  type Query {
    ci(id: ID!): CI
    cis(type: String, status: String, environment: String, limit: Int, offset: Int): CIConnection!
    ciRelationships(id: ID!, direction: String): [Relationship!]!
    ciImpactAnalysis(id: ID!, depth: Int): [CI!]!
    searchCIs(query: String!): [CI!]!
  }

  type Mutation {
    createCI(input: CIInput!): CI!
    updateCI(id: ID!, input: CIUpdateInput!): CI!
    deleteCI(id: ID!): Boolean!
    createRelationship(from: ID!, to: ID!, type: String!): Relationship!
  }

  input CIInput {
    id: ID!
    external_id: String
    name: String!
    type: String!
    status: String
    environment: String
    discovered_at: String
    metadata: JSON
  }

  input CIUpdateInput {
    name: String
    status: String
    environment: String
    metadata: JSON
  }
`;

/**
 * A CI source object as seen by GraphQL field resolvers. The underlying Neo4j
 * client returns two shapes depending on the entry point:
 *  - `recordToCI()` output (getCI / createCI / updateCI): underscore-prefixed
 *    keys (`_id`, `_type`, `_status`, `_created_at`, `_metadata`) plus plain
 *    `external_id`, `name`, `environment`.
 *  - raw Neo4j node `.properties` (cis / searchCIs / relationship endpoints):
 *    all plain keys (`id`, `type`, `status`, ...) with `metadata` as a JSON
 *    string.
 * Field resolvers normalize both into the GraphQL `CI` shape.
 */
interface CISource {
  _id?: string;
  id?: string;
  external_id?: string | null;
  name?: string;
  _type?: string;
  type?: string;
  _status?: string;
  status?: string;
  environment?: string | null;
  _created_at?: unknown;
  created_at?: unknown;
  _updated_at?: unknown;
  updated_at?: unknown;
  _discovered_at?: unknown;
  discovered_at?: unknown;
  _metadata?: unknown;
  metadata?: unknown;
}

interface RelationshipResult {
  type: string;
  from: CISource;
  to: CISource;
  properties: Record<string, unknown>;
}

interface GqlCIInput {
  id: string;
  external_id?: string;
  name: string;
  type: string;
  status?: string;
  environment?: string;
  discovered_at?: string;
  metadata?: Record<string, unknown>;
}

interface GqlCIUpdateInput {
  name?: string;
  status?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

const toScalarString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
};

const toMetadataObject = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    return value.length > 0 ? (JSON.parse(value) as Record<string, unknown>) : {};
  }
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return {};
};

// GraphQL Resolvers
const resolvers = {
  CI: {
    id: (ci: CISource) => ci._id ?? ci.id,
    external_id: (ci: CISource) => ci.external_id ?? null,
    name: (ci: CISource) => ci.name,
    type: (ci: CISource) => ci._type ?? ci.type,
    status: (ci: CISource) => ci._status ?? ci.status,
    environment: (ci: CISource) => ci.environment ?? null,
    created_at: (ci: CISource) => toScalarString(ci._created_at ?? ci.created_at),
    updated_at: (ci: CISource) => toScalarString(ci._updated_at ?? ci.updated_at),
    discovered_at: (ci: CISource) => toScalarString(ci._discovered_at ?? ci.discovered_at),
    metadata: (ci: CISource) => toMetadataObject(ci._metadata ?? ci.metadata),
  },
  Query: {
    ci: async (_parent: unknown, { id }: { id: string }): Promise<CI | null> => {
      const neo4jClient = getNeo4jClient();
      return neo4jClient.getCI(id);
    },
    cis: async (
      _parent: unknown,
      {
        type,
        status,
        environment,
        limit = 100,
        offset = 0,
      }: {
        type?: string;
        status?: string;
        environment?: string;
        limit?: number;
        offset?: number;
      }
    ): Promise<{ nodes: CISource[]; totalCount: number }> => {
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();
      try {
        let query = 'MATCH (ci:CI) WHERE 1=1';
        const params: Record<string, unknown> = {};

        if (type) {
          query += ' AND ci.type = $type';
          params.type = type;
        }
        if (status) {
          query += ' AND ci.status = $status';
          params.status = status;
        }
        if (environment) {
          query += ' AND ci.environment = $environment';
          params.environment = environment;
        }

        const countResult = await session.run(query + ' RETURN count(ci) as total', params);
        const totalRecord = countResult.records[0];
        const totalCount = totalRecord
          ? (totalRecord.get('total') as { toNumber(): number }).toNumber()
          : 0;

        query += ' RETURN ci ORDER BY ci.name SKIP toInteger($offset) LIMIT toInteger($limit)';
        params.offset = offset;
        params.limit = limit;

        const result = await session.run(query, params);
        const nodes = result.records.map(
          (r) => (r.get('ci') as { properties: CISource }).properties
        );

        return { nodes, totalCount };
      } finally {
        await session.close();
      }
    },
    ciRelationships: async (
      _parent: unknown,
      { id, direction = 'both' }: { id: string; direction?: string }
    ): Promise<RelationshipResult[]> => {
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();
      try {
        const queries: string[] = [];
        if (direction === 'out' || direction === 'both') {
          queries.push(
            'MATCH (from:CI {id: $id})-[r]->(to:CI) ' +
              'RETURN from AS fromNode, to AS toNode, type(r) AS relType, properties(r) AS props'
          );
        }
        if (direction === 'in' || direction === 'both') {
          queries.push(
            'MATCH (from:CI)-[r]->(to:CI {id: $id}) ' +
              'RETURN from AS fromNode, to AS toNode, type(r) AS relType, properties(r) AS props'
          );
        }

        const relationships: RelationshipResult[] = [];
        for (const query of queries) {
          const result = await session.run(query, { id });
          for (const record of result.records) {
            relationships.push({
              type: record.get('relType') as string,
              from: (record.get('fromNode') as { properties: CISource }).properties,
              to: (record.get('toNode') as { properties: CISource }).properties,
              properties: (record.get('props') as Record<string, unknown>) ?? {},
            });
          }
        }
        return relationships;
      } finally {
        await session.close();
      }
    },
    ciImpactAnalysis: async (
      _parent: unknown,
      { id, depth = 5 }: { id: string; depth?: number }
    ): Promise<CI[]> => {
      const neo4jClient = getNeo4jClient();
      const results = await neo4jClient.impactAnalysis(id, depth);
      return results.map((result) => result._ci);
    },
    searchCIs: async (_parent: unknown, { query }: { query: string }): Promise<CISource[]> => {
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          CALL db.index.fulltext.queryNodes('ci_search', $query)
          YIELD node, score
          RETURN node
          ORDER BY score DESC
          LIMIT 50
          `,
          { query }
        );
        return result.records.map(
          (r) => (r.get('node') as { properties: CISource }).properties
        );
      } finally {
        await session.close();
      }
    },
  },
  Mutation: {
    createCI: async (_parent: unknown, { input }: { input: GqlCIInput }): Promise<CI> => {
      const neo4jClient = getNeo4jClient();
      return neo4jClient.createCI({
        _id: input.id,
        external_id: input.external_id,
        name: input.name,
        _type: input.type as CIType,
        status: input.status as CIStatus | undefined,
        environment: input.environment as Environment | undefined,
        discovered_at: input.discovered_at,
        metadata: input.metadata,
      });
    },
    updateCI: async (
      _parent: unknown,
      { id, input }: { id: string; input: GqlCIUpdateInput }
    ): Promise<CI> => {
      const neo4jClient = getNeo4jClient();
      return neo4jClient.updateCI(id, {
        name: input.name,
        status: input.status as CIStatus | undefined,
        environment: input.environment as Environment | undefined,
        metadata: input.metadata,
      });
    },
    deleteCI: async (_parent: unknown, { id }: { id: string }): Promise<boolean> => {
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();
      try {
        await session.run('MATCH (ci:CI {id: $id}) DETACH DELETE ci', { id });
        return true;
      } finally {
        await session.close();
      }
    },
    createRelationship: async (
      _parent: unknown,
      { from, to, type }: { from: string; to: string; type: string }
    ): Promise<RelationshipResult> => {
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();
      try {
        const result = await session.run(
          `
          MATCH (from:CI {id: $fromId}), (to:CI {id: $toId})
          CREATE (from)-[r:${type}]->(to)
          RETURN from AS fromNode, to AS toNode, type(r) AS relType
          `,
          { fromId: from, toId: to }
        );

        const record = result.records[0]!;
        return {
          type: record.get('relType') as string,
          from: (record.get('fromNode') as { properties: CISource }).properties,
          to: (record.get('toNode') as { properties: CISource }).properties,
          properties: {},
        };
      } finally {
        await session.close();
      }
    },
  },
};

describe('GraphQL API Integration Tests', () => {
  let server: ApolloServer | undefined;

  // Setup test containers before all tests
  beforeAll(async () => {
    await startTestContainers();

    // Create Apollo Server
    server = new ApolloServer({
      typeDefs,
      resolvers,
    });

    await server.start();
  }, 120000);

  // Clean databases between tests
  afterEach(async () => {
    await cleanDatabases();
  });

  // Stop containers after all tests
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    await stopTestContainers();
  }, 30000);

  describe('Query: ci - Get single CI', () => {
    it('should retrieve CI by ID', async () => {
      const ciId = uuidv4();

      // Create CI directly in Neo4j
      const neo4jClient = getNeo4jClient();
      await neo4jClient.createCI({
        _id: ciId,
        name: 'test-server',
        _type: 'server',
        status: 'active',
        environment: 'production',
      });

      const response = await server!.executeOperation({
        query: `
          query GetCI($id: ID!) {
            ci(id: $id) {
              id
              name
              type
              status
              environment
            }
          }
        `,
        variables: { id: ciId },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        expect(response.body.singleResult.data?.ci).toMatchObject({
          id: ciId,
          name: 'test-server',
          type: 'server',
          status: 'active',
          environment: 'production',
        });
      }
    });

    it('should return null for non-existent CI', async () => {
      const response = await server!.executeOperation({
        query: `
          query GetCI($id: ID!) {
            ci(id: $id) {
              id
              name
            }
          }
        `,
        variables: { id: 'non-existent-id' },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.data?.ci).toBeNull();
      }
    });
  });

  describe('Query: cis - List CIs', () => {
    beforeEach(async () => {
      // Create test data
      const neo4jClient = getNeo4jClient();
      await neo4jClient.createCI({
        _id: uuidv4(),
        name: 'web-server-01',
        _type: 'server',
        status: 'active',
        environment: 'production',
      });
      await neo4jClient.createCI({
        _id: uuidv4(),
        name: 'web-server-02',
        _type: 'server',
        status: 'active',
        environment: 'production',
      });
      await neo4jClient.createCI({
        _id: uuidv4(),
        name: 'database-01',
        _type: 'database',
        status: 'active',
        environment: 'production',
      });
    });

    it('should list all CIs', async () => {
      const response = await server!.executeOperation({
        query: `
          query ListCIs {
            cis {
              nodes {
                id
                name
                type
              }
              totalCount
            }
          }
        `,
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        const data = response.body.singleResult.data?.cis as
          | { nodes: unknown[]; totalCount: number }
          | undefined;
        expect(data?.nodes).toHaveLength(3);
        expect(data?.totalCount).toBe(3);
      }
    });

    it('should filter CIs by type', async () => {
      const response = await server!.executeOperation({
        query: `
          query ListCIsByType($type: String) {
            cis(type: $type) {
              nodes {
                id
                name
                type
              }
              totalCount
            }
          }
        `,
        variables: { type: 'server' },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        const data = response.body.singleResult.data?.cis as
          | { nodes: Array<{ type: string }>; totalCount: number }
          | undefined;
        expect(data?.nodes).toHaveLength(2);
        expect(data?.totalCount).toBe(2);
        expect(data?.nodes.every((ci) => ci.type === 'server')).toBe(true);
      }
    });

    it('should support pagination', async () => {
      const response = await server!.executeOperation({
        query: `
          query ListCIsPaginated($limit: Int, $offset: Int) {
            cis(limit: $limit, offset: $offset) {
              nodes {
                id
                name
              }
              totalCount
            }
          }
        `,
        variables: { limit: 2, offset: 0 },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        const data = response.body.singleResult.data?.cis as
          | { nodes: unknown[]; totalCount: number }
          | undefined;
        expect(data?.nodes).toHaveLength(2);
        expect(data?.totalCount).toBe(3);
      }
    });
  });

  describe('Mutation: createCI', () => {
    it('should create new CI', async () => {
      const ciId = uuidv4();
      const response = await server!.executeOperation({
        query: `
          mutation CreateCI($input: CIInput!) {
            createCI(input: $input) {
              id
              name
              type
              status
              environment
            }
          }
        `,
        variables: {
          input: {
            id: ciId,
            name: 'new-server',
            type: 'server',
            status: 'active',
            environment: 'production',
            metadata: { region: 'us-east-1' },
          },
        },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        expect(response.body.singleResult.data?.createCI).toMatchObject({
          id: ciId,
          name: 'new-server',
          type: 'server',
          status: 'active',
          environment: 'production',
        });
      }
    });

    it('should handle metadata in CI creation', async () => {
      const ciId = uuidv4();
      const metadata = {
        ip_address: '10.0.1.100',
        hostname: 'server01.example.com',
        cpu_cores: 8,
      };

      const response = await server!.executeOperation({
        query: `
          mutation CreateCI($input: CIInput!) {
            createCI(input: $input) {
              id
              name
              metadata
            }
          }
        `,
        variables: {
          input: {
            id: ciId,
            name: 'metadata-server',
            type: 'server',
            metadata,
          },
        },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        const created = response.body.singleResult.data?.createCI as
          | { metadata: Record<string, unknown> }
          | undefined;
        expect(created?.metadata).toMatchObject(metadata);
      }
    });
  });

  describe('Mutation: updateCI', () => {
    it('should update existing CI', async () => {
      const ciId = uuidv4();

      // Create CI first
      const neo4jClient = getNeo4jClient();
      await neo4jClient.createCI({
        _id: ciId,
        name: 'original-name',
        _type: 'server',
        status: 'active',
      });

      // Update CI
      const response = await server!.executeOperation({
        query: `
          mutation UpdateCI($id: ID!, $input: CIUpdateInput!) {
            updateCI(id: $id, input: $input) {
              id
              name
              status
              metadata
            }
          }
        `,
        variables: {
          id: ciId,
          input: {
            name: 'updated-name',
            status: 'maintenance',
            metadata: { updated: true },
          },
        },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        expect(response.body.singleResult.data?.updateCI).toMatchObject({
          id: ciId,
          name: 'updated-name',
          status: 'maintenance',
          metadata: { updated: true },
        });
      }
    });
  });

  describe('Mutation: deleteCI', () => {
    it('should delete existing CI', async () => {
      const ciId = uuidv4();

      // Create CI first
      const neo4jClient = getNeo4jClient();
      await neo4jClient.createCI({
        _id: ciId,
        name: 'to-delete',
        _type: 'server',
      });

      // Delete CI
      const response = await server!.executeOperation({
        query: `
          mutation DeleteCI($id: ID!) {
            deleteCI(id: $id)
          }
        `,
        variables: { id: ciId },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.data?.deleteCI).toBe(true);
      }

      // Verify deletion
      const ci = await neo4jClient.getCI(ciId);
      expect(ci).toBeNull();
    });
  });

  describe('Relationships and Impact Analysis', () => {
    let serverId: string;
    let appId: string;
    let dbId: string;

    beforeEach(async () => {
      serverId = uuidv4();
      appId = uuidv4();
      dbId = uuidv4();

      const neo4jClient = getNeo4jClient();

      // Create CIs
      await neo4jClient.createCI({
        _id: serverId,
        name: 'app-server',
        _type: 'server',
        status: 'active',
      });

      await neo4jClient.createCI({
        _id: appId,
        name: 'web-app',
        _type: 'application',
        status: 'active',
      });

      await neo4jClient.createCI({
        _id: dbId,
        name: 'postgres-db',
        _type: 'database',
        status: 'active',
      });

      // Create dependency relationships (impactAnalysis traverses DEPENDS_ON)
      const session = neo4jClient.getSession();
      try {
        await session.run(
          `
          MATCH (from:CI {id: $fromId}), (to:CI {id: $toId})
          CREATE (from)-[r:DEPENDS_ON]->(to)
          `,
          { fromId: serverId, toId: appId }
        );

        await session.run(
          `
          MATCH (from:CI {id: $fromId}), (to:CI {id: $toId})
          CREATE (from)-[r:DEPENDS_ON]->(to)
          `,
          { fromId: appId, toId: dbId }
        );
      } finally {
        await session.close();
      }
    });

    it('should create relationship between CIs', async () => {
      const newServerId = uuidv4();
      const newAppId = uuidv4();

      const neo4jClient = getNeo4jClient();
      await neo4jClient.createCI({ _id: newServerId, name: 'new-server', _type: 'server' });
      await neo4jClient.createCI({ _id: newAppId, name: 'new-app', _type: 'application' });

      const response = await server!.executeOperation({
        query: `
          mutation CreateRelationship($from: ID!, $to: ID!, $type: String!) {
            createRelationship(from: $from, to: $to, type: $type) {
              type
              from {
                id
                name
              }
              to {
                id
                name
              }
            }
          }
        `,
        variables: {
          from: newServerId,
          to: newAppId,
          type: 'HOSTS',
        },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        expect(response.body.singleResult.data?.createRelationship).toMatchObject({
          type: 'HOSTS',
          from: { id: newServerId },
          to: { id: newAppId },
        });
      }
    });

    it('should query CI relationships', async () => {
      const response = await server!.executeOperation({
        query: `
          query GetRelationships($id: ID!, $direction: String) {
            ciRelationships(id: $id, direction: $direction) {
              type
              from {
                id
                name
              }
              to {
                id
                name
              }
            }
          }
        `,
        variables: { id: serverId, direction: 'out' },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        const rels = response.body.singleResult.data?.ciRelationships as unknown[] | undefined;
        expect(rels).toBeInstanceOf(Array);
        expect(rels?.length).toBeGreaterThan(0);
      }
    });

    it('should perform impact analysis', async () => {
      const response = await server!.executeOperation({
        query: `
          query ImpactAnalysis($id: ID!, $depth: Int) {
            ciImpactAnalysis(id: $id, depth: $depth) {
              id
              name
              type
            }
          }
        `,
        variables: { id: dbId, depth: 3 },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        const impacted = response.body.singleResult.data?.ciImpactAnalysis as
          | unknown[]
          | undefined;
        expect(impacted).toBeInstanceOf(Array);
        // Database impacts app and server
        expect(impacted?.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('Query: searchCIs', () => {
    beforeEach(async () => {
      const neo4jClient = getNeo4jClient();

      await neo4jClient.createCI({
        _id: uuidv4(),
        name: 'production-web-server',
        _type: 'server',
        external_id: 'i-prod-web-001',
      });

      await neo4jClient.createCI({
        _id: uuidv4(),
        name: 'production-database',
        _type: 'database',
        external_id: 'db-prod-001',
      });

      await neo4jClient.createCI({
        _id: uuidv4(),
        name: 'staging-app',
        _type: 'application',
      });
    });

    it('should search CIs by name', async () => {
      const response = await server!.executeOperation({
        query: `
          query SearchCIs($query: String!) {
            searchCIs(query: $query) {
              id
              name
              type
            }
          }
        `,
        variables: { query: 'production' },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        expect(response.body.singleResult.errors).toBeUndefined();
        const found = response.body.singleResult.data?.searchCIs as unknown[] | undefined;
        expect(found).toBeInstanceOf(Array);
        expect(found?.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('should search CIs by type', async () => {
      const response = await server!.executeOperation({
        query: `
          query SearchCIs($query: String!) {
            searchCIs(query: $query) {
              id
              name
              type
            }
          }
        `,
        variables: { query: 'database' },
      });

      expect(response.body.kind).toBe('single');
      if (response.body.kind === 'single') {
        const found = response.body.singleResult.data?.searchCIs as unknown[] | undefined;
        expect(found?.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('Complex Workflow', () => {
    it('should support complete GraphQL workflow', async () => {
      const serverId = uuidv4();
      const appId = uuidv4();

      // 1. Create server CI
      const createServerResponse = await server!.executeOperation({
        query: `
          mutation CreateCI($input: CIInput!) {
            createCI(input: $input) {
              id
              name
              type
              status
            }
          }
        `,
        variables: {
          input: {
            id: serverId,
            name: 'workflow-server',
            type: 'server',
            status: 'active',
            environment: 'production',
          },
        },
      });

      expect(createServerResponse.body.kind).toBe('single');

      // 2. Create app CI
      const createAppResponse = await server!.executeOperation({
        query: `
          mutation CreateCI($input: CIInput!) {
            createCI(input: $input) {
              id
              name
            }
          }
        `,
        variables: {
          input: {
            id: appId,
            name: 'workflow-app',
            type: 'application',
            status: 'active',
          },
        },
      });

      expect(createAppResponse.body.kind).toBe('single');

      // 3. Create relationship
      const createRelResponse = await server!.executeOperation({
        query: `
          mutation CreateRelationship($from: ID!, $to: ID!, $type: String!) {
            createRelationship(from: $from, to: $to, type: $type) {
              type
            }
          }
        `,
        variables: {
          from: serverId,
          to: appId,
          type: 'HOSTS',
        },
      });

      expect(createRelResponse.body.kind).toBe('single');

      // 4. Query relationships
      const queryRelResponse = await server!.executeOperation({
        query: `
          query GetRelationships($id: ID!) {
            ciRelationships(id: $id) {
              type
              to {
                name
              }
            }
          }
        `,
        variables: { id: serverId },
      });

      expect(queryRelResponse.body.kind).toBe('single');
      if (queryRelResponse.body.kind === 'single') {
        const rels = queryRelResponse.body.singleResult.data?.ciRelationships as
          | unknown[]
          | undefined;
        expect(rels?.length).toBeGreaterThan(0);
      }

      // 5. Update server status
      const updateResponse = await server!.executeOperation({
        query: `
          mutation UpdateCI($id: ID!, $input: CIUpdateInput!) {
            updateCI(id: $id, input: $input) {
              id
              status
            }
          }
        `,
        variables: {
          id: serverId,
          input: { status: 'maintenance' },
        },
      });

      expect(updateResponse.body.kind).toBe('single');
      if (updateResponse.body.kind === 'single') {
        const updated = updateResponse.body.singleResult.data?.updateCI as
          | { status: string }
          | undefined;
        expect(updated?.status).toBe('maintenance');
      }

      // 6. Delete CIs
      await server!.executeOperation({
        query: `
          mutation DeleteCI($id: ID!) {
            deleteCI(id: $id)
          }
        `,
        variables: { id: appId },
      });

      await server!.executeOperation({
        query: `
          mutation DeleteCI($id: ID!) {
            deleteCI(id: $id)
          }
        `,
        variables: { id: serverId },
      });

      // 7. Verify deletion
      const verifyResponse = await server!.executeOperation({
        query: `
          query GetCI($id: ID!) {
            ci(id: $id) {
              id
            }
          }
        `,
        variables: { id: serverId },
      });

      expect(verifyResponse.body.kind).toBe('single');
      if (verifyResponse.body.kind === 'single') {
        expect(verifyResponse.body.singleResult.data?.ci).toBeNull();
      }
    });
  });
});
