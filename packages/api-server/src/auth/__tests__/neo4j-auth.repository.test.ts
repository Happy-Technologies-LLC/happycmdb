// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Neo4jAuthRepository.updateUser and .deleteUserAccount --
 * the two methods added on top of the pre-existing (extracted, unchanged)
 * Neo4j/Postgres query logic.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { Neo4jAuthRepository } from '../neo4j-auth.repository';

type AnyMock = jest.Mock<(...args: any[]) => any>;

describe('Neo4jAuthRepository', () => {
  let mockSession: { run: AnyMock; close: AnyMock };
  let mockPgPoolClient: { query: AnyMock; release: AnyMock };
  let mockPostgresQuery: AnyMock;
  let repository: Neo4jAuthRepository;

  beforeEach(() => {
    mockSession = { run: jest.fn(), close: jest.fn() };
    mockPgPoolClient = { query: jest.fn(), release: jest.fn() };
    mockPostgresQuery = jest.fn();

    (getNeo4jClient as AnyMock).mockReturnValue({ getSession: () => mockSession });
    (getPostgresClient as AnyMock).mockReturnValue({
      getClient: async () => mockPgPoolClient,
      query: mockPostgresQuery,
    });
    repository = new Neo4jAuthRepository();
  });

  describe('updateUser', () => {
    it('sets only the provided fields and returns the mapped user', async () => {
      mockSession.run.mockResolvedValue({
        records: [
          {
            get: () => ({
              properties: {
                _id: 'user-1',
                _username: 'alice',
                _email: 'alice@example.com',
                _passwordHash: 'hash',
                _role: 'operator',
                _enabled: true,
                _name: 'Alice Updated',
              },
            }),
          },
        ],
      });

      const result = await repository.updateUser('user-1', { name: 'Alice Updated' });

      expect(result._name).toBe('Alice Updated');
      const [cypher, params] = mockSession.run.mock.calls[0] as [string, Record<string, unknown>];
      expect(cypher).toContain('u._name = $name');
      expect(cypher).not.toContain('$avatar');
      expect(params).toEqual({ id: 'user-1', name: 'Alice Updated' });
      expect(mockSession.close).toHaveBeenCalled();
    });

    it('throws when the user does not exist', async () => {
      mockSession.run.mockResolvedValue({ records: [] });

      await expect(repository.updateUser('ghost', { name: 'x' })).rejects.toThrow('User not found');
    });
  });

  describe('deleteUserAccount', () => {
    it('deletes dependent Postgres rows in one transaction before deleting the Neo4j user', async () => {
      mockPgPoolClient.query.mockResolvedValue({ rows: [] });
      mockSession.run.mockResolvedValue({ records: [] });

      await repository.deleteUserAccount('user-1');

      const pgCalls = mockPgPoolClient.query.mock.calls.map((c) => (c as [string])[0]);
      expect(pgCalls[0]).toBe('BEGIN');
      expect(pgCalls).toEqual(
        expect.arrayContaining([
          expect.stringContaining('DELETE FROM discovery_provider_settings'),
          expect.stringContaining('DELETE FROM user_settings'),
          expect.stringContaining('DELETE FROM api_keys'),
        ])
      );
      expect(pgCalls[pgCalls.length - 1]).toBe('COMMIT');
      expect(mockPgPoolClient.release).toHaveBeenCalled();

      expect(mockSession.run).toHaveBeenCalledWith(expect.stringContaining('DETACH DELETE u'), { id: 'user-1' });

      // Postgres cleanup must run before the Neo4j identity is removed.
      const commitIndex = pgCalls.indexOf('COMMIT');
      expect(commitIndex).toBeGreaterThanOrEqual(0);
    });

    it('rolls back and never touches Neo4j when the Postgres transaction fails', async () => {
      mockPgPoolClient.query.mockImplementation((sql: string) => {
        if (sql.startsWith('DELETE FROM user_settings')) {
          return Promise.reject(new Error('constraint violation'));
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(repository.deleteUserAccount('user-1')).rejects.toThrow('Failed to delete account data');

      const pgCalls = mockPgPoolClient.query.mock.calls.map((c) => (c as [string])[0]);
      expect(pgCalls).toContain('ROLLBACK');
      expect(mockPgPoolClient.release).toHaveBeenCalled();
      expect(mockSession.run).not.toHaveBeenCalled();
    });
  });

  describe('deleteApiKey', () => {
    it('soft-revokes only the active key belonging to the requested user and returns affected rows', async () => {
      mockPostgresQuery.mockResolvedValue({ rowCount: 1 });

      await expect(repository.deleteApiKey('user-1', 'key-1')).resolves.toBe(1);

      expect(mockPostgresQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL'),
        ['key-1', 'user-1']
      );
    });

    it('reports no affected row for a missing, foreign, or already revoked key', async () => {
      mockPostgresQuery.mockResolvedValue({ rowCount: 0 });

      await expect(repository.deleteApiKey('user-1', 'key-1')).resolves.toBe(0);
    });
  });
});
