// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for PatternStorageService's admin-surface additions:
 * listPatterns (all-status, filtered, paginated), deletePattern, and
 * getPatternUsage. loadPatterns()/savePattern()/updatePattern()/workflow
 * plumbing predate this ticket and are exercised indirectly elsewhere.
 *
 * Mock implementations are assigned in beforeEach (not baked into the
 * jest.mock() factories) because some test configs in this monorepo run
 * with resetMocks: true, which strips any implementation a factory-created
 * jest.fn() was given before the first test body runs.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@cmdb/database', () => ({
  getPostgresClient: jest.fn(),
}));

jest.mock('@cmdb/common', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../pattern-cache.service', () => ({
  PatternCacheService: jest.fn(),
}));

import { getPostgresClient, type PostgresClient } from '@cmdb/database';
import { PatternCacheService } from '../pattern-cache.service';
import { PatternStorageService } from '../pattern-storage';

/** Minimal shape of a pg QueryResult, as consumed by PatternStorageService. */
interface MockQueryResult {
  rows?: unknown[];
  rowCount?: number;
}

function patternRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    pattern_id: 'pat-1',
    name: 'Test Pattern',
    version: '1.0.0',
    category: 'web',
    detection_code: 'return true;',
    discovery_code: 'return [];',
    description: null,
    author: 'tester',
    license: 'MIT',
    confidence_score: '0.9',
    usage_count: 5,
    success_count: 4,
    failure_count: 1,
    avg_execution_time_ms: 120,
    learned_from_sessions: [],
    ai_model: null,
    status: 'active',
    is_active: true,
    registry_url: null,
    community_upvotes: 0,
    community_downvotes: 0,
    test_cases: [],
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-02'),
    approved_at: null,
    approved_by: null,
    ...overrides,
  };
}

describe('PatternStorageService', () => {
  let storage: PatternStorageService;
  let mockClientQuery: jest.Mock<(text: string, params?: unknown[]) => Promise<MockQueryResult>>;
  let mockInvalidatePattern: jest.Mock<(patternId: string) => Promise<void>>;

  beforeEach(() => {
    mockClientQuery = jest.fn();
    const mockClient = { query: mockClientQuery, release: jest.fn() };
    mockInvalidatePattern = jest.fn();

    jest.mocked(getPostgresClient).mockReturnValue({
      getClient: jest.fn(async () => mockClient),
      query: jest.fn(),
    } as unknown as PostgresClient);

    // jest.mocked() on a class constructor requires a MockedObject with
    // every method wrapped; this test double only needs invalidatePattern,
    // so mock the constructor as a plain factory function instead.
    (PatternCacheService as unknown as jest.Mock<() => PatternCacheService>).mockReturnValue({
      invalidatePattern: mockInvalidatePattern,
    } as unknown as PatternCacheService);

    storage = new PatternStorageService();
  });

  describe('listPatterns', () => {
    it('queries every lifecycle status when no filters are given, bounded to the default page size', async () => {
      mockClientQuery.mockResolvedValue({ rows: [patternRow()] });

      const result = await storage.listPatterns();

      expect(result).toHaveLength(1);
      expect(result[0].patternId).toBe('pat-1');
      const [sql, params] = mockClientQuery.mock.calls[0];
      expect(sql).not.toContain('WHERE');
      expect(params).toEqual([200, 0]);
    });

    it('builds a WHERE clause combining every provided filter', async () => {
      mockClientQuery.mockResolvedValue({ rows: [] });

      await storage.listPatterns({
        status: ['draft', 'review'],
        category: 'web',
        isActive: false,
        minConfidence: 0.5,
        minUsage: 10,
        search: 'nginx',
      });

      const [sql, params] = mockClientQuery.mock.calls[0];
      expect(sql).toContain('status = ANY($1)');
      expect(sql).toContain('category = $2');
      expect(sql).toContain('is_active = $3');
      expect(sql).toContain('confidence_score >= $4');
      expect(sql).toContain('usage_count >= $5');
      expect(sql).toContain('name ILIKE $6');
      expect(params).toEqual([
        ['draft', 'review'],
        'web',
        false,
        0.5,
        10,
        '%nginx%',
        200,
        0,
      ]);
    });

    it('clamps an out-of-range limit/offset to the allowed page-size window', async () => {
      mockClientQuery.mockResolvedValue({ rows: [] });

      await storage.listPatterns({ limit: 10000, offset: -5 });

      const [, params] = mockClientQuery.mock.calls[0];
      expect(params).toEqual([500, 0]);
    });
  });

  describe('deletePattern', () => {
    it('returns true and invalidates caches when a row is deleted', async () => {
      mockClientQuery.mockResolvedValue({ rowCount: 1 });

      const deleted = await storage.deletePattern('pat-1');

      expect(deleted).toBe(true);
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM ai_discovery_patterns'),
        ['pat-1']
      );
      expect(mockInvalidatePattern).toHaveBeenCalledWith('pat-1');
    });

    it('returns false when no row matched the pattern ID', async () => {
      mockClientQuery.mockResolvedValue({ rowCount: 0 });

      const deleted = await storage.deletePattern('missing');

      expect(deleted).toBe(false);
    });
  });

  describe('getPatternUsage', () => {
    it('maps usage rows joined with their originating session host/port', async () => {
      mockClientQuery.mockResolvedValue({
        rows: [
          {
            timestamp: new Date('2026-01-03'),
            execution_time_ms: 42,
            success: true,
            confidence_score: '0.95',
            error_message: null,
            target_host: '10.0.0.5',
            target_port: 443,
          },
        ],
      });

      const usage = await storage.getPatternUsage('pat-1', 7);

      expect(usage).toEqual([
        {
          patternId: 'pat-1',
          timestamp: new Date('2026-01-03'),
          executionTimeMs: 42,
          success: true,
          confidenceScore: 0.95,
          errorMessage: undefined,
          matchedHost: '10.0.0.5',
          matchedPort: 443,
        },
      ]);
      const [, params] = mockClientQuery.mock.calls[0];
      expect(params).toEqual(['pat-1', 7]);
    });

    it('defaults to a 30-day window', async () => {
      mockClientQuery.mockResolvedValue({ rows: [] });

      await storage.getPatternUsage('pat-1');

      const [, params] = mockClientQuery.mock.calls[0];
      expect(params).toEqual(['pat-1', 30]);
    });
  });
});
