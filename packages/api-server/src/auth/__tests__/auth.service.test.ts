// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AuthService's profile/password/account-lifecycle methods.
 *
 * AuthService takes its AuthRepository via constructor injection, so these
 * tests drive it against a small in-memory fake repository instead of
 * mocking @cmdb/database -- no Neo4j/Postgres involved.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ApiKeyNotFoundError, AuthService, AuthRepository, UserProfileUpdate } from '../auth.service';
import type { GuardedPasswordWrite, GuardedUserWrite } from '../auth.service';
import { User, ApiKey } from '../types';
import { PasswordService } from '../password.service';
import { JWTService } from '../jwt.service';

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
  deletedUserIds: string[] = [];
  apiKeyDeleteRequests: Array<[string, string]> = [];
  apiKeyDeleteResult = 1;

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
    this.deletedUserIds.push(id);
  }

  async findApiKeyByKey(): Promise<ApiKey | null> {
    return null;
  }

  async createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey> {
    return { ...apiKey, _id: 'key-1', _createdAt: new Date() } as ApiKey;
  }

  async updateApiKeyLastUsed(): Promise<void> {}
  async deleteApiKey(userId: string, keyId: string): Promise<number> {
    this.apiKeyDeleteRequests.push([userId, keyId]);
    return this.apiKeyDeleteResult;
  }
  async listApiKeys(): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    return [];
  }
}

describe('AuthService profile/password/account lifecycle', () => {
  let repository: InMemoryAuthRepository;
  let service: AuthService;
  let passwordService: PasswordService;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    service = new AuthService(authConfig as any, repository);
    passwordService = new PasswordService(authConfig.bcrypt as any);

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
  });

  describe('getUserProfile', () => {
    it('never includes the password hash', async () => {
      const profile = await service.getUserProfile('user-1');
      expect(profile).not.toBeNull();
      expect(profile).not.toHaveProperty('_passwordHash');
      expect(JSON.stringify(profile)).not.toContain('correct-horse-battery-staple');
    });

    it('returns null for an unknown user id', async () => {
      const profile = await service.getUserProfile('does-not-exist');
      expect(profile).toBeNull();
    });
  });

  describe('updateProfile', () => {
    it('persists name so a subsequent read reflects it', async () => {
      await service.updateProfile('user-1', { name: 'Alice Example' });
      const reread = await service.getUserProfile('user-1');
      expect(reread?._name).toBe('Alice Example');
    });

    it('throws for an unknown user id', async () => {
      await expect(service.updateProfile('ghost', { name: 'x' })).rejects.toThrow('User not found');
    });
  });

  describe('changePassword', () => {
    it('rejects an incorrect current password without touching the stored hash', async () => {
      const before = repository.users.get('user-1')?._passwordHash;

      await expect(
        service.changePassword('user-1', 'wrong-password', 'new-password-123', 0)
      ).rejects.toThrow('Current password is incorrect');

      expect(repository.users.get('user-1')?._passwordHash).toBe(before);
    });

    it('accepts the correct current password and the new password verifies afterwards', async () => {
      await service.changePassword('user-1', 'correct-horse-battery-staple', 'new-password-123', 0);

      const updatedHash = repository.users.get('user-1')?._passwordHash as string;
      expect(await passwordService.verify('new-password-123', updatedHash)).toBe(true);
      expect(await passwordService.verify('correct-horse-battery-staple', updatedHash)).toBe(false);
    });

    it('throws for an unknown user id', async () => {
      await expect(service.changePassword('ghost', 'a-new-password', 'b-new-password', 0)).rejects.toThrow('User not found');
    });
  });

  describe('deleteAccount', () => {
    it('operates only on the identity passed in, never a different account', async () => {
      repository.users.set('user-2', {
        _id: 'user-2',
        _username: 'bob',
        _email: 'bob@example.com',
        _passwordHash: 'irrelevant',
        _role: 'viewer',
        _enabled: true,
        _createdAt: new Date(),
        _updatedAt: new Date(),
      } as User);

      await service.deleteAccount('user-1', 0);

      expect(repository.deletedUserIds).toEqual(['user-1']);
      expect(await service.getUserProfile('user-1')).toBeNull();
      expect(await service.getUserProfile('user-2')).not.toBeNull();
    });

    it('throws for an unknown user id instead of silently succeeding', async () => {
      await expect(service.deleteAccount('ghost', 0)).rejects.toThrow('User not found');
      expect(repository.deletedUserIds).toEqual([]);
    });
  });

  describe('revokeApiKey', () => {
    it('scopes revocation to the authenticated user identity', async () => {
      await expect(service.revokeApiKey('user-1', 'key-1')).resolves.toBeUndefined();

      expect(repository.apiKeyDeleteRequests).toEqual([['user-1', 'key-1']]);
    });

    it('throws a typed not-found error when no active owned key is affected', async () => {
      repository.apiKeyDeleteResult = 0;

      await expect(service.revokeApiKey('user-1', 'foreign-or-revoked-key'))
        .rejects.toBeInstanceOf(ApiKeyNotFoundError);
    });
  });

  describe('tenant claim', () => {
    const ORG = '11111111-1111-4111-8111-111111111111';
    const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
    const jwtService = new JWTService(authConfig.jwt);
    const setOrg = (organizationId: string | undefined) =>
      repository.users.set('user-1', { ...repository.users.get('user-1')!, _organizationId: organizationId });
    const login = () => service.login({ username: 'alice', password: 'correct-horse-battery-staple' });

    it("mints the user's organization into the access token only", async () => {
      setOrg(ORG);
      const tokens = await login();

      expect(jwtService.decodeToken(tokens._accessToken)?._organizationId).toBe(ORG);
      expect(jwtService.decodeToken(tokens._refreshToken)).not.toHaveProperty('_organizationId');
    });

    it("resolves the claim from the user's current organization, not the token", async () => {
      setOrg(ORG);
      const { _accessToken } = await login();

      setOrg(OTHER_ORG);
      expect((await service.verifyToken(_accessToken))._organizationId).toBe(OTHER_ORG);

      setOrg(undefined);
      expect((await service.verifyToken(_accessToken))._organizationId).toBeUndefined();
    });

    it('rejects a refresh token presented as a bearer token', async () => {
      setOrg(ORG);
      const { _refreshToken } = await login();

      await expect(service.verifyToken(_refreshToken)).rejects.toThrow(/Invalid token type/);
    });

    it('mints the current organization on refresh', async () => {
      const tokens = await login();
      setOrg(ORG);

      const refreshed = await service.refreshToken({ refreshToken: tokens._refreshToken });

      expect(jwtService.decodeToken(refreshed._accessToken)?._organizationId).toBe(ORG);
    });
  });
});
