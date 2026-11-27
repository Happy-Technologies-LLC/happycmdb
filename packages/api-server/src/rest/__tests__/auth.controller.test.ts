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
import type { GuardedEpochBump, GuardedPasswordRehash, GuardedPasswordWrite, GuardedUserWrite, UsersByIds } from '../../auth/auth.service';
import { ValidationMiddleware } from '../middleware/validation.middleware';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import type { Redis } from 'ioredis';
import type { AuditLogEntry, ConfigSchema } from '@cmdb/common';
import { PasswordService } from '../../auth/password.service';
import { JWTService } from '../../auth/jwt.service';
import { User, ApiKey } from '../../auth/types';
import { logger } from '@cmdb/common';
import * as jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { inspect } from 'util';
import { AUTH_HEADER, AUTH_HEADER_VALUE, REFRESH_COOKIE, setRefreshCookie } from '../middleware/refresh-cookie';

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
  /** Key hashes revoked by revokeApiKeysBelowEpoch: not listed and not found, like `revoked_at IS NOT NULL`. */
  revokedKeyHashes = new Set<string>();
  listCalls = 0;

  async findUserByUsername(username: string): Promise<User | null> {
    return [...this.users.values()].find((u) => u._username === username) || null;
  }

  async findUserById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async findUsersByIds(ids: readonly string[]): Promise<UsersByIds> {
    return { ambiguous: [], users: new Map(ids.flatMap(id => (this.users.has(id) ? [[id, this.users.get(id)!] as [string, User]] : []))) };
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

  /** Like GUARDED_PASSWORD_CYPHER: the hash and the next generation land together. */
  async updatePasswordHashGuarded(write: GuardedPasswordWrite): Promise<boolean> {
    const existing = this.users.get(write.userId);
    if (!existing || existing._passwordHash !== write.readHash || existing._organizationId !== write.organizationId) {
      return false;
    }
    this.users.set(write.userId, { ...existing, _passwordHash: write.newHash, _credentialEpoch: (existing._credentialEpoch ?? 0) + 1 });
    return true;
  }

  /** Like GUARDED_REHASH_CYPHER: the hash lands, the generation does not move. */
  async rehashPasswordGuarded(write: GuardedPasswordRehash): Promise<boolean> {
    const existing = this.users.get(write.userId);
    if (!existing || existing._passwordHash !== write.readHash) {
      return false;
    }
    this.users.set(write.userId, { ...existing, _passwordHash: write.newHash });
    return true;
  }

  /** Like GUARDED_BUMP_EPOCH_CYPHER: the generation moves by one, the hash never changes; a marked or organization-less user is refused. */
  async bumpCredentialEpochGuarded(write: GuardedEpochBump): Promise<boolean> {
    const existing = this.users.get(write.userId);
    if (
      !existing || existing._passwordHash !== write.readHash || (existing._credentialEpoch ?? 0) !== write.credentialEpoch ||
      existing._defaultPasswordSuspect === true || !existing._organizationId || existing._organizationId !== write.organizationId
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

  /** HAP-1368: the audit chain readiness and the audit rows written through the port. */
  chainReady = true;
  auditStoreDown = false;
  audits: Array<{ entry: Omit<AuditLogEntry, 'id' | 'timestamp'>; organizationId: string }> = [];
  auditChainReady(): boolean {
    return this.chainReady;
  }
  async recordAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>, organizationId: string): Promise<void> {
    if (this.auditStoreDown) throw new Error('audit store unavailable');
    this.audits.push({ entry, organizationId });
  }

  async deleteUserAccount(id: string): Promise<void> {
    this.users.delete(id);
  }

  async findApiKeyByKey(hash: string): Promise<ApiKey | null> {
    return this.revokedKeyHashes.has(hash) ? null : this.issuedKeys.get(hash) || null;
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
  async revokeApiKeysBelowEpoch(userId: string, nextEpoch: number): Promise<number> {
    const dead = [...this.issuedKeys.values()].filter(key =>
      key._userId === userId && (key._credentialEpoch ?? 0) < nextEpoch && !this.revokedKeyHashes.has(key._keyHash));
    dead.forEach(key => this.revokedKeyHashes.add(key._keyHash));
    return dead.length;
  }
  async listApiKeys(userId: string): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> {
    this.listCalls++;
    return [...this.issuedKeys.values()]
      .filter(key => key._userId === userId && !this.revokedKeyHashes.has(key._keyHash))
      .map(({ _key, _keyHash, ...key }) => key);
  }
}

/** A pass-through rate limiter: the limiter itself is covered in login-rate-limit.test.ts. */
function fakeRateLimiter(): RateLimitMiddleware {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    limit: pass,
    custom: pass,
    endpointBudget: () => ({ _max: 1, _windowMs: 1 }),
  } as unknown as RateLimitMiddleware;
}

/** The single cmdb_rt Set-Cookie of a response: its value and sorted attributes. */
function refreshCookieOf(response: request.Response): { value: string; attributes: string[] } {
  const mine = ([] as string[]).concat(response.headers['set-cookie'] ?? []).filter(c => c.startsWith(`${REFRESH_COOKIE}=`));
  expect(mine).toHaveLength(1);
  const [pair, ...attributes] = mine[0]!.split('; ');
  return { value: pair!.slice(REFRESH_COOKIE.length + 1), attributes: attributes.sort() };
}

/** The wire attributes of HAP-1211 B1/B4, written out (not from the module) so a changed attribute fails. */
const cookieAttributes = (maxAge: number, ...extra: string[]) =>
  [`Max-Age=${maxAge}`, 'Path=/api/v1/auth', 'HttpOnly', 'Secure', 'SameSite=Strict', ...extra].sort();

/** HAP-1714: a self-service password change needs a stored organization, so the seeded users have one. */
const SEED_ORGANIZATION = '0c2d6d1e-6f3a-4a51-8e0b-9d4c7f1a2b35';

/** Live API-key rows of `userId` at generation 0, with secrets the audit row must never carry. */
function seedIssuedKeys(repository: InMemoryAuthRepository, userId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    repository.issuedKeys.set(`hash-${userId}-${i}`, {
      _id: `key-id-${i}`, _key: `secret-key-${i}`, _keyHash: `hash-${userId}-${i}`, _name: `key ${i}`, _userId: userId,
      _role: 'operator', _tier: 'standard', _enabled: true, _createdAt: new Date(), _credentialEpoch: 0,
    } as ApiKey);
  }
}

describe('AuthController profile/password/account routes', () => {
  let app: express.Express;
  let repository: InMemoryAuthRepository;
  let jwtService: JWTService;
  let authService: AuthService;
  let passwordService: PasswordService;
  let victimToken: string;
  let otherUserToken: string;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    authService = new AuthService(authConfig as any, repository);
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
      _organizationId: SEED_ORGANIZATION,
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
      _organizationId: SEED_ORGANIZATION,
      _enabled: true,
      _createdAt: new Date('2024-01-01'),
      _updatedAt: new Date('2024-01-01'),
    } as User);

    victimToken = jwtService.generateAccessToken('user-1', 'alice', 'operator', undefined, 0, Math.floor(Date.now() / 1000));
    otherUserToken = jwtService.generateAccessToken('user-2', 'bob', 'viewer', undefined, 0, Math.floor(Date.now() / 1000));

    repository.apiKeys.set('alice-key', { userId: 'user-1', revoked: false });
    repository.apiKeys.set('bob-key', { userId: 'user-2', revoked: false });
  });

  /** POST /refresh with cmdb_rt=<token> (or a raw Cookie header) and, unless null, X-CMDB-Auth. */
  const refresh = (token?: string, header: string | null = AUTH_HEADER_VALUE,
    cookie = token === undefined ? undefined : `${REFRESH_COOKIE}=${token}`) => {
    const call = request(app).post('/api/v1/auth/refresh');
    if (cookie !== undefined) call.set('Cookie', cookie);
    if (header !== null) call.set(AUTH_HEADER, header);
    return call;
  };

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
        // The seeded admin's credentials, issued before this deploy (as on main: no generation claim, key generation 0).
        const preAccess = jwtService.generateAccessToken('user-admin-001', 'admin', 'admin', undefined, 0, Math.floor(Date.now() / 1000));
        const preRefresh = jwtService.generateRefreshToken('user-admin-001', 'admin', 'admin', 0, Math.floor(Date.now() / 1000));
        const preKey = 'seeded-admin-pre-issued-key';
        const { createHash } = await import('crypto');
        repository.issuedKeys.set(createHash('sha256').update(preKey).digest('hex'), {
          _id: 'k-admin', _key: preKey, _keyHash: createHash('sha256').update(preKey).digest('hex'), _name: 'admin-key',
          _userId: 'user-admin-001', _role: 'admin', _tier: 'standard', _enabled: true, _createdAt: new Date(), _credentialEpoch: 0,
        } as ApiKey);
        // The repository marks like MARK_DEFAULT_SUSPECT_CYPHER (unmarked, verified hash still current).
        jest.spyOn(repository, 'markDefaultSuspect').mockImplementation(async verified => {
          const current = repository.users.get(verified._id);
          if (!current || current._defaultPasswordSuspect === true || current._passwordHash !== verified._passwordHash) return false;
          current._defaultPasswordSuspect = true;
          return true;
        });
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

        // The refused login marked the seeded admin: every pre-issued credential is now refused.
        expect(repository.users.get('user-admin-001')!._defaultPasswordSuspect).toBe(true);
        expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${preAccess}`)).status).toBe(401);
        expect((await refresh(preRefresh)).status).toBe(401);
        expect((await request(app).get('/api/v1/auth/me').set('X-API-Key', preKey)).status).toBe(401);
      } finally {
        warnings.mockRestore();
        if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = savedNodeEnv;
      }
    }
  );

  it('N-21 (b): no auth route sets a password without an authenticated session', async () => {
    const hashes = () => [...repository.users.values()].map(u => [u._id, u._passwordHash]);
    const before = hashes();
    type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle: { stack?: Layer[] } };
    const routes = ((app as unknown as { _router: { stack: Layer[] } })._router.stack)
      .flatMap(layer => layer.handle.stack ?? [])
      .flatMap(layer => (layer.route ? Object.keys(layer.route.methods).map(method => ({ method, path: layer.route!.path })) : []));
    const body = {
      username: 'alice', password: 'correct-horse-battery-staple', currentPassword: 'correct-horse-battery-staple',
      newPassword: 'attacker-chosen-long-pass', userId: 'user-1', refreshToken: 'x',
    };

    // The inventory: a new auth route fails here until it is reviewed.
    expect(routes.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort()).toEqual([
      'DELETE /account', 'DELETE /api-key/:keyId', 'GET /api-keys', 'GET /me', 'POST /api-key', 'POST /login',
      'POST /logout', 'POST /refresh', 'POST /sessions/revoke-others', 'PUT /password', 'PUT /profile',
    ]);
    const statuses: Record<string, number> = {};
    for (const { method, path } of routes) {
      const url = `/api/v1/auth${path.replace(':keyId', 'alice-key')}`;
      statuses[`${method.toUpperCase()} ${path}`] =
        (await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(url).send(body)).status;
    }

    expect(hashes()).toEqual(before);
    // Without a session only login answers other than 401, and login verifies a password, never sets one.
    // Refresh refuses a request without X-CMDB-Auth first (403); logout only expires the cookie (HAP-1211 H1).
    expect(Object.entries(statuses).filter(([, status]) => status !== 401).map(([route, status]) => `${route} ${status}`))
      .toEqual(['POST /login 200', 'POST /refresh 403', 'POST /logout 200']);
  });

  it('returns one fixed refresh failure for invalid, expired, wrong-type, revoked, disabled, and store failures', async () => {
    const warnings = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const failed = { success: false, error: 'Authentication failed' };
    const valid = jwtService.generateRefreshToken('user-1', 'alice', 'operator', 0, Math.floor(Date.now() / 1000));
    const expired = jwt.sign(
      { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'refresh' },
      authConfig.jwt.secret, { expiresIn: -1, issuer: authConfig.jwt.issuer, audience: authConfig.jwt.audience }
    );
    try {
      for (const [token, reason] of [
        ['invalid.token.payload', 'invalid'],
        [expired, 'expired'],
        [victimToken, 'wrong_type'],
        [jwtService.generateRefreshToken('deleted-user', 'deleted', 'viewer', 0, Math.floor(Date.now() / 1000)), 'revoked'],
      ]) {
        const response = await refresh(token);
        expect([response.status, response.body]).toEqual([401, failed]);
        expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'refresh', reason });
      }
      repository.users.get('user-1')!._enabled = false;
      const disabled = await refresh(valid);
      expect([disabled.status, disabled.body]).toEqual([401, failed]);
      expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'refresh', reason: 'disabled' });
      repository.users.get('user-1')!._enabled = true;
      const lookup = jest.spyOn(repository, 'findUserById').mockRejectedValueOnce(new Error('private-driver-detail'));
      const store = await refresh(valid);
      expect([store.status, store.body]).toEqual([401, failed]);
      expect(warnings).toHaveBeenLastCalledWith('Authentication failed', { credentialType: 'refresh', reason: 'store_error' });
      expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-driver-detail');
      lookup.mockRestore();
      const success = await refresh(valid);
      expect(success.status).toBe(200);
      expect(success.body.data._accessToken).toEqual(expect.any(String));
    } finally {
      warnings.mockRestore();
    }
  });

  describe('HAP-1211 H1 refresh cookie', () => {
    const forbidden = { success: false, error: 'Forbidden' };
    let records: unknown[];
    let sensitive: string[];
    let spies: Array<{ mockRestore(): void }>;
    const record = (...args: unknown[]) => { records.push(args); };

    // Every logger level, console and stdout/stderr are captured; afterEach proves no registered value reached them.
    beforeEach(() => {
      records = [];
      sensitive = [];
      spies = [
        ...(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly', 'log'] as const).map(level =>
          jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => (record(...args), logger)) as never)),
        ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(method =>
          jest.spyOn(console, method).mockImplementation(record)),
        ...[process.stdout, process.stderr].map(stream =>
          jest.spyOn(stream, 'write').mockImplementation(((...args: unknown[]) => (record(...args), true)) as never)),
      ];
    });

    afterEach(() => {
      spies.forEach(spy => spy.mockRestore());
      const output = inspect(records, { depth: null, maxArrayLength: null, maxStringLength: null });
      expect(sensitive.length).toBeGreaterThan(0);
      expect(sensitive.filter(value => output.includes(value)).length).toBe(0);
    });

    /** A real login of alice with a runtime-built password and, unless null, X-CMDB-Auth (the web-ui sends it). */
    const login = async (header: string | null = AUTH_HEADER_VALUE) => {
      const pass = `pw-${randomUUID()}`;
      repository.users.get('user-1')!._passwordHash = await passwordService.hash(pass);
      sensitive.push(pass);
      const call = request(app).post('/api/v1/auth/login');
      if (header !== null) call.set(AUTH_HEADER, header);
      return call.send({ username: 'alice', password: pass });
    };

    it('login sets __Secure-cmdb_rt (HttpOnly, Secure, SameSite=Strict, /api/v1/auth, refresh TTL) and no body refresh token', async () => {
      // Pin the clock inside one second: generateRefreshToken reads Date.now twice (the _authTime default and jsonwebtoken's
      // iat), and Max-Age is min(TTL, authTime + cap - iat), so a wall-clock tick between the two reads yields 604799.
      spies.push(jest.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 1000) * 1000));
      const response = await login();
      expect(response.status).toBe(200);
      const cookie = refreshCookieOf(response);
      sensitive.push(cookie.value, response.body.data._accessToken);
      expect(response.headers['set-cookie'][0]).toMatch(/^__Secure-cmdb_rt=/); // the wire name, written out
      expect(Object.keys(response.body.data).sort()).toEqual(['_accessToken', '_expiresIn', '_user']);
      expect(cookie.attributes).toEqual(cookieAttributes(jwtService.getTokenExpiresIn('refresh')));
      expect(jwtService.verifyToken(cookie.value)._type).toBe('refresh');
    });

    it('HAP-1872: the login response documented in doc-site/docs/api/authentication.md has the keys the route sends', async () => {
      const docPath = 'doc-site/docs/api/authentication.md';
      const doc = readFileSync(join(__dirname, '../../../../..', docPath), 'utf8');
      const start = doc.indexOf('### Login');
      const end = doc.indexOf('### Refresh Token');
      if (start < 0 || end < start) {
        throw new Error(`${docPath} must keep a "### Login" heading followed by a "### Refresh Token" heading: this test reads the documented login response between them (found Login at ${start}, Refresh Token at ${end}). If you renamed either heading, update this test too.`);
      }
      const section = doc.slice(start, end);
      const block = /\*\*Response\*\* \(200 OK\):\s*```json\n([\s\S]*?)\n```/.exec(section);
      if (!block) {
        throw new Error(`The "### Login" section of ${docPath} must contain a "**Response** (200 OK):" line followed by a fenced json block: this test compares its keys with the route's login response.`);
      }
      const documented = JSON.parse(block[1]!);
      const response = await login();
      expect(response.status).toBe(200);
      sensitive.push(refreshCookieOf(response).value, response.body.data._accessToken);
      const keyPaths = (value: unknown, prefix = ''): string[] =>
        value !== null && typeof value === 'object'
          ? Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...keyPaths(child, `${prefix}${key}.`)])
          : [];
      expect(keyPaths(documented).sort()).toEqual(keyPaths(response.body).sort());
    });

    it('HAP-1211 F2: a login without exactly X-CMDB-Auth: 1 (all a cross-site form can send) gets the body token but no cookie', async () => {
      for (const header of [null, '0']) {
        const response = await login(header);
        sensitive.push(response.body.data?._accessToken);
        expect([response.status, Object.keys(response.body.data).sort(), response.headers['set-cookie']])
          .toEqual([200, ['_accessToken', '_expiresIn', '_user'], undefined]);
      }
    });

    it('refresh answers a fixed 403 without exactly X-CMDB-Auth: 1, before any token or store work', async () => {
      const issued = jwtService.generateRefreshToken('user-1', 'alice', 'operator', 0, Math.floor(Date.now() / 1000));
      sensitive.push(issued);
      const lookups = jest.spyOn(repository, 'findUserById');
      const verify = jest.spyOn(JWTService.prototype, 'verifyToken');
      for (const header of [null, '0', 'true', '11']) {
        const response = await refresh(issued, header);
        expect([response.status, response.body, response.headers['set-cookie']]).toEqual([403, forbidden, undefined]);
      }
      expect(lookups).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });

    it('refresh reads only one well-formed __Secure-cmdb_rt: none, legacy cmdb_rt, malformed, duplicate, oversized or a body token is 401', async () => {
      // Pin the clock inside one second: the token below carries _authTime = floor(now), and the renewed cookie's
      // Max-Age is min(TTL, authTime + cap - iat of the renewal), so a wall-clock tick between the two reads yields 604799.
      spies.push(jest.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 1000) * 1000));
      const issued = jwtService.generateRefreshToken('user-1', 'alice', 'operator', 0, Math.floor(Date.now() / 1000));
      const malformed = `bad-${randomUUID()}`;
      sensitive.push(issued, malformed);
      const lookups = jest.spyOn(repository, 'findUserById');
      for (const cookie of [
        undefined, 'other=1', `cmdb_rt=${issued}`, `${REFRESH_COOKIE}=${malformed}`, `${REFRESH_COOKIE}=${issued}; ${REFRESH_COOKIE}=${issued}`,
        `${REFRESH_COOKIE}=${issued}; pad=${'p'.repeat(8192)}`,
      ]) {
        const response = await refresh(undefined, AUTH_HEADER_VALUE, cookie).send({ refreshToken: issued });
        expect([response.status, response.body, response.headers['set-cookie']])
          .toEqual([401, { success: false, error: 'Authentication failed' }, undefined]);
      }
      expect(lookups).not.toHaveBeenCalled();

      const ok = await refresh(issued);
      expect(ok.status).toBe(200);
      const renewed = refreshCookieOf(ok);
      sensitive.push(renewed.value, ok.body.data._accessToken);
      expect(Object.keys(ok.body.data).sort()).toEqual(['_accessToken', '_expiresIn', '_user']);
      expect(jwtService.verifyToken(ok.body.data._accessToken)._type).toBe('access');
      expect(renewed.attributes).toEqual(cookieAttributes(jwtService.getTokenExpiresIn('refresh')));
      expect(jwtService.verifyToken(renewed.value)._type).toBe('refresh');
    });

    it('the web-ui header-less logout clears cmdb_rt; the next refresh from that browser jar is 401', async () => {
      // The browser jar (superagent's own jar never sends a Secure cookie over the test's plain http).
      let jar: string | undefined = refreshCookieOf(await login()).value;
      sensitive.push(jar);
      // As the current web-ui sends it: no X-CMDB-Auth, no access token, the jar's cookie.
      const out = await request(app).post('/api/v1/auth/logout').set('Cookie', `${REFRESH_COOKIE}=${jar}`);
      expect([out.status, out.body]).toEqual([200, { success: true, message: 'Logged out successfully' }]);
      const cleared = refreshCookieOf(out);
      expect(cleared).toEqual({ value: '', attributes: cookieAttributes(0, 'Expires=Thu, 01 Jan 1970 00:00:00 GMT') });
      if (cleared.attributes.includes('Max-Age=0')) jar = undefined; // RFC 6265 5.3: an expired Set-Cookie deletes it
      const next = await refresh(jar);
      expect([next.status, next.headers['set-cookie']]).toEqual([401, undefined]);
    });

    it('logout is stateless (founder H1b): a __Secure-cmdb_rt captured before logout still refreshes after it, and the refresh renews the cookie with a full TTL (sliding) within the 7-day cap', async () => {
      spies.push(jest.spyOn(Date, 'now').mockReturnValue(Math.floor(Date.now() / 1000) * 1000)); // see the login test above
      const captured = refreshCookieOf(await login()).value;
      sensitive.push(captured);
      expect((await request(app).post('/api/v1/auth/logout').set('Cookie', `${REFRESH_COOKIE}=${captured}`)).status).toBe(200);
      const replay = await refresh(captured);
      expect(replay.status).toBe(200);
      const renewed = refreshCookieOf(replay);
      sensitive.push(renewed.value, replay.body.data._accessToken);
      expect(renewed.attributes).toEqual(cookieAttributes(jwtService.getTokenExpiresIn('refresh')));
    });

    it('HP1-S6: a cmdb_rt of an older credential generation is 401 (revoked); the current one refreshes', async () => {
      repository.users.get('user-1')!._credentialEpoch = 2;
      const stale = jwtService.generateRefreshToken('user-1', 'alice', 'operator', 1, Math.floor(Date.now() / 1000));
      const current = jwtService.generateRefreshToken('user-1', 'alice', 'operator', 2, Math.floor(Date.now() / 1000));
      sensitive.push(stale, current);
      const refused = await refresh(stale);
      expect([refused.status, refused.headers['set-cookie']]).toEqual([401, undefined]);
      expect(records).toContainEqual(['Authentication failed', { credentialType: 'refresh', reason: 'revoked' }]);
      const ok = await refresh(current);
      expect(ok.status).toBe(200);
      sensitive.push(refreshCookieOf(ok).value, ok.body.data._accessToken);
    });

    describe('HAP-1285 absolute cap and password change', () => {
      const failed = { success: false, error: 'Authentication failed' };
      const DAY = 24 * 60 * 60;
      const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
      /** Pins Date.now (jsonwebtoken's clock for iat, exp and verify) to T0 + `seconds`. */
      let at: (seconds: number) => void;
      beforeEach(() => {
        const clock = jest.spyOn(Date, 'now');
        spies.push(clock);
        at = seconds => { clock.mockReturnValue(T0 + seconds * 1000); };
      });

      it('refresh is refused once now − login time exceeds 7 days, however often the cookie was renewed', async () => {
        at(0);
        let cookie = refreshCookieOf(await login()).value;
        sensitive.push(cookie);
        for (const seconds of [6 * DAY, 7 * DAY]) {
          at(seconds);
          const renewed = await refresh(cookie);
          expect(renewed.status).toBe(200);
          cookie = refreshCookieOf(renewed).value;
          sensitive.push(cookie, renewed.body.data._accessToken);
        }
        at(7 * DAY + 1);
        const lookups = jest.spyOn(repository, 'findUserById');
        const refused = await refresh(cookie);
        expect([refused.status, refused.body, refused.headers['set-cookie']]).toEqual([401, failed, undefined]);
        expect(lookups).not.toHaveBeenCalled(); // MB2: the 7-day comparison runs before any store read
        expect(records).toContainEqual(['Authentication failed', { credentialType: 'refresh', reason: 'expired' }]);
      });

      it('a refresh token without _authTime (minted before the cap) is 401 before any store read', async () => {
        const legacy = jwt.sign(
          { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'refresh', _cep: 0 },
          authConfig.jwt.secret, { expiresIn: '7d', issuer: authConfig.jwt.issuer, audience: authConfig.jwt.audience }
        );
        sensitive.push(legacy);
        const lookups = jest.spyOn(repository, 'findUserById');
        const refused = await refresh(legacy);
        expect([refused.status, refused.body, refused.headers['set-cookie']]).toEqual([401, failed, undefined]);
        expect(lookups).not.toHaveBeenCalled();
        expect(records).toContainEqual(['Authentication failed', { credentialType: 'refresh', reason: 'invalid' }]);
      });

      it.each([
        ['the revoke succeeds: the old key is gone from the listing', false],
        ['the best-effort revoke fails: the old key stays listed as not enabled', true],
      ])('a self-service password change ends every session and API key of the user; the changing device gets a new one (%s)', async (_label, revokeFails) => {
        const pass = `pw-${randomUUID()}`;
        const next = `pw-${randomUUID()}`;
        repository.users.get('user-1')!._passwordHash = await passwordService.hash(pass);
        sensitive.push(pass, next);
        const signIn = async () => {
          const response = await request(app).post('/api/v1/auth/login').set(AUTH_HEADER, AUTH_HEADER_VALUE).send({ username: 'alice', password: pass });
          expect(response.status).toBe(200);
          const session = { access: response.body.data._accessToken as string, cookie: refreshCookieOf(response).value };
          sensitive.push(session.access, session.cookie);
          return session;
        };
        const me = (token: string) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
        at(0);
        const changing = await signIn();
        const other = await signIn();
        if (revokeFails) {
          jest.spyOn(repository, 'revokeApiKeysBelowEpoch').mockRejectedValue(new Error('pg down'));
        }
        const listKeys = async (token: string) => (await request(app).get('/api/v1/auth/api-keys')
          .set('Authorization', `Bearer ${token}`)).body.data as Array<Record<string, unknown>>;
        const issued = await request(app).post('/api/v1/auth/api-key').set('Authorization', `Bearer ${other.access}`).send({ name: 'pre-change key' });
        const key = issued.body.data._apiKey as string;
        sensitive.push(key);
        expect((await listKeys(other.access)).map(k => k._enabled)).toEqual([true]);

        at(60);
        const changed = await request(app).put('/api/v1/auth/password')
          .set('Authorization', `Bearer ${changing.access}`).send({ currentPassword: pass, newPassword: next });
        expect(changed.status).toBe(200);
        const reissued = refreshCookieOf(changed);
        const access = changed.body.data._accessToken;
        sensitive.push(reissued.value, access);
        expect(Object.keys(changed.body.data).sort()).toEqual(['_accessToken', '_expiresIn', '_user']);
        expect(changed.body.message)
          .toBe('Password changed. All other sessions and all your API keys have been revoked; this device stays signed in.');
        expect(reissued.attributes).toEqual(cookieAttributes(jwtService.getTokenExpiresIn('refresh')));

        for (const old of [other.cookie, changing.cookie]) {
          const refused = await refresh(old);
          expect([refused.status, refused.body, refused.headers['set-cookie']]).toEqual([401, failed, undefined]);
        }
        expect(records).toContainEqual(['Authentication failed', { credentialType: 'refresh', reason: 'revoked' }]);
        expect((await me(other.access)).status).toBe(401);
        expect((await me(changing.access)).status).toBe(401);
        expect((await me(access)).status).toBe(200);
        // R2: the key minted before the change no longer authenticates (generation check, even if the revoke failed).
        expect((await request(app).get('/api/v1/auth/me').set('X-API-Key', key)).status).toBe(401);
        // Listing contract (HAP-1669): a revoked pre-change key is not listed; one whose revoke failed is listed as
        // not enabled, never as usable. No generation field leaks either way.
        expect((await listKeys(access)).map(k => [k._enabled, '_credentialEpoch' in k]))
          .toEqual(revokeFails ? [[false, false]] : []);
        // A key created after the change is at the new generation and is listed as enabled.
        const fresh = await request(app).post('/api/v1/auth/api-key').set('Authorization', `Bearer ${access}`).send({ name: 'post-change key' });
        sensitive.push(fresh.body.data._apiKey);
        expect((await listKeys(access)).map(k => k._enabled)).toEqual(revokeFails ? [false, true] : [true]);

        // The change is a fresh authentication: its cap runs from the change, not from the first login.
        at(7 * DAY + 1);
        const renewed = await refresh(reissued.value);
        expect(renewed.status).toBe(200);
        sensitive.push(refreshCookieOf(renewed).value, renewed.body.data._accessToken);
      });

      it.each([
        ['the revoke succeeds: the old key is gone from the listing', false],
        ['the best-effort revoke fails: the old key stays listed as not enabled', true],
      ])('HAP-1716: the revoke-others step-up ends every other session, refresh token and API key without changing the password; the calling device gets a new session (%s)', async (_label, revokeFails) => {
        const pass = `pw-${randomUUID()}`;
        repository.users.get('user-1')!._passwordHash = await passwordService.hash(pass);
        const hashBefore = repository.users.get('user-1')!._passwordHash;
        sensitive.push(pass);
        const signIn = async () => {
          const response = await request(app).post('/api/v1/auth/login').set(AUTH_HEADER, AUTH_HEADER_VALUE).send({ username: 'alice', password: pass });
          expect(response.status).toBe(200);
          const session = { access: response.body.data._accessToken as string, cookie: refreshCookieOf(response).value };
          sensitive.push(session.access, session.cookie);
          return session;
        };
        const me = (token: string) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
        const listKeys = async (token: string) => (await request(app).get('/api/v1/auth/api-keys')
          .set('Authorization', `Bearer ${token}`)).body.data as Array<Record<string, unknown>>;
        at(0);
        const calling = await signIn();
        const other = await signIn();
        if (revokeFails) jest.spyOn(repository, 'revokeApiKeysBelowEpoch').mockRejectedValue(new Error('pg down'));
        const issued = await request(app).post('/api/v1/auth/api-key').set('Authorization', `Bearer ${other.access}`).send({ name: 'pre-revoke key' });
        const key = issued.body.data._apiKey as string;
        sensitive.push(key);
        expect((await listKeys(other.access)).map(k => k._enabled)).toEqual([true]);

        at(60);
        const stepUp = await request(app).post('/api/v1/auth/sessions/revoke-others')
          .set('Authorization', `Bearer ${calling.access}`).send({ currentPassword: pass });
        expect(stepUp.status).toBe(200);
        const reissued = refreshCookieOf(stepUp);
        const access = stepUp.body.data._accessToken as string;
        sensitive.push(reissued.value, access);
        expect(repository.users.get('user-1')).toMatchObject({ _passwordHash: hashBefore, _credentialEpoch: 1 });

        for (const old of [other.cookie, calling.cookie]) {
          const refused = await refresh(old);
          expect([refused.status, refused.body, refused.headers['set-cookie']]).toEqual([401, failed, undefined]);
        }
        expect(records).toContainEqual(['Authentication failed', { credentialType: 'refresh', reason: 'revoked' }]);
        expect((await me(other.access)).status).toBe(401);
        expect((await me(calling.access)).status).toBe(401);
        expect((await me(access)).status).toBe(200);
        expect((await request(app).get('/api/v1/auth/me').set('X-API-Key', key)).status).toBe(401);
        expect((await listKeys(access)).map(k => [k._enabled, '_credentialEpoch' in k])).toEqual(revokeFails ? [[false, false]] : []);

        // The password still works (a new sign-in), and the step-up is a fresh authentication: its cap runs from now.
        expect((await request(app).post('/api/v1/auth/login').set(AUTH_HEADER, AUTH_HEADER_VALUE).send({ username: 'alice', password: pass })).status).toBe(200);
        at(7 * DAY + 1);
        const renewed = await refresh(reissued.value);
        expect(renewed.status).toBe(200);
        sensitive.push(refreshCookieOf(renewed).value, renewed.body.data._accessToken);
      });

      it('HAP-1382 L4: the cookie Max-Age never runs past the 7-day cap from login, however late it was renewed', async () => {
        at(0);
        let response = await login();
        expect(refreshCookieOf(response).attributes).toEqual(cookieAttributes(7 * DAY));
        sensitive.push(refreshCookieOf(response).value, response.body.data._accessToken);
        for (const [seconds, maxAge] of [[DAY, 6 * DAY], [6 * DAY + 3600, DAY - 3600], [7 * DAY - 30, 30], [7 * DAY, 0]]) {
          at(seconds!);
          response = await refresh(refreshCookieOf(response).value);
          expect(response.status).toBe(200);
          const renewed = refreshCookieOf(response);
          sensitive.push(renewed.value, response.body.data._accessToken);
          expect(renewed.attributes).toEqual(cookieAttributes(maxAge!));
          expect(jwt.decode(renewed.value)).toMatchObject({ _authTime: T0 / 1000 });
        }
      });

      it('HAP-1382 L4: a refresh TTL longer than the cap still gets a cookie that ends at the cap', async () => {
        at(0);
        const long = new JWTService({ ...authConfig.jwt, refreshTokenExpiresIn: '30d' } as never);
        const token = long.generateRefreshToken('user-1', 'alice', 'operator', 0, T0 / 1000 - DAY);
        sensitive.push(token);
        const cookies: string[] = [];
        setRefreshCookie({ append: (_name: string, value: string) => cookies.push(value) } as never, token);
        expect(cookies).toEqual([`${REFRESH_COOKIE}=${token}; Max-Age=${6 * DAY}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict`]);
      });
    });

    describe('HAP-1382 P-4 no-store', () => {
      const uncached = (response: request.Response) =>
        [response.headers['cache-control'], response.headers['pragma']];

      it('every token, API-key and cookie response of /auth (and their refusals) is Cache-Control: no-store, Pragma: no-cache', async () => {
        const loggedIn = await login();
        const session = { access: loggedIn.body.data._accessToken as string, cookie: refreshCookieOf(loggedIn).value };
        sensitive.push(session.access, session.cookie);
        const refreshed = await refresh(session.cookie);
        sensitive.push(refreshCookieOf(refreshed).value, refreshed.body.data._accessToken);
        const bearer = (call: request.Test) => call.set('Authorization', `Bearer ${session.access}`);
        const key = await bearer(request(app).post('/api/v1/auth/api-key')).send({ name: 'ci key' });
        sensitive.push(key.body.data._apiKey);
        const me = await bearer(request(app).get('/api/v1/auth/me'));
        const logout = await request(app).post('/api/v1/auth/logout');
        const refusedLogin = await request(app).post('/api/v1/auth/login').send({ username: 'alice', password: 'wrong-password' });
        const csrfRefused = await refresh(session.cookie, null);

        const pass = `pw-${randomUUID()}`;
        const next = `pw-${randomUUID()}`;
        repository.users.get('user-1')!._passwordHash = await passwordService.hash(pass);
        sensitive.push(pass, next);
        const changed = await bearer(request(app).put('/api/v1/auth/password')).send({ currentPassword: pass, newPassword: next });
        sensitive.push(refreshCookieOf(changed).value, changed.body.data._accessToken);

        const responses = [loggedIn, refreshed, key, me, logout, refusedLogin, csrfRefused, changed];
        expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 401, 403, 200]);
        expect(responses.map(uncached)).toEqual(responses.map(() => ['no-store', 'no-cache']));
      });
    });
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
    expect([chained.status, chained.body]).toEqual([403, expect.objectContaining({
      _error: 'Forbidden', _message: 'JWT user session required', code: 'JWT_SESSION_REQUIRED',
    })]);
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
      { method: 'post', path: '/api/v1/auth/sessions/revoke-others', body: {
        currentPassword: 'correct-horse-battery-staple', userId: 'user-2',
      } },
      { method: 'delete', path: '/api/v1/auth/account', body: undefined },
    ] as const;

    async function call(
      method: 'get' | 'delete' | 'put' | 'post', path: string, headers: Record<string, string>,
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
        expect([denied.status, denied.body]).toEqual([403, expect.objectContaining({
          _error: 'Forbidden', _message: 'JWT user session required', code: 'JWT_SESSION_REQUIRED',
        })]);
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
      } else if (path.endsWith('revoke-others')) {
        expect(repository.users.get('user-1')).toMatchObject({ _credentialEpoch: 1, _passwordHash: aliceHash });
        expect(repository.users.get('user-2')!._credentialEpoch).toBeUndefined();
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

  describe('HAP-1911 platformAdmin and organizationId from the stored principal', () => {
    const legacyKeys = ['avatar', 'createdAt', 'email', 'lastLoginAt', 'name', 'role', 'userId', 'username'];
    // HAP-1930 (BW16): additive, the role's grants from the server's own table.
    const additiveKeys = ['organizationId', 'permissions', 'platformAdmin'];
    const me = () => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${victimToken}`);
    const store = (patch: Partial<User>) => Object.assign(repository.users.get('user-1')!, patch);
    // JSON drops undefined keys, so the wire key set is what the client sees.
    const wireKeys = (res: request.Response) => Object.keys(res.body.data).sort();

    it('a tenant user sees its own organization and platformAdmin false; every existing field keeps its name and type', async () => {
      store({ _organizationId: 'org-acme', _name: 'Alice', _avatar: 'data:image/png;base64,AAAA', lastLoginAt: new Date('2024-02-02') });
      const res = await me();

      expect(res.status).toBe(200);
      expect(wireKeys(res)).toEqual([...legacyKeys, ...additiveKeys].sort());
      expect(res.body.data).toEqual({
        userId: 'user-1', username: 'alice', email: 'alice@example.com', name: 'Alice', avatar: 'data:image/png;base64,AAAA',
        role: 'operator', createdAt: '2024-01-01T00:00:00.000Z', lastLoginAt: '2024-02-02T00:00:00.000Z',
        platformAdmin: false, organizationId: 'org-acme', permissions: ['read', 'write', 'discover'],
      });
    });

    it('a user without an organization gets organizationId null, still present on the wire', async () => {
      store({ _organizationId: undefined });
      const res = await me();
      expect(res.body.data).toHaveProperty('organizationId', null);
      expect(res.body.data.platformAdmin).toBe(false);
    });

    it.each([
      ['admin', ['read', 'write', 'discover', 'admin']],
      ['operator', ['read', 'write', 'discover']],
      ['viewer', ['read']],
      ['agent', ['discover', 'write']],
    ] as const)('HAP-1930: %s gets its own role and the grants of the server role table, on GET /me and PUT /profile', async (role, permissions) => {
      store({ _role: role });
      const read = await me();
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({ role, permissions });
      const updated = await request(app).put('/api/v1/auth/profile').set('Authorization', `Bearer ${victimToken}`).send({ name: 'Same' });
      expect(updated.body.data).toMatchObject({ role, permissions });
    });

    it('HAP-1930: an API key reports the grants of its effective role (viewer key, admin owner), a JWT the stored role', async () => {
      store({ _role: 'viewer' });
      const login = await request(app).post('/api/v1/auth/login').send({ username: 'alice', password: 'correct-horse-battery-staple' });
      expect(login.status).toBe(200);
      const issued = await request(app).post('/api/v1/auth/api-key')
        .set('Authorization', `Bearer ${login.body.data._accessToken}`).send({ name: 'Viewer key' });
      expect(issued.status).toBe(200);
      store({ _role: 'admin' });

      const viaKey = await request(app).get('/api/v1/auth/me').set('X-API-Key', issued.body.data._apiKey as string);
      expect(viaKey.status).toBe(200);
      expect(viaKey.body.data.permissions).toEqual(['read']);
      const viaJwt = await me();
      expect(viaJwt.status).toBe(200);
      expect(viaJwt.body.data).toMatchObject({ role: 'admin', permissions: ['read', 'write', 'discover', 'admin'] });
    });

    it.each(['constructor', 'zzz'])('HAP-1930: an unknown stored role %s gets no permissions and a 200 on GET /me', async role => {
      store({ _role: role as User['_role'] });
      const res = await me();
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ role, permissions: [] });
    });

    it('a platform administrator gets true, on GET /me and PUT /profile', async () => {
      store({ _platformAdmin: true, _organizationId: 'org-internal' });
      expect((await me()).body.data).toMatchObject({ platformAdmin: true, organizationId: 'org-internal' });
      const updated = await request(app).put('/api/v1/auth/profile').set('Authorization', `Bearer ${victimToken}`).send({ name: 'Renamed' });
      expect(updated.body.data).toMatchObject({ name: 'Renamed', platformAdmin: true, organizationId: 'org-internal' });
    });

    it('the stored flag alone is not enough: a seeded account with the flag set gets false, on both routes', async () => {
      const env = process.env['NODE_ENV'];
      try {
        // A default-password suspect authenticates only in development, so that case runs there.
        for (const [seeded, nodeEnv] of [
          [{ _seedProvenance: 'seed-writer' }, env], [{ _username: 'admin' }, env], [{ _email: 'admin@happycmdb.local' }, env],
          [{ _defaultPasswordSuspect: true }, 'development'],
        ] as const) {
          process.env['NODE_ENV'] = nodeEnv;
          store({ _platformAdmin: true, _seedProvenance: undefined, _defaultPasswordSuspect: false, _username: 'alice', _email: 'alice@example.com', ...seeded });
          const read = await me();
          expect([read.status, read.body.data.platformAdmin]).toEqual([200, false]);
          const updated = await request(app).put('/api/v1/auth/profile').set('Authorization', `Bearer ${victimToken}`).send({ name: 'Renamed' });
          expect([updated.status, updated.body.data.platformAdmin]).toEqual([200, false]);
        }
      } finally {
        process.env['NODE_ENV'] = env;
      }
    });

    it('headers, query and body cannot change either field, and the stored value still wins', async () => {
      store({ _organizationId: 'org-acme' });
      const forged = { 'X-Organization-Id': 'org-other', 'X-Tenant-Id': 'org-other', 'X-Platform-Admin': 'true', 'X-Is-Platform-Admin': '1' };
      const res = await request(app).get('/api/v1/auth/me?organizationId=org-other&platformAdmin=true&platform_admin=true')
        .set('Authorization', `Bearer ${victimToken}`).set(forged).send({ organizationId: 'org-other', platformAdmin: true });
      expect(res.body.data).toMatchObject({ platformAdmin: false, organizationId: 'org-acme' });

      const updated = await request(app).put('/api/v1/auth/profile?platformAdmin=true').set('Authorization', `Bearer ${victimToken}`)
        .set(forged).send({ name: 'Renamed', platformAdmin: true, organizationId: 'org-other', _platformAdmin: true, _organizationId: 'org-other' });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({ platformAdmin: false, organizationId: 'org-acme' });
      expect(repository.users.get('user-1')).toMatchObject({ _organizationId: 'org-acme' });
      expect(repository.users.get('user-1')!._platformAdmin).toBeUndefined();
    });

    it('a token claim of another organization does not change the response (verifyToken replaces it with the stored one)', async () => {
      store({ _organizationId: 'org-acme' });
      const claimed = jwtService.generateAccessToken('user-1', 'alice', 'operator', 'org-other', 0, Math.floor(Date.now() / 1000));
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${claimed}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ platformAdmin: false, organizationId: 'org-acme' });
    });

    it('discloses nothing beyond the caller\'s own profile: no hash, credential epoch, seed marker, scopes or element id', async () => {
      store({ _avatar: 'data:image/png;base64,AAAA', lastLoginAt: new Date('2024-02-02'), _credentialEpoch: 7, _seedProvenance: undefined, _elementId: '4:abc:1', _scopes: ['credentials:manage'] } as Partial<User>);
      const token = jwtService.generateAccessToken('user-1', 'alice', 'operator', undefined, 7, Math.floor(Date.now() / 1000));
      const auth = { Authorization: `Bearer ${token}` };
      const bodies = [
        (await request(app).get('/api/v1/auth/me').set(auth)).body,
        (await request(app).put('/api/v1/auth/profile').set(auth).send({ name: 'x' })).body,
      ];
      for (const body of bodies) {
        const text = JSON.stringify(body);
        for (const secret of ['$2', 'correct-horse', 'credentialEpoch', '_cep', 'seedProvenance', 'credentials:manage', '4:abc:1', 'passwordHash']) {
          expect(text).not.toContain(secret);
        }
        expect(Object.keys(body.data).sort()).toEqual([...legacyKeys, ...additiveKeys].sort());
      }
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
      expect(res.body).toEqual({ success: false, error: 'Password Change Failed', message: 'Current password is incorrect' });

      const stillOldPassword = await passwordService.verify(
        'correct-horse-battery-staple',
        repository.users.get('user-1')?._passwordHash as string
      );
      expect(stillOldPassword).toBe(true);
    });

    // HAP-1382 B1/P-2/L2: a store/driver message can quote credentials or SQL; it reaches neither the body nor the log.
    it.each([
      ['post', '/api-key', { name: 'ci key' }, 'createApiKey', 0, 'API Key Generation Failed'],
      ['get', '/api-keys', undefined, 'listApiKeys', 0, 'Failed to List API Keys'],
      ['delete', '/api-key/alice-key', undefined, 'deleteApiKey', 0, 'API Key Revocation Failed'],
      ['get', '/me', undefined, 'findUserById', 1, 'Failed to Load User'],
      ['put', '/profile', { name: 'Alice Updated' }, 'updateUser', 0, 'Profile Update Failed'],
      ['put', '/password', { currentPassword: 'correct-horse-battery-staple', newPassword: 'new-password-123' },
        'updatePasswordHashGuarded', 0, 'Password Change Failed'],
      ['delete', '/account', undefined, 'deleteUserAccount', 0, 'Account Deletion Failed'],
    ] as const)('%s %s: a store failure is a fixed 500; only the error class, code and user id are logged',
      async (verb, route, body, method, passCalls, label) => {
        const needle = `needle-${randomUUID()}`;
        const storeError = Object.assign(new Error(
          `Failed: bolt://svc:${needle}@neo4j.internal:7687 password authentication failed; SELECT key_hash FROM api_keys`
        ), { code: '28P01' });
        const target = repository as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
        const original = target[method]!.bind(repository);
        let calls = 0;
        target[method] = async (...args) => {
          if (calls++ < passCalls) return original(...args); // /me: the authentication read succeeds
          throw storeError;
        };
        const levels = (['error', 'warn', 'info', 'debug'] as const).map(level =>
          jest.spyOn(logger, level).mockImplementation(() => logger));
        try {
          const call = request(app)[verb](`/api/v1/auth${route}`).set('Authorization', `Bearer ${victimToken}`);
          const res = await (body === undefined ? call : call.send(body));

          expect([res.status, res.body]).toEqual([500, { success: false, error: label, message: 'Internal error' }]);
          expect(JSON.stringify(res.headers)).not.toContain(needle);
          expect(levels[0]).toHaveBeenCalledWith(expect.any(String), { errorClass: 'Error', code: '28P01', userId: 'user-1' });
          const logged = inspect(levels.map(spy => spy.mock.calls), { depth: null, maxStringLength: null });
          for (const text of [needle, 'SELECT', 'password authentication']) expect(logged).not.toContain(text);
        } finally {
          levels.forEach(spy => spy.mockRestore());
        }
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

    describe('HAP-1368 audit', () => {
      const ORG = '5f0c7a52-3d1e-4b8a-9c61-2f4e8d7b1a03';
      // verifyToken takes the organization from the stored user, so the actor's record carries it.
      beforeEach(() => {
        repository.users.set('user-1', { ...repository.users.get('user-1')!, _organizationId: ORG });
      });
      const change = (token: string, currentPassword: string, newPassword: string) => request(app)
        .put('/api/v1/auth/password').set('Authorization', `Bearer ${token}`).send({ currentPassword, newPassword });

      it('a wrong current password writes one audit row (user, org, client address, outcome) with no secret', async () => {
        const token = jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG, 0, Math.floor(Date.now() / 1000));
        const guess = randomUUID();
        const next = randomUUID();

        expect((await change(token, guess, next)).status).toBe(400);

        expect(repository.audits).toHaveLength(1);
        expect(repository.audits[0]).toMatchObject({
          organizationId: ORG,
          entry: { entity_type: 'USER', entity_id: 'user-1', actor: 'user-1', actor_type: 'user',
            ip_address: expect.stringMatching(/127\.0\.0\.1$/), metadata: { outcome: 'wrong_password' } },
        });
        const row = JSON.stringify(repository.audits);
        for (const secret of [guess, next, token, repository.users.get('user-1')!._passwordHash]) {
          expect(row).not.toContain(secret);
        }
      });

      describe('HAP-2061 the success row records what the API-key revoke did', () => {
        const bearer = () => jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG);
        const noSecrets = () => {
          const row = JSON.stringify(repository.audits);
          for (const secret of ['key-id-', 'secret-key-', 'hash-user-1', bearer()]) expect(row).not.toContain(secret);
        };

        it.each([[0], [2]])('revoked_api_keys is the number of keys the repository revoked (%i)', async count => {
          seedIssuedKeys(repository, 'user-1', count);
          const revoke = jest.spyOn(repository, 'revokeApiKeysBelowEpoch');

          expect((await change(bearer(), 'correct-horse-battery-staple', randomUUID())).status).toBe(200);

          expect(await revoke.mock.results[0]!.value).toBe(count);
          expect(repository.audits).toHaveLength(1);
          expect(repository.audits[0]!.entry.metadata).toEqual({ operation: 'password_change', outcome: 'success', revoked_api_keys: count });
          noSecrets();
        });

        it('a failed revoke still returns the new session; the row says api_key_revoke_failed and carries no count', async () => {
          seedIssuedKeys(repository, 'user-1', 2);
          jest.spyOn(repository, 'revokeApiKeysBelowEpoch').mockRejectedValue(new Error('pg down'));
          const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
          try {
            const res = await change(bearer(), 'correct-horse-battery-staple', randomUUID());

            expect(res.status).toBe(200);
            expect(Object.keys(res.body.data).sort()).toEqual(['_accessToken', '_expiresIn', '_user']);
            expect(repository.audits).toHaveLength(1);
            expect(repository.audits[0]!.entry.metadata).toEqual({ operation: 'password_change', outcome: 'success', api_key_revoke_failed: true });
            noSecrets();
          } finally {
            warn.mockRestore();
          }
        });
      });

      it('HAP-2061: an organization change between the service read and the guarded write writes nothing and the caller gets 401 with no row', async () => {
        const before = repository.users.get('user-1')!;
        const write = repository.updatePasswordHashGuarded.bind(repository);
        const revoke = jest.spyOn(repository, 'revokeApiKeysBelowEpoch');
        jest.spyOn(repository, 'updatePasswordHashGuarded').mockImplementation(async attempt => {
          repository.users.set('user-1', { ...repository.users.get('user-1')!, _organizationId: '9d1f2c3b-7a40-4e55-8b6d-1c2e3f4a5b6c' });
          return write(attempt);
        });

        const res = await change(jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG), 'correct-horse-battery-staple', randomUUID());

        expect([res.status, res.body]).toEqual([401, { success: false, error: 'Unauthorized', message: 'Credentials changed' }]);
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(repository.users.get('user-1')).toEqual({ ...before, _organizationId: '9d1f2c3b-7a40-4e55-8b6d-1c2e3f4a5b6c' });
        expect(revoke).not.toHaveBeenCalled();
        expect(repository.audits).toEqual([]);
      });

      it('a successful change writes one audit row with outcome success', async () => {
        const token = jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG, 0, Math.floor(Date.now() / 1000));

        expect((await change(token, 'correct-horse-battery-staple', randomUUID())).status).toBe(200);

        expect(repository.audits.map(({ entry, organizationId }) => [entry.entity_id, organizationId, entry.metadata?.['outcome']]))
          .toEqual([['user-1', ORG, 'success']]);
      });

      it('with the audit chain not ready, refuses with 503 before any check and leaves the password unchanged', async () => {
        repository.chainReady = false;
        const token = jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG, 0, Math.floor(Date.now() / 1000));

        expect((await change(token, 'correct-horse-battery-staple', randomUUID())).status).toBe(503);

        expect(await passwordService.verify('correct-horse-battery-staple',
          repository.users.get('user-1')?._passwordHash as string)).toBe(true);
        expect(repository.audits).toEqual([]);
      });

      it('once the change is committed, a failed audit write still answers 200 with the new password in place', async () => {
        repository.auditStoreDown = true;
        const token = jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG, 0, Math.floor(Date.now() / 1000));
        const next = randomUUID();

        expect((await change(token, 'correct-horse-battery-staple', next)).status).toBe(200);

        expect(await passwordService.verify(next, repository.users.get('user-1')?._passwordHash as string)).toBe(true);
      });

      describe('HAP-1714 organization required', () => {
        const OTHER_ORG = '9d1f2c3b-7a40-4e55-8b6d-1c2e3f4a5b6c';
        const REFUSED = expect.objectContaining({ success: false, error: 'Forbidden', message: 'Organization required to change password', code: 'ORGANIZATION_REQUIRED' });
        const store = (patch: Partial<User>) => repository.users.set('user-1', { ...repository.users.get('user-1')!, ...patch });
        /** The request authenticates against the stored user as it is now; the service then reads it as `patch` has it. */
        const changesAfterAuthentication = (patch: Partial<User>) => {
          const read = repository.findUserById.bind(repository);
          let reads = 0;
          jest.spyOn(repository, 'findUserById').mockImplementation(async id => {
            const user = await read(id);
            return reads++ === 0 || !user ? user : { ...user, ...patch };
          });
        };
        const expectRefusedUntouched = async (res: request.Response, before: User) => {
          expect([res.status, res.body]).toEqual([403, REFUSED]);
          expect(res.headers['set-cookie']).toBeUndefined();
          expect(JSON.stringify(res.body)).not.toMatch(/_accessToken|_refreshToken/);
          expect(repository.audits).toEqual([]);
          expect(guardedWrite).not.toHaveBeenCalled();
          expect(hash).not.toHaveBeenCalled();
          expect(repository.users.get('user-1')).toEqual(before);
        };
        let guardedWrite: jest.SpiedFunction<AuthRepository['updatePasswordHashGuarded']>;
        let hash: jest.SpiedFunction<PasswordService['hash']>;
        let warn: jest.SpiedFunction<typeof logger.warn>;
        let changePassword: jest.SpiedFunction<AuthService['changePassword']>;
        beforeEach(() => {
          guardedWrite = jest.spyOn(repository, 'updatePasswordHashGuarded');
          hash = jest.spyOn(PasswordService.prototype, 'hash');
          warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
          changePassword = jest.spyOn(authService, 'changePassword');
        });
        afterEach(() => {
          hash.mockRestore();
          warn.mockRestore();
        });

        it.each([['the right', 'correct-horse-battery-staple'], ['a wrong', 'totally-wrong']])(
          'a stored user with no organization is refused with 403 whatever %s current password is sent: nothing written, nothing audited, no cookie',
          async (_label, current) => {
            store({ _organizationId: undefined });
            const before = repository.users.get('user-1')!;

            const res = await change(jwtService.generateAccessToken('user-1', 'alice', 'operator', undefined, 0, Math.floor(Date.now() / 1000)), current, randomUUID());

            await expectRefusedUntouched(res, before);
            expect(changePassword).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith('Password change refused: the user has no usable organization', { userId: 'user-1' });
            expect(JSON.stringify(warn.mock.calls)).not.toContain(current);
          }
        );

        it('a stored organization that is not a well-formed claim (no claim on the request) is refused before the service is called', async () => {
          store({ _organizationId: 'org-acme' });
          const before = repository.users.get('user-1')!;

          await expectRefusedUntouched(await change(jwtService.generateAccessToken('user-1', 'alice', 'operator', undefined, 0, Math.floor(Date.now() / 1000)),
            'correct-horse-battery-staple', randomUUID()), before);
          expect(changePassword).not.toHaveBeenCalled();
        });

        it('a stored user that lost its organization after the request authenticated is refused by the service with the same 403', async () => {
          const before = repository.users.get('user-1')!;
          changesAfterAuthentication({ _organizationId: undefined });

          await expectRefusedUntouched(await change(jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG, 0, Math.floor(Date.now() / 1000)),
            'totally-wrong', randomUUID()), before);
        });

        it('a request claim that is not the stored organization is refused with the same 403, with no row in either tenant', async () => {
          const before = repository.users.get('user-1')!;
          changesAfterAuthentication({ _organizationId: OTHER_ORG });

          await expectRefusedUntouched(await change(jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG, 0, Math.floor(Date.now() / 1000)),
            'correct-horse-battery-staple', randomUUID()), before);
        });

        it('control: a user with an organization still gets 200 and exactly one success audit row', async () => {
          const token = jwtService.generateAccessToken('user-1', 'alice', 'operator', ORG, 0, Math.floor(Date.now() / 1000));

          const res = await change(token, 'correct-horse-battery-staple', randomUUID());

          expect(res.status).toBe(200);
          expect(repository.audits.map(({ entry, organizationId }) => [organizationId, entry.metadata?.['outcome']])).toEqual([[ORG, 'success']]);
        });
      });
    });
  });

  describe('POST /sessions/revoke-others (HAP-1716)', () => {
    const PASSWORD = 'correct-horse-battery-staple';
    const OTHER_ORG = '9d1f2c3b-7a40-4e55-8b6d-1c2e3f4a5b6c';
    const token = () => jwtService.generateAccessToken('user-1', 'alice', 'operator', SEED_ORGANIZATION, 0, Math.floor(Date.now() / 1000));
    const revoke = (bearer: string, body: object = { currentPassword: PASSWORD }) =>
      request(app).post('/api/v1/auth/sessions/revoke-others').set('Authorization', `Bearer ${bearer}`).send(body);
    const stored = () => repository.users.get('user-1')!;
    const auditedOutcomes = () => repository.audits.map(({ entry }) => [entry.metadata?.['operation'], entry.metadata?.['outcome']]);
    const store = (patch: Partial<User>) => repository.users.set('user-1', { ...stored(), ...patch });
    /** The request authenticates against the stored user as it is now; the service then reads it as `after` says (null: gone). */
    const changesAfterAuthentication = (after: Partial<User> | null) => {
      const read = repository.findUserById.bind(repository);
      let reads = 0;
      jest.spyOn(repository, 'findUserById').mockImplementation(async id => {
        const user = await read(id);
        if (reads++ === 0 || !user) return user;
        return after === null ? null : { ...user, ...after };
      });
    };
    afterEach(() => jest.restoreAllMocks());

    it('returns 401 without a bearer token', async () => {
      const res = await request(app).post('/api/v1/auth/sessions/revoke-others').send({ currentPassword: PASSWORD });
      expect(res.status).toBe(401);
    });

    it('200: advances the generation by one, keeps the password, ends the user\'s API keys, sets the cookie, and audits one success row', async () => {
      const hashBefore = stored()._passwordHash;
      const revokeKeys = jest.spyOn(repository, 'revokeApiKeysBelowEpoch');

      const res = await revoke(token());

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'success']);
      expect(res.body.success).toBe(true);
      expect(Object.keys(res.body.data).sort()).toEqual(['_accessToken', '_expiresIn', '_user']);
      expect(res.body.message).toBe('All other sessions and all your API keys have been revoked (both end with the credential generation); this device stays signed in. Your password is unchanged.');
      expect(refreshCookieOf(res).attributes).toEqual(cookieAttributes(jwtService.getTokenExpiresIn('refresh')));
      expect(stored()).toMatchObject({ _credentialEpoch: 1, _passwordHash: hashBefore });
      expect(revokeKeys.mock.calls).toEqual([['user-1', 1]]);
      expect(repository.audits).toHaveLength(1);
      expect(repository.audits[0]).toMatchObject({
        organizationId: SEED_ORGANIZATION,
        entry: { entity_type: 'USER', entity_id: 'user-1', actor: 'user-1', actor_type: 'user',
          ip_address: expect.stringMatching(/127\.0\.0\.1$/), metadata: { operation: 'revoke_other_sessions', outcome: 'success' } },
      });
    });

    describe('HAP-2061 the success row records what the API-key revoke did', () => {
      it.each([[0], [2]])('revoked_api_keys is the number of keys the repository revoked (%i)', async count => {
        seedIssuedKeys(repository, 'user-1', count);
        const revokeKeys = jest.spyOn(repository, 'revokeApiKeysBelowEpoch');

        expect((await revoke(token())).status).toBe(200);

        expect(await revokeKeys.mock.results[0]!.value).toBe(count);
        expect(repository.audits).toHaveLength(1);
        expect(repository.audits[0]!.entry.metadata).toEqual({ operation: 'revoke_other_sessions', outcome: 'success', revoked_api_keys: count });
        const row = JSON.stringify(repository.audits);
        for (const secret of ['key-id-', 'secret-key-', 'hash-user-1', token()]) expect(row).not.toContain(secret);
      });

      it('a failed revoke still returns the new session; the row says api_key_revoke_failed and carries no count', async () => {
        seedIssuedKeys(repository, 'user-1', 2);
        jest.spyOn(repository, 'revokeApiKeysBelowEpoch').mockRejectedValue(new Error('pg down'));
        jest.spyOn(logger, 'warn').mockImplementation(() => logger);

        const res = await revoke(token());

        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(['_accessToken', '_expiresIn', '_user']);
        expect(stored()._credentialEpoch).toBe(1);
        expect(repository.audits).toHaveLength(1);
        expect(repository.audits[0]!.entry.metadata).toEqual({ operation: 'revoke_other_sessions', outcome: 'success', api_key_revoke_failed: true });
      });
    });

    it('HAP-2061: an organization change between the service read and the guarded write writes nothing and the caller gets 401 with no row', async () => {
      const before = stored();
      const bump = repository.bumpCredentialEpochGuarded.bind(repository);
      const revokeKeys = jest.spyOn(repository, 'revokeApiKeysBelowEpoch');
      jest.spyOn(repository, 'bumpCredentialEpochGuarded').mockImplementation(async attempt => {
        store({ _organizationId: OTHER_ORG });
        return bump(attempt);
      });

      const res = await revoke(token());

      expect([res.status, res.body]).toEqual([401, { success: false, error: 'Unauthorized', message: 'Credentials changed' }]);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(stored()).toEqual({ ...before, _organizationId: OTHER_ORG });
      expect(revokeKeys).not.toHaveBeenCalled();
      expect(repository.audits).toEqual([]);
    });

    it('400: a wrong current password changes nothing, sets no cookie and audits wrong_password with no secret in the row', async () => {
      const guess = randomUUID();
      const before = stored();

      const res = await revoke(token(), { currentPassword: guess });

      expect([res.status, res.body]).toEqual([400, { success: false, error: 'Session Revoke Failed', message: 'Current password is incorrect' }]);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(stored()).toEqual(before);
      expect(auditedOutcomes()).toEqual([['revoke_other_sessions', 'wrong_password']]);
      const row = JSON.stringify(repository.audits);
      for (const secret of [guess, PASSWORD, token(), before._passwordHash]) expect(row).not.toContain(secret);
    });

    it('400: a body without the current password is refused by validation before anything runs', async () => {
      const res = await revoke(token(), {});

      expect(res.status).toBe(400);
      expect(stored()._credentialEpoch).toBeUndefined();
      expect(repository.audits).toEqual([]);
    });

    it('401: a request whose guarded write loses to a rotation is refused with Credentials changed, no cookie, audited rotation_lost', async () => {
      jest.spyOn(repository, 'bumpCredentialEpochGuarded').mockResolvedValue(false);

      const res = await revoke(token());

      expect([res.status, res.body]).toEqual([401, { success: false, error: 'Unauthorized', message: 'Credentials changed' }]);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(auditedOutcomes()).toEqual([['revoke_other_sessions', 'rotation_lost']]);
    });

    it('401: a session of an older generation never reaches the step-up (authentication refuses it)', async () => {
      store({ _credentialEpoch: 3 });
      const stale = jwtService.generateAccessToken('user-1', 'alice', 'operator', SEED_ORGANIZATION, 2, Math.floor(Date.now() / 1000));

      const res = await revoke(stale);

      expect(res.status).toBe(401);
      expect(stored()._credentialEpoch).toBe(3);
      expect(repository.audits).toEqual([]);
    });

    it.each([
      ['a stored user with no organization and no claim', { _organizationId: undefined }, false],
      ['a stored user that lost its organization after the request authenticated', { _organizationId: undefined }, true],
      ['a request claim that is not the stored organization', { _organizationId: OTHER_ORG }, true],
    ])('403: %s is refused with a fixed body, nothing written, nothing audited, no cookie', async (_label, patch, afterAuthentication) => {
      const bearer = afterAuthentication ? token() : jwtService.generateAccessToken('user-1', 'alice', 'operator', undefined, 0, Math.floor(Date.now() / 1000));
      if (afterAuthentication) changesAfterAuthentication(patch); else store(patch);
      const before = stored();
      const bump = jest.spyOn(repository, 'bumpCredentialEpochGuarded');

      const res = await revoke(bearer);

      expect([res.status, res.body]).toEqual([403, expect.objectContaining({ success: false, error: 'Forbidden', message: 'Organization required to revoke sessions', code: 'ORGANIZATION_REQUIRED' })]);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(bump).not.toHaveBeenCalled();
      expect(repository.audits).toEqual([]);
      expect(stored()).toEqual(before);
    });

    it('404: a user that is gone after the request authenticated is a fixed 404, audited user_not_found', async () => {
      changesAfterAuthentication(null);

      const res = await revoke(token());

      expect([res.status, res.body]).toEqual([404, { success: false, error: 'Session Revoke Failed', message: 'User not found' }]);
      expect(auditedOutcomes()).toEqual([['revoke_other_sessions', 'user_not_found']]);
    });

    it('503: with the audit chain not ready the step-up is refused before any check, nothing written or audited', async () => {
      repository.chainReady = false;
      const bump = jest.spyOn(repository, 'bumpCredentialEpochGuarded');

      const res = await revoke(token());

      expect([res.status, res.body]).toEqual([503, { success: false, error: 'Service Unavailable', message: 'Session revoke temporarily unavailable' }]);
      expect(bump).not.toHaveBeenCalled();
      expect(stored()._credentialEpoch).toBeUndefined();
      expect(repository.audits).toEqual([]);
    });

    it('500: a store failure is a fixed body; only the error class and user id are logged', async () => {
      const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      jest.spyOn(repository, 'bumpCredentialEpochGuarded').mockRejectedValue(new Error('neo4j bolt://internal token=private-driver-detail'));

      const res = await revoke(token());

      expect([res.status, res.body]).toEqual([500, { success: false, error: 'Session Revoke Failed', message: 'Internal error' }]);
      expect(error.mock.calls).toEqual([['Error revoking other sessions', { errorClass: 'Error', userId: 'user-1' }]]);
      expect(JSON.stringify([res.body, error.mock.calls])).not.toContain('private-driver-detail');
    });

    it('once the generation has advanced, a failed audit write still answers 200', async () => {
      repository.auditStoreDown = true;
      jest.spyOn(logger, 'error').mockImplementation(() => logger);

      const res = await revoke(token());

      expect(res.status).toBe(200);
      expect(stored()._credentialEpoch).toBe(1);
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

  describe('API-key kill switch (auth.apiKeys.enabled false)', () => {
    const bearer = { Authorization: '' };
    let disabledApp: express.Express;

    beforeEach(() => {
      const disabledConfig = { ...authConfig, apiKeys: { ...authConfig.apiKeys, enabled: false } };
      const disabledService = new AuthService(disabledConfig as any, repository);
      const controller = new AuthController(
        disabledService, new ValidationMiddleware(), new AuthMiddleware(disabledService, disabledConfig as any), fakeRateLimiter());
      disabledApp = express();
      disabledApp.use(express.json());
      disabledApp.use('/api/v1/auth', controller.getRouter());
      bearer.Authorization = `Bearer ${victimToken}`;
    });

    it('refuses to mint a key for a valid JWT session with one fixed 403 and stores nothing', async () => {
      const res = await request(disabledApp).post('/api/v1/auth/api-key').set(bearer).send({ name: 'secret-key-name', expiresInDays: 30 });

      expect([res.status, res.body]).toEqual([403, { success: false, error: 'Forbidden', message: 'API keys are disabled' }]);
      expect(JSON.stringify(res.body)).not.toContain('_apiKey');
      expect(JSON.stringify(res.body)).not.toContain('secret-key-name');
      expect(repository.issuedKeys.size).toBe(0);
    });

    it('lists keys created while the switch was on, and revokes a key while it is off', async () => {
      const issued = await request(app).post('/api/v1/auth/api-key').set(bearer).send({ name: 'created while on' });
      expect(issued.status).toBe(200);

      const listed = await request(disabledApp).get('/api/v1/auth/api-keys').set(bearer);
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([expect.objectContaining({ _name: 'created while on' })]);

      const revoked = await request(disabledApp).delete('/api/v1/auth/api-key/alice-key').set(bearer);
      expect(revoked.status).toBe(200);
      expect(repository.apiKeys.get('alice-key')?.revoked).toBe(true);
    });
  });
});

/** The sorted-set pipeline RateLimitMiddleware runs, in memory (no Redis). */
function memoryRedis(): Redis {
  const sets = new Map<string, number[]>();
  const pipeline = () => {
    const ops: Array<() => unknown> = [];
    const chain = {
      zremrangebyscore: (key: string, _min: string, max: string) => {
        ops.push(() => sets.set(key, (sets.get(key) ?? []).filter(score => score > Number(max))));
        return chain;
      },
      zcard: (key: string) => { ops.push(() => (sets.get(key) ?? []).length); return chain; },
      zadd: (key: string, score: string) => {
        ops.push(() => sets.set(key, [...(sets.get(key) ?? []), Number(score)]));
        return chain;
      },
      expire: () => { ops.push(() => 1); return chain; },
      exec: async () => ops.map(op => [null, op()]),
    };
    return chain;
  };
  return { pipeline } as unknown as Redis;
}

describe('HAP-1211 H2 ruling A: refresh has its own rate-limit bucket at the REST budget', () => {
  const appWith = (authMax: number, restMax: number) => {
    const rateLimit = {
      enabled: true,
      bypassHeader: 'X-RateLimit-Bypass',
      tierMultipliers: { standard: 1, premium: 1, enterprise: 1 },
      endpoints: {
        auth: { max: authMax, windowMs: 60_000 },
        authAccount: { max: authMax, windowMs: 60_000 }, // HAP-1091: login's account+client bucket (schema default 5)
        authAccountGlobal: { max: authMax, windowMs: 60_000 }, // HAP-1764: login's per-account bucket (default 20)
        rest: { max: restMax, windowMs: 60_000 },
      },
      monitoring: { enabled: false, logRateLimitHits: false },
    } as unknown as ConfigSchema['rateLimit'];
    const authService = new AuthService(authConfig as any, new InMemoryAuthRepository());
    const controller = new AuthController(authService, new ValidationMiddleware(),
      new AuthMiddleware(authService, authConfig as any), new RateLimitMiddleware(memoryRedis(), rateLimit));
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', controller.getRouter());
    return app;
  };
  const statuses = async (count: number, call: () => request.Test) => {
    const seen: number[] = [];
    for (let i = 0; i < count; i++) seen.push((await call()).status);
    return seen;
  };
  const refreshes = (app: express.Express, count: number) =>
    statuses(count, () => request(app).post('/api/v1/auth/refresh').set(AUTH_HEADER, AUTH_HEADER_VALUE));
  /** Failed logins of an unknown user, each with a fresh runtime-built password. */
  const logins = (app: express.Express, count: number) => statuses(count, () => {
    const password = randomUUID();
    return request(app).post('/api/v1/auth/login').send({ username: 'nobody', password });
  });

  it.each([['a REST max of 10', 10], ['an unlimited REST max (0, addendum)', 0]])(
    'with %s, refreshes past the login max never 429 and never use up login, which still 429s at its own max',
    async (_label, restMax) => {
      const app = appWith(2, restMax);
      expect(await refreshes(app, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(await logins(app, 3)).toEqual([401, 401, 429]);
    });

  it('refresh 429s at the REST budget, under its own key', async () => {
    const app = appWith(2, 3);
    expect(await refreshes(app, 4)).toEqual([401, 401, 401, 429]);
  });
});

describe('HAP-1716 F1: the revoke-others cap is bound to the login, through real tokens, refresh, limiter and service', () => {
  const PASSWORD = 'correct-horse-battery-staple';
  const SESSION_BUDGET = 2;
  let app: express.Express;
  let repository: InMemoryAuthRepository;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    repository.users.set('user-1', {
      _id: 'user-1', _username: 'alice', _email: 'alice@example.com',
      _passwordHash: await new PasswordService(authConfig.bcrypt as any).hash(PASSWORD),
      _role: 'operator', _organizationId: SEED_ORGANIZATION, _enabled: true,
      _createdAt: new Date('2024-01-01'), _updatedAt: new Date('2024-01-01'),
    } as User);
    const window = { windowMs: 60_000 };
    const rateLimit = {
      enabled: true,
      bypassHeader: 'X-RateLimit-Bypass',
      tierMultipliers: { standard: 1, premium: 1, enterprise: 1 },
      // Per-address buckets are wide, so only the session bucket (the authAccount budget) can refuse across addresses.
      endpoints: {
        auth: { max: 50, ...window }, authAccount: { max: SESSION_BUDGET, ...window },
        authAccountGlobal: { max: 50, ...window }, rest: { max: 50, ...window },
      },
      monitoring: { enabled: false, logRateLimitHits: false },
    } as unknown as ConfigSchema['rateLimit'];
    const authService = new AuthService(authConfig as any, repository);
    app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/v1/auth', new AuthController(authService, new ValidationMiddleware(),
      new AuthMiddleware(authService, authConfig as any), new RateLimitMiddleware(memoryRedis(), rateLimit)).getRouter());
  });

  /** A login `offsetSeconds` from now: the clock is moved only while the login is minted, so each login has its own `_authTime`. */
  const loginAt = async (offsetSeconds: number) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + offsetSeconds * 1000);
    try {
      const res = await request(app).post('/api/v1/auth/login').set(AUTH_HEADER, AUTH_HEADER_VALUE)
        .send({ username: 'alice', password: PASSWORD });
      expect(res.status).toBe(200);
      return { access: res.body.data._accessToken as string, cookie: refreshCookieOf(res).value };
    } finally {
      clock.mockRestore();
    }
  };
  const renew = async (cookie: string) => {
    const res = await request(app).post('/api/v1/auth/refresh').set(AUTH_HEADER, AUTH_HEADER_VALUE)
      .set('Cookie', `${REFRESH_COOKIE}=${cookie}`);
    expect(res.status).toBe(200);
    return { access: res.body.data._accessToken as string, cookie: refreshCookieOf(res).value };
  };
  const revoke = (access: string, address: string, currentPassword: string) =>
    request(app).post('/api/v1/auth/sessions/revoke-others')
      .set({ Authorization: `Bearer ${access}`, 'X-Forwarded-For': address }).send({ currentPassword });

  it('a stolen session and its refreshed tokens share one budget across addresses; the owner\'s own login is untouched and the right password gets 200', async () => {
    const stolen = await loginAt(0);
    const refreshed = await renew(stolen.cookie);
    const refreshedAgain = await renew(refreshed.cookie);
    expect(jwt.decode(refreshedAgain.access)).toMatchObject({ _authTime: (jwt.decode(stolen.access) as { _authTime: number })._authTime });
    const owner = await loginAt(3600);

    // Fresh address each time; the three tokens are one login, whichever of them the guess comes with.
    const guesses = [stolen.access, refreshed.access, refreshedAgain.access, stolen.access];
    const statuses: number[] = [];
    for (const [i, access] of guesses.entries()) statuses.push((await revoke(access, `198.51.100.${i}`, 'not-the-password')).status);
    expect(statuses).toEqual([400, 400, 429, 429]);

    // Not even the right password passes on the stolen login's bucket.
    expect((await revoke(refreshedAgain.access, '198.51.100.99', PASSWORD)).status).toBe(429);
    expect(repository.users.get('user-1')!._credentialEpoch ?? 0).toBe(0);

    const ownerStepUp = await revoke(owner.access, '203.0.113.7', PASSWORD);
    expect([ownerStepUp.status, ownerStepUp.body.success]).toEqual([200, true]);
    expect(repository.users.get('user-1')!._credentialEpoch).toBe(1);
    // The step-up restarts the family (intended: only the right password gets here): both new tokens carry the
    // step-up's own login time, from now and never copied from the request's token; the thief's tokens are dead.
    const issued = jwt.decode(ownerStepUp.body.data._accessToken) as { _authTime: number };
    expect(Math.abs(issued._authTime - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(5);
    expect(jwt.decode(refreshCookieOf(ownerStepUp).value)).toMatchObject({ _authTime: issued._authTime });
    expect((await revoke(stolen.access, '198.51.100.200', 'x')).status).toBe(401);
  });

  it('a wrong guess never yields a new login time or any token, and a pre-claim access token is told to renew (401) without spending a bucket', async () => {
    const session = await loginAt(0);
    const wrong = await revoke(session.access, '198.51.100.1', 'not-the-password');
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).not.toMatch(/_accessToken|_refreshToken/);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const preClaim = jwt.sign(
      { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'access', _organizationId: SEED_ORGANIZATION, _cep: 0 },
      authConfig.jwt.secret,
      { expiresIn: '15m', issuer: authConfig.jwt.issuer, audience: authConfig.jwt.audience },
    );
    for (let i = 0; i < SESSION_BUDGET + 2; i++) {
      const res = await revoke(preClaim, `198.51.100.${10 + i}`, PASSWORD);
      expect([res.status, res.body.message]).toEqual([401, 'Session must be renewed']);
    }
    expect(repository.users.get('user-1')!._credentialEpoch ?? 0).toBe(0);
    // The renewed token (refresh carries the claim) works, with the one budget unit the wrong guess already spent.
    const renewed = await renew(session.cookie);
    expect((await revoke(renewed.access, '198.51.100.30', 'not-the-password')).status).toBe(400);
    expect((await revoke(renewed.access, '198.51.100.31', PASSWORD)).status).toBe(429);
  });
});
