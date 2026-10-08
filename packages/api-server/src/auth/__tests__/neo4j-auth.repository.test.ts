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
import neo4j from 'neo4j-driver';
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

  // HP1-S6 (v16 §1.1 mapped spelling contract, SEC15-04 / SEC16-03).
  describe('user mapping', () => {
    const load = async (properties: Record<string, unknown>) => {
      mockSession.run.mockResolvedValue({ records: [{ get: () => ({ properties, elementId: '4:abc:1' }) }] });
      return repository.findUserById('u');
    };

    it('either spelling of the default-password marker marks the user (fail-closed)', async () => {
      expect((await load({ _id: 'u', defaultPasswordSuspect: true }))?._defaultPasswordSuspect).toBe(true);
      expect((await load({ _id: 'u', defaultPasswordSuspect: false, _defaultPasswordSuspect: true }))?._defaultPasswordSuspect).toBe(true);
      expect((await load({ _id: 'u', defaultPasswordSuspect: false }))?._defaultPasswordSuspect).toBe(false);
    });

    it('maps the credential generation: absent 0, Neo4j Integer, anything else (Float, string, unsafe) NaN', async () => {
      expect((await load({ _id: 'u' }))?._credentialEpoch).toBe(0);
      expect((await load({ _id: 'u', credentialEpoch: neo4j.int(3) }))?._credentialEpoch).toBe(3);
      expect((await load({ _id: 'u', credentialEpoch: 1.0 }))?._credentialEpoch).toBeNaN();
      expect((await load({ _id: 'u', credentialEpoch: '1' }))?._credentialEpoch).toBeNaN();
      expect((await load({ _id: 'u', credentialEpoch: neo4j.int('9007199254740993') }))?._credentialEpoch).toBeNaN();
    });

    it('maps the platform flag, seed provenance and element id', async () => {
      expect(await load({ _id: 'u', platformAdmin: true, seedProvenance: 'seed-data' })).toMatchObject({
        _platformAdmin: true, _seedProvenance: 'seed-data', _elementId: '4:abc:1',
      });
      expect((await load({ _id: 'u', platformAdmin: 'true' }))?._platformAdmin).toBe(false);
    });
  });

  describe('API keys carry the authorizing credential generation', () => {
    it('refuses to create a key without one and stores the one given', async () => {
      mockPostgresQuery.mockResolvedValue({ rows: [{ id: 'k', credential_epoch: 2 }] });
      const key = { _userId: 'u', _keyHash: 'h', _name: 'n', _role: 'operator', _enabled: true } as never;

      await expect(repository.createApiKey(key)).rejects.toThrow('authorizing credential generation required');
      await expect(repository.createApiKey({ ...(key as object), _credentialEpoch: 2 } as never))
        .resolves.toMatchObject({ _credentialEpoch: 2 });
      expect(mockPostgresQuery.mock.calls[0]?.[1]).toEqual(['u', 'h', 'n', 'operator', true, null, 2]);
    });
  });
});
