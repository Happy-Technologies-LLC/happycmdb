// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1767: PUT /profile when the :User node vanishes between the service's
 * read and the repository's write. Runs the real AuthController, AuthService
 * and Neo4jAuthRepository over a scripted Neo4j session: the read finds the
 * node, the write statement matches 0 nodes (or the driver fails).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import { randomUUID } from 'crypto';
import { logger } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
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

describe('PUT /profile when the user node vanishes mid-update (HAP-1767)', () => {
  let app: express.Express;
  let session: { run: AnyMock; close: AnyMock };
  let token: string;
  /** What the update statement does: matches 0 nodes, or the driver fails. */
  let onUpdate: () => Promise<unknown>;

  beforeEach(() => {
    const alice = {
      elementId: '4:alice',
      properties: {
        _id: 'user-1', _username: 'alice', _email: 'alice@example.com', _passwordHash: 'hash', _role: 'operator',
        _enabled: true, _createdAt: new Date('2024-01-01'), _updatedAt: new Date('2024-01-01'),
      },
    };
    session = {
      // The read (and authentication's read) always finds the node; any other statement is the update.
      run: jest.fn(async (cypher: string) =>
        cypher === FIND_USER_BY_ID_CYPHER ? { records: [{ get: () => alice }] } : onUpdate()),
      close: jest.fn(async () => undefined),
    };
    (getNeo4jClient as AnyMock).mockReturnValue({ getSession: () => session });
    (getPostgresClient as AnyMock).mockReturnValue({ getClient: jest.fn(), query: jest.fn() });

    const authService = new AuthService(authConfig as any, new Neo4jAuthRepository());
    const controller = new AuthController(
      authService, new ValidationMiddleware(), new AuthMiddleware(authService, authConfig as any), rateLimiter
    );
    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', controller.getRouter());
    token = new JWTService(authConfig.jwt as any).generateAccessToken('user-1', 'alice', 'operator');
  });

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

  it('keeps a genuine driver failure a fixed 500 that never echoes the driver text', async () => {
    const needle = `needle-${randomUUID()}`;
    onUpdate = async () => { throw new Error(`bolt://svc:${needle}@neo4j.internal:7687 connection reset`); };
    const levels = (['error', 'warn', 'info', 'debug'] as const).map(level =>
      jest.spyOn(logger, level).mockImplementation(() => logger));
    try {
      const res = await put();

      expect([res.status, res.body]).toEqual([
        500, { success: false, error: 'Profile Update Failed', message: 'Internal error' },
      ]);
      expect(JSON.stringify([res.body, res.headers])).not.toContain(needle);
    } finally {
      levels.forEach(spy => spy.mockRestore());
    }
  });
});
