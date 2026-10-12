// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j Client Tests
 *
 * Tests for Neo4j database client including:
 * - Connection and session management
 * - CI CRUD operations
 * - Relationship management
 * - Graph traversal queries (dependencies, impact analysis)
 * - Error handling and session cleanup
 */

import { Neo4jClient } from '../../src/neo4j/client';
import neo4j from 'neo4j-driver';

// Mock neo4j-driver
jest.mock('neo4j-driver');

describe('Neo4jClient', () => {
  let client: Neo4jClient;
  let mockDriver: any;
  let mockSession: any;
  let mockResult: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup mock session
    mockResult = {
      _records: [],
    };

    mockSession = {
      _run: jest.fn().mockResolvedValue(mockResult),
      _close: jest.fn().mockResolvedValue(undefined),
    };

    // Setup mock driver
    mockDriver = {
      _session: jest.fn().mockReturnValue(mockSession),
      _close: jest.fn().mockResolvedValue(undefined),
    };

    // Mock neo4j.driver() to return mockDriver
    (neo4j.driver as jest.Mock).mockReturnValue(mockDriver);
    (neo4j.auth.basic as jest.Mock) = jest.fn().mockReturnValue({});

    // Create client instance
    client = new Neo4jClient('bolt://localhost:7687', 'neo4j', 'password');
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Constructor and Configuration', () => {
    it('should create driver with correct configuration', () => {
      expect(neo4j.driver).toHaveBeenCalledWith(
        'bolt://localhost:7687',
        {},
        {
          _maxConnectionLifetime: 3 * 60 * 60 * 1000,
          _maxConnectionPoolSize: 50,
          _connectionAcquisitionTimeout: 2 * 60 * 1000,
        }
      );
    });

    it('should use basic auth', () => {
      expect(neo4j.auth.basic).toHaveBeenCalledWith('neo4j', 'password');
    });
  });

  describe('verifyConnectivity', () => {
    it('should verify connection successfully', async () => {
      mockSession.run.mockResolvedValueOnce({ records: [1] });

      await expect(client.verifyConnectivity()).resolves.not.toThrow();

      expect(mockSession.run).toHaveBeenCalledWith('RETURN 1');
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should close session even if verification fails', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('Connection failed'));

      await expect(client.verifyConnectivity()).rejects.toThrow('Connection failed');

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    it('should create session with default database', () => {
      client.getSession();

      expect(mockDriver.session).toHaveBeenCalledWith({ database: 'neo4j' });
    });

    it('should create session with custom database', () => {
      client.getSession('custom-db');

      expect(mockDriver.session).toHaveBeenCalledWith({ database: 'custom-db' });
    });
  });

  describe('createCI', () => {
    it('should create CI with all properties', async () => {
      const ciInput = {
        _id: 'ci-123',
        _external_id: 'ext-123',
        _name: 'Test Server',
        _type: 'server' as const,
        _status: 'active' as const,
        _environment: 'production' as const,
        _discovered_at: '2025-01-15T10:00:00Z',
        _metadata: { location: 'us-east-1' },
      };

      mockResult.records = [{
        _get: jest.fn().mockReturnValue({
          _properties: {
            _id: ciInput.id,
            _external_id: ciInput.external_id,
            _name: ciInput.name,
            _type: ciInput.type,
            _status: ciInput.status,
            _environment: ciInput.environment,
            _created_at: '2025-01-15T10:00:00Z',
            _updated_at: '2025-01-15T10:00:00Z',
            _discovered_at: ciInput.discovered_at,
            _metadata: JSON.stringify(ciInput.metadata),
          },
        }),
      }];

      const result = await client.createCI(ciInput);

      expect(mockSession.run).toHaveBeenCalled();
      const call = mockSession.run.mock.calls[0];
      expect(call[0]).toContain('CREATE (ci:CI:server');
      expect(call[1]).toMatchObject({
        _id: ciInput.id,
        _name: ciInput.name,
        _type: ciInput.type,
      });
      expect(result.id).toBe(ciInput.id);
      expect(result.name).toBe(ciInput.name);
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should use default values for optional fields', async () => {
      const ciInput = {
        _id: 'ci-123',
        _name: 'Minimal CI',
        _type: 'server' as const,
      };

      mockResult.records = [{
        _get: jest.fn().mockReturnValue({
          _properties: {
            _id: ciInput.id,
            _name: ciInput.name,
            _type: ciInput.type,
            _status: 'active',
            _created_at: '2025-01-15T10:00:00Z',
            _updated_at: '2025-01-15T10:00:00Z',
            _discovered_at: '2025-01-15T10:00:00Z',
            _metadata: '{}',
          },
        }),
      }];

      const result = await client.createCI(ciInput);

      expect(result.status).toBe('active');
      expect(result.metadata).toEqual({});
    });

    it('should close session on error', async () => {
      mockSession.run.mockRejectedValueOnce(new Error('Create failed'));

      await expect(client.createCI({
        _id: 'ci-123',
        _name: 'Test',
        _type: 'server',
      })).rejects.toThrow('Create failed');

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('updateCI', () => {
    it('should update CI successfully', async () => {
      const updates = {
        _name: 'Updated Name',
        _status: 'maintenance' as const,
      };

      mockResult.records = [{
        _get: jest.fn().mockReturnValue({
          _properties: {
            _id: 'ci-123',
            _name: 'Updated Name',
            _type: 'server',
            _status: 'maintenance',
            _created_at: '2025-01-15T10:00:00Z',
            _updated_at: '2025-01-15T11:00:00Z',
            _discovered_at: '2025-01-15T10:00:00Z',
            _metadata: '{}',
          },
        }),
      }];

      const result = await client.updateCI('ci-123', updates);

      expect(mockSession.run).toHaveBeenCalled();
      const call = mockSession.run.mock.calls[0];
      expect(call[0]).toContain('MATCH (ci:CI {id: $id})');
      expect(call[0]).toContain('SET ci += $updates');
      expect(call[1]).toEqual({ id: 'ci-123', updates });
      expect(result.name).toBe('Updated Name');
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should throw error if CI not found', async () => {
      mockResult.records = [];

      await expect(client.updateCI('ci-999', { name: 'New Name' }))
        .rejects.toThrow('CI not found: ci-999');

      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('getCI', () => {
    it('should retrieve CI by id', async () => {
      mockResult.records = [{
        _get: jest.fn().mockReturnValue({
          _properties: {
            _id: 'ci-123',
            _name: 'Test Server',
            _type: 'server',
            _status: 'active',
            _created_at: '2025-01-15T10:00:00Z',
            _updated_at: '2025-01-15T10:00:00Z',
            _discovered_at: '2025-01-15T10:00:00Z',
            _metadata: '{"key": "value"}',
          },
        }),
      }];

      const result = await client.getCI('ci-123');

      expect(mockSession.run).toHaveBeenCalledWith(
        'MATCH (ci:CI {id: $id}) RETURN ci',
        { id: 'ci-123' }
      );
      expect(result).not.toBeNull();
      expect(result?.id).toBe('ci-123');
      expect(result?.metadata).toEqual({ key: 'value' });
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should return null if CI not found', async () => {
      mockResult.records = [];

      const result = await client.getCI('ci-999');

      expect(result).toBeNull();
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('createRelationship', () => {
    it('should create relationship with properties', async () => {
      const properties = { weight: 1, created: '2025-01-15' };

      await client.createRelationship('ci-1', 'ci-2', 'DEPENDS_ON', properties);

      expect(mockSession.run).toHaveBeenCalled();
      const call = mockSession.run.mock.calls[0];
      expect(call[0]).toContain('MATCH (from:CI {id: $fromId})');
      expect(call[0]).toContain('MATCH (to:CI {id: $toId})');
      expect(call[0]).toContain('MERGE (from)-[r:DEPENDS_ON]->(to)');
      expect(call[1]).toEqual({
        _fromId: 'ci-1',
        _toId: 'ci-2',
        properties,
      });
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('should create relationship without properties', async () => {
      await client.createRelationship('ci-1', 'ci-2', 'HOSTS');

      const call = mockSession.run.mock.calls[0];
      expect(call[1].properties).toEqual({});
    });
  });


  describe('close', () => {
    it('should close driver connection', async () => {
      await client.close();

      expect(mockDriver.close).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle JSON parse errors in metadata', async () => {
      mockResult.records = [{
        _get: jest.fn().mockReturnValue({
          _properties: {
            _id: 'ci-123',
            _name: 'Test',
            _type: 'server',
            _status: 'active',
            _created_at: '2025-01-15T10:00:00Z',
            _updated_at: '2025-01-15T10:00:00Z',
            _discovered_at: '2025-01-15T10:00:00Z',
            _metadata: 'invalid-json',
          },
        }),
      }];

      // Should handle gracefully or throw appropriate error
      await expect(client.getCI('ci-123')).rejects.toThrow();
    });

    it('should handle null/undefined metadata', async () => {
      mockResult.records = [{
        _get: jest.fn().mockReturnValue({
          _properties: {
            _id: 'ci-123',
            _name: 'Test',
            _type: 'server',
            _status: 'active',
            _created_at: '2025-01-15T10:00:00Z',
            _updated_at: '2025-01-15T10:00:00Z',
            _discovered_at: '2025-01-15T10:00:00Z',
            _metadata: null,
          },
        }),
      }];

      const result = await client.getCI('ci-123');

      expect(result?.metadata).toEqual({});
    });
  });
});
