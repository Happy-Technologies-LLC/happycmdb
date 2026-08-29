// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP-level tests for AuthController's profile/password/account routes.
 *
 * Builds a real AuthController (real AuthService/AuthMiddleware/JWT
 * signing) over an in-memory fake AuthRepository and drives it with
 * supertest, so these assert the actual wire contract: 401 without a
 * token, 400 on password mismatch, and that the account acted on is
 * always the token's subject -- a userId in the request body is never
 * honored.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { AuthController } from '../auth.controller';
import { AuthService, AuthRepository, UserProfileUpdate } from '../../auth/auth.service';
import { ValidationMiddleware } from '../middleware/validation.middleware';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { PasswordService } from '../../auth/password.service';
import { JWTService } from '../../auth/jwt.service';
import { User, ApiKey } from '../../auth/types';

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
      ...(updates.passwordHash !== undefined ? { _passwordHash: updates.passwordHash } : {}),
      _updatedAt: new Date(),
    };
    this.users.set(id, updated);
    return updated;
  }

  async deleteUserAccount(id: string): Promise<void> {
    this.users.delete(id);
  }

  async findApiKeyByKey(): Promise<ApiKey | null> {
    return null;
  }

  async createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey> {
    return { ...apiKey, _id: 'key-1', _createdAt: new Date() } as ApiKey;
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
  async listApiKeys(): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    return [];
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
