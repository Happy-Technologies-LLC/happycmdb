// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * PUT /settings/discovery/:provider on real PostgreSQL (PGlite, hosted in a forked child by
 * ../../routes/__tests__/fixtures/pglite-host.cjs) over the table of 006_application_settings.sql.
 *
 * The statements of the secret merge path read and write the encrypted blob of one (user, provider) row.
 * A mocked client cannot tell a statement scoped to that row from one that touches every user's row, so these
 * rows run the controller's real SQL and assert what each user's row holds afterwards. Only the Postgres
 * client wrapper (BEGIN/COMMIT/ROLLBACK around a single connection) and the encryption service (reversible
 * JSON, not the unit under test) are substituted.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Response } from 'express';

jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  getEncryptionService: jest.fn(),
}));
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
  getRedisClient: jest.fn(),
}));

import { getPostgresClient } from '@cmdb/database';
import { getEncryptionService } from '@cmdb/common';
import { SettingsController } from '../settings.controller';
import type { AuthenticatedRequest } from '../../../middleware/auth.middleware';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const host = fork(join(__dirname, '../../routes/__tests__/fixtures/pglite-host.cjs'), [], {
  serialization: 'advanced',
});
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<Record<string, any>[]>>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, any>[]; error?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(new Error(error));
  else call.resolve(rows);
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const call = Promise.withResolvers<Record<string, any>[]>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}

const MIGRATION = join(__dirname, '../../../../../database/src/postgres/migrations/006_application_settings.sql');

// One connection, so statements are serialized by the test; BEGIN/COMMIT/ROLLBACK as PostgresClient.transaction does.
type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
const pgClient: { query: Query; transaction: (cb: (client: { query: Query }) => Promise<unknown>) => Promise<unknown> } = {
  query: async (text, params = []) => ({ rows: await sql(text, params) }),
  transaction: async (cb) => {
    await sql('BEGIN', [], 'exec');
    try {
      const result = await cb({ query: pgClient.query });
      await sql('COMMIT', [], 'exec');
      return result;
    } catch (error) {
      await sql('ROLLBACK', [], 'exec');
      throw error;
    }
  },
};

const encryption = {
  encryptCredential: (value: unknown) => `enc:${JSON.stringify(value)}`,
  decryptCredential: (blob: string) => JSON.parse(blob.slice('enc:'.length)),
};

const blob = (value: Record<string, unknown>) => encryption.encryptCredential(value);

function mockRes(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function mockReq(userId: string, provider: string, body: Record<string, unknown>): AuthenticatedRequest {
  return {
    user: { _userId: userId, _username: userId, _role: 'operator', _type: 'access' },
    params: { provider },
    body,
  } as unknown as AuthenticatedRequest;
}

async function seed(userId: string, provider: string, config: Record<string, unknown>, creds: Record<string, unknown>) {
  await sql(
    `INSERT INTO discovery_provider_settings (user_id, provider, config, encrypted_credentials)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [userId, provider, JSON.stringify(config), blob(creds)]
  );
}

async function row(userId: string, provider: string) {
  const rows = await sql(
    'SELECT config, encrypted_credentials, updated_at FROM discovery_provider_settings WHERE user_id = $1 AND provider = $2',
    [userId, provider]
  );
  return rows[0] as { config: unknown; encrypted_credentials: string | null; updated_at: Date } | undefined;
}

describe('updateDiscoveryProviderSettings against real PostgreSQL: row scope', () => {
  const controller = new SettingsController();

  beforeAll(async () => {
    await sql(readFileSync(MIGRATION, 'utf8'), [], 'exec');
  });

  afterAll(() => {
    host.kill();
  });

  beforeEach(async () => {
    await sql('DELETE FROM discovery_provider_settings', [], 'exec');
    (getPostgresClient as AnyMock).mockReturnValue(pgClient);
    (getEncryptionService as AnyMock).mockReturnValue(encryption);
    // Another user's aws row is inserted first so an unscoped statement meets it before the caller's row.
    await seed('user-2', 'aws', { region: 'eu-west-1' }, { accessKeyId: 'U2-AK', secretAccessKey: 'U2-SK' });
    await seed('user-1', 'aws', { region: 'us-east-1' }, { accessKeyId: 'U1-AK', secretAccessKey: 'U1-SK' });
    await seed('user-1', 'azure', { tenantId: 'u1-tenant' }, { clientSecret: 'U1-AZ-SECRET' });
  });

  it('a partial secret save rewrites only the caller\'s row for that provider', async () => {
    const res = mockRes();
    await controller.updateDiscoveryProviderSettings(
      mockReq('user-1', 'aws', { credentials: { accessKeyId: 'U1-NEW', region: 'us-west-2' } }),
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    const mine = await row('user-1', 'aws');
    expect(mine!.config).toEqual({ region: 'us-west-2' });
    expect(encryption.decryptCredential(mine!.encrypted_credentials!)).toEqual({
      accessKeyId: 'U1-NEW',
      secretAccessKey: 'U1-SK',
    });

    const other = await row('user-2', 'aws');
    expect(other!.config).toEqual({ region: 'eu-west-1' });
    expect(other!.encrypted_credentials).toBe(blob({ accessKeyId: 'U2-AK', secretAccessKey: 'U2-SK' }));

    const sameUserOtherProvider = await row('user-1', 'azure');
    expect(sameUserOtherProvider!.config).toEqual({ tenantId: 'u1-tenant' });
    expect(sameUserOtherProvider!.encrypted_credentials).toBe(blob({ clientSecret: 'U1-AZ-SECRET' }));
  });

  it('never merges another user\'s stored secrets into the caller\'s blob', async () => {
    await controller.updateDiscoveryProviderSettings(
      mockReq('user-1', 'aws', { credentials: { sessionToken: 'U1-TOKEN' } }),
      mockRes()
    );

    const mine = encryption.decryptCredential((await row('user-1', 'aws'))!.encrypted_credentials!);
    expect(mine).toEqual({ accessKeyId: 'U1-AK', secretAccessKey: 'U1-SK', sessionToken: 'U1-TOKEN' });
    expect(JSON.stringify(mine)).not.toContain('U2-');
  });

  it('takes the user from the authenticated session, not from the request body', async () => {
    await controller.updateDiscoveryProviderSettings(
      mockReq('user-1', 'aws', { userId: 'user-2', user_id: 'user-2', credentials: { accessKeyId: 'U1-NEW' } }),
      mockRes()
    );

    const other = await row('user-2', 'aws');
    expect(other!.encrypted_credentials).toBe(blob({ accessKeyId: 'U2-AK', secretAccessKey: 'U2-SK' }));
    const mine = await row('user-1', 'aws');
    expect(encryption.decryptCredential(mine!.encrypted_credentials!)).toEqual({
      accessKeyId: 'U1-NEW',
      secretAccessKey: 'U1-SK',
    });
  });

  it('a save without secrets rewrites only the caller\'s row and keeps its blob', async () => {
    await controller.updateDiscoveryProviderSettings(
      mockReq('user-1', 'aws', { credentials: { region: 'ap-south-1' } }),
      mockRes()
    );

    const mine = await row('user-1', 'aws');
    expect(mine!.config).toEqual({ region: 'ap-south-1' });
    expect(mine!.encrypted_credentials).toBe(blob({ accessKeyId: 'U1-AK', secretAccessKey: 'U1-SK' }));
    const other = await row('user-2', 'aws');
    expect(other!.config).toEqual({ region: 'eu-west-1' });
  });

  it('a first save creates the caller\'s row; a failed merge leaves the stored row untouched', async () => {
    await controller.updateDiscoveryProviderSettings(
      mockReq('user-3', 'gcp', { credentials: { projectId: 'p', credentials: '{"k":1}' } }),
      mockRes()
    );
    const created = await row('user-3', 'gcp');
    expect(created!.config).toEqual({ projectId: 'p' });
    expect(encryption.decryptCredential(created!.encrypted_credentials!)).toEqual({ credentials: '{"k":1}' });

    await sql(
      `INSERT INTO discovery_provider_settings (user_id, provider, encrypted_credentials) VALUES ('user-4', 'ssh', 'enc:"not-an-object"')`,
      [],
      'exec'
    );
    const res = mockRes();
    await controller.updateDiscoveryProviderSettings(
      mockReq('user-4', 'ssh', { credentials: { privateKey: 'K' } }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect((await row('user-4', 'ssh'))!.encrypted_credentials).toBe('enc:"not-an-object"');
  });
});
