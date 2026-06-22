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
import { GraphQLError } from 'graphql';
import {
  createMockNeo4jDriver,
  createMockNeo4jResult,
} from '../../../../../../tests/utils/mock-database-clients';
import { createCI, createCIs } from '../../../../../../tests/utils/mock-factories';

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
        createRelationship: jest.fn(),
      } as any,
      _loaders: {
        _ciLoader: mockLoaders.ciLoader,
        _relationshipLoader: mockLoaders.relationshipLoader,
        _dependentLoader: mockLoaders.dependentLoader,
      },
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
          limit: 100,
          offset: 0,
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
        expect.objectContaining({ offset: 100 })
      );

      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $limit'),
        expect.objectContaining({ limit: 25 })
      );
    });
  });

  describe('Query.getCI', () => {
    it('should fetch single CI by ID using DataLoader', async () => {
      // Arrange: Mock DataLoader response
      const mockCI = createCI({ id: 'ci-123', name: 'web-server' });
      mockLoaders.ciLoader.load.mockResolvedValueOnce(mockCI);

      const getCI = (resolvers.Query as any).getCI;

      // Act: Execute query
      const result = await getCI(
        null,
        { id: 'ci-123' },
        mockContext
      );

      // Assert: Verify DataLoader used
      expect(mockLoaders.ciLoader.load).toHaveBeenCalledWith('ci-123');

      // Assert: Verify result
      expect(result).toEqual(mockCI);
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

      // Assert: Verify result structure
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('ci');
      expect(result[0]).toHaveProperty('distance', 1);
      expect(result[1]).toHaveProperty('distance', 2);
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

  describe('Mutation.createCI', () => {
    it('should create new CI with valid input', async () => {
      // Arrange: Mock create operation
      const newCI = createCI({ id: 'ci-new', name: 'new-server' });
      (mockContext._neo4jClient as any).createCI.mockResolvedValue(newCI);

      const createCIMut = (resolvers.Mutation as any).createCI;

      // Act: Create mutation
      const result = await createCIMut(
        null,
        {
          input: {
            id: 'ci-new',
            name: 'new-server',
            type: 'SERVER',
            status: 'ACTIVE',
            environment: 'PRODUCTION',
          },
        },
        mockContext
      );

      // Assert: Verify createCI called
      expect((mockContext._neo4jClient as any).createCI).toHaveBeenCalled();

      // Assert: Verify result
      expect(result).toEqual(newCI);
    });

    it('should validate required fields', async () => {
      const createCIMut = (resolvers.Mutation as any).createCI;

      // Act & Assert: Missing ID
      await expect(
        createCIMut(
          null,
          {
            input: {
              name: 'test',
              type: 'SERVER',
            },
          },
          mockContext
        )
      ).rejects.toThrow(GraphQLError);

      // Act & Assert: Missing name
      await expect(
        createCIMut(
          null,
          {
            input: {
              id: 'ci-123',
              type: 'SERVER',
            },
          },
          mockContext
        )
      ).rejects.toThrow(GraphQLError);

      // Act & Assert: Missing type
      await expect(
        createCIMut(
          null,
          {
            input: {
              id: 'ci-123',
              name: 'test',
            },
          },
          mockContext
        )
      ).rejects.toThrow(GraphQLError);
    });
  });

  describe('Mutation.updateCI', () => {
    it('should update CI with partial data', async () => {
      // Arrange
      const updatedCI = createCI({ id: 'ci-123', name: 'updated-name' });
      (mockContext._neo4jClient as any).updateCI.mockResolvedValue(updatedCI);

      const updateCIMut = (resolvers.Mutation as any).updateCI;

      // Act: Update mutation
      const result = await updateCIMut(
        null,
        {
          id: 'ci-123',
          input: {
            name: 'updated-name',
            status: 'INACTIVE',
          },
        },
        mockContext
      );

      // Assert: Verify updateCI called
      expect((mockContext._neo4jClient as any).updateCI).toHaveBeenCalledWith(
        'ci-123',
        expect.objectContaining({
          name: 'updated-name',
          status: 'inactive',
        })
      );

      // Assert: Verify cache cleared
      expect(mockLoaders.ciLoader.clear).toHaveBeenCalledWith('ci-123');

      expect(result).toEqual(updatedCI);
    });
  });

  describe('Mutation.deleteCI', () => {
    it('should delete CI and return true', async () => {
      // Arrange: Mock successful delete
      mockNeo4j.session.run.mockResolvedValueOnce({
        records: [{ get: () => ({ toNumber: () => 1 }) }],
      });

      const deleteCIMut = (resolvers.Mutation as any).deleteCI;

      // Act: Delete mutation
      const result = await deleteCIMut(
        null,
        { id: 'ci-123' },
        mockContext
      );

      // Assert: Verify Cypher DELETE query
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('DETACH DELETE ci'),
        expect.objectContaining({ id: 'ci-123' })
      );

      // Assert: Verify cache cleared
      expect(mockLoaders.ciLoader.clear).toHaveBeenCalledWith('ci-123');

      // Assert: Verify result
      expect(result).toBe(true);
    });

    it('should throw error when CI not found', async () => {
      // Arrange: CI doesn't exist
      mockNeo4j.session.run.mockResolvedValueOnce({
        records: [{ get: () => ({ toNumber: () => 0 }) }],
      });

      const deleteCIMut = (resolvers.Mutation as any).deleteCI;

      // Act & Assert: Expect NOT_FOUND error
      await expect(
        deleteCIMut(null, { id: 'non-existent' }, mockContext)
      ).rejects.toMatchObject({
        extensions: { code: 'NOT_FOUND' },
      });
    });
  });

  describe('Mutation.createRelationship', () => {
    it('should create relationship between CIs', async () => {
      // Arrange
      (mockContext._neo4jClient as any).createRelationship.mockResolvedValue(undefined);

      const createRelMut = (resolvers.Mutation as any).createRelationship;

      // Act: Create relationship (source uses _input, _fromId, _toId, _type)
      const result = await createRelMut(
        null,
        {
          _input: {
            _fromId: 'ci-1',
            _toId: 'ci-2',
            _type: 'DEPENDS_ON',
            properties: { strength: 'strong' },
          },
        },
        mockContext
      );

      // Assert: Verify relationship creation
      expect((mockContext._neo4jClient as any).createRelationship).toHaveBeenCalledWith(
        'ci-1',
        'ci-2',
        'DEPENDS_ON',
        { strength: 'strong' }
      );

      // Assert: Verify caches cleared for both CIs
      expect(mockLoaders.relationshipLoader.clear).toHaveBeenCalledWith('ci-1');
      expect(mockLoaders.dependentLoader.clear).toHaveBeenCalledWith('ci-2');

      expect(result).toBe(true);
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
