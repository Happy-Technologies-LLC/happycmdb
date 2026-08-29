// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j to PostgreSQL ETL Job Unit Tests
 *
 * TDD London School Approach:
 * - Mock database clients (Neo4j and PostgreSQL)
 * - Test interactions and transformation logic
 * - Verify batch processing and error handling
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Neo4jToPostgresJob } from '../neo4j-to-postgres.job';
import {
  createMockNeo4jDriver,
  createMockPostgresPool,
  createMockNeo4jResult,
  createMockPostgresResult,
} from '../../../../../tests/utils/mock-database-clients';
import { createCI } from '../../../../../tests/utils/mock-factories';

// Mock dependencies
jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../../transformers/dimension-transformer');

describe('Neo4jToPostgresJob', () => {
  let job: Neo4jToPostgresJob;
  let mockNeo4j: ReturnType<typeof createMockNeo4jDriver>;
  let mockPostgres: ReturnType<typeof createMockPostgresPool>;
  let mockBullJob: any;
  let mockNeo4jClient: any;
  let mockPostgresClient: any;

  beforeEach(() => {
    // Arrange: Create mock database clients
    mockNeo4j = createMockNeo4jDriver();
    mockPostgres = createMockPostgresPool();

    // Mock BullMQ job
    mockBullJob = {
      id: 'job-123',
      data: {},
      updateProgress: jest.fn(),
    };

    // Create mock Neo4jClient that matches the interface used by the job
    mockNeo4jClient = {
      getSession: jest.fn().mockReturnValue(mockNeo4j.session),
      getRelationships: jest.fn().mockResolvedValue([]),
    };

    // Create mock PostgresClient that matches the interface used by the job
    // The job uses postgresClient.transaction() and postgresClient.query()
    mockPostgresClient = {
      query: jest.fn().mockResolvedValue(createMockPostgresResult([])),
      getClient: jest.fn().mockResolvedValue(mockPostgres.client),
      transaction: jest.fn().mockImplementation(async (callback: any) => {
        return await callback(mockPostgres.client);
      }),
    };

    // Set up DimensionTransformer mock before creating job (resetMocks clears factory)
    const { DimensionTransformer } = require('../../transformers/dimension-transformer');
    (DimensionTransformer as jest.Mock).mockImplementation(() => ({
      toDimension: jest.fn((ci: any) => ({
        _ci_id: ci._id || ci.id,
        _ci_name: ci.name,
        _ci_type: ci._type || ci.type,
        environment: ci.environment,
        _status: ci._status || ci.status,
        external_id: ci.external_id,
        created_at: ci._created_at || ci.created_at,
      })),
      toDiscoveryFact: jest.fn((_ci: any, ciKey: number) => ({
        _ci_key: ciKey,
        _date_key: 20231201,
        _discovered_at: _ci._discovered_at || _ci.discovered_at,
        _discovery_method: 'automated',
        _discovery_source: _ci.discovery_provider || 'unknown',
      })),
    }));

    // Create job instance with properly mocked clients
    job = new Neo4jToPostgresJob(mockNeo4jClient as any, mockPostgresClient as any);

    // Mock the private sleep method to avoid delays during retries
    (job as any).sleep = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('should execute complete ETL flow successfully', async () => {
      // Arrange: Mock CI data from Neo4j (metadata as JSON string for Neo4j)
      const mockCIs = [
        createCI({ id: 'ci-1', name: 'server-1', type: 'server' }),
        createCI({ id: 'ci-2', name: 'db-1', type: 'database' }),
      ].map(ci => ({ ...ci, metadata: JSON.stringify(ci.metadata || {}) }));

      mockNeo4j.session.run.mockResolvedValueOnce(
        createMockNeo4jResult(
          mockCIs.map((ci) => ({ ci: { properties: ci } }))
        )
      );

      // Mock PostgreSQL: CIs don't exist (new inserts)
      mockPostgres.client.query
        .mockResolvedValueOnce(createMockPostgresResult([])) // Check existence ci-1
        .mockResolvedValueOnce(createMockPostgresResult([{ ci_key: 1 }])) // Insert dim_ci ci-1
        .mockResolvedValueOnce(createMockPostgresResult([])) // Insert fact ci-1
        .mockResolvedValueOnce(createMockPostgresResult([])) // Check existence ci-2
        .mockResolvedValueOnce(createMockPostgresResult([{ ci_key: 2 }])) // Insert dim_ci ci-2
        .mockResolvedValueOnce(createMockPostgresResult([])); // Insert fact ci-2

      mockBullJob.data = { batchSize: 100 };

      // Act: Execute ETL job
      const result = await job.execute(mockBullJob);

      // Assert: Verify Neo4j extraction
      expect(mockNeo4jClient.getSession).toHaveBeenCalled();
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('MATCH (ci:CI)'),
        expect.any(Object)
      );

      // Assert: Verify session cleanup
      expect(mockNeo4j.session.close).toHaveBeenCalled();

      // Assert: Verify transaction was called
      expect(mockPostgresClient.transaction).toHaveBeenCalled();

      // Assert: Verify PostgreSQL inserts within transaction
      // Note: the client is passed via transaction callback
      const transactionCalls = (mockPostgresClient.transaction as jest.Mock).mock.calls.length;
      expect(transactionCalls).toBeGreaterThan(0);

      // Assert: Verify result structure
      expect(result).toMatchObject({
        cisProcessed: 2,
        recordsInserted: 2,
        recordsUpdated: 0,
        errors: 0,
      });

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAt).toBeDefined();
    });

    it('should filter CIs by type when specified', async () => {
      // Arrange
      mockNeo4j.session.run.mockResolvedValueOnce(createMockNeo4jResult([]));
      mockBullJob.data = {
        ciTypes: ['server', 'database'],
        batchSize: 100,
      };

      // Act
      await job.execute(mockBullJob);

      // Assert: Verify query includes type filter
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('WHERE ci.type IN $ciTypes'),
        expect.objectContaining({
          ciTypes: ['server', 'database'],
        })
      );
    });

    it('should perform incremental sync when incrementalSince is provided', async () => {
      // Arrange
      const since = '2023-12-01T00:00:00.000Z';
      mockNeo4j.session.run.mockResolvedValueOnce(createMockNeo4jResult([]));
      mockBullJob.data = {
        incrementalSince: since,
        batchSize: 100,
      };

      // Act
      await job.execute(mockBullJob);

      // Assert: Verify incremental query
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('ci.updated_at >= datetime($since)'),
        expect.objectContaining({
          since,
        })
      );
    });

    it('should update progress during batch processing', async () => {
      // Arrange: Multiple batches (metadata as JSON string)
      const mockCIs = Array.from({ length: 150 }, (_, i) =>
        createCI({ id: `ci-${i}`, name: `server-${i}` })
      ).map(ci => ({ ...ci, metadata: JSON.stringify(ci.metadata || {}) }));

      mockNeo4j.session.run.mockResolvedValueOnce(
        createMockNeo4jResult(
          mockCIs.map((ci) => ({ ci: { properties: ci } }))
        )
      );

      mockPostgres.client.query.mockResolvedValue(
        createMockPostgresResult([{ ci_key: 1 }])
      );

      mockBullJob.data = { batchSize: 50 }; // 3 batches

      // Act
      await job.execute(mockBullJob);

      // Assert: Progress updated 3 times (once per batch)
      expect(mockBullJob.updateProgress).toHaveBeenCalledTimes(3);
    });

    it('should handle batch processing errors gracefully', async () => {
      // Arrange: Mock CIs (metadata as JSON string)
      const mockCIs = [
        createCI({ id: 'ci-1' }),
        createCI({ id: 'ci-2' }),
      ].map(ci => ({ ...ci, metadata: JSON.stringify(ci.metadata || {}) }));

      mockNeo4j.session.run.mockResolvedValueOnce(
        createMockNeo4jResult(
          mockCIs.map((ci) => ({ ci: { properties: ci } }))
        )
      );

      // Mock PostgreSQL error - all retries fail
      mockPostgresClient.transaction.mockRejectedValue(
        new Error('Persistent connection error')
      );

      mockBullJob.data = { batchSize: 100 };

      // Act
      const result = await job.execute(mockBullJob);

      // Assert: Error counted but job completes
      expect(result.errors).toBe(1);
    });
  });

  describe('Contract Verification (London School)', () => {
    it('should follow contract with Neo4j client for CI extraction', async () => {
      // Arrange
      mockNeo4j.session.run.mockResolvedValueOnce(createMockNeo4jResult([]));
      mockBullJob.data = { batchSize: 100 };

      // Act
      await job.execute(mockBullJob);

      // Assert: Contract verification
      expect(mockNeo4jClient.getSession).toHaveBeenCalled();
      expect(mockNeo4j.session.run).toHaveBeenCalledWith(
        expect.stringContaining('MATCH (ci:CI)'),
        expect.any(Object)
      );
      expect(mockNeo4j.session.close).toHaveBeenCalled();
    });

    it('should follow contract with PostgreSQL client for dimension insert', async () => {
      // Arrange
      const mockCI = createCI({ id: 'ci-1' });
      mockCI.metadata = JSON.stringify(mockCI.metadata || {});

      mockNeo4j.session.run.mockResolvedValueOnce(
        createMockNeo4jResult([{ ci: { properties: mockCI } }])
      );

      mockPostgres.client.query
        .mockResolvedValueOnce(createMockPostgresResult([])) // Not found
        .mockResolvedValueOnce(createMockPostgresResult([{ ci_key: 1 }])) // Insert
        .mockResolvedValueOnce(createMockPostgresResult([])); // Fact insert

      mockBullJob.data = { batchSize: 100 };

      // Act
      await job.execute(mockBullJob);

      // Assert: Contract with PostgreSQL - dimension insert was called
      expect(mockPostgres.client.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO cmdb.dim_ci'),
        expect.any(Array)
      );
    });
  });
});
