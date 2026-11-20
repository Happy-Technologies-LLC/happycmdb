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

describe('GET /relationships/type/:type paging', () => {
  const run = jest.fn();
  const close = jest.fn();
  const total = { records: [{ get: () => ({ toNumber: () => 0 }) }] };
  const get = (query: string, token = 'operator') =>
    request(app).get(`/relationships/type/DEPENDS_ON${query}`).set('authorization', `Bearer ${token}`);

  beforeEach(() => {
    run.mockReset().mockResolvedValueOnce(total).mockResolvedValue({ records: [] });
    close.mockReset().mockResolvedValue(undefined);
    getSession.mockReturnValue({ run, close });
  });

  it.each([
    '?limit=abc', '?limit=', '?limit=0', '?limit=-1', '?limit=1001', '?limit=1.5',
    '?offset=-1', '?offset=-5', '?offset=abc', '?offset=1.5',
  ])('refuses %s with a validation error before graph access', async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(response.body._error).toBe('Validation Error');
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    ['', 100, 0],
    ['?limit=1', 1, 0],
    ['?limit=1000', 1000, 0],
    ['?offset=0', 100, 0],
    ['?offset=5', 100, 5],
    ['?limit=25&offset=50', 25, 50],
  ])('accepts %s and binds limit %i offset %i', async (query, limit, offset) => {
    const response = await get(query);
    expect(response.status).toBe(200);
    expect(response.body.pagination).toMatchObject({ limit, offset });
    const params = run.mock.calls[1]![1];
    expect(params.limit.toNumber()).toBe(limit);
    expect(params.offset.toNumber()).toBe(offset);
  });

  it('keeps the relationship type allow-list', async () => {
    const response = await request(app).get('/relationships/type/NOPE').set('authorization', 'Bearer operator');
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Invalid relationship type/);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('lets a read-only viewer read a valid page', async () => {
    const response = await get('?limit=25&offset=50', 'viewer');
    expect(response.status).toBe(200);
    expect(run.mock.calls[1]![1].limit.toNumber()).toBe(25);
  });
});
