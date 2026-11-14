// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1711: PUT /auth/password appends exactly one audit row whatever req.ip is. Mounted AuthController, real
 * AuthService/AuthMiddleware/JWT, and the real appendAuditEntry on PGlite (so Postgres `inet` decides what an
 * acceptable address is). A zone-id IPv6, a non-IP leftmost X-Forwarded-For, or an address with a /prefix is stored as
 * a null address, never dropping the row, and the rejected value is never logged.
 */
import { fork } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { logger, type AuditLogEntry, type ConfigSchema } from '@cmdb/common';
import { appendAuditEntry } from '@cmdb/database/postgres/audit.service';
import { AuthController } from '../auth.controller';
import { AuthService, PASSWORD_CHANGE_OUTCOMES, type AuthRepository, type PasswordChangeOutcome } from '../../auth/auth.service';
import { ValidationMiddleware } from '../middleware/validation.middleware';
import { AuthMiddleware } from '../../middleware/auth.middleware';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { PasswordService } from '../../auth/password.service';
import { JWTService } from '../../auth/jwt.service';
import type { User } from '../../auth/types';

process.env['AUDIT_CHAIN_KEY'] = randomBytes(32).toString('hex');

const ORG = '5f0c7a52-3d1e-4b8a-9c61-2f4e8d7b1a03';
const authConfig = {
  jwt: { secret: 'test-secret-at-least-32-characters-long', accessTokenExpiresIn: '15m', refreshTokenExpiresIn: '7d',
    issuer: 'happycmdb-test', audience: 'happycmdb-test' },
  bcrypt: { rounds: 4 },
  apiKeys: { enabled: true, headerName: 'X-API-Key' },
};

const host = fork(join(__dirname, '../routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<Record<string, any>[]>>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, any>[]; error?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(new Error(error));
  else call.resolve(rows);
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const call = Promise.withResolvers<Record<string, any>[]>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}

/** The users and the rest of the AuthRepository are in memory; recordAudit is the production writer on PGlite. */
class Repository {
  user!: User;
  /** Whether the guarded password write wins (a success) or loses to a rotation (credentials changed). */
  written = false;
  /** How many reads find the user before it vanishes: authentication finds it, the service's own read then misses. */
  readsThatFind = Infinity;
  chainReady = true;
  async findUserById(id: string) { return id === this.user._id && this.readsThatFind-- > 0 ? this.user : null; }
  async updatePasswordHashGuarded() { return this.written; }
  async recordCredentialEvent() {}
  auditChainReady() { return this.chainReady; }
  async recordAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>, organizationId: string) {
    const client = { query: async (text: string, params?: unknown[]) => ({ rows: await sql(text, params) }) } as unknown as PoolClient;
    await sql('BEGIN');
    try {
      await appendAuditEntry(client, entry, organizationId);
      await sql('COMMIT');
    } catch (error) {
      await sql('ROLLBACK');
      throw error;
    }
  }
}

const repository = new Repository();
const authService = new AuthService(authConfig as any, repository as unknown as AuthRepository);
const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
/** The client address is unavailable: req.ip itself is undefined, or the socket has no remote address (a closed peer). */
const ADDRESS_UNAVAILABLE = ['req.ip undefined', 'socket without remoteAddress'] as const;

/** Sorted sets as the sliding-window limiter uses them; `clear` is a fresh store. */
class FakeRedis {
  private sets = new Map<string, number[]>();
  clear() { this.sets.clear(); }
  pipeline() {
    const ops: Array<() => unknown> = [];
    const set = (key: string) => this.sets.get(key) ?? this.sets.set(key, []).get(key)!;
    const pipe = {
      zremrangebyscore: (key: string, _min: string, max: string) => ops.push(() => this.sets.set(key, set(key).filter(score => score > Number(max)))),
      zcard: (key: string) => ops.push(() => set(key).length),
      zadd: (key: string, score: string) => ops.push(() => set(key).push(Number(score))),
      expire: () => ops.push(() => 1),
      exec: async () => ops.map(op => [null, op()]),
    };
    return pipe;
  }
}
/** The real limiter: a generous per-client budget and a per-user budget of one, so the second change by a user is a 429. */
const redis = new FakeRedis();
const budgetWindow = { windowMs: 900_000 };
const realLimiter = new RateLimitMiddleware(redis as never, {
  enabled: true,
  bypassHeader: 'X-Internal-Service',
  tierMultipliers: { standard: 1, premium: 1, enterprise: 1 },
  endpoints: {
    rest: { max: 100, ...budgetWindow }, graphql: { max: 100, ...budgetWindow }, health: { max: 0, ...budgetWindow },
    auth: { max: 100, ...budgetWindow }, authAccount: { max: 1, ...budgetWindow }, authAccountGlobal: { max: 1, ...budgetWindow },
    discovery: { max: 100, ...budgetWindow }, admin: { max: 100, ...budgetWindow },
  },
  monitoring: { enabled: false, logRateLimitHits: false },
} as unknown as ConfigSchema['rateLimit']);

function mount(limiter: RateLimitMiddleware) {
  const mounted = express();
  mounted.set('trust proxy', 1);
  mounted.use((req, _res, next) => {
    const mode = req.get('x-test-address-unavailable');
    if (mode === ADDRESS_UNAVAILABLE[0]) Object.defineProperty(req, 'ip', { value: undefined });
    if (mode === ADDRESS_UNAVAILABLE[1]) Object.defineProperty(req.socket, 'remoteAddress', { value: undefined });
    next();
  });
  mounted.use(express.json());
  mounted.use('/api/v1/auth', new AuthController(authService, new ValidationMiddleware(),
    new AuthMiddleware(authService, authConfig as any), limiter).getRouter());
  return mounted;
}
const app = mount({ limit: pass, custom: pass, endpointBudget: () => ({ _max: 1, _windowMs: 1 }) } as unknown as RateLimitMiddleware);
const limitedApp = mount(realLimiter);
const token = new JWTService(authConfig.jwt as any).generateAccessToken('user-1', 'alice', 'operator', ORG);

const wrongPassword = (clientAddress: string) => request(app).put('/api/v1/auth/password')
  .set({ Authorization: `Bearer ${token}`, 'X-Forwarded-For': clientAddress })
  .send({ currentPassword: randomUUID(), newPassword: randomUUID() });
const audit = () => sql(`SELECT host(ip_address) AS ip, masklen(ip_address) AS mask, organization_id, metadata->>'outcome' AS outcome
  FROM audit_log ORDER BY timestamp, id`);

beforeAll(async () => {
  const migrations = join(__dirname, '../../../../database/src/postgres/migrations');
  const schema = readFileSync(join(migrations, '001_complete_schema.sql'), 'utf8');
  await sql([...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!,
    schema.match(/CREATE TABLE IF NOT EXISTS audit_log \([\s\S]*?\n\);/)![0]].join('\n'), [], 'exec');
  await sql('ALTER TABLE audit_log ADD COLUMN organization_id UUID', [], 'exec'); // 028 (its other tables are not needed)
  for (const file of ['003_audit_hash_chain.sql', '049_audit_entity_user.sql']) {
    await sql(readFileSync(join(migrations, file), 'utf8'), [], 'exec');
  }
  repository.user = {
    _id: 'user-1', _username: 'alice', _email: 'alice@example.com', _role: 'operator', _enabled: true, _organizationId: ORG,
    _passwordHash: await new PasswordService(authConfig.bcrypt as any).hash('correct-horse-battery-staple'),
    _createdAt: new Date('2024-01-01'), _updatedAt: new Date('2024-01-01'),
  } as User;
});
afterAll(() => { host.kill(); });

const NOT_AN_IP = `not-an-ip-${randomUUID()}`;
it.each([
  // [leftmost client address, stored host address (null = rejected)]
  ['fe80::1%eth0', null],
  ['fe80::1%25eth0', null],
  [NOT_AN_IP, null],
  ['192.0.2.1/24', null],
  ['2001:db8::/64', null],
  ['192.0.2.1:8080', null],
  ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
  ['192.0.2.1', '192.0.2.1'],
  ['2001:db8:0:0:0:0:0:1', '2001:db8::1'],
  ['::1', '::1'],
])('client address %j: one audit row, address %j, same outcome and org', async (clientAddress, stored) => {
  const before = (await audit()).length;
  const errors = jest.spyOn(logger, 'error');
  const warnings = jest.spyOn(logger, 'warn');
  try {
    expect((await wrongPassword(clientAddress)).status).toBe(400);

    const [row, ...extra] = (await audit()).slice(before);
    expect(extra).toEqual([]);
    expect(row).toMatchObject({ ip: stored, organization_id: ORG, outcome: 'wrong_password' });
    if (stored !== null) expect(row!['mask']).toBe(stored.includes(':') ? 128 : 32);
    expect(JSON.stringify([errors.mock.calls, warnings.mock.calls])).not.toContain(clientAddress);
    expect(errors.mock.calls).toEqual([]);
  } finally {
    errors.mockRestore();
    warnings.mockRestore();
  }
});

const STALE_CLIENT = '198.51.100.7';
const CURRENT = 'correct-horse-battery-staple';
const DEFAULT_EQUIVALENT = 'Admin123!';
const changePassword = (currentPassword: string, newPassword: string, unavailable?: (typeof ADDRESS_UNAVAILABLE)[number], target = app) =>
  request(target).put('/api/v1/auth/password')
    .set({ Authorization: `Bearer ${token}`, ...(unavailable ? { 'x-test-address-unavailable': unavailable } : { 'X-Forwarded-For': STALE_CLIENT }) })
    .send({ currentPassword, newPassword });
const rows = () => sql(`SELECT ip_address IS NULL AS no_address, to_jsonb(audit_log) - 'ip_address' AS record,
  metadata->>'outcome' AS outcome, organization_id, entity_id FROM audit_log ORDER BY timestamp, id`);
/** The response fields that must not depend on the address (the 429's countdown and the success tokens vary by time). */
const stable = (body: Record<string, unknown>) =>
  Object.fromEntries(['success', 'error', 'message', '_error', '_limit'].filter(key => key in body).map(key => [key, body[key]]));

type Scenario = {
  status: number;
  /** Runs before every attempt. */
  beforeAttempt?: () => void;
  /** The exact stable body of a refusal; absent for a success (its body carries tokens). */
  body?: Record<string, unknown>;
  currentPassword: () => string;
  newPassword: () => string;
  target?: express.Express;
  /** Runs before the rows are counted. */
  setup: () => Promise<void>;
};
const direct = { currentPassword: () => CURRENT, newPassword: () => randomUUID(), setup: async () => undefined };

/**
 * Every audited outcome has a scenario; the table is keyed by PasswordChangeOutcome and driven by
 * PASSWORD_CHANGE_OUTCOMES, so an outcome added to the code has no scenario and fails here.
 */
const outcomes: Record<PasswordChangeOutcome, Scenario> = {
  success: { ...direct, status: 200, setup: async () => { repository.written = true; } },
  wrong_password: {
    ...direct, status: 400, currentPassword: () => randomUUID(),
    body: { success: false, error: 'Password Change Failed', message: 'Current password is incorrect' },
  },
  policy_failure: {
    ...direct, status: 400, newPassword: () => DEFAULT_EQUIVALENT,
    body: { success: false, error: 'Bad Request', message: 'Password not allowed' },
  },
  rotation_lost: {
    ...direct, status: 401, body: { success: false, error: 'Unauthorized', message: 'Credentials changed' },
  },
  user_not_found: {
    ...direct, status: 404, beforeAttempt: () => { repository.readsThatFind = 1; },
    body: { success: false, error: 'Password Change Failed', message: 'User not found' },
  },
  rate_limited: {
    ...direct, status: 429, target: limitedApp, body: { _error: 'Too Many Requests', _limit: 100 },
    // The user's one change in the window is spent (a wrong password, 400, audited before the rows are counted).
    setup: async () => {
      redis.clear();
      expect((await changePassword(randomUUID(), randomUUID(), undefined, limitedApp)).status).toBe(400);
    },
  },
};

beforeEach(() => {
  repository.written = false;
  repository.readsThatFind = Infinity;
  repository.chainReady = true;
});

describe.each(PASSWORD_CHANGE_OUTCOMES)('outcome %s with the client address unavailable', outcome => {
  it.each(ADDRESS_UNAVAILABLE)('%s: same response as with an address, one null-address row, no stale address', async unavailable => {
    const scenario = outcomes[outcome];
    expect(scenario).toBeDefined();
    const errors = jest.spyOn(logger, 'error');
    const warnings = jest.spyOn(logger, 'warn');
    try {
      const attempt = async (address?: (typeof ADDRESS_UNAVAILABLE)[number]) => {
        scenario.beforeAttempt?.();
        return changePassword(scenario.currentPassword(), scenario.newPassword(), address, scenario.target);
      };
      await scenario.setup();
      // A prior client of the same user: its address must not leak into the next attempt's row.
      const before = (await rows()).length;
      const withAddress = await attempt();
      const previous = (await rows()).slice(before);
      expect(previous).toHaveLength(1);
      expect(previous[0]!['no_address']).toBe(false);

      const without = await attempt(unavailable);
      expect(without.status).toBe(scenario.status);
      expect(without.status).toBe(withAddress.status);
      expect(stable(without.body)).toEqual(stable(withAddress.body));
      if (scenario.body) expect(stable(without.body)).toEqual(scenario.body);

      const [row, ...extra] = (await rows()).slice(before + 1);
      expect(extra).toEqual([]);
      expect(row).toMatchObject({ no_address: true, outcome, organization_id: ORG, entity_id: 'user-1' });
      expect(JSON.stringify(row!['record'])).not.toMatch(new RegExp(`${STALE_CLIENT.replaceAll('.', '\\.')}|None|undefined|"null"`));
      expect(JSON.stringify([errors.mock.calls, warnings.mock.calls])).not.toContain(STALE_CLIENT);
      expect(errors.mock.calls).toEqual([]);
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });
});

it('while the audit chain is not ready the change is refused with 503 and nothing is audited (the chain cannot be written)', async () => {
  repository.chainReady = false;
  const before = (await rows()).length;
  const res = await changePassword(CURRENT, randomUUID());
  expect([res.status, res.body]).toEqual([503,
    { success: false, error: 'Service Unavailable', message: 'Password change temporarily unavailable' }]);
  expect((await rows()).length).toBe(before);
});

it('no audit row carries a password: only the fixed outcome code and operation name', async () => {
  repository.written = false;
  const guess = randomUUID();
  const next = DEFAULT_EQUIVALENT;
  const before = (await rows()).length;
  await changePassword(guess, next);
  const [row] = (await sql(`SELECT to_jsonb(audit_log) AS record FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT 1`));
  expect((await rows()).length).toBe(before + 1);
  expect(JSON.stringify(row!['record'])).not.toContain(guess);
  expect(JSON.stringify(row!['record'])).not.toContain(next);
  expect(row!['record'].metadata).toMatchObject({ operation: 'password_change', outcome: 'policy_failure' });
});
