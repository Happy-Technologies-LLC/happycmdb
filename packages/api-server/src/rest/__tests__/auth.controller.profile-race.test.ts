// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1767: PUT /profile when the :User node vanishes between the service's
 * read and the repository's write. Runs the real AuthController, AuthService
 * and Neo4jAuthRepository over a scripted Neo4j session: the read finds the
 * node, the write statement matches 0 nodes (or the driver fails).
 * Also the read-miss case: the service's own read finds no user after
 * authentication did (profile, and HAP-1825: password change and account
 * deletion), every 404 mapped by `instanceof UserNotFoundError`.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
  auditChainReady: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import { randomUUID } from 'crypto';
import { logger } from '@cmdb/common';
import { auditChainReady, getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { AuthController } from '../auth.controller';
import { AuthService } from '../../auth/auth.service';
import { Neo4jAuthRepository, FIND_USER_BY_ID_CYPHER } from '../../auth/neo4j-auth.repository';
import { ValidationMiddleware } from '../middleware/validation.middleware';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { JWTService } from '../../auth/jwt.service';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const authConfig = {
  jwt: {
    secret: 'test-secret-at-least-32-characters-long',
    accessTokenExpiresIn: '15m',
    refreshTokenExpiresIn: '7d',
    issuer: 'happycmdb-test',
    audience: 'happycmdb-test',
  },
  bcrypt: { rounds: 4 },
  apiKeys: { enabled: true, headerName: 'X-API-Key' },
};

const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
const rateLimiter = {
  limit: pass, custom: pass, endpointBudget: () => ({ _max: 1, _windowMs: 1 }),
} as unknown as RateLimitMiddleware;

type LogSpies = { calls: () => unknown[][]; errorCalls: () => unknown[][]; restore: () => void };

/**
 * Plain structure of a logged value with Errors fully opened: own properties (driver `detail`, `cause`,
 * AggregateError `errors`) as well as name/message/stack, recursively and cycle-safe. JSON.stringify alone
 * drops all of them for an Error, so a wrapped driver error would escape a `not.toContain(marker)` check.
 */
function opened(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => opened(item, seen));
  const out: Record<string, unknown> = {};
  if (value instanceof Error) out.name = value.name;
  for (const key of value instanceof Error ? Object.getOwnPropertyNames(value) : Object.keys(value)) {
    out[key] = opened((value as Record<string, unknown>)[key], seen);
  }
  return out;
}

/** Silences and records every logger level and every console method a log line could leave through. */
function spyOnLogs(): LogSpies {
  const loggerSpies = (['error', 'warn', 'info', 'debug'] as const).map(level =>
    jest.spyOn(logger, level).mockImplementation(() => logger));
  const consoleSpies = (['log', 'error', 'warn', 'info', 'debug'] as const).map(method =>
    jest.spyOn(console, method).mockImplementation(() => undefined));
  const all = [...loggerSpies, ...consoleSpies];
  return {
    calls: () => all.flatMap(spy => spy.mock.calls as unknown[][]),
    errorCalls: () => loggerSpies[0].mock.calls as unknown[][],
    restore: () => all.forEach(spy => spy.mockRestore()),
  };
}

let app: express.Express;
let session: { run: AnyMock; close: AnyMock };
let token: string;
let authService: AuthService;
/** What the update statement does: matches 0 nodes, or the driver fails. */
let onUpdate: () => Promise<unknown>;
/** How many FIND_USER_BY_ID reads find the node before it is gone (authentication takes the first). */
let readsThatFind: number;

beforeEach(() => {
  readsThatFind = Number.POSITIVE_INFINITY;
  const alice = {
    elementId: '4:alice',
    properties: {
      _id: 'user-1', _username: 'alice', _email: 'alice@example.com', _passwordHash: 'hash', _role: 'operator',
      _enabled: true, _createdAt: new Date('2024-01-01'), _updatedAt: new Date('2024-01-01'),
    },
  };
  session = {
    // By default the read (and authentication's read) always finds the node; any other statement is the update.
    run: jest.fn(async (cypher: string) => {
      if (cypher !== FIND_USER_BY_ID_CYPHER) return onUpdate();
      const found = readsThatFind-- > 0;
      return { records: found ? [{ get: () => alice }] : [] };
    }),
    close: jest.fn(async () => undefined),
  };
  (getNeo4jClient as AnyMock).mockReturnValue({ getSession: () => session });
  (getPostgresClient as AnyMock).mockReturnValue({ getClient: jest.fn(), query: jest.fn() });
  (auditChainReady as AnyMock).mockReturnValue(true);

  authService = new AuthService(authConfig as any, new Neo4jAuthRepository());
  const controller = new AuthController(
    authService, new ValidationMiddleware(), new AuthMiddleware(authService, authConfig as any), rateLimiter
  );
  app = express();
  app.use(express.json());
  app.use('/api/v1/auth', controller.getRouter());
  token = new JWTService(authConfig.jwt as any).generateAccessToken('user-1', 'alice', 'operator');
});

describe('PUT /profile when the user node vanishes mid-update (HAP-1767)', () => {
  const put = () =>
    request(app).put('/api/v1/auth/profile').set('Authorization', `Bearer ${token}`).send({ name: 'Alice Updated' });

  it('answers 404 with the not-found body when the update matches 0 nodes', async () => {
    onUpdate = async () => ({ records: [{ get: (k: string) => (k === 'matched' ? neo4j.int(0) : null) }] });

    const res = await put();

    expect([res.status, res.body]).toEqual([
      404, { success: false, error: 'Profile Update Failed', message: 'User not found' },
    ]);
    // The write really ran after a successful read (not the service's own read-miss path).
    expect(session.run.mock.calls.some(([cypher]) => String(cypher).includes('SET'))).toBe(true);
  });

  it('answers 404 with the not-found body when the service read finds no user after authentication', async () => {
    readsThatFind = 1; // authentication finds the user; the service's own read then misses
    onUpdate = async () => { throw new Error('the update must not run after a read-miss'); };

    const res = await put();

    expect([res.status, res.body]).toEqual([
      404, { success: false, error: 'Profile Update Failed', message: 'User not found' },
    ]);
    const calls = session.run.mock.calls.map(([cypher]) => cypher);
    expect(calls).toEqual([FIND_USER_BY_ID_CYPHER, FIND_USER_BY_ID_CYPHER]);
  });

  it('keeps a genuine driver failure a fixed 500 that never echoes the driver text', async () => {
    const needle = `needle-${randomUUID()}`;
    onUpdate = async () => { throw new Error(`bolt://svc:${needle}@neo4j.internal:7687 connection reset`); };
    const logs = spyOnLogs();
    try {
      const res = await put();

      expect([res.status, res.body]).toEqual([
        500, { success: false, error: 'Profile Update Failed', message: 'Internal error' },
      ]);
      expect(JSON.stringify([res.body, res.headers])).not.toContain(needle);
      // Non-vacuity: the profile-error log itself fired, so a deleted log cannot pass the absence checks below.
      expect(logs.errorCalls()).toEqual([
        ['Error updating profile', expect.objectContaining({ errorClass: 'Error', userId: 'user-1' })],
      ]);
      expect(JSON.stringify(opened(logs.calls()))).not.toContain(needle);
    } finally {
      logs.restore();
    }
  });

  const driverError = (marker: string) =>
    Object.assign(new Error('Neo.TransientError: write failed'), {
      code: 'Neo.TransientError.General.DatabaseUnavailable', detail: `row=${marker}`,
    });
  it.each([
    ['an Error cause', (marker: string) => new Error('wrapped', { cause: driverError(marker) })],
    ['a nested cause chain', (marker: string) =>
      new Error('outer', { cause: new Error('middle', { cause: driverError(marker) }) })],
    ['an AggregateError member', (marker: string) => new AggregateError([driverError(marker)], 'all attempts failed')],
    ['an AggregateError member with a cause', (marker: string) =>
      new AggregateError([new Error('member', { cause: driverError(marker) })], 'all attempts failed')],
  ])('keeps a driver error wrapped as %s out of the response and every log sink', async (_name, wrap) => {
    const marker = `marker-${randomUUID()}`;
    // The repository rewraps driver errors as a bare message, so the wrapped error is injected at the service seam,
    // where it reaches the controller's catch with its cause chain intact.
    const service = jest.spyOn(authService, 'updateProfile').mockRejectedValue(wrap(marker));
    const logs = spyOnLogs();
    try {
      const res = await put();

      expect([res.status, res.body]).toEqual([
        500, { success: false, error: 'Profile Update Failed', message: 'Internal error' },
      ]);
      expect(logs.errorCalls().map(([message]) => message)).toEqual(['Error updating profile']);
      expect(JSON.stringify(opened([res.body, res.headers, logs.calls()]))).not.toContain(marker);
    } finally {
      logs.restore();
      service.mockRestore();
    }
  });

  describe('the redaction check itself', () => {
    // The replacer the check used before HAP-1825: it flattens an Error to name/message/stack only.
    const legacy = (_k: string, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);
    it.each([
      ['an own property of an Error', () => driverError('mk-7')],
      ['Error.cause', () => new Error('w', { cause: driverError('mk-7') })],
      ['AggregateError.errors', () => new AggregateError([driverError('mk-7')], 'a')],
    ])('sees a marker in %s, which the old replacer dropped', (_name, build) => {
      const logged = [['msg', { error: build() }]];
      expect(JSON.stringify(logged, legacy)).not.toContain('mk-7');
      expect(JSON.stringify(opened(logged))).toContain('mk-7');
    });

    it('terminates on a cyclic cause', () => {
      const a = new Error('a');
      const b = new Error('b', { cause: a });
      (a as Error & { cause?: unknown }).cause = b;
      expect(JSON.stringify(opened(a))).toContain('[Circular]');
    });
  });
});

describe('PUT /password and DELETE /account when the user is gone (HAP-1825)', () => {
  const NOT_FOUND_PASSWORD = { success: false, error: 'Password Change Failed', message: 'User not found' };
  const NOT_FOUND_DELETE = { success: false, error: 'Account Deletion Failed', message: 'User not found' };
  const changePassword = () =>
    request(app).put('/api/v1/auth/password').set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'old-password-1', newPassword: 'a-brand-new-passphrase' });
  const deleteAccount = () =>
    request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${token}`);

  beforeEach(() => {
    readsThatFind = 1; // authentication finds the user; the service's own read then misses
    onUpdate = async () => { throw new Error('no write may run after a read-miss'); };
  });

  // The password change now attempts its (cmdb#321) user_not_found audit; this token has no organization claim, so
  // that is the one fixed-text error. Neither route logs an internal error.
  it.each([
    ['PUT /password', changePassword, NOT_FOUND_PASSWORD, [['Password change not audited: the actor has no organization claim']]],
    ['DELETE /account', deleteAccount, NOT_FOUND_DELETE, []],
  ])('%s answers 404 with the not-found body, writes nothing and logs no internal error', async (_name, call, body, errors) => {
    const logs = spyOnLogs();
    try {
      const res = await call();

      expect([res.status, res.body]).toEqual([404, body]);
      expect(session.run.mock.calls.map(([cypher]) => cypher)).toEqual([FIND_USER_BY_ID_CYPHER, FIND_USER_BY_ID_CYPHER]);
      expect(logs.errorCalls()).toEqual(errors);
    } finally {
      logs.restore();
    }
  });

  // The mapping is by type: the historical message on a plain Error is an internal failure, not a 404.
  it.each([
    ['PUT /password', 'changePassword', changePassword,
      { success: false, error: 'Password Change Failed', message: 'Internal error' }, 'Error changing password'],
    ['DELETE /account', 'deleteAccount', deleteAccount,
      { success: false, error: 'Account Deletion Failed', message: 'Internal error' }, 'Error deleting account'],
  ] as const)('%s answers a fixed 500 for a plain Error carrying the not-found text', async (_name, method, call, body, logMessage) => {
    const service = jest.spyOn(authService, method).mockRejectedValue(new Error('User not found'));
    const logs = spyOnLogs();
    try {
      const res = await call();

      expect([res.status, res.body]).toEqual([500, body]);
      expect(logs.errorCalls()).toEqual([[logMessage, expect.objectContaining({ errorClass: 'Error', userId: 'user-1' })]]);
    } finally {
      logs.restore();
      service.mockRestore();
    }
  });
});
