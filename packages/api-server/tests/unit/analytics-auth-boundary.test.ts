// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express from 'express';
import request from 'supertest';
import { loadConfig } from '@cmdb/common';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const users = {
  own: { _id: 'analytics-own', _username: 'own', _role: 'admin' as const, _enabled: true, _organizationId: A },
  none: { _id: 'analytics-none', _username: 'none', _role: 'admin' as const, _enabled: true },
  invalid: { _id: 'analytics-invalid', _username: 'invalid', _role: 'admin' as const, _enabled: true, _organizationId: 'not-a-uuid' },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
  })),
}));
// The unit suite has no database/JWT environment. Provide only inert local
// auth config; database clients below still throw if a reader is reached.
jest.mock('@cmdb/common', () => ({
  ...jest.requireActual('@cmdb/common'),
  loadConfig: () => ({
    auth: {
      jwt: { secret: 'local-only-analytics-test-secret', accessTokenExpiresIn: '15m',
        refreshTokenExpiresIn: '7d', issuer: 'analytics-test', audience: 'analytics-test' },
      bcrypt: { rounds: 4 },
      apiKeys: { headerName: 'x-api-key' },
    },
  }),
}));
jest.mock('@cmdb/database', () => ({
  getPostgresClient: jest.fn(() => ({ query: jest.fn(() => { throw new Error('no database access expected'); }) })),
  getNeo4jClient: jest.fn(() => ({ getSession: jest.fn(() => { throw new Error('no graph access expected'); }) })),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { analyticsRoutes } from '../../src/rest/routes/analytics.routes';
import { createGraphQLServer } from '../../src/graphql/server';

const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/analytics', analyticsRoutes);
const bearer = (key: keyof typeof users) => {
  const user = users[key];
  return { authorization: `Bearer ${jwt.generateAccessToken(user._id, user._username, user._role, '_organizationId' in user ? user._organizationId : undefined)}` };
};
let server: { stop(): Promise<void> };
beforeAll(async () => { ({ server } = await createGraphQLServer(app)); });
afterAll(async () => { await server?.stop(); });

it('returns 403 before any store access for tenantless REST analytics', async () => {
  for (const path of ['/ci-counts', '/ci-status', '/ci-environments', '/relationship-counts',
    '/discovery-stats', '/discovery-timeline', '/top-connected', '/dependency-depth',
    '/change-history?ci_id=analytics-own', '/relationship-matrix', '/change-timeline',
    '/health-metrics/analytics-own', '/dashboard']) {
    const response = await request(app).get(`/api/v1/analytics${path}`).set(bearer('none'));
    expect(response.status).toBe(403);
  }
  expect((await request(app).get('/api/v1/analytics/dashboard').set(bearer('invalid'))).status).toBe(403);
});

it('refuses unproven health readers for own organization through real HTTP and GraphQL execution', async () => {
  const rest = await request(app).get('/api/v1/analytics/health-metrics/analytics-own').set(bearer('own'));
  expect(rest.status).toBe(403);
  const query = '{ analytics { getCIHealthMetrics(ciId:"analytics-own", startTime:"2026-01-01", endTime:"2026-01-02") { _avgCpu } } }';
  const graphql = await request(app).post('/graphql').set(bearer('own')).send({ query });
  expect(graphql.body.errors?.[0].extensions.code).toBe('FORBIDDEN');
  const missingOrg = await request(app).post('/graphql').set(bearer('none')).send({ query });
  const invalidOrg = await request(app).post('/graphql').set(bearer('invalid')).send({ query });
  expect(invalidOrg.body.errors?.[0].extensions.code).toBe('FORBIDDEN');
  expect(missingOrg.body.errors?.[0].extensions.code).toBe('FORBIDDEN');
});
