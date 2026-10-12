// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';
import type { ConfigSchema } from '@cmdb/common';
import type { AuthService } from '../../auth/auth.service';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import { admitGraphQLRequest } from '../../middleware/analysis-admission';

const ORG = '33333333-3333-4333-8333-333333333333';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('does not reserve slots after an authenticated client disconnects during verification', async () => {
  const verifying = deferred();
  const verifyRelease = deferred();
  const disconnected = deferred();
  const app = express();
  app.use((_req, res, next) => { res.once('close', disconnected.resolve); next(); });
  const verifier = { verifyToken: async (token: string) => {
    if (token === 'auth-delayed') {
      verifying.resolve();
      await verifyRelease.promise;
    }
    return { _userId: token, _organizationId: ORG, _username: token, _role: 'viewer', _type: 'access' };
  } } as AuthService;
  const auth = new AuthMiddleware(verifier, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']);
  app.use('/graphql', express.json(), auth.authenticate(), admitGraphQLRequest,
    (_req, res) => { res.json({ data: { __typename: 'Query' } }); });

  const abandoned = request(app).post('/graphql').set('authorization', 'Bearer auth-delayed')
    .send({ query: '{ __typename }' });
  abandoned.end(() => {});
  try {
    await verifying.promise;
    abandoned.abort();
    await disconnected.promise;
  } finally {
    verifyRelease.resolve();
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  const next = await request(app).post('/graphql').set('authorization', 'Bearer auth-delayed')
    .send({ query: '{ __typename }' });
  expect(next.status).toBe(200);
  expect(next.body).toEqual({ data: { __typename: 'Query' } });
});

it('frees principal and tenant slots on client abort before Apollo operation starts', async () => {
  const app = express();
  const closed: Array<Promise<void>> = [];
  const entered: Array<() => void> = [];
  app.use((req, res, next) => {
    if (req.headers['x-hold-operation']) {
      closed.push(new Promise<void>(resolve => { res.once('close', resolve); }));
    }
    next();
  });
  const verifier = { verifyToken: async (token: string) => ({
    _userId: token, _organizationId: '44444444-4444-4444-8444-444444444444',
    _username: token, _role: 'viewer', _type: 'access',
  }) } as AuthService;
  const auth = new AuthMiddleware(verifier, { apiKeys: { headerName: 'X-API-Key' } } as ConfigSchema['auth']);
  app.use('/graphql', express.json(), auth.authenticate(), admitGraphQLRequest,
    (req, res) => {
      if (req.headers['x-hold-operation']) { entered.shift()?.(); return; }
      res.json({ data: { __typename: 'Query' } });
    });

  for (const principal of ['a-abandoned', 'b-abandoned']) {
    const admitted = deferred();
    entered.push(admitted.resolve);
    const abandoned = request(app).get('/graphql').set('authorization', `Bearer ${principal}`)
      .set('accept', 'text/html').set('x-hold-operation', 'true');
    abandoned.end(() => {});
    await admitted.promise;
    abandoned.abort();
    await closed[closed.length - 1];
  }
  const next = await request(app).get('/graphql').set('authorization', 'Bearer c-owner');
  expect(next.status).toBe(200);
  expect(next.body).toEqual({ data: { __typename: 'Query' } });
});
