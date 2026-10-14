// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 (v16 §1.1, acceptance N-21): default-credential refusal, the
 * defaultPasswordSuspect marker, the credential generation (credentialEpoch)
 * and the dedicated platform-admin flag, driven through the real AuthService,
 * JWTService and bcrypt against an in-memory repository whose guarded writes
 * have the compare-and-set semantics of the Neo4j statements (those statements
 * themselves run against Neo4j in
 * tests/integration/database/credential-generation.integration.test.ts).
 *
 * NODE_ENV is 'test' (Jest default) unless a case sets 'development': every
 * environment other than development refuses default credentials.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import type { Response } from 'express';
import { AuthService, AuthRepository, UserProfileUpdate } from '../auth.service';
import { JWTService } from '../jwt.service';
import { bcryptKey, isDefaultEquivalent } from '../default-credentials';
import { PasswordService } from '../password.service';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import type { ApiKey, AuthenticatedRequest, TokenPayload, User } from '../types';

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

const ORG_A = '11111111-1111-4111-8111-111111111111';
const DEFAULT = 'Admin123!';
const CYCLE = 'Admin123!\u0000'.repeat(8);
/** Strings bcrypt treats as the same key as 'Admin123!' (key = utf8(p) ‖ 0x00, cycled to 72 bytes). */
const EQUIVALENT = [CYCLE.slice(0, 59), CYCLE.slice(0, 72), CYCLE.slice(0, 80)];
const OPERATOR_PASSWORD = 'operator-chosen-16';
/** Every refused login is the same uniform failure (main #63), whatever the S6 cause. */
const INVALID = { name: 'Error', message: 'Authentication failed', reason: 'invalid' };
/** A default-equivalent login: the same failure, with only the logged reason distinct (N-21). */
const DEFAULT_REFUSED = { name: 'Error', message: 'Authentication failed', reason: 'default_credential_refused' };

type Hook = () => void | Promise<void>;
type Events = Array<{ userId: string; event: string; actor: string }>;

/** In-memory AuthRepository; guarded writes compare-and-set like their Cypher. */
class FakeRepository implements AuthRepository {
  users = new Map<string, User>();
  keys = new Map<string, ApiKey & { _credentialEpoch: number }>();
  events: Events = [];
  /** Runs when a password write or account delete is about to land (any variant). */
  beforeWrite?: Hook;
  /** Runs on every findUserById call. */
  onFindById?: Hook;

  async findUserByUsername(username: string): Promise<User | null> {
    const user = [...this.users.values()].find(u => u._username === username);
    return user ? { ...user } : null;
  }
  async findUserById(id: string): Promise<User | null> {
    await this.onFindById?.();
    const user = this.users.get(id);
    return user ? { ...user } : null;
  }
  async updateUserLastLogin(): Promise<void> {}
  async updateUser(id: string, updates: UserProfileUpdate): Promise<User> {
    const updated = { ...this.users.get(id)!, ...(updates.name !== undefined ? { _name: updates.name } : {}) };
    this.users.set(id, updated);
    return updated;
  }
  async updatePasswordHashGuarded(args: {
    userId: string; elementId?: string; credentialEpoch: number; readHash: string; newHash: string;
  }): Promise<boolean> {
    await this.beforeWrite?.();
    const user = this.users.get(args.userId);
    if (!user || (user._credentialEpoch ?? 0) !== args.credentialEpoch || user._defaultPasswordSuspect === true
      || user._passwordHash !== args.readHash) return false;
    this.users.set(args.userId, { ...user, _passwordHash: args.newHash });
    return true;
  }
  async disableUserGuarded(args: { userId: string; elementId?: string; credentialEpoch: number }): Promise<boolean> {
    await this.beforeWrite?.();
    const user = this.users.get(args.userId);
    if (!user || (user._credentialEpoch ?? 0) !== args.credentialEpoch || user._defaultPasswordSuspect === true) return false;
    this.users.set(args.userId, { ...user, _enabled: false });
    return true;
  }
  async deleteUserAccount(id: string): Promise<void> {
    if (this.beforeWrite !== undefined && this.users.get(id)?._enabled !== false) await this.beforeWrite();
    this.users.delete(id);
  }
  /** Like MARK_DEFAULT_SUSPECT_CYPHER: unmarked, and still the hash and generation of the verified read `user`. */
  async markDefaultSuspect(user: User): Promise<boolean> {
    const current = this.users.get(user._id);
    if (!current || current._defaultPasswordSuspect === true || current._passwordHash !== user._passwordHash
      || (current._credentialEpoch ?? 0) !== (user._credentialEpoch ?? 0)) return false;
    this.users.set(user._id, { ...current, _defaultPasswordSuspect: true });
    return true;
  }
  async recordCredentialEvent(event: { userId: string; event: string; actor: string }): Promise<void> {
    this.events.push(event);
  }
  async findApiKeyByKey(keyHash: string): Promise<ApiKey | null> {
    return [...this.keys.values()].find(k => k._keyHash === keyHash) ?? null;
  }
  async createApiKey(apiKey: Omit<ApiKey, 'id' | 'createdAt'>): Promise<ApiKey> {
    const created = { ...apiKey, _id: `key-${this.keys.size + 1}`, _createdAt: new Date() } as ApiKey & { _credentialEpoch: number };
    this.keys.set(created._id, created);
    return created;
  }
  async updateApiKeyLastUsed(): Promise<void> {}
  async deleteApiKey(): Promise<number> { return 0; }
  async listApiKeys(): Promise<Omit<ApiKey, '_key' | '_keyHash'>[]> { return []; }

  /** What the operator rotation does to the user node (scripts/rotate-user-password.ts). */
  rotate(id: string, newHash: string): void {
    const user = this.users.get(id)!;
    this.users.set(id, {
      ...user, _passwordHash: newHash, _defaultPasswordSuspect: false, _credentialEpoch: (user._credentialEpoch ?? 0) + 1,
    });
  }
}

let repository: FakeRepository;
let service: AuthService;
let jwt: JWTService;
let defaultHash: string;
let operatorHash: string;
const savedNodeEnv = process.env['NODE_ENV'];

function user(id: string, overrides: Partial<User> = {}): User {
  return {
    _id: id, _username: id, _email: `${id}@example.com`, _passwordHash: defaultHash, _role: 'admin',
    _enabled: true, _createdAt: new Date(), _updatedAt: new Date(), _organizationId: ORG_A, ...overrides,
  } as User;
}

async function addKey(userId: string, credentialEpoch: number): Promise<string> {
  const raw = `${userId}-key-${credentialEpoch}-${repository.keys.size}`;
  repository.keys.set(raw, {
    _id: raw, _key: raw, _keyHash: createHash('sha256').update(raw).digest('hex'), _name: 'k', _userId: userId,
    _role: 'operator', _tier: 'standard', _enabled: true, _createdAt: new Date(), _credentialEpoch: credentialEpoch,
  } as ApiKey & { _credentialEpoch: number });
  return raw;
}

beforeEach(async () => {
  defaultHash = defaultHash ?? await bcrypt.hash(DEFAULT, 4);
  operatorHash = operatorHash ?? await bcrypt.hash(OPERATOR_PASSWORD, 4);
  repository = new FakeRepository();
  service = new AuthService(authConfig, repository);
  jwt = new JWTService(authConfig.jwt);
  process.env['NODE_ENV'] = 'test';
});

afterEach(() => {
  process.env['NODE_ENV'] = savedNodeEnv;
  jest.useRealTimers();
});

describe('N-21 (a) default and bcrypt-equivalent logins are refused outside development', () => {
  it.each([DEFAULT, ...EQUIVALENT])('refuses %j for an unmarked default-hash user (reason default_credential_refused)', async password => {
    repository.users.set('u', user('u'));

    await expect(service.login({ username: 'u', password })).rejects.toMatchObject(DEFAULT_REFUSED);
  });

  it('refuses the NUL variant "Admin123!\\u0000x" by the NUL rule (reason invalid)', async () => {
    repository.users.set('u', user('u'));

    await expect(service.login({ username: 'u', password: 'Admin123!\u0000x' })).rejects.toMatchObject(INVALID);
  });

  describe('bcryptKey and isDefaultEquivalent agree with the real bcrypt binding on $2b$ hashes', () => {
    const REFERENCE = 'Admin123!';
    let reference: string;
    beforeAll(async () => {
      reference = await bcrypt.hash(REFERENCE, 4);
    });

    it('uses $2b$ hashes', () => {
      expect(reference.startsWith('$2b$')).toBe(true);
    });

    it.each([
      ['the default itself', REFERENCE, true],
      ['cycle cut at 59 bytes', CYCLE.slice(0, 59), true],
      ['cycle cut at 72 bytes', CYCLE.slice(0, 72), true],
      ['cycle cut at 80 bytes', CYCLE.slice(0, 80), true],
      ['near miss Admin123!x', 'Admin123!x', false],
      ['near miss Admin123', 'Admin123', false],
      ['near miss admin123!', 'admin123!', false],
      ['near miss: cycle cut at 60 bytes', CYCLE.slice(0, 60), false],
      ['near miss: cycle cut at 70 bytes', CYCLE.slice(0, 70), false],
      ['near miss: cycle cut at 71 bytes', CYCLE.slice(0, 71), false],
    ] as Array<[string, string, boolean]>)('%s', async (_label, candidate, equivalent) => {
      const real = await bcrypt.compare(candidate, reference);

      expect(real).toBe(equivalent);
      expect(bcryptKey(candidate).equals(bcryptKey(REFERENCE))).toBe(real);
      expect(isDefaultEquivalent(candidate)).toBe(real);
    });
  });

  it('marks the account on the first matching default login and audits only that transition', async () => {
    repository.users.set('u', user('u'));

    for (let i = 0; i < 10; i++) {
      await expect(service.login({ username: 'u', password: DEFAULT })).rejects.toMatchObject(DEFAULT_REFUSED);
    }

    expect(repository.users.get('u')!._defaultPasswordSuspect).toBe(true);
    expect(repository.events).toEqual([{ userId: 'u', event: 'default_marker_set_login', actor: 'u' }]);
  });

  it('never marks an account whose stored hash is not a default', async () => {
    repository.users.set('o', user('o', { _passwordHash: operatorHash }));

    await expect(service.login({ username: 'o', password: DEFAULT })).rejects.toMatchObject(DEFAULT_REFUSED);

    expect(repository.users.get('o')!._defaultPasswordSuspect).toBeUndefined();
    expect(repository.events).toEqual([]);
  });

  it('development keeps the seeded default login working', async () => {
    process.env['NODE_ENV'] = 'development';
    repository.users.set('admin', user('admin', { _defaultPasswordSuspect: true }));

    const result = await service.login({ username: 'admin', password: DEFAULT });

    expect(result._accessToken).toEqual(expect.any(String));
  });
});

describe('N-21 (b) a marked account cannot log in or use any credential until operator rotation', () => {
  it('refuses a correct non-default password while marked (direct-DB rehash does not unlock)', async () => {
    repository.users.set('m', user('m', { _passwordHash: operatorHash, _defaultPasswordSuspect: true }));

    await expect(service.login({ username: 'm', password: OPERATOR_PASSWORD })).rejects.toMatchObject(INVALID);
  });

  it('refuses access tokens, refresh tokens and API keys of a marked user', async () => {
    repository.users.set('m', user('m', { _defaultPasswordSuspect: true }));
    const access = jwt.generateAccessToken('m', 'm', 'admin', ORG_A);
    const refresh = jwt.generateRefreshToken('m', 'm', 'admin');
    const key = await addKey('m', 0);

    await expect(service.verifyToken(access)).rejects.toThrow();
    await expect(service.refreshToken({ refreshToken: refresh })).rejects.toThrow();
    await expect(service.verifyApiKey(key)).rejects.toThrow();
  });

  it('honours the underscore spelling of the marker too (fail-closed mapping)', async () => {
    repository.users.set('m', user('m', { _passwordHash: operatorHash, _defaultPasswordSuspect: true }));

    await expect(service.login({ username: 'm', password: OPERATOR_PASSWORD })).rejects.toMatchObject(INVALID);
  });
});

describe('N-21 (c)/(d) the credential generation kills every pre-rotation credential, independent of clocks', () => {
  it.each([-10, 0, 10])('API clock skewed %i min: pre-rotation access, refresh and key are refused; new ones work', async skew => {
    jest.useFakeTimers({ now: Date.now() + skew * 60_000, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));
    const before = await service.login({ username: 'u', password: OPERATOR_PASSWORD });
    const oldKey = await addKey('u', 0);

    repository.rotate('u', operatorHash);

    await expect(service.verifyToken(before._accessToken)).rejects.toThrow();
    await expect(service.refreshToken({ refreshToken: before._refreshToken })).rejects.toThrow();
    await expect(service.verifyApiKey(oldKey)).rejects.toThrow();

    const after = await service.login({ username: 'u', password: OPERATOR_PASSWORD });
    const verified = await service.verifyToken(after._accessToken);
    expect(verified._cep).toBe(1);
    const refreshed = await service.refreshToken({ refreshToken: after._refreshToken });
    await expect(service.verifyToken(refreshed._accessToken)).resolves.toMatchObject({ _userId: 'u' });
    await expect(service.verifyApiKey(await addKey('u', 1))).resolves.toMatchObject({ _userId: 'u', _cep: 1 });
  });

  it('a key created in flight by a pre-rotation credential is born dead', async () => {
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));
    const authorizing = await service.verifyToken(jwt.generateAccessToken('u', 'u', 'admin', ORG_A));
    repository.rotate('u', operatorHash);

    const created = await service.generateApiKey('u', { name: 'late' }, authorizing._cep!);

    await expect(service.verifyApiKey(created._apiKey)).rejects.toThrow();
  });

  it('a malformed stored generation refuses every credential', async () => {
    repository.users.set('u', user('u', { _passwordHash: operatorHash, _credentialEpoch: Number.NaN }));

    await expect(service.login({ username: 'u', password: OPERATOR_PASSWORD })).rejects.toMatchObject(INVALID);
    await expect(service.verifyToken(jwt.generateAccessToken('u', 'u', 'admin', ORG_A))).rejects.toThrow();
  });
});

describe('N-21 (i) login race: a rotation committing during login yields no usable token', () => {
  it('re-checks the user after bcrypt and refuses when the generation moved', async () => {
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));
    repository.onFindById = () => {
      repository.onFindById = undefined;
      repository.rotate('u', operatorHash);
    };

    await expect(service.login({ username: 'u', password: OPERATOR_PASSWORD })).rejects.toMatchObject(INVALID);
  });
});

describe('N-21 (h5) in-flight self-service writes across a live rotation (SEC16-01)', () => {
  it('a password change authorized before the rotation cannot overwrite the operator hash', async () => {
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));
    const authorizing = await service.verifyToken(jwt.generateAccessToken('u', 'u', 'admin', ORG_A));
    const rotated = await bcrypt.hash('rotated-by-operator', 4);
    repository.beforeWrite = () => {
      repository.beforeWrite = undefined;
      repository.rotate('u', rotated);
    };

    await expect(service.changePassword('u', OPERATOR_PASSWORD, 'attacker-chosen-pass', authorizing._cep!))
      .rejects.toThrow('Credentials changed');

    expect(repository.users.get('u')!._passwordHash).toBe(rotated);
  });

  it('an account delete authorized before the rotation is refused and the account survives', async () => {
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));
    const authorizing = await service.verifyToken(jwt.generateAccessToken('u', 'u', 'admin', ORG_A));
    repository.beforeWrite = () => {
      repository.beforeWrite = undefined;
      repository.rotate('u', operatorHash);
    };

    await expect(service.deleteAccount('u', authorizing._cep!)).rejects.toThrow('Credentials changed');

    expect(repository.users.has('u')).toBe(true);
  });

  it('an unraced password change still works', async () => {
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));
    const authorizing = await service.verifyToken(jwt.generateAccessToken('u', 'u', 'admin', ORG_A));

    await service.changePassword('u', OPERATOR_PASSWORD, 'a-new-long-password', authorizing._cep!);

    await expect(service.login({ username: 'u', password: 'a-new-long-password' })).resolves.toBeDefined();
  });
});

describe('N-21 new-password rules (every environment)', () => {
  it.each(['test', 'development', 'production'])('NODE_ENV=%s: default, default-equivalent, NUL and >72-byte passwords → Password not allowed', async env => {
    process.env['NODE_ENV'] = env;
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));

    for (const newPassword of [DEFAULT, CYCLE.slice(0, 72), 'long-enough\u0000x', 'é'.repeat(37)]) {
      await expect(service.changePassword('u', OPERATOR_PASSWORD, newPassword, 0)).rejects.toThrow('Password not allowed');
    }
    expect(repository.users.get('u')!._passwordHash).toBe(operatorHash);
  });
});

describe('N-21 SEC12-02: per-request paths never run bcrypt; a non-bcrypt hash is a plain refusal', () => {
  it('verifyToken, refreshToken and verifyApiKey make zero bcrypt calls', async () => {
    repository.users.set('u', user('u', { _passwordHash: operatorHash }));
    const login = await service.login({ username: 'u', password: OPERATOR_PASSWORD });
    const key = await addKey('u', 0);
    const compare = jest.spyOn(PasswordService.prototype, 'verify');
    const hash = jest.spyOn(PasswordService.prototype, 'hash');

    await service.verifyToken(login._accessToken);
    await service.refreshToken({ refreshToken: login._refreshToken });
    await service.verifyApiKey(key);

    expect(compare).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it.each([['missing', undefined], ['plaintext', 'Admin123!'], ['garbage', '$2b$xx']])(
    'a %s stored hash gives the same 401 without throwing', async (_label, stored) => {
      repository.users.set('n', user('n', { _passwordHash: stored as string }));

      await expect(service.login({ username: 'n', password: 'some-other-password' })).rejects.toMatchObject(INVALID);
    }
  );
});

describe('N-21 P-6 dedicated platform-admin flag with seeded-account exclusion', () => {
  const access = (id: string) => jwt.generateAccessToken(id, id, 'admin', ORG_A);
  type Outcome = { status: number; body: unknown; nextCalled: boolean };
  const response = () => ({ statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } });

  /** authenticate() then requirePlatformAdmin(), as a mounted platform route would run them. */
  async function gate(headers: Record<string, string>): Promise<Outcome> {
    const middleware = new AuthMiddleware(service, authConfig as never);
    const req = { headers } as unknown as AuthenticatedRequest;
    const res = response();
    let authenticated = false;
    await middleware.authenticate()(req, res as unknown as Response, () => { authenticated = true; });
    if (!authenticated) {
      return { status: res.statusCode, body: res.body, nextCalled: false };
    }
    let nextCalled = false;
    await middleware.requirePlatformAdmin()(req, res as unknown as Response, () => { nextCalled = true; });
    return { status: res.statusCode, body: res.body, nextCalled };
  }
  const bearer = (id: string) => ({ authorization: `Bearer ${access(id)}` });
  const FORBIDDEN = { status: 403, nextCalled: false, body: { success: false, error: 'Forbidden', message: 'Platform administrator required' } };

  it('grants platform admin only from the flag, never from role or org', async () => {
    repository.users.set('p', user('p', { _passwordHash: operatorHash, _platformAdmin: true, _role: 'viewer' }));
    repository.users.set('r', user('r', { _passwordHash: operatorHash, _organizationId: '00000000-0000-0000-0000-000000000000' }));

    expect(await gate(bearer('p'))).toMatchObject({ status: 200, nextCalled: true });
    expect(await gate(bearer('r'))).toEqual(FORBIDDEN);
  });

  it('is decided from the store on each request: revoking the flag denies an already-issued token', async () => {
    repository.users.set('p', user('p', { _passwordHash: operatorHash, _platformAdmin: true }));
    const headers = bearer('p');
    expect(await gate(headers)).toMatchObject({ nextCalled: true });

    repository.users.set('p', { ...repository.users.get('p')!, _platformAdmin: false });
    expect(await gate(headers)).toEqual(FORBIDDEN);
  });

  it.each([
    ['seed provenance', { _seedProvenance: 'seed-data' }],
    ['the init-neo4j seed id', { _id: 'user-admin-001' }],
    ['the admin username', { _username: 'ADMIN' }],
    ['the seeded admin email', { _email: 'Admin@HappyCMDB.local' }],
  ] as Array<[string, Partial<User>]>)('a seeded account (%s) never qualifies, whatever its flag', async (_label, overrides) => {
    const id = overrides._id ?? 's';
    repository.users.set(id, user(id, { _passwordHash: operatorHash, _platformAdmin: true, ...overrides }));

    expect(await gate(bearer(id))).toEqual(FORBIDDEN);
  });

  it('API keys never carry platform admin, even for a flagged user', async () => {
    repository.users.set('p', user('p', { _passwordHash: operatorHash, _platformAdmin: true }));

    expect(await gate({ 'x-api-key': await addKey('p', 0) })).toEqual(FORBIDDEN);
  });

  it('a request identity claiming the marker grants nothing', async () => {
    repository.users.set('r', user('r', { _passwordHash: operatorHash }));
    const req = { headers: {}, user: { _userId: 'r', _role: 'viewer', _platformAdmin: true } as unknown as TokenPayload,
      credentialType: 'jwt' } as unknown as AuthenticatedRequest;
    const res = response();
    let nextCalled = false;
    await new AuthMiddleware(service, authConfig as never).requirePlatformAdmin()(req, res as unknown as Response, () => { nextCalled = true; });
    expect({ status: res.statusCode, body: res.body, nextCalled }).toEqual(FORBIDDEN);
  });
});
