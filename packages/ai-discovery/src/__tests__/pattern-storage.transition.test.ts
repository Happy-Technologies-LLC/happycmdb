// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for PatternStorageService.transitionPattern(): the atomic
 * status/approval-field UPDATE + ai_pattern_review_history INSERT pair used
 * by every PatternWorkflow transition. The mocked `transaction()` mirrors
 * PostgresClient.transaction()'s real BEGIN/COMMIT/ROLLBACK sequence (see
 * packages/database/src/postgres/client.ts) against a single shared mock
 * client, so these tests exercise the same commit/rollback contract the
 * real Postgres transaction provides, without a live database.
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

describe('PatternStorageService.transitionPattern', () => {
  let storage: PatternStorageService;
  let mockClientQuery: jest.Mock<(text: string, params?: unknown[]) => Promise<unknown>>;
  let mockRelease: jest.Mock<() => void>;
  let mockInvalidatePattern: jest.Mock<(patternId: string) => Promise<void>>;

  beforeEach(() => {
    mockClientQuery = jest.fn();
    mockRelease = jest.fn();
    const mockClient = { query: mockClientQuery, release: mockRelease };
    const getClient = jest.fn(async () => mockClient);

    // Faithful reimplementation of PostgresClient.transaction() (BEGIN,
    // callback, COMMIT on success / ROLLBACK on throw, always release),
    // against the single shared mockClient above -- proving both writes
    // ride the same connection/transaction.
    const transaction = jest.fn(
      async <T>(callback: (client: typeof mockClient) => Promise<T>): Promise<T> => {
        const client = await getClient();
        try {
          await client.query('BEGIN');
          const result = await callback(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    );

    mockInvalidatePattern = jest.fn();

    jest.mocked(getPostgresClient).mockReturnValue({
      getClient,
      transaction,
      query: jest.fn(),
    } as unknown as PostgresClient);

    (PatternCacheService as unknown as jest.Mock<() => PatternCacheService>).mockReturnValue({
      invalidatePattern: mockInvalidatePattern,
    } as unknown as PatternCacheService);

    storage = new PatternStorageService();
  });

  it('commits the status update and the review-history insert together on success', async () => {
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await storage.transitionPattern(
      'pat-1',
      { status: 'review' },
      'submit',
      'alice',
      'ready for review'
    );

    const calls = mockClientQuery.mock.calls;
    expect(calls[0][0]).toBe('BEGIN');

    const updateCall = calls.find(c => String(c[0]).includes('UPDATE ai_discovery_patterns'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toEqual(expect.arrayContaining(['review', 'pat-1']));

    const insertCall = calls.find(c =>
      String(c[0]).includes('INSERT INTO ai_pattern_review_history')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toEqual(['pat-1', 'submit', 'alice', 'ready for review']);

    // UPDATE and INSERT both ran before COMMIT, and COMMIT is the last call.
    const updateIndex = calls.indexOf(updateCall!);
    const insertIndex = calls.indexOf(insertCall!);
    const commitIndex = calls.findIndex(c => c[0] === 'COMMIT');
    expect(updateIndex).toBeGreaterThan(0);
    expect(insertIndex).toBeGreaterThan(updateIndex);
    expect(commitIndex).toBe(calls.length - 1);
    expect(calls.some(c => c[0] === 'ROLLBACK')).toBe(false);

    expect(mockRelease).toHaveBeenCalledTimes(1);

    // Cache invalidation only happens after a successful commit.
    expect(mockInvalidatePattern).toHaveBeenCalledWith('pat-1');
  });

  it('rolls back the status update when the review-history insert fails, and never touches the cache', async () => {
    mockClientQuery.mockImplementation(async (text: string) => {
      if (text.includes('INSERT INTO ai_pattern_review_history')) {
        throw new Error('duplicate key value violates unique constraint');
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      storage.transitionPattern(
        'pat-1',
        { status: 'approved', approvedBy: 'bob', approvedAt: new Date('2026-01-01') },
        'approve',
        'bob',
        'looks good'
      )
    ).rejects.toThrow('duplicate key value violates unique constraint');

    const calls = mockClientQuery.mock.calls;
    expect(calls[0][0]).toBe('BEGIN');
    expect(calls.some(c => String(c[0]).includes('UPDATE ai_discovery_patterns'))).toBe(true);
    expect(calls.some(c => String(c[0]).includes('INSERT INTO ai_pattern_review_history'))).toBe(
      true
    );
    // ROLLBACK ran (proving the UPDATE that already executed is undone by
    // Postgres) and no COMMIT was ever issued.
    expect(calls[calls.length - 1][0]).toBe('ROLLBACK');
    expect(calls.some(c => c[0] === 'COMMIT')).toBe(false);

    // Connection still released even though the transaction failed.
    expect(mockRelease).toHaveBeenCalledTimes(1);

    // A rolled-back transition must never evict/invalidate the cached
    // pattern based on a mutation that never actually committed.
    expect(mockInvalidatePattern).not.toHaveBeenCalled();
  });
});
