// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import express from 'express';
import request from 'supertest';
import { logger } from '@cmdb/common';
import { AuthMiddleware } from '../auth.middleware';
import type { AuthService } from '../../auth/auth.service';
import type { ConfigSchema } from '@cmdb/common';

const internalText = 'Neo4j routing failure at internal-db:7687 synthetic-secret';
const user = { _userId: 'u1', _username: 'owner', _role: 'operator', _type: 'access', _organizationId: '11111111-1111-4111-8111-111111111111' };
const verifyToken = jest.fn(async (token: string) => {
  if (token === 'valid') return user;
  throw new Error(internalText);
});
const verifyApiKey = jest.fn(async (key: string) => {
  if (key === 'valid') return user;
  throw new Error(internalText);
});
const authService = { verifyToken, verifyApiKey } as unknown as AuthService;
const middleware = new AuthMiddleware(authService, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']);
const app = express();
app.get('/protected', middleware.authenticate(), (req, res) => res.json({ organizationId: (req as express.Request & { user: typeof user }).user._organizationId }));

test('mounted JWT and API-key failures have one static 401 body and static diagnostics; valid credentials still pass', async () => {
  verifyToken.mockImplementation(async (token: string) => {
    if (token === 'valid') return user;
    throw new Error(internalText);
  });
  verifyApiKey.mockImplementation(async (key: string) => {
    if (key === 'valid') return user;
    throw new Error(internalText);
  });
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    for (const headers of [{}, { authorization: 'Bearer broken' }, { 'x-api-key': 'broken' }]) {
      const response = await request(app).get('/protected').set(headers);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ _error: 'Unauthorized', _message: 'Authentication failed' });
      expect(JSON.stringify(response.body)).not.toContain(internalText);
    }
    expect(warn.mock.calls).toEqual([['Authentication failed'], ['Authentication failed']]);
    for (const headers of [{ authorization: 'Bearer valid' }, { 'x-api-key': 'valid' }]) {
      const response = await request(app).get('/protected').set(headers);
      expect(response.status).toBe(200);
      expect(response.body.organizationId).toBe(user._organizationId);
    }
  } finally {
    warn.mockRestore();
  }
});
