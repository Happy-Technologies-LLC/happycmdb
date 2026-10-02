// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GraphQL CI Resolver Unit Tests
 *
 * TDD London School Approach:
 * - Mock Neo4j database client and DataLoaders
 * - Test GraphQL resolver behavior and interactions
 * - Verify query construction and response formatting
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { resolvers, GraphQLContext } from '../index';
import { createCILoader } from '../../dataloaders/ci-loader';
import { GraphQLError } from 'graphql';
import {
  createMockNeo4jDriver,
  createMockNeo4jResult,
} from '../../../../../../tests/utils/mock-database-clients';
import { createCI, createCIs } from '../../../../../../tests/utils/mock-factories';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// Mock dependencies
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock other modules that may be imported transitively
jest.mock('@cmdb/database', () => ({
  Neo4jClient: jest.fn(),
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn().mockReturnValue({
    query: jest.fn(),
    getClient: jest.fn(),
    pool: {},
  }),
  getUnifiedCredentialService: jest.fn().mockReturnValue({}),
  queueManager: { getQueue: jest.fn() },
}));

jest.mock('@cmdb/identity-resolution', () => ({
  getIdentityReconciliationEngine: jest.fn().mockReturnValue({}),
}));

jest.mock('@cmdb/integration-framework', () => ({}));

describe('GraphQL CI Resolvers', () => {
  let mockNeo4j: ReturnType<typeof createMockNeo4jDriver>;
  let mockContext: GraphQLContext;
  let mockLoaders: any;

  beforeEach(() => {
    // Arrange: Create mock Neo4j client
    mockNeo4j = createMockNeo4jDriver();

    // Arrange: Create mock DataLoaders
    mockLoaders = {
      ciLoader: {
        load: jest.fn(),
        clear: jest.fn(),
      },
      relationshipLoader: {
        load: jest.fn(),
        clear: jest.fn(),
      },
      dependentLoader: {
        load: jest.fn(),
        clear: jest.fn(),
      },
    };

    // Arrange: Create GraphQL context
    // The resolvers access context._neo4jClient and context._loaders
    mockContext = {
      _neo4jClient: {
        getSession: jest.fn().mockReturnValue(mockNeo4j.session),
        createCI: jest.fn(),
        updateCI: jest.fn(),
        getCI: jest.fn(),
        deleteCI: jest.fn(),
        createRelationship: jest.fn(),
      } as any,
      _loaders: {
        _ciLoader: mockLoaders.ciLoader,
        _relationshipLoader: mockLoaders.relationshipLoader,
        _dependentLoader: mockLoaders.dependentLoader,
      },
      // Mutation resolvers now call checkGraphQLPermission(context, 'write');
      // an operator role carries the 'write' permission (see ROLE_PERMISSIONS).
      // Every CI resolver requires the organization claim.
      user: { _userId: 'u1', _username: 'tester', _role: 'operator', _type: 'access', _organizationId: ORG_A },
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Query.getCIs', () => {
    it('should fetch all CIs without filters', async () => {
      // Arrange: Mock CIs with metadata as JSON string (resolver calls JSON.parse)
      const mockCIs = createCIs(3, { type: 'server' }).map(ci => ({
        ...ci,
        metadata: JSON.stringify(ci.metadata || {}),
      }));

      mockNeo4j.session.run.mockResolvedValueOnce(
        createMockNeo4jResult(
          mockCIs.map((ci) => ({ ci: { properties: ci } }))
        )
      );

      // Act: Execute query - resolver is at resolvers.Query (spread from Query object)
      // The resolver function name has underscore prefix in source: _getCIs
      const getCIs = (resolvers.Query as any).getCIs;
      const result = await getCIs(
        null,
        { limit: 100, offset: 0 },
        mockContext
      );

      // Assert: Verify Neo4j query
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('MATCH (ci:CI)'),
        expect.objectContaining({
          limit: expect.objectContaining({ low: 100, high: 0 }),
          offset: expect.objectContaining({ low: 0, high: 0 }),
        })
      );

      // Assert: Verify session cleanup
      expect(mockNeo4j.session.close).toHaveBeenCalled();

      // Assert: Verify results
      expect(result).toHaveLength(3);
    });

    it('should handle Neo4j errors gracefully', async () => {
      // Arrange: Mock database error
      mockNeo4j.session.run.mockRejectedValueOnce(new Error('Connection lost'));

      const getCIs = (resolvers.Query as any).getCIs;

      // Act & Assert: Expect GraphQL error
      await expect(
        getCIs(null, {}, mockContext)
      ).rejects.toThrow(GraphQLError);

      // Assert: Session still closed
      expect(mockNeo4j.session.close).toHaveBeenCalled();
    });

    it('should apply pagination correctly', async () => {
      // Arrange
      mockNeo4j.session.run.mockResolvedValueOnce(createMockNeo4jResult([]));

      const getCIs = (resolvers.Query as any).getCIs;

      // Act: Query with pagination
      await getCIs(
        null,
        {
          limit: 25,
          offset: 100,
        },
        mockContext
      );

      // Assert: Verify SKIP and LIMIT in query
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('SKIP $offset'),
        expect.objectContaining({ offset: expect.objectContaining({ low: 100, high: 0 }) })
      );

      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $limit'),
        expect.objectContaining({ limit: expect.objectContaining({ low: 25, high: 0 }) })
      );
    });
  });

  describe('Query.getCI', () => {
    it('should fetch single CI by ID using DataLoader', async () => {
      // Arrange: Mock DataLoader response
      const mockCI = createCI({ id: 'ci-123', name: 'web-server' });
      mockLoaders.ciLoader.load.mockResolvedValueOnce(mockCI);

      const getCI = (resolvers.Query as any).getCI;
      const result = await getCI(null, { id: 'ci-123' }, mockContext);

      expect(mockLoaders.ciLoader.load).toHaveBeenCalledWith({ id: 'ci-123', organizationId: ORG_A });
      expect(result).toMatchObject({
        _id: 'ci-123',
        _name: 'web-server',
        _type: 'SERVER',
        _status: 'ACTIVE',
        _environment: 'PRODUCTION',
      });
    });

    it('should return null when CI not found', async () => {
      // Arrange: DataLoader returns null
      mockLoaders.ciLoader.load.mockResolvedValueOnce(null);

      const getCI = (resolvers.Query as any).getCI;

      // Act
      const result = await getCI(
        null,
        { id: 'non-existent' },
        mockContext
      );

      // Assert
      expect(result).toBeNull();
    });

    it('should handle DataLoader errors', async () => {
      // Arrange: Mock DataLoader error
      mockLoaders.ciLoader.load.mockRejectedValueOnce(new Error('Database error'));

      const getCI = (resolvers.Query as any).getCI;

      // Act & Assert
      await expect(
        getCI(null, { id: 'ci-123' }, mockContext)
      ).rejects.toThrow(GraphQLError);
    });
  });

  describe('Query.getCIDependencies', () => {
    it('should fetch recursive dependencies with specified depth', async () => {
      // Arrange: Mock dependency graph with metadata as JSON string
      const dependencies = createCIs(3, { type: 'database' }).map(ci => ({
        ...ci,
        metadata: JSON.stringify(ci.metadata || {}),
      }));

      mockNeo4j.session.run.mockResolvedValueOnce(
        createMockNeo4jResult(
          dependencies.map((ci) => ({ dep: { properties: ci } }))
        )
      );

      const getCIDeps = (resolvers.Query as any).getCIDependencies;

      // Act: Get dependencies with depth 3
      const result = await getCIDeps(
        null,
        { id: 'ci-123', depth: 3 },
        mockContext
      );

      // Assert: Verify Cypher query with depth
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('DEPENDS_ON*1..3'),
        expect.objectContaining({ id: 'ci-123' })
      );

      expect(result).toHaveLength(3);
    });

    it('should use default depth of 5 when not specified', async () => {
      // Arrange
      mockNeo4j.session.run.mockResolvedValueOnce(createMockNeo4jResult([]));

      const getCIDeps = (resolvers.Query as any).getCIDependencies;

      // Act: Get dependencies without depth
      await getCIDeps(
        null,
        { id: 'ci-123' },
        mockContext
      );

      // Assert: Verify default depth
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('DEPENDS_ON*1..5'),
        expect.any(Object)
      );
    });
  });

  describe('Query.getImpactAnalysis', () => {
    it('should return impacted CIs with distance', async () => {
      // Arrange: Mock impact analysis results (metadata must be JSON string)
      const ci1 = createCI({ id: 'ci-1' });
      const ci2 = createCI({ id: 'ci-2' });
      ci1.metadata = JSON.stringify(ci1.metadata || {});
      ci2.metadata = JSON.stringify(ci2.metadata || {});
      const mockResults = [
        { impacted: { properties: ci1 }, distance: 1 },
        { impacted: { properties: ci2 }, distance: 2 },
      ];

      mockNeo4j.session.run.mockResolvedValueOnce({
        records: mockResults.map((r) => ({
          get: (key: string) => {
            if (key === 'impacted') return r.impacted;
            if (key === 'distance') return { toNumber: () => r.distance };
          },
        })),
      });

      const getImpact = (resolvers.Query as any).getImpactAnalysis;

      // Act: Perform impact analysis
      const result = await getImpact(
        null,
        { id: 'ci-123', depth: 3 },
        mockContext
      );

      // Assert: Verify reverse dependency query (incoming edges)
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('<-[:DEPENDS_ON*1..3]'),
        expect.objectContaining({ id: 'ci-123' })
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('_ci');
      expect(result[0]).toHaveProperty('_distance', 1);
      expect(result[1]).toHaveProperty('_distance', 2);
    });

    it('should order results by distance', async () => {
      // Arrange
      mockNeo4j.session.run.mockResolvedValueOnce(createMockNeo4jResult([]));

      const getImpact = (resolvers.Query as any).getImpactAnalysis;

      // Act
      await getImpact(
        null,
        { id: 'ci-123' },
        mockContext
      );

      // Assert: Verify ORDER BY in query
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY distance'),
        expect.any(Object)
      );
    });
  });

  describe('Mutation.createRelationship', () => {
    it('should create relationship between CIs', async () => {
      // Arrange: the scoped client reports that both endpoints matched
      (mockContext._neo4jClient as any).createRelationship.mockResolvedValue(true);

      const createRelMut = (resolvers.Mutation as any).createRelationship;

      const result = await createRelMut(
        null,
        {
          input: {
            _fromId: 'ci-1',
            _toId: 'ci-2',
            _type: 'DEPENDS_ON',
            _properties: { strength: 'strong' },
          },
        },
        mockContext
      );

      // Assert: Verify relationship creation within the caller's organization
      expect((mockContext._neo4jClient as any).createRelationship).toHaveBeenCalledWith(
        'ci-1',
        'ci-2',
        'DEPENDS_ON',
        ORG_A,
        { strength: 'strong' }
      );

      // Assert: Verify caches cleared for both CIs
      expect(mockLoaders.relationshipLoader.clear).toHaveBeenCalledWith({ id: 'ci-1', organizationId: ORG_A });
      expect(mockLoaders.dependentLoader.clear).toHaveBeenCalledWith({ id: 'ci-2', organizationId: ORG_A });

      expect(result).toBe(true);
    });
  });

  describe('Tenant scoping', () => {
    const client = () => mockContext._neo4jClient as any;
    const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e);

    it('getCIs/getCI/searchCIs pass the context org to the client', async () => {
      mockNeo4j.session.run.mockResolvedValue(createMockNeo4jResult([]));
      mockLoaders.ciLoader.load.mockResolvedValue(null);

      await (resolvers.Query as any).getCIs(null, { filter: { _name: 'web' } }, mockContext);
      await (resolvers.Query as any).searchCIs(null, { query: 'web' }, mockContext);
      await (resolvers.Query as any).getCI(null, { id: 'ci-1' }, mockContext);

      expect(mockNeo4j.session.run).toHaveBeenCalledTimes(2);
      for (const [cypher, params] of mockNeo4j.session.run.mock.calls as Array<[string, Record<string, unknown>]>) {
        expect(cypher).toContain('ci.organization_id = $organizationId');
        expect(params.organizationId).toBe(ORG_A);
      }
      expect(mockLoaders.ciLoader.load).toHaveBeenCalledWith({ id: 'ci-1', organizationId: ORG_A });
    });

    it('createCI stamps the context org and ignores an input org', async () => {
      client().createCI.mockResolvedValue(createCI({ id: 'ci-new', name: 'new-server' }));

      await (resolvers.Mutation as any).createCI(
        null,
        {
          input: {
            _id: 'ci-new',
            _name: 'new-server',
            _type: 'SERVER',
            _organizationId: ORG_B,
            organization_id: ORG_B,
          },
        },
        mockContext
      );

      expect(client().createCI).toHaveBeenCalledTimes(1);
      const [ciInput, scope] = client().createCI.mock.calls[0];
      expect(scope).toBe(ORG_A);
      expect(Object.keys(ciInput).filter(key => /organization/i.test(key))).toEqual([]);
      expect(JSON.stringify(ciInput)).not.toContain(ORG_B);
    });

    it('updateCI cannot change organization_id', async () => {
      client().getCI.mockResolvedValue(createCI({ id: 'ci-1' }));
      client().updateCI.mockResolvedValue(createCI({ id: 'ci-1', name: 'renamed' }));

      await (resolvers.Mutation as any).updateCI(
        null,
        { id: 'ci-1', input: { _name: 'renamed', _organizationId: ORG_B, organization_id: ORG_B } },
        mockContext
      );

      expect(client().getCI).toHaveBeenCalledWith('ci-1', ORG_A);
      expect(client().updateCI).toHaveBeenCalledWith('ci-1', { name: 'renamed' }, ORG_A);
    });

    it('deleteCI on a foreign CI deletes nothing', async () => {
      // The org-scoped delete matches no CI of the caller's organization.
      client().deleteCI.mockResolvedValue(false);

      const error = await errorOf((resolvers.Mutation as any).deleteCI(null, { id: 'ci-of-org-b' }, mockContext));

      expect(client().deleteCI).toHaveBeenCalledWith('ci-of-org-b', ORG_A);
      // No unscoped DETACH DELETE on a raw session, and the same error as a missing CI.
      expect(client().getSession).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(GraphQLError);
      expect(error).toMatchObject({ message: 'CI not found', extensions: { code: 'NOT_FOUND' } });
      expect(mockLoaders.ciLoader.clear).not.toHaveBeenCalled();
    });

    it('createRelationship across orgs is rejected', async () => {
      // The org-scoped MERGE finds no pair of endpoints in the caller's organization.
      client().createRelationship.mockResolvedValue(false);

      const error = await errorOf(
        (resolvers.Mutation as any).createRelationship(
          null,
          { input: { _fromId: 'ci-of-org-a', _toId: 'ci-of-org-b', _type: 'DEPENDS_ON' } },
          mockContext
        )
      );

      expect(client().createRelationship).toHaveBeenCalledWith('ci-of-org-a', 'ci-of-org-b', 'DEPENDS_ON', ORG_A, {});
      expect(error).toBeInstanceOf(GraphQLError);
      expect(error).toMatchObject({ message: 'CI not found', extensions: { code: 'NOT_FOUND' } });
      expect(mockLoaders.relationshipLoader.clear).not.toHaveBeenCalled();
      expect(mockLoaders.dependentLoader.clear).not.toHaveBeenCalled();
    });

    it('FORBIDDEN without an org claim, with zero session.run calls', async () => {
      // A valid role but no (or a malformed) organization claim.
      const calls: Array<[string, (context: GraphQLContext) => Promise<unknown>]> = [
        ['getCIs', ctx => (resolvers.Query as any).getCIs(null, {}, ctx)],
        ['getCI', ctx => (resolvers.Query as any).getCI(null, { id: 'ci-1' }, ctx)],
        ['searchCIs', ctx => (resolvers.Query as any).searchCIs(null, { query: 'x' }, ctx)],
        ['getCIRelationships', ctx => (resolvers.Query as any).getCIRelationships(null, { id: 'ci-1' }, ctx)],
        ['getCIDependencies', ctx => (resolvers.Query as any).getCIDependencies(null, { id: 'ci-1' }, ctx)],
        ['getImpactAnalysis', ctx => (resolvers.Query as any).getImpactAnalysis(null, { id: 'ci-1' }, ctx)],
        ['createCI', ctx => (resolvers.Mutation as any).createCI(null, { input: { _id: 'ci-1', _name: 'n', _type: 'SERVER' } }, ctx)],
        ['updateCI', ctx => (resolvers.Mutation as any).updateCI(null, { id: 'ci-1', input: { _name: 'n' } }, ctx)],
        ['deleteCI', ctx => (resolvers.Mutation as any).deleteCI(null, { id: 'ci-1' }, ctx)],
        ['createRelationship', ctx => (resolvers.Mutation as any).createRelationship(null, { input: { _fromId: 'a', _toId: 'b', _type: 'DEPENDS_ON' } }, ctx)],
        ['deleteRelationship', ctx => (resolvers.Mutation as any).deleteRelationship(null, { fromId: 'a', toId: 'b', type: 'DEPENDS_ON' }, ctx)],
        ['CI._relationships', ctx => (resolvers.CI as any)._relationships({ _id: 'ci-1' }, {}, ctx)],
        ['CI._dependents', ctx => (resolvers.CI as any)._dependents({ _id: 'ci-1' }, {}, ctx)],
        ['CI._dependencies', ctx => (resolvers.CI as any)._dependencies({ _id: 'ci-1' }, {}, ctx)],
      ];

      for (const organizationId of [undefined, 'not-a-uuid']) {
        const context: GraphQLContext = {
          ...mockContext,
          user: { _userId: 'u1', _username: 'tester', _role: 'admin', _type: 'access', _organizationId: organizationId },
        };
        for (const [name, call] of calls) {
          const error = await errorOf(call(context));
          expect({ name, error }).toMatchObject({ name, error: { extensions: { code: 'FORBIDDEN' } } });
        }
      }

      expect(client().getSession).not.toHaveBeenCalled();
      expect(mockNeo4j.session.run).not.toHaveBeenCalled();
      for (const method of ['createCI', 'updateCI', 'getCI', 'deleteCI', 'createRelationship']) {
        expect(client()[method]).not.toHaveBeenCalled();
      }
      for (const loader of Object.values(mockLoaders) as Array<{ load: jest.Mock }>) {
        expect(loader.load).not.toHaveBeenCalled();
      }
    });

    it("dataloader does not serve another org's CI", async () => {
      // One shared loader over a stored CI of ORG_A. The fake answers both the
      // org-keyed batch query and a bare id batch, matching Cypher semantics.
      const stored = { id: 'ci-shared', name: 'org-a-server', type: 'server', status: 'active', organization_id: ORG_A };
      const queries: string[] = [];
      const run = async (cypher: string, params: { keys?: Array<{ id: string; organizationId: string }>; ids?: string[] }) => {
        queries.push(cypher);
        const rows = params.keys
          ? params.keys.map(key => ({
              ciId: key.id,
              organizationId: key.organizationId,
              ci: key.id === stored.id && key.organizationId === stored.organization_id ? { properties: stored } : null,
            }))
          : (params.ids ?? []).map(id => ({ ciId: id, ci: id === stored.id ? { properties: stored } : null }));
        return { records: rows.map(row => ({ get: (field: string) => (row as Record<string, unknown>)[field] })) };
      };
      const loader = createCILoader({ getSession: () => ({ run, close: async () => undefined }) } as any);
      const contextFor = (organizationId: string): GraphQLContext => ({
        ...mockContext,
        _loaders: { ...mockContext._loaders, _ciLoader: loader },
        user: { _userId: 'u1', _username: 'tester', _role: 'operator', _type: 'access', _organizationId: organizationId },
      });

      const asOrgA = await (resolvers.Query as any).getCI(null, { id: 'ci-shared' }, contextFor(ORG_A));
      const asOrgB = await (resolvers.Query as any).getCI(null, { id: 'ci-shared' }, contextFor(ORG_B));

      expect(asOrgA).toMatchObject({ _id: 'ci-shared', _name: 'org-a-server' });
      expect(asOrgB).toBeNull();
      // ORG_B's lookup went to Neo4j (no cache hit) with the org predicate.
      expect(queries).toHaveLength(2);
      expect(queries[1]).toContain('ci.organization_id = key.organizationId');
    });
  });

  describe('Input validation', () => {
    const client = () => mockContext._neo4jClient as any;
    const errorOf = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e);
    const updateName = (id: string, name: string) =>
      (resolvers.Mutation as any).updateCI(null, { id, input: { _name: name } }, mockContext);

    it('updateCI rejects an empty or a 501-character name with BAD_USER_INPUT', async () => {
      client().getCI.mockResolvedValue(createCI({ id: 'ci-1' }));
      client().updateCI.mockResolvedValue(createCI({ id: 'ci-1' }));

      for (const name of ['', 'x'.repeat(501)]) {
        const error = await errorOf(updateName('ci-1', name));
        expect(error).toBeInstanceOf(GraphQLError);
        expect(error).toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
      }
      expect(client().updateCI).not.toHaveBeenCalled();

      await updateName('ci-1', 'x'.repeat(500));
      expect(client().updateCI).toHaveBeenCalledWith('ci-1', { name: 'x'.repeat(500) }, ORG_A);
    });

    it('updateCI on a foreign id with a bad name still returns NOT_FOUND', async () => {
      // The scoped lookup finds no CI of the caller's organization.
      client().getCI.mockResolvedValue(null);

      const error = await errorOf(updateName('ci-of-org-b', ''));

      expect(client().getCI).toHaveBeenCalledWith('ci-of-org-b', ORG_A);
      expect(error).toMatchObject({ message: 'CI not found', extensions: { code: 'NOT_FOUND' } });
      expect(client().updateCI).not.toHaveBeenCalled();
    });

    it('getCIDependencies/getImpactAnalysis reject depth 0, 11, -1 and a non-integer with BAD_USER_INPUT', async () => {
      for (const resolver of ['getCIDependencies', 'getImpactAnalysis']) {
        for (const depth of [0, 11, -1, 2.5]) {
          const error = await errorOf((resolvers.Query as any)[resolver](null, { id: 'ci-1', depth }, mockContext));
          expect({ resolver, depth, error }).toMatchObject({
            resolver,
            depth,
            error: { extensions: { code: 'BAD_USER_INPUT' } },
          });
        }
      }
      expect(client().getSession).not.toHaveBeenCalled();

      mockNeo4j.session.run.mockResolvedValue(createMockNeo4jResult([]));
      await (resolvers.Query as any).getCIDependencies(null, { id: 'ci-1', depth: 10 }, mockContext);
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(expect.stringContaining('DEPENDS_ON*1..10]'), expect.any(Object));
    });
  });

  describe('Contract Verification (London School)', () => {
    it('should always close Neo4j session after query', async () => {
      // Arrange
      mockNeo4j.session.run.mockResolvedValueOnce(createMockNeo4jResult([]));

      const getCIs = (resolvers.Query as any).getCIs;

      // Act: Execute any query
      await getCIs(null, {}, mockContext);

      // Assert: Session closed
      expect(mockNeo4j.session.close).toHaveBeenCalled();

      // Act: Execute query that throws error
      mockNeo4j.session.run.mockRejectedValueOnce(new Error('Database error'));

      try {
        await getCIs(null, {}, mockContext);
      } catch {
        // Expected to throw
      }

      // Assert: Session still closed even on error
      expect(mockNeo4j.session.close).toHaveBeenCalledTimes(2);
    });

    it('should follow GraphQL error handling contract', async () => {
      // Arrange: Database error
      mockNeo4j.session.run.mockRejectedValueOnce(new Error('Connection timeout'));

      const getCIs = (resolvers.Query as any).getCIs;

      // Act & Assert: Should wrap in GraphQLError with proper code
      try {
        await getCIs(null, {}, mockContext);
        fail('Expected error to be thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(GraphQLError);
        expect(error.extensions).toHaveProperty('code', 'INTERNAL_SERVER_ERROR');
        expect(error.extensions).toHaveProperty('originalError');
      }
    });
  });
});
