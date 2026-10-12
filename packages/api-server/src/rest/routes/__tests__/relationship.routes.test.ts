// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Real route authorization with an in-memory credential verifier, no graph access on denial. */
import express from 'express';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../../auth/auth.service';
import type { AuthMiddleware as AuthMiddlewareClass } from '../../../middleware/auth.middleware';

const ORG = '11111111-1111-4111-8111-111111111111';
const getSession = jest.fn();

jest.mock('../../../auth/auth-bootstrap', () => {
  const { AuthMiddleware } = jest.requireActual<{ AuthMiddleware: typeof AuthMiddlewareClass }>(
    '../../../middleware/auth.middleware'
  );
  const verifier = { verifyToken: async (token: string) => {
    if (token !== 'viewer' && token !== 'operator') throw new Error('Invalid token');
    return { _userId: token, _username: token, _role: token, _organizationId: ORG, _type: 'access' };
  } } as unknown as AuthService;
  return { getAuthMiddleware: () => new AuthMiddleware(verifier, {
    apiKeys: { headerName: 'X-API-Key' },
  } as ConfigSchema['auth']) };
});
jest.mock('@cmdb/database', () => ({ getNeo4jClient: () => ({ getSession }) }));

import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { relationshipRoutes } from '../relationship.routes';

const app = express();
app.use(express.json());
app.use('/relationships', getAuthMiddleware().authenticate(), relationshipRoutes);

beforeEach(() => getSession.mockClear());

it('returns 401 to unauthenticated relationship readers and writers before graph access', async () => {
  for (const response of [
    await request(app).get('/relationships'),
    await request(app).get('/relationships/type/DEPENDS_ON'),
    await request(app).post('/relationships').send({ from_id: 'ci-1', to_id: 'ci-2', type: 'DEPENDS_ON' }),
    await request(app).delete('/relationships?from_id=ci-1&to_id=ci-2&type=DEPENDS_ON'),
  ]) expect(response.status).toBe(401);
  expect(getSession).not.toHaveBeenCalled();
});

it('returns 403 to a read-only viewer on relationship mutations before graph access', async () => {
  for (const response of [
    await request(app).post('/relationships').set('authorization', 'Bearer viewer')
      .send({ from_id: 'ci-1', to_id: 'ci-2', type: 'DEPENDS_ON' }),
    await request(app).delete('/relationships?from_id=ci-1&to_id=ci-2&type=DEPENDS_ON')
      .set('authorization', 'Bearer viewer'),
  ]) expect(response.status).toBe(403);
  expect(getSession).not.toHaveBeenCalled();
});
