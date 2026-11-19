// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1930 (BW16): every role-contract refusal is one 403 body (both historical key families plus `code`,
 * `required` and the caller's own `role`), per server role, through the real AuthMiddleware guards.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { AuthMiddleware } from '../auth.middleware';
import { requireConnectorScope } from '../../auth/connector-scope';
import type { AuthService } from '../../auth/auth.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const authConfig = {
  jwt: { secret: 'test-secret-at-least-32-characters-long', accessTokenExpiresIn: '15m', refreshTokenExpiresIn: '7d' },
  bcrypt: { rounds: 4 },
  apiKeys: { enabled: true, headerName: 'X-API-Key' },
};

const ROLES = ['admin', 'operator', 'viewer', 'agent'] as const;
// Written out here, not read from ROLE_PERMISSIONS: the test pins the contract the UI relies on.
const DENIED: Record<(typeof ROLES)[number], string[]> = {
  admin: [],
  operator: ['admin'],
  viewer: ['write', 'discover', 'admin'],
  agent: ['read', 'admin'],
};

function buildApp(stored: Record<string, unknown> = {}) {
  const service = { findEnabledUser: async () => ({ _id: 'u1', _username: 'bob', _role: 'viewer', ...stored }) } as unknown as AuthService;
  const guards = new AuthMiddleware(service, authConfig as never);
  const app = express();
  // Stand-in for authenticate(): identity comes from headers; the guards under test are the real ones.
  app.use((req, _res, next) => {
    const role = req.header('x-role');
    if (role) {
      Object.assign(req, {
        credentialType: req.header('x-cred') ?? 'jwt',
        user: { _userId: 'u1', _username: 'bob', _role: role, _type: 'access', _organizationId: req.header('x-org') },
      });
    }
    next();
  });
  for (const permission of ['read', 'write', 'discover', 'admin'] as const) {
    app.get(`/perm/${permission}`, guards.requirePermission(permission), (_req, res) => res.json({ ok: true }));
  }
  app.get('/role/admin', guards.requireRole('admin'), (_req, res) => res.json({ ok: true }));
  app.get('/role/either', guards.requireRole('admin', 'operator'), (_req, res) => res.json({ ok: true }));
  app.get('/org', guards.requireOrganization(), (_req, res) => res.json({ ok: true }));
  app.get('/connector-org', requireConnectorScope, (_req, res) => res.json({ ok: true }));
  app.get('/session', guards.requireJwtSession(), (_req, res) => res.json({ ok: true }));
  app.get('/platform', guards.requirePlatformAdmin(), (_req, res) => res.json({ ok: true }));
  app.get('/scope', guards.requireScope('portfolio:import'), (_req, res) => res.json({ ok: true }));
  return app;
}

const forbidden = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  success: false, error: 'Forbidden', message, _error: 'Forbidden', _message: message, code, ...extra,
});

describe('HAP-1930 role-contract 403 shape', () => {
  describe.each(ROLES)('role %s', (role) => {
    const app = buildApp();

    it.each(['read', 'write', 'discover', 'admin'])('permission %s: pass or the full 403 body', async (permission) => {
      const res = await request(app).get(`/perm/${permission}`).set('x-role', role);
      if (DENIED[role].includes(permission)) {
        expect([res.status, res.body]).toEqual([403, forbidden('PERMISSION_REQUIRED', `Permission '${permission}' required`, {
          required: { permission }, role,
        })]);
      } else {
        expect([res.status, res.body]).toEqual([200, { ok: true }]);
      }
    });

    it('role gate names the required roles and the caller role', async () => {
      const admin = await request(app).get('/role/admin').set('x-role', role);
      expect([admin.status, admin.body]).toEqual(role === 'admin'
        ? [200, { ok: true }]
        : [403, forbidden('ROLE_REQUIRED', "Role 'admin' required", { required: { roles: ['admin'] }, role })]);
      const either = await request(app).get('/role/either').set('x-role', role);
      expect([either.status, either.body]).toEqual(role === 'admin' || role === 'operator'
        ? [200, { ok: true }]
        : [403, forbidden('ROLE_REQUIRED', "Role 'admin or operator' required", { required: { roles: ['admin', 'operator'] }, role })]);
    });
  });

  it('no identity is 401, never the 403 body', async () => {
    const res = await request(buildApp()).get('/perm/write');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('code');
  });

  it.each(['/org', '/connector-org'])('%s without a well-formed organization claim: one body, no role leak', async (path) => {
    for (const org of [undefined, 'not-a-uuid']) {
      const req = request(buildApp()).get(path).set('x-role', 'admin');
      const res = await (org ? req.set('x-org', org) : req);
      expect([res.status, res.body]).toEqual([403, forbidden('ORGANIZATION_REQUIRED', 'Organization claim required')]);
    }
    expect((await request(buildApp()).get(path).set('x-role', 'viewer').set('x-org', ORG)).status).toBe(200);
  });

  it('an API key on an account operation: JWT_SESSION_REQUIRED, a login session passes', async () => {
    const app = buildApp();
    const key = await request(app).get('/session').set('x-role', 'admin').set('x-cred', 'api-key');
    expect([key.status, key.body]).toEqual([403, forbidden('JWT_SESSION_REQUIRED', 'JWT user session required')]);
    expect((await request(app).get('/session').set('x-role', 'viewer')).status).toBe(200);
  });

  it('platform administrator: refused whatever the role, with the same body; the stored flag passes', async () => {
    for (const role of ROLES) {
      const res = await request(buildApp()).get('/platform').set('x-role', role);
      expect([res.status, res.body]).toEqual([403, forbidden('PLATFORM_ADMIN_REQUIRED', 'Platform administrator required')]);
    }
    expect((await request(buildApp({ _platformAdmin: true })).get('/platform').set('x-role', 'viewer')).status).toBe(200);
  });

  it('scope: refused whatever the role, naming the scope; the stored scope passes', async () => {
    for (const role of ROLES) {
      const res = await request(buildApp()).get('/scope').set('x-role', role);
      expect([res.status, res.body]).toEqual([403, forbidden('SCOPE_REQUIRED', "Scope 'portfolio:import' required", {
        required: { scope: 'portfolio:import' },
      })]);
    }
    expect((await request(buildApp({ _scopes: ['portfolio:import'] })).get('/scope').set('x-role', 'viewer')).status).toBe(200);
  });
});
