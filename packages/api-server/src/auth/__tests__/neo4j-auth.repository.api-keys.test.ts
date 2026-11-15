// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1669: Neo4jAuthRepository.revokeApiKeysBelowEpoch against a real PostgreSQL (PGlite in a child process,
 * api_keys from 001_complete_schema.sql plus 020's credential_epoch column), so the WHERE clause is executed,
 * not read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: rows => resolve(rows as Array<Record<string, unknown>>), reject });
    host.send({ id, op, sql, params });
  });
}

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({}),
  // Plain functions: the project's Jest config resets jest.fn implementations between tests.
  getPostgresClient: () => ({
    // RETURNING-less UPDATEs report no rows over the IPC hop; the row count is recovered from a wrapped CTE below.
    query: async (text: string, params: unknown[] = []) => {
      const rows = await send('query', `WITH changed AS (${text} RETURNING 1) SELECT count(*)::int AS n FROM changed`, params);
      return { rows: [], rowCount: rows[0]!['n'] as number };
    },
  }),
}));

import { Neo4jAuthRepository } from '../neo4j-auth.repository';

const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');
beforeAll(async () => {
  const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS api_keys (');
  await send('exec', schema.slice(start, schema.indexOf(');', start) + 2));
  await send('exec', 'ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS credential_epoch INTEGER NOT NULL DEFAULT 0');
});
afterAll(() => {
  host.kill();
});
beforeEach(() => send('exec', 'DELETE FROM api_keys'));

const addKey = (name: string, userId: string, epoch: number) =>
  send('query', `INSERT INTO api_keys (user_id, key_hash, name, role, credential_epoch) VALUES ($1, $2, $3, 'admin', $4)`,
    [userId, `${name}-hash`.padEnd(64, '0'), name, epoch]);
const state = () =>
  send('query', 'SELECT name, enabled, revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY name');

describe('Neo4jAuthRepository.revokeApiKeysBelowEpoch (HAP-1669)', () => {
  it('revokes the user\'s keys below the new generation, and only those', async () => {
    await addKey('old-gen', 'u1', 4);
    await addKey('older-gen', 'u1', 0);
    await addKey('new-gen', 'u1', 5);
    await addKey('future-gen', 'u1', 9);
    await addKey('other-user', 'u2', 4);

    await expect(new Neo4jAuthRepository().revokeApiKeysBelowEpoch('u1', 5)).resolves.toBe(2);

    expect(await state()).toEqual([
      { name: 'future-gen', enabled: true, revoked: false },
      { name: 'new-gen', enabled: true, revoked: false },
      { name: 'old-gen', enabled: false, revoked: true },
      { name: 'older-gen', enabled: false, revoked: true },
      { name: 'other-user', enabled: true, revoked: false },
    ]);
  });

  it('does not re-stamp an already revoked key', async () => {
    await addKey('gone', 'u1', 1);
    await send('query', `UPDATE api_keys SET enabled = FALSE, revoked_at = '2026-01-01T00:00:00Z'`);

    await expect(new Neo4jAuthRepository().revokeApiKeysBelowEpoch('u1', 2)).resolves.toBe(0);

    expect(await send('query', 'SELECT revoked_at FROM api_keys')).toEqual([{ revoked_at: new Date('2026-01-01T00:00:00Z') }]);
  });
});
