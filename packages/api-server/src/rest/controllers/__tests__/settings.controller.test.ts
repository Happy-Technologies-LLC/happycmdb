// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for SettingsController
 *
 * Covers: general/notification settings persistence, database status
 * secret-redaction (no passwords ever leave the process), discovery
 * provider settings secret/config split + encryption, and
 * test-connection auth/validation branches.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Response } from 'express';

jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  getEncryptionService: jest.fn(),
}));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
  getRedisClient: jest.fn(),
}));

jest.mock('../settings/discovery-connection-test', () => {
  const actual = jest.requireActual('../settings/discovery-connection-test') as object;
  return {
    ...actual,
    testDiscoveryProviderConnection: jest.fn(),
  };
});

import { getNeo4jClient, getPostgresClient, getRedisClient } from '@cmdb/database';
import { getEncryptionService, logger } from '@cmdb/common';
import { SettingsController } from '../settings.controller';
import { testDiscoveryProviderConnection } from '../settings/discovery-connection-test';
import type { AuthenticatedRequest } from '../../../middleware/auth.middleware';

// Mock typing follows this suite's established convention (see
// drift-impact.controller.test.ts): jest's default Mock generics
// otherwise infer `never` for the resolved-value parameter.
type AnyMock = jest.Mock<(...args: any[]) => any>;

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

function mockReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    user: { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'access' },
    params: {},
    body: {},
    ...overrides,
  } as AuthenticatedRequest;
}

describe('SettingsController', () => {
  let controller: SettingsController;
  let mockPgQuery: AnyMock;
  let mockPgClient: { query: AnyMock; transaction: AnyMock };
  let mockEncryptionService: { encryptCredential: AnyMock; decryptCredential: AnyMock };

  beforeEach(() => {
    mockPgQuery = jest.fn();
    mockPgClient = {
      query: mockPgQuery,
      // One transaction client whose query is the same mock, so every statement is observable in order.
      transaction: jest.fn(async (cb: (client: { query: AnyMock }) => Promise<unknown>) => cb({ query: mockPgQuery })),
    };
    mockEncryptionService = {
      encryptCredential: jest.fn().mockReturnValue('encrypted-blob'),
      decryptCredential: jest.fn(),
    };

    (getPostgresClient as AnyMock).mockReturnValue(mockPgClient);
    (getNeo4jClient as AnyMock).mockReturnValue({ getSession: jest.fn() });
    (getRedisClient as AnyMock).mockReturnValue({ getConnection: jest.fn() });
    (getEncryptionService as AnyMock).mockReturnValue(mockEncryptionService);
    (testDiscoveryProviderConnection as AnyMock).mockReset();

    controller = new SettingsController();
  });

  describe('updateGeneralSettings', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = mockReq({ user: undefined });
      const res = mockRes();

      await controller.updateGeneralSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockPgQuery).not.toHaveBeenCalled();
    });

    it('persists the payload scoped to the authenticated user and returns saved values', async () => {
      mockPgQuery.mockResolvedValue({
        rows: [{ general_settings: { language: 'en', timezone: 'UTC', dateFormat: 'MM/DD/YYYY', defaultPage: '/dashboard' } }],
      });

      const req = mockReq({
        body: { language: 'en', timezone: 'UTC', dateFormat: 'MM/DD/YYYY', defaultPage: '/dashboard' },
      });
      const res = mockRes();

      await controller.updateGeneralSettings(req, res);

      expect(mockPgQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_settings'),
        ['user-1', JSON.stringify(req.body)]
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { language: 'en', timezone: 'UTC', dateFormat: 'MM/DD/YYYY', defaultPage: '/dashboard' },
        })
      );
    });
  });

  describe('updateNotificationSettings', () => {
    it('persists notification preferences for the authenticated user', async () => {
      mockPgQuery.mockResolvedValue({
        rows: [{ notification_settings: { emailOnJobFailure: true } }],
      });

      const req = mockReq({ body: { emailOnJobFailure: true } });
      const res = mockRes();

      await controller.updateNotificationSettings(req, res);

      expect(mockPgQuery).toHaveBeenCalledWith(
        expect.stringContaining('notification_settings'),
        ['user-1', JSON.stringify({ emailOnJobFailure: true })]
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { emailOnJobFailure: true } })
      );
    });
  });

  describe('getDatabaseStatus', () => {
    it('never includes a password/secret field in the response', async () => {
      const mockSession = { run: jest.fn().mockResolvedValue({ records: [] }), close: jest.fn() };
      (getNeo4jClient as AnyMock).mockReturnValue({ getSession: () => mockSession });
      mockPgQuery.mockResolvedValue({ rows: [{ server_version: '15.4' }] });
      (getRedisClient as AnyMock).mockReturnValue({
        getConnection: () => ({ info: jest.fn().mockResolvedValue('redis_version:7.2.0\r\n') }),
      });

      const res = mockRes();
      await controller.getDatabaseStatus(mockReq(), res);

      expect(res.json).toHaveBeenCalledTimes(1);
      const [payload] = (res.json as AnyMock).mock.calls[0] as [{ databases: unknown[] }];
      const serialized = JSON.stringify(payload);
      expect(serialized.toLowerCase()).not.toMatch(/password/);
      expect(payload.databases).toHaveLength(3);
    });

    it('reports a degraded entry (not a thrown error) when a store is unreachable', async () => {
      const mockSession = { run: jest.fn().mockRejectedValue(new Error('connection refused')), close: jest.fn() };
      (getNeo4jClient as AnyMock).mockReturnValue({ getSession: () => mockSession });
      mockPgQuery.mockResolvedValue({ rows: [{ server_version: '15.4' }] });
      (getRedisClient as AnyMock).mockReturnValue({
        getConnection: () => ({ info: jest.fn().mockResolvedValue('redis_version:7.2.0\r\n') }),
      });

      const res = mockRes();
      await controller.getDatabaseStatus(mockReq(), res);

      const [payload] = (res.json as AnyMock).mock.calls[0] as [
        { databases: Array<{ type: string; status: string }> }
      ];
      const neo4j = payload.databases.find((d) => d.type === 'neo4j');
      expect(neo4j?.status).toBe('error');
    });
  });

  describe('updateDiscoveryProviderSettings', () => {
    it('rejects an unsupported provider with 400', async () => {
      const req = mockReq({ params: { provider: 'not-a-provider' }, body: { credentials: {} } });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPgQuery).not.toHaveBeenCalled();
    });

    it('rejects a missing credentials object with 400', async () => {
      const req = mockReq({ params: { provider: 'aws' }, body: {} });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    const updateCall = () =>
      mockPgQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE discovery_provider_settings')) as
        | [string, unknown[]]
        | undefined;

    // Routes each statement of the merge transaction; `stored` is the blob already in the row.
    function mockMergeTransaction(stored: string | null, row: Record<string, unknown> = {}): void {
      mockPgQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT encrypted_credentials')) return { rows: [{ encrypted_credentials: stored }] };
        if (sql.includes('UPDATE discovery_provider_settings')) {
          return { rows: [{ config: {}, has_credentials: true, updated_at: new Date(), ...row }] };
        }
        return { rows: [] };
      });
    }

    it('encrypts secret fields and stores non-secret fields as plain config', async () => {
      mockMergeTransaction(null, { config: { region: 'us-west-2' } });

      const req = mockReq({
        params: { provider: 'aws' },
        body: { credentials: { accessKeyId: 'AKIA123', secretAccessKey: 'shh', region: 'us-west-2' } },
      });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(mockEncryptionService.encryptCredential).toHaveBeenCalledWith({
        accessKeyId: 'AKIA123',
        secretAccessKey: 'shh',
      });

      const [, params] = updateCall()!;
      expect(params[2]).toBe(JSON.stringify({ region: 'us-west-2' }));
      expect(params[3]).toBe('encrypted-blob');
      expect(JSON.stringify(mockPgQuery.mock.calls)).not.toContain('shh');

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: expect.objectContaining({ hasCredentials: true }) })
      );
    });

    it('leaves prior secrets untouched when no secret fields are sent (blank = unchanged)', async () => {
      mockPgQuery.mockResolvedValue({
        rows: [{ config: { region: 'us-west-2' }, has_credentials: true, updated_at: new Date() }],
      });

      const req = mockReq({
        params: { provider: 'aws' },
        body: { credentials: { region: 'us-west-2' } },
      });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(mockEncryptionService.encryptCredential).not.toHaveBeenCalled();
      const [, params] = mockPgQuery.mock.calls[0] as [string, unknown[]];
      expect(params[3]).toBeNull();
    });

    it.each([
      ['ssh', { username: 'u', host: 'h' }, 'host'],
      ['aws', { region: 'us-east-1', secretAcessKey: 'typo-secret-value' }, 'secretAcessKey'],
      ['azure', { clientsecret: 'typo-secret-value' }, 'clientsecret'],
      ['gcp', { private_key: 'typo-secret-value' }, 'private_key'],
    ])('refuses an unknown %s credential field before storing anything', async (provider, credentials, name) => {
      const req = mockReq({ params: { provider }, body: { credentials } });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Bad Request',
        message: `Unsupported credential field '${name}' for provider '${provider}'`,
      });
      expect(mockPgQuery).not.toHaveBeenCalled();
      expect(mockPgClient.transaction).not.toHaveBeenCalled();
      expect(mockEncryptionService.encryptCredential).not.toHaveBeenCalled();
      const observable = JSON.stringify([
        (res.json as AnyMock).mock.calls,
        (logger.error as AnyMock).mock.calls,
        (logger.warn as AnyMock).mock.calls,
        (logger.info as AnyMock).mock.calls,
      ]);
      expect(observable).not.toContain('typo-secret-value');
    });

    it('names only a short identifier in the refusal; any other key name is not echoed', async () => {
      const hostile = "x'; DROP TABLE y;--<script>secret-in-name";
      const req = mockReq({ params: { provider: 'aws' }, body: { credentials: { [hostile]: 'v' } } });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Bad Request',
        message: 'Unsupported credential field',
      });
      expect(mockPgQuery).not.toHaveBeenCalled();
    });

    it('refuses __proto__ as an unsupported field instead of storing it', async () => {
      const credentials = JSON.parse('{"__proto__": {"region": "evil"}}');
      const req = mockReq({ params: { provider: 'aws' }, body: { credentials } });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPgQuery).not.toHaveBeenCalled();
    });

    it.each([
      ['aws', 'sessionToken', 'tok-secret-value'],
      ['ssh', 'password', 'pw-secret-value'],
      ['ssh', 'passphrase', 'pp-secret-value'],
    ])('encrypts %s %s and never stores or echoes it as config', async (provider, field, value) => {
      mockMergeTransaction(null, { config: {} });
      const req = mockReq({ params: { provider }, body: { credentials: { [field]: value } } });
      const res = mockRes();

      await controller.updateDiscoveryProviderSettings(req, res);

      expect(mockEncryptionService.encryptCredential).toHaveBeenCalledWith({ [field]: value });
      const [, params] = updateCall()!;
      expect(params[2]).toBe('{}');
      expect(params[3]).toBe('encrypted-blob');
      expect(JSON.stringify(mockPgQuery.mock.calls)).not.toContain(value);
      expect(JSON.stringify((res.json as AnyMock).mock.calls)).not.toContain(value);
    });

    it('keeps the saved secretAccessKey when an aws update sends only accessKeyId', async () => {
      mockEncryptionService.decryptCredential.mockReturnValue({ accessKeyId: 'OLD', secretAccessKey: 'saved-secret' });
      mockMergeTransaction('stored-blob');

      const req = mockReq({ params: { provider: 'aws' }, body: { credentials: { accessKeyId: 'NEW' } } });
      await controller.updateDiscoveryProviderSettings(req, mockRes());

      expect(mockEncryptionService.decryptCredential).toHaveBeenCalledWith('stored-blob');
      expect(mockEncryptionService.encryptCredential).toHaveBeenCalledWith({
        accessKeyId: 'NEW',
        secretAccessKey: 'saved-secret',
      });
    });

    it('keeps stored secrets whose keys are sent blank, null or missing', async () => {
      mockEncryptionService.decryptCredential.mockReturnValue({ accessKeyId: 'OLD', secretAccessKey: 'saved-secret' });
      mockMergeTransaction('stored-blob');

      const req = mockReq({
        params: { provider: 'aws' },
        body: { credentials: { accessKeyId: 'NEW', secretAccessKey: '', sessionToken: null } },
      });
      await controller.updateDiscoveryProviderSettings(req, mockRes());

      expect(mockEncryptionService.encryptCredential).toHaveBeenCalledWith({
        accessKeyId: 'NEW',
        secretAccessKey: 'saved-secret',
      });
    });

    it('answers 500 and writes nothing when the stored blob cannot be decrypted', async () => {
      mockEncryptionService.decryptCredential.mockImplementation(() => {
        throw new Error('Failed to decrypt credential: bad tag');
      });
      mockMergeTransaction('corrupt-blob');

      const req = mockReq({ params: { provider: 'aws' }, body: { credentials: { accessKeyId: 'NEW' } } });
      const res = mockRes();
      await controller.updateDiscoveryProviderSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Internal error' }));
      expect(mockEncryptionService.encryptCredential).not.toHaveBeenCalled();
      expect(updateCall()).toBeUndefined();
    });

    it('answers 500 and writes nothing when the stored blob decrypts to a non-object', async () => {
      mockEncryptionService.decryptCredential.mockReturnValue('just-a-string');
      mockMergeTransaction('odd-blob');

      const req = mockReq({ params: { provider: 'aws' }, body: { credentials: { accessKeyId: 'NEW' } } });
      const res = mockRes();
      await controller.updateDiscoveryProviderSettings(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockEncryptionService.encryptCredential).not.toHaveBeenCalled();
      expect(updateCall()).toBeUndefined();
    });

    it('serializes the read-modify-write: the row is locked FOR UPDATE inside one transaction', async () => {
      mockMergeTransaction(null);

      const req = mockReq({ params: { provider: 'aws' }, body: { credentials: { accessKeyId: 'A' } } });
      await controller.updateDiscoveryProviderSettings(req, mockRes());

      const sqls = mockPgQuery.mock.calls.map(([sql]) => String(sql));
      const lockIdx = sqls.findIndex((s) => s.includes('FOR UPDATE'));
      const updateIdx = sqls.findIndex((s) => s.includes('UPDATE discovery_provider_settings'));
      expect(mockPgClient.transaction).toHaveBeenCalledTimes(1);
      expect(lockIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeGreaterThan(lockIdx);
    });

    it('keeps both secrets when two saves for the same user and provider run concurrently', async () => {
      // In-memory row with a row lock held from FOR UPDATE until the transaction ends,
      // and a yield after every read so an unlocked implementation interleaves.
      let blob: string | null = null;
      let held: Promise<void> | null = null;
      mockEncryptionService.encryptCredential.mockImplementation((o: unknown) => JSON.stringify(o));
      mockEncryptionService.decryptCredential.mockImplementation((s: string) => JSON.parse(s));
      mockPgClient.transaction.mockImplementation(async (cb: (c: { query: AnyMock }) => Promise<unknown>) => {
        let release!: () => void;
        const done = new Promise<void>((r) => (release = r));
        const client = {
          query: jest.fn(async (sql: string, params: unknown[]) => {
            if (sql.includes('SELECT encrypted_credentials')) {
              if (sql.includes('FOR UPDATE')) {
                while (held) await held;
                held = done;
              }
              const seen = blob;
              await new Promise((r) => setImmediate(r));
              return { rows: [{ encrypted_credentials: seen }] };
            }
            if (sql.includes('UPDATE discovery_provider_settings')) {
              blob = params[3] as string;
              return { rows: [{ config: {}, has_credentials: true, updated_at: new Date() }] };
            }
            return { rows: [] };
          }),
        };
        try {
          return await cb(client);
        } finally {
          held = null;
          release();
        }
      });

      const save = (credentials: Record<string, string>) =>
        controller.updateDiscoveryProviderSettings(
          mockReq({ params: { provider: 'aws' }, body: { credentials } }),
          mockRes()
        );
      await Promise.all([save({ accessKeyId: 'AK' }), save({ secretAccessKey: 'SK' })]);

      expect(JSON.parse(blob!)).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' });
    });
  });

  describe('testDiscoveryConnection', () => {
    it('returns 401 when unauthenticated', async () => {
      const req = mockReq({ user: undefined, body: { provider: 'aws', credentials: {} } });
      const res = mockRes();

      await controller.testDiscoveryConnection(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(testDiscoveryProviderConnection).not.toHaveBeenCalled();
    });

    it('returns 400 for an unsupported provider without attempting a test', async () => {
      const req = mockReq({ body: { provider: 'oracle', credentials: {} } });
      const res = mockRes();

      await controller.testDiscoveryConnection(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(testDiscoveryProviderConnection).not.toHaveBeenCalled();
    });

    it('returns 400 when credentials object is missing', async () => {
      const req = mockReq({ body: { provider: 'aws' } });
      const res = mockRes();

      await controller.testDiscoveryConnection(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(testDiscoveryProviderConnection).not.toHaveBeenCalled();
    });

    it('returns 200 with the real test result on success', async () => {
      (testDiscoveryProviderConnection as AnyMock).mockResolvedValue({
        success: true,
        message: 'AWS credentials verified',
      });

      const req = mockReq({ body: { provider: 'aws', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } } });
      const res = mockRes();

      await controller.testDiscoveryConnection(req, res);

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('returns 400 with the real failure message when the provider test fails', async () => {
      (testDiscoveryProviderConnection as AnyMock).mockResolvedValue({
        success: false,
        message: 'Invalid credentials',
      });

      const req = mockReq({ body: { provider: 'aws', credentials: { accessKeyId: 'x', secretAccessKey: 'y' } } });
      const res = mockRes();

      await controller.testDiscoveryConnection(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: 'Invalid credentials' }));
    });
  });
});
