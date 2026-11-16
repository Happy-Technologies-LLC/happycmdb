// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AuthService's profile/password/account-lifecycle methods.
 *
 * AuthService takes its AuthRepository via constructor injection, so these
 * tests drive it against a small in-memory fake repository instead of
 * mocking @cmdb/database -- no Neo4j/Postgres involved.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { logger } from '@cmdb/common';
import { ApiKeyNotFoundError, AUTH_TIME_TOLERANCE_SECONDS, AuthService, AuthRepository, OrganizationRequiredError, SESSION_ABSOLUTE_CAP_SECONDS, UserProfileUpdate } from '../auth.service';
import type { GuardedEpochBump, GuardedPasswordRehash, GuardedPasswordWrite, GuardedUserWrite } from '../auth.service';
import { AmbiguousUserIdentityError, User, ApiKey, UserNotFoundError } from '../types';
import { PasswordService } from '../password.service';
import { JWTService } from '../jwt.service';
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

const ORG = '5f0c7a52-3d1e-4b8a-9c61-2f4e8d7b1a03';

class InMemoryAuthRepository implements AuthRepository {
  users = new Map<string, User>();
  deletedUserIds: string[] = [];
  apiKeyDeleteRequests: Array<[string, string]> = [];
  apiKeyDeleteResult = 1;
  apiKey: ApiKey | null = null;

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

  async rehashPasswordGuarded(write: GuardedPasswordRehash): Promise<boolean> {
    const existing = this.users.get(write.userId);
    if (!existing || existing._passwordHash !== write.readHash) {
      return false;
    }
    this.users.set(write.userId, { ...existing, _passwordHash: write.newHash });
    return true;
  }

  /** Like GUARDED_BUMP_EPOCH_CYPHER: only an unmarked node with an organization, at the authorizing generation, still holding the verified hash; the hash is never written. */
  async bumpCredentialEpochGuarded(write: GuardedEpochBump): Promise<boolean> {
    const existing = this.users.get(write.userId);
    if (
      !existing || existing._passwordHash !== write.readHash || (existing._credentialEpoch ?? 0) !== write.credentialEpoch ||
      existing._defaultPasswordSuspect === true || !existing._organizationId
    ) {
      return false;
    }
    this.users.set(write.userId, { ...existing, _credentialEpoch: write.credentialEpoch + 1 });
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
    return this.apiKey;
  }

  async createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey> {
    return { ...apiKey, _id: 'key-1', _createdAt: new Date() } as ApiKey;
  }

  async updateApiKeyLastUsed(): Promise<void> {}
  async deleteApiKey(userId: string, keyId: string): Promise<number> {
    this.apiKeyDeleteRequests.push([userId, keyId]);
    return this.apiKeyDeleteResult;
  }
  listedApiKeys: Array<Omit<ApiKey, '_key' | '_keyHash'>> = [];
  async listApiKeys(): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    return this.listedApiKeys;
  }
  apiKeyRevokeRequests: Array<[string, number]> = [];
  async revokeApiKeysBelowEpoch(userId: string, nextEpoch: number): Promise<number> {
    this.apiKeyRevokeRequests.push([userId, nextEpoch]);
    return 0;
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
      _organizationId: ORG,
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
      await expect(service.updateProfile('ghost', { name: 'x' })).rejects.toBeInstanceOf(UserNotFoundError);
    });
  });

  describe('changePassword', () => {
    it('rejects an incorrect current password without touching the stored hash', async () => {
      const before = repository.users.get('user-1')?._passwordHash;

      await expect(
        service.changePassword('user-1', 'wrong-password', 'new-password-123', 0, ORG)
      ).rejects.toThrow('Current password is incorrect');

      expect(repository.users.get('user-1')?._passwordHash).toBe(before);
    });

    it('accepts the correct current password and the new password verifies afterwards', async () => {
      await service.changePassword('user-1', 'correct-horse-battery-staple', 'new-password-123', 0, ORG);

      const updatedHash = repository.users.get('user-1')?._passwordHash as string;
      expect(await passwordService.verify('new-password-123', updatedHash)).toBe(true);
      expect(await passwordService.verify('correct-horse-battery-staple', updatedHash)).toBe(false);
    });

    describe('API key revocation (HAP-1669)', () => {
      beforeEach(() => {
        repository.users.set('user-1', { ...repository.users.get('user-1')!, _credentialEpoch: 4 } as User);
      });

      it('revokes the keys below the new generation once, after the guarded write', async () => {
        const session = await service.changePassword('user-1', 'correct-horse-battery-staple', 'new-password-123', 4, ORG);

        expect(repository.apiKeyRevokeRequests).toEqual([['user-1', 5]]);
        expect(new JWTService(authConfig.jwt).decodeToken(session._accessToken)).toMatchObject({ _cep: 5 });
      });

      it('lists only what the store returns, marking an unrevoked key of another generation as not enabled and hiding the generation', async () => {
        const row = (_id: string, _credentialEpoch: number | undefined) =>
          ({ _id, _userId: 'user-1', _name: _id, _role: 'admin', _tier: 'standard', _enabled: true, _createdAt: new Date(), _credentialEpoch }) as ApiKey;
        repository.listedApiKeys = [row('current', 4), row('older-unrevoked', 3), row('legacy-no-epoch', undefined)];

        const listed = await service.listApiKeys('user-1');

        expect(listed.map(key => [key._id, key._enabled])).toEqual([['current', true], ['older-unrevoked', false], ['legacy-no-epoch', false]]);
        expect(listed.some(key => '_credentialEpoch' in key)).toBe(false);
      });

      it('still returns the new session when the revoke fails, logging the error class only', async () => {
        const hash = repository.users.get('user-1')!._passwordHash;
        const leak = `boom ${hash} correct-horse-battery-staple new-password-123`;
        jest.spyOn(repository, 'revokeApiKeysBelowEpoch').mockRejectedValue(new TypeError(leak));
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
        const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
        try {
          const session = await service.changePassword('user-1', 'correct-horse-battery-staple', 'new-password-123', 4, ORG);

          expect(session).toMatchObject({ _accessToken: expect.any(String), _refreshToken: expect.any(String), _user: { _id: 'user-1' } });
          expect(new JWTService(authConfig.jwt).decodeToken(session._accessToken)).toMatchObject({ _cep: 5 });
          expect(warn.mock.calls).toEqual([['Password change API key revocation failed', { errorClass: 'TypeError' }]]);
          expect(error).not.toHaveBeenCalled();
          expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toMatch(/boom|correct-horse|new-password|\$2[aby]\$/);
        } finally {
          warn.mockRestore();
          error.mockRestore();
        }
      });

      it.each([
        ['a wrong current password', 'wrong-password', 4, 'Current password is incorrect'],
        ['a stale generation', 'correct-horse-battery-staple', 3, 'credentials'],
      ])('never revokes on %s', async (_label, current, epoch, message) => {
        await expect(service.changePassword('user-1', current, 'new-password-123', epoch, ORG)).rejects.toThrow(new RegExp(message, 'i'));

        expect(repository.apiKeyRevokeRequests).toEqual([]);
      });

      it('never revokes when the guarded write is lost', async () => {
        jest.spyOn(repository, 'updatePasswordHashGuarded').mockResolvedValue(false);

        await expect(service.changePassword('user-1', 'correct-horse-battery-staple', 'new-password-123', 4, ORG)).rejects.toThrow(/credentials/i);

        expect(repository.apiKeyRevokeRequests).toEqual([]);
      });
    });

    it('throws for an unknown user id', async () => {
      await expect(service.changePassword('ghost', 'a-new-password', 'b-new-password', 0, ORG)).rejects.toBeInstanceOf(UserNotFoundError);
    });

    describe('organization required (HAP-1714)', () => {
      const OTHER_ORG = 'a1b2c3d4-0000-4000-8000-00000000000a';
      const refuse = (current: string, claim: string, epoch = 0) =>
        expect(service.changePassword('user-1', current, 'new-password-123', epoch, claim)).rejects.toBeInstanceOf(OrganizationRequiredError);

      it.each([
        ['no organization', undefined],
        ['an empty organization', ''],
      ])('refuses a stored user with %s before any check, hash or write', async (_label, stored) => {
        const before = { ...repository.users.get('user-1')!, _organizationId: stored } as User;
        repository.users.set('user-1', before);
        const hash = jest.spyOn(PasswordService.prototype, 'hash');
        const verify = jest.spyOn(PasswordService.prototype, 'verify');
        const write = jest.spyOn(repository, 'updatePasswordHashGuarded');
        try {
          // Right password, wrong password and a stale generation all get the same refusal: it comes first.
          await refuse('correct-horse-battery-staple', ORG);
          await refuse('wrong-password', ORG);
          await refuse('correct-horse-battery-staple', ORG, 99);

          expect(hash).not.toHaveBeenCalled();
          expect(verify).not.toHaveBeenCalled();
          expect(write).not.toHaveBeenCalled();
          expect(repository.users.get('user-1')).toEqual(before);
          expect(repository.apiKeyRevokeRequests).toEqual([]);
        } finally {
          hash.mockRestore();
          verify.mockRestore();
        }
      });

      it('refuses a request claim that is not the stored organization, writing nothing', async () => {
        const before = repository.users.get('user-1');
        const write = jest.spyOn(repository, 'updatePasswordHashGuarded');

        await refuse('correct-horse-battery-staple', OTHER_ORG);

        expect(write).not.toHaveBeenCalled();
        expect(repository.users.get('user-1')).toEqual(before);
      });

      it('control: a user with an organization and the matching claim still changes the password', async () => {
        const session = await service.changePassword('user-1', 'correct-horse-battery-staple', 'new-password-123', 0, ORG);

        expect(session._user._id).toBe('user-1');
        expect(await passwordService.verify('new-password-123', repository.users.get('user-1')!._passwordHash)).toBe(true);
      });
    });
  });

  describe('revokeOtherSessions (HAP-1716)', () => {
    const PASSWORD = 'correct-horse-battery-staple';
    const jwtDecode = (token: string) => new JWTService(authConfig.jwt).decodeToken(token);
    const store = (patch: Partial<User>) => repository.users.set('user-1', { ...repository.users.get('user-1')!, ...patch } as User);
    beforeEach(() => store({ _credentialEpoch: 4 }));

    it('advances the generation by exactly one, keeps the hash, and returns a new session at the new generation', async () => {
      const hashBefore = repository.users.get('user-1')!._passwordHash;
      const hash = jest.spyOn(PasswordService.prototype, 'hash');
      try {
        const session = await service.revokeOtherSessions('user-1', PASSWORD, 4, ORG);

        expect(repository.users.get('user-1')).toMatchObject({ _credentialEpoch: 5, _passwordHash: hashBefore });
        expect(hash).not.toHaveBeenCalled();
        expect(jwtDecode(session._accessToken)).toMatchObject({ _cep: 5 });
        expect(jwtDecode(session._refreshToken)).toMatchObject({ _cep: 5 });
        expect(session._user).toEqual({ _id: 'user-1', _username: 'alice', _role: 'operator' });
        expect(repository.apiKeyRevokeRequests).toEqual([['user-1', 5]]);
      } finally {
        hash.mockRestore();
      }
    });

    it('the new session starts a fresh authentication: its cap runs from now, not from the first login', async () => {
      const session = await service.revokeOtherSessions('user-1', PASSWORD, 4, ORG);
      const now = Math.floor(Date.now() / 1000);

      expect(Math.abs((jwtDecode(session._refreshToken) as unknown as { _authTime: number })._authTime - now)).toBeLessThanOrEqual(5);
    });

    it('still returns the new session when the API-key revoke fails, logging the error class only', async () => {
      const hash = repository.users.get('user-1')!._passwordHash;
      jest.spyOn(repository, 'revokeApiKeysBelowEpoch').mockRejectedValue(new TypeError(`boom ${hash} ${PASSWORD}`));
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      try {
        const session = await service.revokeOtherSessions('user-1', PASSWORD, 4, ORG);

        expect(jwtDecode(session._accessToken)).toMatchObject({ _cep: 5 });
        expect(repository.users.get('user-1')!._credentialEpoch).toBe(5);
        expect(warn.mock.calls).toEqual([['Session revoke API key revocation failed', { errorClass: 'TypeError' }]]);
        expect(error).not.toHaveBeenCalled();
        expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toMatch(/boom|correct-horse|\$2[aby]\$/);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it.each([
      ['a wrong current password', 'wrong-password', 4, ORG, {}, /incorrect/i],
      ['a stale authorizing generation', PASSWORD, 3, ORG, {}, /credentials changed/i],
      ['a marked (default-password-suspect) user', PASSWORD, 4, ORG, { _defaultPasswordSuspect: true }, /credentials changed/i],
      ['a user with no organization', PASSWORD, 4, ORG, { _organizationId: undefined }, /organization required/i],
      ['a request claim that is not the stored organization', PASSWORD, 4, 'a1b2c3d4-0000-4000-8000-00000000000a', {}, /organization required/i],
    ])('%s: nothing is written and no key is revoked', async (_label, password, epoch, claim, patch, message) => {
      store(patch as Partial<User>);
      const before = repository.users.get('user-1');

      await expect(service.revokeOtherSessions('user-1', password, epoch, claim)).rejects.toThrow(message);

      expect(repository.users.get('user-1')).toEqual(before);
      expect(repository.apiKeyRevokeRequests).toEqual([]);
    });

    it('loses to a concurrent change: the guarded write refuses, so the caller is told credentials changed and no key is revoked', async () => {
      const raced = repository.bumpCredentialEpochGuarded.bind(repository);
      repository.bumpCredentialEpochGuarded = async write => {
        store({ _passwordHash: 'rotated-by-operator', _credentialEpoch: 5 });
        return raced(write);
      };

      await expect(service.revokeOtherSessions('user-1', PASSWORD, 4, ORG)).rejects.toThrow(/credentials changed/i);

      expect(repository.users.get('user-1')).toMatchObject({ _passwordHash: 'rotated-by-operator', _credentialEpoch: 5 });
      expect(repository.apiKeyRevokeRequests).toEqual([]);
    });

    it('throws for an unknown user id', async () => {
      await expect(service.revokeOtherSessions('ghost', PASSWORD, 0, ORG)).rejects.toBeInstanceOf(UserNotFoundError);
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
      await expect(service.deleteAccount('ghost', 0)).rejects.toBeInstanceOf(UserNotFoundError);
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


    it('mints the current organization on refresh', async () => {
      const tokens = await login();
      setOrg(ORG);

      const refreshed = await service.refreshToken({ refreshToken: tokens._refreshToken });

      expect(jwtService.decodeToken(refreshed._accessToken)?._organizationId).toBe(ORG);
    });

    it('does not propagate a raw platform marker through verified JWTs or API keys', async () => {
      Object.assign(repository.users.get('user-1')!, { _platformAdmin: true });
      const { _accessToken } = await login();
      expect(await service.verifyToken(_accessToken)).not.toHaveProperty('_platformAdmin');

      repository.apiKey = {
        _id: 'key-1', _key: '', _keyHash: '', _name: 'cli',
        _userId: 'user-1', _role: 'admin', _tier: 'standard', _enabled: true, _createdAt: new Date(),
      } as ApiKey;
      expect(await service.verifyApiKey('opaque')).not.toHaveProperty('_platformAdmin');
    });
  });

  it('refuses a refresh token presented as a bearer token, reason wrong_type', async () => {
    const { _refreshToken } = await service.login({ username: 'alice', password: 'correct-horse-battery-staple' });

    await expect(service.verifyToken(_refreshToken)).rejects.toMatchObject({ message: 'Authentication failed', reason: 'wrong_type' });
  });

  describe('refresh _authTime bounds (HAP-1669)', () => {
    const now = () => Math.floor(Date.now() / 1000);
    const refreshWith = (authTime: number) =>
      service.refreshToken({ refreshToken: new JWTService(authConfig.jwt).generateRefreshToken('user-1', 'alice', 'operator', 0, authTime) });

    it('refuses a future-dated _authTime that would never reach the 7-day cap', async () => {
      await expect(refreshWith(now() + 10 * 365 * 24 * 3600)).rejects.toMatchObject({ reason: 'invalid' });
      await expect(refreshWith(now() + AUTH_TIME_TOLERANCE_SECONDS + 5)).rejects.toMatchObject({ reason: 'invalid' });
    });

    it('accepts _authTime equal to iat and within the skew tolerance', async () => {
      await expect(refreshWith(now())).resolves.toHaveProperty('_accessToken');
      await expect(refreshWith(now() + AUTH_TIME_TOLERANCE_SECONDS - 5)).resolves.toHaveProperty('_accessToken');
    });

    it('still expires at the 7-day cap, and refuses zero and negative values', async () => {
      await expect(refreshWith(now() - SESSION_ABSOLUTE_CAP_SECONDS - 5)).rejects.toMatchObject({ reason: 'expired' });
      await expect(refreshWith(now() - SESSION_ABSOLUTE_CAP_SECONDS + 60)).resolves.toHaveProperty('_accessToken');
      await expect(refreshWith(0)).rejects.toMatchObject({ reason: 'expired' });
      await expect(refreshWith(-1)).rejects.toMatchObject({ reason: 'expired' });
    });

    it('refuses a token that carries no iat, so there is no issue time to bound _authTime by', async () => {
      const noIat = jwt.sign(
        { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'refresh', _cep: 0, _authTime: now() },
        authConfig.jwt.secret,
        { expiresIn: '7d', issuer: authConfig.jwt.issuer, audience: authConfig.jwt.audience, noTimestamp: true },
      );
      expect(new JWTService(authConfig.jwt).decodeToken(noIat)).not.toHaveProperty('iat');

      await expect(service.refreshToken({ refreshToken: noIat })).rejects.toMatchObject({ reason: 'invalid' });
    });

    it('a normal refresh keeps the original _authTime in the new refresh token', async () => {
      const authTime = now() - 3 * 24 * 3600;

      const refreshed = await refreshWith(authTime);

      expect(new JWTService(authConfig.jwt).decodeToken(refreshed._refreshToken)).toMatchObject({ _authTime: authTime });
    });
  });

  describe('session-family id in the access token (HAP-1716 F1)', () => {
    const PASSWORD = 'correct-horse-battery-staple';
    const jwtService = () => new JWTService(authConfig.jwt);
    const claim = (token: string) => (jwtService().decodeToken(token) as unknown as { _authTime?: number })._authTime;
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const at = async <T>(seconds: number, run: () => Promise<T>): Promise<T> => {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(seconds * 1000);
      try {
        return await run();
      } finally {
        spy.mockRestore();
      }
    };

    it('login mints one login time into both tokens, and verifyToken hands it on', async () => {
      const session = await service.login({ username: 'alice', password: PASSWORD });

      expect(claim(session._accessToken)).toBe(claim(session._refreshToken));
      expect(Math.abs(claim(session._accessToken)! - nowSeconds())).toBeLessThanOrEqual(5);
      expect(await service.verifyToken(session._accessToken)).toMatchObject({ _authTime: claim(session._refreshToken) });
    });

    it('every refresh keeps the original login time in the new access token, so refreshed tokens share the parent\'s session bucket', async () => {
      const t0 = nowSeconds();
      const login = await at(t0, () => service.login({ username: 'alice', password: PASSWORD }));
      const first = await at(t0 + 2 * 24 * 3600, () => service.refreshToken({ refreshToken: login._refreshToken }));
      const second = await at(t0 + 4 * 24 * 3600, () => service.refreshToken({ refreshToken: first._refreshToken }));

      for (const session of [login, first, second]) {
        expect(claim(session._accessToken)).toBe(t0);
        expect(claim(session._refreshToken)).toBe(t0);
      }
      const verified = await at(t0 + 4 * 24 * 3600, () => service.verifyToken(second._accessToken));
      expect(verified).toMatchObject({ _authTime: t0 });
    });

    it('a later login of the same user gets a different login time', async () => {
      const t0 = nowSeconds();
      const stolen = await at(t0, () => service.login({ username: 'alice', password: PASSWORD }));
      const owner = await at(t0 + 3600, () => service.login({ username: 'alice', password: PASSWORD }));

      expect(claim(owner._accessToken)).toBe(t0 + 3600);
      expect(claim(owner._accessToken)).not.toBe(claim(stolen._accessToken));
    });

    it('an access token minted before the claim existed verifies without one (the route refuses it)', async () => {
      const old = jwt.sign(
        { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'access', _cep: 0 },
        authConfig.jwt.secret,
        { expiresIn: '15m', issuer: authConfig.jwt.issuer, audience: authConfig.jwt.audience },
      );

      expect((await service.verifyToken(old))._authTime).toBeUndefined();
    });

    it('a successful revoke-others restarts the family: both new tokens carry a new login time; a wrong password returns none', async () => {
      const t0 = nowSeconds();
      const login = await at(t0, () => service.login({ username: 'alice', password: PASSWORD }));

      await at(t0 + 600, async () => {
        await expect(service.revokeOtherSessions('user-1', 'wrong-password', 0, ORG)).rejects.toThrow(/incorrect/i);
      });
      const session = await at(t0 + 1200, () => service.revokeOtherSessions('user-1', PASSWORD, 0, ORG));

      expect(claim(login._accessToken)).toBe(t0);
      expect(claim(session._accessToken)).toBe(t0 + 1200);
      expect(claim(session._refreshToken)).toBe(t0 + 1200);
    });

    it('a password change likewise mints one new login time into both tokens', async () => {
      const t0 = nowSeconds();
      const session = await at(t0 + 60, () => service.changePassword('user-1', PASSWORD, 'new-password-123', 0, ORG));

      expect(claim(session._accessToken)).toBe(t0 + 60);
      expect(claim(session._refreshToken)).toBe(t0 + 60);
    });
  });

  describe('ambiguous identity (more than one :User node for an identifier)', () => {
    it('refuses login, bearer, refresh and API key with the uniform failure, reason ambiguous_identity', async () => {
      const jwtService = new JWTService(authConfig.jwt);
      repository.apiKey = {
        _id: 'key-1', _key: '', _keyHash: '', _name: 'cli',
        _userId: 'user-1', _role: 'admin', _tier: 'standard', _enabled: true, _createdAt: new Date(),
      } as ApiKey;
      const ambiguous = async () => { throw new AmbiguousUserIdentityError(); };
      repository.findUserById = ambiguous;
      repository.findUserByUsername = ambiguous;
      const refused = { message: 'Authentication failed', reason: 'ambiguous_identity' };

      await expect(service.login({ username: 'alice', password: 'correct-horse-battery-staple' })).rejects.toMatchObject(refused);
      await expect(service.verifyToken(jwtService.generateAccessToken('user-1', 'alice', 'admin'))).rejects.toMatchObject(refused);
      await expect(service.refreshToken({ refreshToken: jwtService.generateRefreshToken('user-1', 'alice', 'admin') }))
        .rejects.toMatchObject(refused);
      await expect(service.verifyApiKey('opaque')).rejects.toMatchObject(refused);
    });
  });
});
