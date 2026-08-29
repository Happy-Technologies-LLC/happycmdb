// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/index.test.ts

/**
 * GraphQL Resolver Tests
 *
 * These tests demonstrate how to test GraphQL resolvers with mocked dependencies
 */

import { resolvers } from './index';
import { GraphQLContext } from './index';
import { Neo4jClient } from '@cmdb/database';
import { CI, CIInput } from '@cmdb/common';

// Mock Neo4j client
const mockNeo4jClient = {
  _getSession: jest.fn(),
  _createCI: jest.fn(),
  _updateCI: jest.fn(),
  _getCI: jest.fn(),
  _createRelationship: jest.fn(),
  _getRelationships: jest.fn(),
  _getDependencies: jest.fn(),
  _impactAnalysis: jest.fn(),
  _verifyConnectivity: jest.fn(),
  _close: jest.fn(),
} as unknown as Neo4jClient;

// Mock DataLoaders
const mockCILoader = {
  _load: jest.fn(),
  _loadMany: jest.fn(),
  _clear: jest.fn(),
  _clearAll: jest.fn(),
};

const mockRelationshipLoader = {
  _load: jest.fn(),
  _loadMany: jest.fn(),
  _clear: jest.fn(),
  _clearAll: jest.fn(),
};

const mockDependentLoader = {
  _load: jest.fn(),
  _loadMany: jest.fn(),
  _clear: jest.fn(),
  _clearAll: jest.fn(),
};

// Mock context
const mockContext: GraphQLContext = {
  _neo4jClient: mockNeo4jClient,
  _loaders: {
    _ciLoader: mockCILoader,
    _relationshipLoader: mockRelationshipLoader,
    _dependentLoader: mockDependentLoader,
  },
  // Mutation resolvers now call checkGraphQLPermission(context, 'write');
  // an operator role carries the 'write' permission (see ROLE_PERMISSIONS).
  user: { _userId: 'u1', _username: 'tester', _role: 'operator', _type: 'access' },
};

// Sample test data
const mockCI: CI = {
  _id: 'server-001',
  _external_id: 'i-1234567890',
  _name: 'Test Server',
  _type: 'server',
  _status: 'active',
  _environment: 'production',
  _created_at: '2024-01-15T10:00:00Z',
  _updated_at: '2024-01-15T10:00:00Z',
  _discovered_at: '2024-01-15T10:00:00Z',
  _metadata: {
    _ip_address: '10.0.1.100',
    _region: 'us-east-1',
  },
};

describe('GraphQL Resolvers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Query Resolvers', () => {
    describe('getCI', () => {
      it('should return a CI by ID using DataLoader', async () => {
        mockCILoader.load.mockResolvedValue(mockCI);

        const result = await resolvers.Query.getCI(
          null,
          { id: 'server-001' },
          mockContext
        );

        expect(result).toEqual(mockCI);
        expect(mockCILoader.load).toHaveBeenCalledWith('server-001');
      });

      it('should return null if CI not found', async () => {
        mockCILoader.load.mockResolvedValue(null);

        const result = await resolvers.Query.getCI(
          null,
          { id: 'non-existent' },
          mockContext
        );

        expect(result).toBeNull();
      });

      it('should throw GraphQLError on database error', async () => {
        mockCILoader.load.mockRejectedValue(new Error('Database error'));

        await expect(
          resolvers.Query.getCI(null, { id: 'server-001' }, mockContext)
        ).rejects.toThrow('Failed to fetch CI');
      });
    });

    describe('getCIs', () => {
      it('should return filtered CIs', async () => {
        const mockSession = {
          _run: jest.fn().mockResolvedValue({
            _records: [
              {
                _get: jest.fn().mockReturnValue({
                  _properties: mockCI,
                }),
              },
            ],
          }),
          _close: jest.fn(),
        };

        mockNeo4jClient.getSession = jest.fn().mockReturnValue(mockSession);

        const result = await resolvers.Query.getCIs(
          null,
          {
            _filter: { type: 'SERVER', status: 'ACTIVE' },
            _limit: 10,
            _offset: 0,
          },
          mockContext
        );

        expect(Array.isArray(result)).toBe(true);
        expect(mockSession.close).toHaveBeenCalled();
      });
    });

    describe('searchCIs', () => {
      it('should search CIs by query string', async () => {
        const mockSession = {
          _run: jest.fn().mockResolvedValue({
            _records: [
              {
                _get: jest.fn().mockReturnValue({
                  _properties: mockCI,
                }),
              },
            ],
          }),
          _close: jest.fn(),
        };

        mockNeo4jClient.getSession = jest.fn().mockReturnValue(mockSession);

        const result = await resolvers.Query.searchCIs(
          null,
          {
            _query: 'server',
            _filter: { type: 'SERVER' },
            _limit: 50,
          },
          mockContext
        );

        expect(Array.isArray(result)).toBe(true);
        expect(mockSession.run).toHaveBeenCalledWith(
          expect.stringContaining('CONTAINS'),
          expect.any(Object)
        );
      });
    });

    describe('getCIRelationships', () => {
      it('should return outgoing relationships', async () => {
        const mockRelationships = [
          {
            _type: 'DEPENDS_ON',
            _ci: mockCI,
            _properties: {},
          },
        ];

        mockRelationshipLoader.load.mockResolvedValue(mockRelationships);

        const result = await resolvers.Query.getCIRelationships(
          null,
          { id: 'server-001', direction: 'out' },
          mockContext
        );

        expect(result).toEqual(mockRelationships);
        expect(mockRelationshipLoader.load).toHaveBeenCalledWith('server-001');
      });

      it('should return incoming relationships', async () => {
        const mockRelationships = [
          {
            _type: 'HOSTS',
            _ci: mockCI,
            _properties: {},
          },
        ];

        mockDependentLoader.load.mockResolvedValue(mockRelationships);

        const result = await resolvers.Query.getCIRelationships(
          null,
          { id: 'server-001', direction: 'in' },
          mockContext
        );

        expect(result).toEqual(mockRelationships);
        expect(mockDependentLoader.load).toHaveBeenCalledWith('server-001');
      });

      it('should return both directions when direction is "both"', async () => {
        const outgoing = [{ type: 'DEPENDS_ON', ci: mockCI, properties: {} }];
        const incoming = [{ type: 'HOSTS', ci: mockCI, properties: {} }];

        mockRelationshipLoader.load.mockResolvedValue(outgoing);
        mockDependentLoader.load.mockResolvedValue(incoming);

        const result = await resolvers.Query.getCIRelationships(
          null,
          { id: 'server-001', direction: 'both' },
          mockContext
        );

        expect(result).toEqual([...outgoing, ...incoming]);
      });
    });

    describe('getCIDependencies', () => {
      it('should return recursive dependencies', async () => {
        const mockSession = {
          _run: jest.fn().mockResolvedValue({
            _records: [
              {
                _get: jest.fn().mockReturnValue({
                  _properties: mockCI,
                }),
              },
            ],
          }),
          _close: jest.fn(),
        };

        mockNeo4jClient.getSession = jest.fn().mockReturnValue(mockSession);

        const result = await resolvers.Query.getCIDependencies(
          null,
          { id: 'server-001', depth: 5 },
          mockContext
        );

        expect(Array.isArray(result)).toBe(true);
        expect(mockSession.close).toHaveBeenCalled();
      });
    });

    describe('getImpactAnalysis', () => {
      it('should return impact analysis with distances', async () => {
        const mockSession = {
          _run: jest.fn().mockResolvedValue({
            _records: [
              {
                _get: jest.fn((key: string) => {
                  if (key === 'impacted') {
                    return { properties: mockCI };
                  }
                  return { toNumber: () => 2 };
                }),
              },
            ],
          }),
          _close: jest.fn(),
        };

        mockNeo4jClient.getSession = jest.fn().mockReturnValue(mockSession);

        const result = await resolvers.Query.getImpactAnalysis(
          null,
          { id: 'database-001', depth: 5 },
          mockContext
        );

        expect(Array.isArray(result)).toBe(true);
        expect(result[0]).toHaveProperty('ci');
        expect(result[0]).toHaveProperty('distance');
      });
    });
  });

  describe('Mutation Resolvers', () => {
    describe('createCI', () => {
      it('should create a new CI', async () => {
        mockNeo4jClient.createCI = jest.fn().mockResolvedValue(mockCI);

        const input = {
          _id: 'server-001',
          _name: 'Test Server',
          _type: 'SERVER',
          _status: 'ACTIVE',
          _environment: 'PRODUCTION',
        };

        const result = await resolvers.Mutation.createCI(
          null,
          { input },
          mockContext
        );

        expect(result).toEqual(mockCI);
        expect(mockNeo4jClient.createCI).toHaveBeenCalled();
        expect(mockCILoader.clear).toHaveBeenCalledWith('server-001');
      });

      it('should throw error for invalid input', async () => {
        const invalidInput = {
          _name: 'Test Server',
          // Missing required fields
        };

        await expect(
          resolvers.Mutation.createCI(null, { input: invalidInput }, mockContext)
        ).rejects.toThrow('CI ID is required');
      });
    });

    describe('updateCI', () => {
      it('should update an existing CI', async () => {
        const updatedCI = { ...mockCI, name: 'Updated Server' };
        mockNeo4jClient.updateCI = jest.fn().mockResolvedValue(updatedCI);

        const result = await resolvers.Mutation.updateCI(
          null,
          {
            _id: 'server-001',
            _input: { name: 'Updated Server' },
          },
          mockContext
        );

        expect(result).toEqual(updatedCI);
        expect(mockNeo4jClient.updateCI).toHaveBeenCalledWith(
          'server-001',
          expect.objectContaining({ name: 'Updated Server' })
        );
        expect(mockCILoader.clear).toHaveBeenCalledWith('server-001');
      });
    });

    describe('deleteCI', () => {
      it('should delete a CI', async () => {
        const mockSession = {
          _run: jest.fn().mockResolvedValue({
            _records: [
              {
                _get: jest.fn().mockReturnValue({ toNumber: () => 1 }),
              },
            ],
          }),
          _close: jest.fn(),
        };

        mockNeo4jClient.getSession = jest.fn().mockReturnValue(mockSession);

        const result = await resolvers.Mutation.deleteCI(
          null,
          { id: 'server-001' },
          mockContext
        );

        expect(result).toBe(true);
        expect(mockCILoader.clear).toHaveBeenCalledWith('server-001');
      });

      it('should throw error if CI not found', async () => {
        const mockSession = {
          _run: jest.fn().mockResolvedValue({
            _records: [
              {
                _get: jest.fn().mockReturnValue({ toNumber: () => 0 }),
              },
            ],
          }),
          _close: jest.fn(),
        };

        mockNeo4jClient.getSession = jest.fn().mockReturnValue(mockSession);

        await expect(
          resolvers.Mutation.deleteCI(null, { id: 'non-existent' }, mockContext)
        ).rejects.toThrow('CI not found');
      });
    });

    describe('createRelationship', () => {
      it('should create a relationship between two CIs', async () => {
        mockNeo4jClient.createRelationship = jest.fn().mockResolvedValue(undefined);

        const input = {
          _fromId: 'app-001',
          _toId: 'database-001',
          _type: 'DEPENDS_ON',
          _properties: { port: 5432 },
        };

        const result = await resolvers.Mutation.createRelationship(
          null,
          { input },
          mockContext
        );

        expect(result).toBe(true);
        expect(mockNeo4jClient.createRelationship).toHaveBeenCalledWith(
          'app-001',
          'database-001',
          'DEPENDS_ON',
          { port: 5432 }
        );
        expect(mockRelationshipLoader.clear).toHaveBeenCalledWith('app-001');
        expect(mockDependentLoader.clear).toHaveBeenCalledWith('database-001');
      });
    });

    describe('deleteRelationship', () => {
      it('should delete a relationship', async () => {
        const mockSession = {
          _run: jest.fn().mockResolvedValue({
            _records: [
              {
                _get: jest.fn().mockReturnValue({ toNumber: () => 1 }),
              },
            ],
          }),
          _close: jest.fn(),
        };

        mockNeo4jClient.getSession = jest.fn().mockReturnValue(mockSession);

        const result = await resolvers.Mutation.deleteRelationship(
          null,
          {
            _fromId: 'app-001',
            _toId: 'database-001',
            _type: 'DEPENDS_ON',
          },
          mockContext
        );

        expect(result).toBe(true);
        expect(mockRelationshipLoader.clear).toHaveBeenCalledWith('app-001');
        expect(mockDependentLoader.clear).toHaveBeenCalledWith('database-001');
      });
    });
  });

  describe('CI Type Resolvers', () => {
    describe('relationships', () => {
      it('should resolve CI relationships using DataLoader', async () => {
        const mockRelationships = [
          {
            _type: 'DEPENDS_ON',
            _ci: mockCI,
            _properties: {},
          },
        ];

        mockRelationshipLoader.load.mockResolvedValue(mockRelationships);

        const result = await resolvers.CI.relationships(mockCI, {}, mockContext);

        expect(result).toEqual(mockRelationships);
        expect(mockRelationshipLoader.load).toHaveBeenCalledWith('server-001');
      });
    });

    describe('dependents', () => {
      it('should resolve CI dependents using DataLoader', async () => {
        const mockDependents = [
          {
            _type: 'HOSTS',
            _ci: mockCI,
            _properties: {},
          },
        ];

        mockDependentLoader.load.mockResolvedValue(mockDependents);

        const result = await resolvers.CI.dependents(mockCI, {}, mockContext);

        expect(result).toEqual(mockDependents);
        expect(mockDependentLoader.load).toHaveBeenCalledWith('server-001');
      });
    });

    describe('field resolvers', () => {
      it('should resolve externalId field', () => {
        const result = resolvers.CI.externalId(mockCI);
        expect(result).toBe('i-1234567890');
      });

      it('should resolve createdAt field', () => {
        const result = resolvers.CI.createdAt(mockCI);
        expect(result).toBe('2024-01-15T10:00:00Z');
      });

      it('should resolve updatedAt field', () => {
        const result = resolvers.CI.updatedAt(mockCI);
        expect(result).toBe('2024-01-15T10:00:00Z');
      });

      it('should resolve discoveredAt field', () => {
        const result = resolvers.CI.discoveredAt(mockCI);
        expect(result).toBe('2024-01-15T10:00:00Z');
      });
    });
  });
});
