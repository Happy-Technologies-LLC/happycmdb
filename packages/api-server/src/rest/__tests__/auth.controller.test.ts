// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP-level tests for AuthController's profile/password/account routes.
 *
 * Builds a real AuthController (real AuthService/AuthMiddleware/JWT
 * signing) over an in-memory fake AuthRepository and drives it with
 * supertest. Account operations require a login session, and authenticated
 * requests act only on their verified subject, never a request-body userId.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { AuthController } from '../auth.controller';
import { AuthService, AuthRepository, UserProfileUpdate } from '../../auth/auth.service';
import type { GuardedPasswordWrite, GuardedUserWrite } from '../../auth/auth.service';
import { ValidationMiddleware } from '../middleware/validation.middleware';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { PasswordService } from '../../auth/password.service';
import { JWTService } from '../../auth/jwt.service';
import { User, ApiKey } from '../../auth/types';
import { logger } from '@cmdb/common';
import * as jwt from 'jsonwebtoken';

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

class InMemoryAuthRepository implements AuthRepository {
  users = new Map<string, User>();
  apiKeys = new Map<string, { userId: string; revoked: boolean }>();
  issuedKeys = new Map<string, ApiKey>();
  listCalls = 0;

  async findUserByUsername(username: string): Promise<User | null> {
    return [...this.users.values()].find((u) => u._username === username) || null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async updateUserLastLogin(): Promise<void> {}

  async updateUser(id: string, updates: UserProfileUpdate): Promise<User> {
    const existing = this.users.get(id);
    if (!existing) {
      throw new Error('User not found');
    }
    const updated: User = {
      ...existing,
      ...(updates.name !== undefined ? { _name: updates.name } : {}),
      ...(updates.avatar !== undefined ? { _avatar: updates.avatar } : {}),
      _updatedAt: new Date(),
    };
    this.users.set(id, updated);
    return updated;
  }

  async updatePasswordHashGuarded(write: GuardedPasswordWrite): Promise<boolean> {
    const existing = this.users.get(write.userId);
    if (!existing || existing._passwordHash !== write.readHash) {
      return false;
    }
    this.users.set(write.userId, { ...existing, _passwordHash: write.newHash });
    return true;
  }

  async disableUserGuarded(write: GuardedUserWrite): Promise<boolean> {
    return this.users.has(write.userId);
  }

  async markDefaultSuspect(): Promise<boolean> {
    return false;
  }

  async recordCredentialEvent(): Promise<void> {}

  async deleteUserAccount(id: string): Promise<void> {
    this.users.delete(id);
  }

  async findApiKeyByKey(hash: string): Promise<ApiKey | null> {
    return this.issuedKeys.get(hash) || null;
  }

  async createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey> {
    const created = { ...apiKey, _id: 'key-1', _createdAt: new Date() } as ApiKey;
    this.issuedKeys.set(created._keyHash, created);
    return created;
  }

  async updateApiKeyLastUsed(): Promise<void> {}
  async deleteApiKey(userId: string, keyId: string): Promise<number> {
    const key = this.apiKeys.get(keyId);
    if (!key || key.userId !== userId || key.revoked) {
      return 0;
    }

    key.revoked = true;
    return 1;
  }
  async listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    this.listCalls++;
    return [...this.issuedKeys.values()]
      .filter(key => key._userId === userId)
      .map(({ _key, _keyHash, ...key }) => key);
  }
}

/** A no-op rate limiter: profile/password/account routes don't apply it. */
function fakeRateLimiter(): RateLimitMiddleware {
  return {
    limit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  } as unknown as RateLimitMiddleware;
}

describe('AuthController profile/password/account routes', () => {
  let app: express.Express;
  let repository: InMemoryAuthRepository;
  let jwtService: JWTService;
  let passwordService: PasswordService;
  let victimToken: string;
  let otherUserToken: string;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    const authService = new AuthService(authConfig as any, repository);
    const validator = new ValidationMiddleware();
    const authMiddleware = new AuthMiddleware(authService, authConfig as any);
    const controller = new AuthController(authService, validator, authMiddleware, fakeRateLimiter());

    app = express();
    app.use(express.json());
    app.use('/api/v1/auth', controller.getRouter());

    passwordService = new PasswordService(authConfig.bcrypt as any);
    jwtService = new JWTService(authConfig.jwt as any);

    repository.users.set('user-1', {
      _id: 'user-1',
      _username: 'alice',
      _email: 'alice@example.com',
      _passwordHash: await passwordService.hash('correct-horse-battery-staple'),
      _role: 'operator',
      _enabled: true,
      _createdAt: new Date('2024-01-01'),
      _updatedAt: new Date('2024-01-01'),
    } as User);

    repository.users.set('user-2', {
      _id: 'user-2',
      _username: 'bob',
      _email: 'bob@example.com',
      _passwordHash: await passwordService.hash('bobs-password'),
      _role: 'viewer',
      _enabled: true,
      _createdAt: new Date('2024-01-01'),
      _updatedAt: new Date('2024-01-01'),
    } as User);

    victimToken = jwtService.generateAccessToken('user-1', 'alice', 'operator');
    otherUserToken = jwtService.generateAccessToken('user-2', 'bob', 'viewer');

    repository.apiKeys.set('alice-key', { userId: 'user-1', revoked: false });
    repository.apiKeys.set('bob-key', { userId: 'user-2', revoked: false });
  });

  it('returns one fixed login failure for unknown, wrong, disabled, and store failures without logging driver text', async () => {
    const warnings = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const failed = { success: false, error: 'Authentication failed' };
    try {
      const login = (username: string, password: string) =>
        request(app).post('/api/v1/auth/login').send({ username, password });
      for (const [username, password, reason] of [
        ['missing', 'wrong-password', 'invalid'],
        ['alice', 'wrong-password', 'invalid'],
      ]) {
        const response = await login(username, password);
        expect([response.status, response.body]).toEqual([401, failed]);
        expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'login', reason });
      }
      repository.users.get('user-1')!._enabled = false;
      const disabled = await login('alice', 'correct-horse-battery-staple');
      expect([disabled.status, disabled.body]).toEqual([401, failed]);
      expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'login', reason: 'disabled' });
      repository.users.get('user-1')!._enabled = true;

      const driverError = new Error('neo4j bolt://internal token=private-driver-detail');
      for (const method of ['findUserByUsername', 'updateUserLastLogin'] as const) {
        const spy = jest.spyOn(repository, method).mockRejectedValueOnce(driverError);
        const response = await login('alice', 'correct-horse-battery-staple');
        expect([response.status, response.body]).toEqual([401, failed]);
        expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'login', reason: 'store_error' });
        expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-driver-detail');
        spy.mockRestore();
      }
      const success = await login('alice', 'correct-horse-battery-staple');
      expect(success.status).toBe(200);
      expect(success.body.data._accessToken).toEqual(expect.any(String));
    } finally {
      warnings.mockRestore();
    }
  });

  it.each([['production'], [undefined]])(
    'N-21: NODE_ENV=%s refuses the seeded admin/Admin123! byte-identically to a wrong password, logging default_credential_refused and no password',
    async nodeEnv => {
      const savedNodeEnv = process.env['NODE_ENV'];
      if (nodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = nodeEnv;
      const warnings = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      try {
        const seededHash = await passwordService.hash('Admin123!');
        repository.users.set('user-admin-001', {
          _id: 'user-admin-001', _username: 'admin', _email: 'admin@happycmdb.local', _passwordHash: seededHash,
          _role: 'admin', _enabled: true, _createdAt: new Date('2024-01-01'), _updatedAt: new Date('2024-01-01'),
        } as User);
        const login = (password: string) => request(app).post('/api/v1/auth/login').send({ username: 'admin', password });
        const bytes = (response: request.Response) => ({
          status: response.status,
          text: response.text,
          contentType: response.headers['content-type'],
          contentLength: response.headers['content-length'],
          etag: response.headers['etag'],
        });

        const wrong = await login('not-the-password');
        expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'login', reason: 'invalid' });
        const refused = await login('Admin123!');

        expect(bytes(refused)).toEqual(bytes(wrong));
        expect(refused.status).toBe(401);
        expect(refused.body._accessToken ?? refused.body.data).toBeUndefined();
        expect(warnings).toHaveBeenLastCalledWith('Authentication failed', {
          credentialType: 'login', reason: 'default_credential_refused',
        });
        const logged = JSON.stringify(warnings.mock.calls);
        expect(logged).not.toContain('Admin123');
        expect(logged).not.toContain(seededHash);
      } finally {
        warnings.mockRestore();
        if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = savedNodeEnv;
      }
    }
  );

  it('returns one fixed refresh failure for invalid, expired, wrong-type, revoked, disabled, and store failures', async () => {
    const warnings = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const failed = { success: false, error: 'Authentication failed' };
    const valid = jwtService.generateRefreshToken('user-1', 'alice', 'operator');
    const expired = jwt.sign(
      { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'refresh' },
      authConfig.jwt.secret, { expiresIn: -1, issuer: authConfig.jwt.issuer, audience: authConfig.jwt.audience }
    );
    try {
      for (const [token, reason] of [
        ['invalid.token.payload', 'invalid'],
        [expired, 'expired'],
        [victimToken, 'wrong_type'],
        [jwtService.generateRefreshToken('deleted-user', 'deleted', 'viewer'), 'revoked'],
      ]) {
        const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: token });
        expect([response.status, response.body]).toEqual([401, failed]);
        expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'refresh', reason });
      }
      repository.users.get('user-1')!._enabled = false;
      const disabled = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: valid });
      expect([disabled.status, disabled.body]).toEqual([401, failed]);
      expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'refresh', reason: 'disabled' });
      repository.users.get('user-1')!._enabled = true;
      const lookup = jest.spyOn(repository, 'findUserById').mockRejectedValueOnce(new Error('private-driver-detail'));
      const store = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: valid });
      expect([store.status, store.body]).toEqual([401, failed]);
      expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'refresh', reason: 'store_error' });
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-driver-detail');
      lookup.mockRestore();
      const success = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: valid });
      expect(success.status).toBe(200);
      expect(success.body.data._accessToken).toEqual(expect.any(String));
    } finally {
      warnings.mockRestore();
    }
  });

  it('preserves the original store exception as an internal cause without exposing it', async () => {
    // This fixture supplies the subset of auth config used by AuthService.
    const service = new AuthService(authConfig as unknown as ConstructorParameters<typeof AuthService>[0], repository);
    const original = new Error('private-driver-detail');
    const spy = jest.spyOn(repository, 'findUserById').mockRejectedValueOnce(original);
    try {
      await expect(service.verifyToken(victimToken)).rejects.toMatchObject({
        reason: 'store_error', cause: original,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('allows login sessions to issue keys but refuses key chaining after viewer promotion', async () => {
    repository.users.get('user-1')!._role = 'viewer';
    const viewerLogin = await request(app).post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'correct-horse-battery-staple' });
    expect(viewerLogin.status).toBe(200);
    const viewerSession = viewerLogin.body.data._accessToken as string;
    const first = await request(app).post('/api/v1/auth/api-key')
      .set('Authorization', `Bearer ${viewerSession}`).send({ name: 'Viewer key' });
    expect(first.status).toBe(200);
    const key = first.body.data._apiKey as string;
    expect(repository.issuedKeys.size).toBe(1);
    expect((await request(app).get('/api/v1/auth/me').set('X-API-Key', key)).status).toBe(200);

    repository.users.get('user-1')!._role = 'operator';
    const chained = await request(app).post('/api/v1/auth/api-key')
      .set('X-API-Key', key).send({ name: 'Escalated key', expiresInDays: 365 });
    expect([chained.status, chained.body]).toEqual([403, {
      _error: 'Forbidden', _message: 'JWT user session required',
    }]);
    expect((await request(app).post('/api/v1/auth/api-key')
      .set('Authorization', 'Bearer malformed').set('X-API-Key', key)
      .send({ name: 'Escalated key' })).status).toBe(401);
    expect(repository.issuedKeys.size).toBe(1);

    const currentLogin = await request(app).post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'correct-horse-battery-staple' });
    expect(currentLogin.status).toBe(200);
    const currentSession = currentLogin.body.data._accessToken as string;
    const issued = await request(app).post('/api/v1/auth/api-key')
      .set('Authorization', `Bearer ${currentSession}`).set('X-API-Key', key)
      .send({ name: 'Session key' });
    expect(issued.status).toBe(200);
    expect(repository.issuedKeys.size).toBe(2);

    repository.users.get('user-1')!._role = 'admin';
    const adminKey = await request(app).post('/api/v1/auth/api-key')
      .set('Authorization', `Bearer ${currentSession}`).send({ name: 'Admin key' });
    expect(adminKey.status).toBe(200);
    const adminChained = await request(app).post('/api/v1/auth/api-key')
      .set('X-API-Key', adminKey.body.data._apiKey as string).send({});
    expect([adminChained.status, adminChained.body]).toEqual([403, chained.body]);
    expect(repository.issuedKeys.size).toBe(3);

    repository.users.get('user-1')!._enabled = false;
    for (const headers of [{ Authorization: `Bearer ${currentSession}` }, { 'X-API-Key': key }]) {
      expect((await request(app).post('/api/v1/auth/api-key')
        .set(headers).send({ name: 'Disabled user' })).status).toBe(401);
    }
    repository.users.delete('user-1');
    for (const headers of [{ Authorization: `Bearer ${currentSession}` }, { 'X-API-Key': key }]) {
      expect((await request(app).post('/api/v1/auth/api-key')
        .set(headers).send({ name: 'Missing user' })).status).toBe(401);
    }
    expect(repository.issuedKeys.size).toBe(3);
  });

  // The same mounted routes authenticate both credentials. Only login sessions
  // may enter an account operation, including reads of key inventory.
  describe('account operations require a user session', () => {
    const operations = [
      { method: 'get', path: '/api/v1/auth/api-keys', body: undefined },
      { method: 'delete', path: '/api/v1/auth/api-key/alice-key', body: undefined },
      { method: 'put', path: '/api/v1/auth/profile', body: { name: 'Changed', userId: 'user-2' } },
      { method: 'put', path: '/api/v1/auth/password', body: {
        currentPassword: 'correct-horse-battery-staple', newPassword: 'new-password-123', userId: 'user-2',
      } },
      { method: 'delete', path: '/api/v1/auth/account', body: undefined },
    ] as const;

    async function call(
      method: 'get' | 'delete' | 'put', path: string, headers: Record<string, string>,
      body?: object
    ) {
      const req = request(app)[method](path).set(headers);
      return body === undefined ? req : req.send(body);
    }

    it.each(operations)('$method $path denies keys before validation or effects, allows login sessions, and isolates users', async ({ method, path, body }) => {
      const login = await request(app).post('/api/v1/auth/login')
        .send({ username: 'alice', password: 'correct-horse-battery-staple' });
      expect(login.status).toBe(200);
      const session = { Authorization: `Bearer ${login.body.data._accessToken as string}` };
      const issue = await request(app).post('/api/v1/auth/api-key').set(session).send({ name: 'Account test key' });
      expect(issue.status).toBe(200);
      const apiKey = { 'X-API-Key': issue.body.data._apiKey as string };
      const aliceHash = repository.users.get('user-1')!._passwordHash;
      const bobHash = repository.users.get('user-2')!._passwordHash;
      const invalidBody = method === 'put' ? {} : body;

      for (const role of ['viewer', 'operator', 'admin', 'agent'] as const) {
        repository.users.get('user-1')!._role = role;
        const denied = await call(method, path, apiKey, invalidBody);
        expect([denied.status, denied.body]).toEqual([403, {
          _error: 'Forbidden', _message: 'JWT user session required',
        }]);
      }
      expect(repository.listCalls).toBe(0);
      expect(repository.apiKeys.get('alice-key')?.revoked).toBe(false);
      expect(repository.users.get('user-1')!._passwordHash).toBe(aliceHash);
      expect(repository.users.get('user-1')!._name).toBeUndefined();
      expect(repository.users.has('user-1')).toBe(true);
      expect(repository.users.get('user-2')!._passwordHash).toBe(bobHash);

      repository.users.get('user-1')!._role = 'operator';
      const allowed = await call(method, path, session, body);
      expect(allowed.status).toBe(200);
      if (method === 'get') {
        expect(repository.listCalls).toBe(1);
        expect(allowed.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ _id: 'key-1' })]));
        expect(JSON.stringify(allowed.body.data)).not.toContain(issue.body.data._apiKey);
      } else if (path.includes('api-key/')) {
        expect(repository.apiKeys.get('alice-key')?.revoked).toBe(true);
        expect(repository.apiKeys.get('bob-key')?.revoked).toBe(false);
      } else if (path.endsWith('profile')) {
        expect(repository.users.get('user-1')!._name).toBe('Changed');
        expect(repository.users.get('user-2')!._name).toBeUndefined();
      } else if (path.endsWith('password')) {
        expect(await passwordService.verify('new-password-123', repository.users.get('user-1')!._passwordHash)).toBe(true);
      } else {
        expect(repository.users.has('user-1')).toBe(false);
      }
      expect(repository.users.has('user-2')).toBe(true);
      expect(repository.users.get('user-2')!._passwordHash).toBe(bobHash);
    });

    it.each(operations)('$method $path refuses disabled and missing principals with both credential types', async ({ method, path, body }) => {
      const issue = await request(app).post('/api/v1/auth/api-key')
        .set('Authorization', `Bearer ${victimToken}`).send({ name: 'Account test key' });
      const headers = [{ Authorization: `Bearer ${victimToken}` }, { 'X-API-Key': issue.body.data._apiKey as string }];
      repository.users.get('user-1')!._enabled = false;
      for (const auth of headers) expect((await call(method, path, auth, body)).status).toBe(401);
      repository.users.delete('user-1');
      for (const auth of headers) expect((await call(method, path, auth, body)).status).toBe(401);
      expect(repository.listCalls).toBe(0);
      expect(repository.apiKeys.get('alice-key')?.revoked).toBe(false);
      expect(repository.users.has('user-2')).toBe(true);
    });
  });

  describe('PUT /profile', () => {
    it('returns 401 without a bearer token', async () => {
      const res = await request(app).put('/api/v1/auth/profile').send({ name: 'New Name' });
      expect(res.status).toBe(401);
    });

    it('updates and rereads the authenticated user, never the request body userId', async () => {
      const res = await request(app)
        .put('/api/v1/auth/profile')
        .set('Authorization', `Bearer ${victimToken}`)
        // Even if a caller stuffs a foreign userId into the body, the
        // server must act on the token's subject, not this value.
        .send({ name: 'Alice Updated', userId: 'user-2' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Alice Updated');
      expect(res.body.data.userId).toBe('user-1');

      const bobStillUnchanged = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${otherUserToken}`)
        .send({ currentPassword: 'bobs-password', newPassword: 'still-bobs-own-choice-1' });
      expect(bobStillUnchanged.status).toBe(200);

      const meAfter = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${victimToken}`);
      expect(meAfter.body.data.name).toBe('Alice Updated');
    });

    it('persists the avatar and rereads it through GET /me (survives a simulated reload)', async () => {
      const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA';

      const updateRes = await request(app)
        .put('/api/v1/auth/profile')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({ name: 'Alice Updated', avatar: avatarDataUrl });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.data.avatar).toBe(avatarDataUrl);

      const meAfter = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${victimToken}`);
      expect(meAfter.body.data.avatar).toBe(avatarDataUrl);
    });

    it('rejects malformed bodies with 400', async () => {
      const res = await request(app)
        .put('/api/v1/auth/profile')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /password', () => {
    it('returns 401 without a bearer token', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .send({ currentPassword: 'x', newPassword: 'new-password-123' });
      expect(res.status).toBe(401);
    });

    it('rejects a mismatched current password with 400 and leaves the hash untouched', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({ currentPassword: 'totally-wrong', newPassword: 'new-password-123' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/incorrect/i);

      const stillOldPassword = await passwordService.verify(
        'correct-horse-battery-staple',
        repository.users.get('user-1')?._passwordHash as string
      );
      expect(stillOldPassword).toBe(true);
    });

    // HP1-S6 (v16 §1.1): fixed wire contract for the new refusals.
    it('refuses a default-equivalent new password with 400 Password not allowed', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({ currentPassword: 'correct-horse-battery-staple', newPassword: 'Admin123!' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Bad Request', message: 'Password not allowed' });
    });

    it('refuses a change whose guarded write loses to a rotation with 401 Credentials changed', async () => {
      const rotateFirst = repository.updatePasswordHashGuarded.bind(repository);
      repository.updatePasswordHashGuarded = async write => {
        const user = repository.users.get(write.userId)!;
        repository.users.set(write.userId, { ...user, _passwordHash: 'rotated-by-operator', _credentialEpoch: 1 });
        return rotateFirst(write);
      };

      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({ currentPassword: 'correct-horse-battery-staple', newPassword: 'brand-new-password-1' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Unauthorized', message: 'Credentials changed' });
      expect(repository.users.get('user-1')?._passwordHash).toBe('rotated-by-operator');
    });

    it('changes only the authenticated caller\'s password (account identity from the token)', async () => {
      const res = await request(app)
        .put('/api/v1/auth/password')
        .set('Authorization', `Bearer ${victimToken}`)
        .send({ currentPassword: 'correct-horse-battery-staple', newPassword: 'brand-new-password-1' });

      expect(res.status).toBe(200);

      const aliceNewPasswordWorks = await passwordService.verify(
        'brand-new-password-1',
        repository.users.get('user-1')?._passwordHash as string
      );
      expect(aliceNewPasswordWorks).toBe(true);

      const bobPasswordUnaffected = await passwordService.verify(
        'bobs-password',
        repository.users.get('user-2')?._passwordHash as string
      );
      expect(bobPasswordUnaffected).toBe(true);
    });
  });

  describe('DELETE /account', () => {
    it('returns 401 without a bearer token', async () => {
      const res = await request(app).delete('/api/v1/auth/account');
      expect(res.status).toBe(401);
    });

    it('deletes only the authenticated account, leaving other accounts intact', async () => {
      const res = await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${victimToken}`);

      expect(res.status).toBe(200);
      expect(repository.users.has('user-1')).toBe(false);
      expect(repository.users.has('user-2')).toBe(true);
    });

    it('rejects further authenticated calls with the now-deleted account\'s token', async () => {
      await request(app).delete('/api/v1/auth/account').set('Authorization', `Bearer ${victimToken}`);

      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${victimToken}`);
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api-key/:keyId', () => {
    it('revokes an active key owned by the authenticated user', async () => {
      const res = await request(app)
        .delete('/api/v1/auth/api-key/alice-key')
        .set('Authorization', `Bearer ${victimToken}`);

      expect(res.status).toBe(200);
      expect(repository.apiKeys.get('alice-key')?.revoked).toBe(true);
    });

    it('returns the same not-found response for foreign and missing API keys', async () => {
      const foreign = await request(app)
        .delete('/api/v1/auth/api-key/bob-key')
        .set('Authorization', `Bearer ${victimToken}`);
      const missing = await request(app)
        .delete('/api/v1/auth/api-key/missing-key')
        .set('Authorization', `Bearer ${victimToken}`);

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expect(repository.apiKeys.get('bob-key')?.revoked).toBe(false);
    });

    it('returns 401 without a bearer token', async () => {
      const res = await request(app).delete('/api/v1/auth/api-key/alice-key');

      expect(res.status).toBe(401);
    });
  });
});
