// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
/** Affinity and match-context inputs are length and count bounded at the credential create, update and select routes. */
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';

const rnd = () => randomBytes(16).toString('hex');
Object.assign(process.env, { JWT_SECRET: rnd() + rnd(), CREDENTIAL_ENCRYPTION_KEY: rnd() + rnd(), NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: rnd(), NEO4J_PASSWORD: rnd(),
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: rnd(), POSTGRES_USER: rnd(), POSTGRES_PASSWORD: rnd(), REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: rnd(), KAFKA_GROUP_ID: rnd() });

const credentialService = { create: jest.fn(), update: jest.fn(), findBestMatch: jest.fn(), rankCredentials: jest.fn() };
const setService = { selectCredentials: jest.fn() };
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: {} }), getUnifiedCredentialService: () => credentialService, getCredentialSetService: () => setService,
  getAuditService: () => ({}), getOAuthSubstrate: () => ({}), SERVICENOW_PROVIDER_ID: 'servicenow',
}));
jest.mock('bcrypt', () => ({}));
jest.mock('../../../auth/neo4j-auth.repository', () => ({ Neo4jAuthRepository: jest.fn(() => ({ findUserById: async (id: string) => (id === 'a' ? { _id: 'a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: A } : null) })) }));
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { unifiedCredentialRoutes } from '../unified-credential.routes';

const A = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate(), unifiedCredentialRoutes);
const auth = { Authorization: `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken('a', 'alice', 'operator', A, 0, Math.floor(Date.now() / 1000))}` };

const base = { name: 'n', protocol: 'ssh_password', scope: 'ssh', credentials: { username: 'svc', password: rnd() } };
const calls = {
  create: (affinity: object) => ({ send: () => request(app).post('/api/v1/credentials').set(auth).send({ ...base, affinity }), spy: credentialService.create }),
  update: (affinity: object) => ({ send: () => request(app).put(`/api/v1/credentials/${ID}`).set(auth).send({ affinity }), spy: credentialService.update }),
  select: (context: object) => ({ send: () => request(app).post(`/api/v1/credential-sets/${ID}/select`).set(auth).send({ context }), spy: setService.selectCredentials }),
  match: (context: object) => ({ send: () => request(app).post('/api/v1/credentials/match').set(auth).send(context), spy: credentialService.findBestMatch }),
  rank: (context: object) => ({ send: () => request(app).post('/api/v1/credentials/rank').set(auth).send(context), spy: credentialService.rankCredentials }),
};
const affinityRoutes = ['create', 'update'] as const;
const patterns = (n: number, len = 10) => Array.from({ length: n }, () => 'a'.repeat(len));

// The unit config resets mocks between tests, so the resolved values are set here.
beforeEach(() => {
  jest.clearAllMocks();
  credentialService.create.mockResolvedValue({ id: ID });
  credentialService.update.mockResolvedValue({ id: ID });
  credentialService.findBestMatch.mockResolvedValue(null);
  credentialService.rankCredentials.mockResolvedValue([]);
  setService.selectCredentials.mockResolvedValue([]);
});

describe.each(affinityRoutes)('%s credential affinity bounds', (route) => {
  it.each([
    ['a 254 character hostname pattern', { hostname_patterns: ['a'.repeat(254)] }],
    ['51 hostname patterns', { hostname_patterns: patterns(51) }],
    ['a 65 character network', { networks: ['1'.repeat(65)] }],
    ['51 networks', { networks: patterns(51) }],
  ])('refuses %s with 400 before the service is reached', async (_label, affinity) => {
    const { send, spy } = calls[route](affinity);
    expect((await send()).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts a 253 character pattern, 50 patterns, a 64 character network and 50 networks', async () => {
    const { send, spy } = calls[route]({ hostname_patterns: [...patterns(49), 'a'.repeat(253)], networks: [...patterns(49), '1'.repeat(64)] });
    expect((await send()).status).not.toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe.each(['select', 'match'] as const)('%s match-context hostname bound', (route) => {
  it('refuses a 254 character hostname with 400 before the service is reached', async () => {
    const { send, spy } = calls[route]({ hostname: 'a'.repeat(254) });
    expect((await send()).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts a 253 character hostname', async () => {
    const { send, spy } = calls[route]({ hostname: 'a'.repeat(253) });
    expect((await send()).status).not.toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe.each(['select', 'match', 'rank'] as const)('%s match-context ip bound', (route) => {
  it.each([
    ['a 10 KB ip', 'a'.repeat(10 * 1024)],
    ['a 10 KB dotted run', '1.'.repeat(5 * 1024)],
    ['a 16 character ip', '1'.repeat(16)],
    ['an ip with a prefix length', '10.0.0.1/8'],
    ['an IPv6 address', '::1'],
    ['a non-address', 'not-an-ip'],
  ])('refuses %s with 400 before the service is reached', async (_label, ip) => {
    const { send, spy } = calls[route]({ ip });
    expect((await send()).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts the longest IPv4 address', async () => {
    const { send, spy } = calls[route]({ ip: '255.255.255.255' });
    expect((await send()).status).not.toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
