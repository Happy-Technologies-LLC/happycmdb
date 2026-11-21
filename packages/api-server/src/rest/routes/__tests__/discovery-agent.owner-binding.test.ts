// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery agents are bound to the principal that registered them (migration 057, owner_user_id), exercised through
 * the real discoveryAgentRoutes + DiscoveryAgentController + DiscoveryAgentService behind the real AuthMiddleware
 * (JWT and API-key verification) at the production path, over real PostgreSQL (PGlite hosted by fixtures/pglite-host.cjs,
 * the discovery_agents DDL of 001 plus organization_id and the real 057 file).
 *
 * Substitutions: Neo4jAuthRepository -> in-memory users/API keys; getPostgresClient -> IPC client to PGlite;
 * getRedisClient -> an in-memory sorted-set store behind the REAL RateLimitMiddleware.
 */

import { fork } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
  // The limiter's metrics interval is not unref'd.
  RATE_LIMIT_MONITORING_ENABLED: 'false',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
type Result = { rows: unknown[]; rowCount?: number };
const pending = new Map<number, { resolve: (result: Result) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, rowCount, error }: { id: number; rows: unknown[]; rowCount?: number; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve({ rows, rowCount });
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<Result> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const rows = async <T>(sql: string, params: unknown[] = []) => (await send('query', sql, params)).rows as T[];

// Plain functions: the unit config resets mock implementations.
const pgClient = {
  query: (sql: string, params: unknown[] = []) => send('query', sql, params),
  getClient: async () => ({ query: pgClient.query, release: () => undefined }),
};

/** The sorted-set pipeline RateLimitMiddleware runs, in memory. */
function memoryRedis() {
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
  return { pipeline, reset: () => sets.clear() };
}
const redis = memoryRedis();

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getRedisClient: () => ({ getConnection: () => redis }),
}));
jest.mock('bcrypt', () => ({}));

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
type TestUser = { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId: string };
const user = (id: string, role: string, org = ORG): TestUser =>
  ({ _id: id, _username: id, _role: role, _enabled: true, _organizationId: org });
const USERS: Record<string, TestUser> = Object.fromEntries([
  user('agent-a', 'agent'), user('agent-b', 'agent'), user('operator-1', 'operator'), user('admin-1', 'admin'),
  user('operator-2', 'operator', OTHER_ORG),
].map(u => [u._id, u]));
const API_KEY_A1 = randomBytes(32).toString('hex');
const API_KEYS: Record<string, { _id: string; _userId: string; _role: string; _enabled: boolean }> = {
  [createHash('sha256').update(API_KEY_A1).digest('hex')]: { _id: 'key-a1', _userId: 'agent-a', _role: 'agent', _enabled: true },
};
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async (keyHash: string) => API_KEYS[keyHash] ?? null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { discoveryAgentRoutes } from '../discovery-agent.routes';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const jwt = new JWTService(loadConfig().auth.jwt);
const as = (userId: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(
    userId, USERS[userId]!._username, USERS[userId]!._role as 'agent', USERS[userId]!._organizationId, 0, Math.floor(Date.now() / 1000),
  )}`,
});

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/agents', discoveryAgentRoutes);

const NOT_FOUND = { success: false, error: 'Agent not found' };
const OLD = '2026-01-01T00:00:00.000Z';
const registration = { hostname: 'worker', provider_capabilities: ['nmap'], reachable_networks: ['8.8.8.0/24'] };
const migration057 = () => send('exec', `BEGIN;\n${readFileSync(join(MIGRATIONS, '057_discovery_agents_owner.sql'), 'utf8')}\nCOMMIT;`);

type AgentRow = { agent_id: string; owner_user_id: string | null; status: string; hostname: string;
  total_jobs_completed: number; last_heartbeat_at: Date };
const agent = async (id: string) => (await rows<AgentRow>(
  'SELECT agent_id, owner_user_id, status, hostname, total_jobs_completed, last_heartbeat_at FROM discovery_agents WHERE agent_id = $1', [id],
))[0];

const register = (userId: string, body: Record<string, unknown> = {}) =>
  request(app).post('/api/v1/agents/register').set(as(userId)).send({ ...registration, ...body });
const heartbeat = (userId: string, agentId: string, status = 'active', stats: Record<string, number> = { jobs_completed: 5 }) =>
  request(app).post('/api/v1/agents/heartbeat').set(as(userId)).send({ agent_id: agentId, status, stats });
const remove = (userId: string, agentId: string) => request(app).delete(`/api/v1/agents/${agentId}`).set(as(userId));

// Pre-057 rows exist before the column does: ownerless, as every legacy agent is.
const LEGACY = 'agent-legacy';
beforeAll(async () => {
  const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const table = schema.match(/CREATE TABLE IF NOT EXISTS discovery_agents \([\s\S]*?\n\);/)![0];
  await send('exec', `${table}\nALTER TABLE discovery_agents ADD COLUMN organization_id UUID;`);
  await send('query', `INSERT INTO discovery_agents (agent_id, hostname, organization_id, last_heartbeat_at, status)
    VALUES ($1, 'legacy-host', $2::uuid, $3::timestamptz, 'active')`, [LEGACY, ORG, OLD]);
  await migration057();
}, 60_000);
afterAll(() => {
  host.kill();
});

/** Two agents of ORG, one per agent-role user, plus the ownerless legacy one, all with an old heartbeat. */
async function seed() {
  await send('query', `DELETE FROM discovery_agents WHERE agent_id <> $1`, [LEGACY]);
  await send('query', `UPDATE discovery_agents SET status = 'active', hostname = 'legacy-host', owner_user_id = NULL,
    total_jobs_completed = 0, last_heartbeat_at = $1::timestamptz WHERE agent_id = $2`, [OLD, LEGACY]);
  for (const [id, owner] of [['agent-of-a', 'agent-a'], ['agent-of-b', 'agent-b']]) {
    await send('query', `INSERT INTO discovery_agents (agent_id, hostname, organization_id, owner_user_id, last_heartbeat_at, status)
      VALUES ($1, $2, $3::uuid, $4, $5::timestamptz, 'active')`, [id, `${id}-host`, ORG, owner, OLD]);
  }
}
beforeEach(async () => {
  redis.reset(); // a fresh rate-limit window per test
  await seed();
});

describe('migration 057_discovery_agents_owner', () => {
  it('leaves a pre-existing row ownerless and re-applies cleanly', async () => {
    expect((await agent(LEGACY))?.owner_user_id).toBeNull();
    await migration057();
    expect((await agent(LEGACY))?.owner_user_id).toBeNull();
  });
});

describe('registration records the issuing principal', () => {
  it('stores the verified user id, whether the credential is a JWT or an API key of that user', async () => {
    const created = await register('agent-a');
    expect(created.status).toBe(200);
    const id = created.body.data.agent_id as string;
    expect((await agent(id))?.owner_user_id).toBe('agent-a');
    // The API key authenticates as its owning user, so it is the same principal as that user's JWT.
    const viaKey = await request(app).post('/api/v1/agents/heartbeat').set('X-API-Key', API_KEY_A1)
      .send({ agent_id: id, status: 'active' });
    expect(viaKey.status).toBe(200);
    expect(created.body.data).not.toHaveProperty('owner_user_id');
  });
});

describe('an agent-role credential only controls the agents it registered', () => {
  it('cannot heartbeat a peer agent of the same organization, and the refusal reads like a missing agent', async () => {
    const missing = await heartbeat('agent-b', 'agent-missing');
    const peer = await heartbeat('agent-b', 'agent-of-a', 'offline', { jobs_completed: 900_000 });
    expect([peer.status, peer.body]).toEqual([404, NOT_FOUND]);
    expect([missing.status, missing.body]).toEqual([404, NOT_FOUND]);
    const row = await agent('agent-of-a');
    expect([row?.status, row?.total_jobs_completed, row?.last_heartbeat_at.toISOString()]).toEqual(['active', 0, OLD]);
  });

  it('cannot re-register a peer agent, rewriting its endpoint and networks', async () => {
    const peer = await register('agent-b', { agent_id: 'agent-of-a', hostname: 'intruder', reachable_networks: ['1.1.1.0/24'] });
    const missing = await register('agent-b', { agent_id: 'agent-missing', hostname: 'intruder' });
    expect([peer.status, peer.body]).toEqual([404, NOT_FOUND]);
    expect([missing.status, missing.body]).toEqual([404, NOT_FOUND]);
    expect((await agent('agent-of-a'))?.hostname).toBe('agent-of-a-host');
  });

  it('cannot delete a peer agent', async () => {
    const peer = await remove('agent-b', 'agent-of-a');
    expect([peer.status, peer.body]).toEqual([404, NOT_FOUND]);
    expect(await agent('agent-of-a')).toBeDefined();
  });

  it('keeps full control of its own agent', async () => {
    expect((await heartbeat('agent-a', 'agent-of-a', 'active', { jobs_completed: 5 })).status).toBe(200);
    expect((await heartbeat('agent-a', 'agent-of-a', 'inactive', { jobs_completed: 2 })).status).toBe(200);
    const row = await agent('agent-of-a');
    expect([row?.status, row?.total_jobs_completed]).toEqual(['inactive', 7]);
    const renamed = await register('agent-a', { agent_id: 'agent-of-a', hostname: 'renamed' });
    expect([renamed.status, renamed.body.data.hostname]).toEqual([200, 'renamed']);
    expect((await remove('agent-a', 'agent-of-a')).status).toBe(200);
    expect(await agent('agent-of-a')).toBeUndefined();
  });

  it('cannot touch an ownerless (pre-057) agent in any way', async () => {
    expect((await heartbeat('agent-a', LEGACY)).status).toBe(404);
    expect((await register('agent-a', { agent_id: LEGACY, hostname: 'claimed' })).status).toBe(404);
    expect((await remove('agent-a', LEGACY)).status).toBe(404);
    const row = await agent(LEGACY);
    expect([row?.owner_user_id, row?.hostname, row?.total_jobs_completed]).toEqual([null, 'legacy-host', 0]);
  });
});

describe('operator and admin keep organization-wide control', () => {
  it.each(['operator-1', 'admin-1'])('%s can heartbeat, re-register and delete any agent of its organization', async (caller) => {
    expect((await heartbeat(caller, 'agent-of-a', 'inactive', { jobs_completed: 3 })).status).toBe(200);
    const row = await agent('agent-of-a');
    expect([row?.status, row?.total_jobs_completed]).toEqual(['inactive', 3]);
    expect((await register(caller, { agent_id: 'agent-of-a', hostname: 'by-operator' })).body.data.hostname).toBe('by-operator');
    // Control is not ownership: the registering agent credential still owns it and still reaches it.
    expect((await agent('agent-of-a'))?.owner_user_id).toBe('agent-a');
    expect((await heartbeat('agent-a', 'agent-of-a')).status).toBe(200);
    expect((await remove(caller, 'agent-of-b')).status).toBe(200);
  });

  it('never reaches an agent of another organization', async () => {
    const response = await heartbeat('operator-2', 'agent-of-a');
    expect([response.status, response.body]).toEqual([404, NOT_FOUND]);
    expect((await register('operator-2', { agent_id: 'agent-of-a' })).status).toBe(404);
    expect((await remove('operator-2', 'agent-of-a')).status).toBe(404);
  });

  it('claims an ownerless agent by re-registering it; an agent-role credential is still refused', async () => {
    const claimed = await register('operator-1', { agent_id: LEGACY, hostname: 'reclaimed' });
    expect([claimed.status, claimed.body.data.hostname]).toEqual([200, 'reclaimed']);
    expect((await agent(LEGACY))?.owner_user_id).toBe('operator-1');
    expect((await heartbeat('agent-a', LEGACY)).status).toBe(404);
    // A later re-registration by another operator/admin never rewrites an owner.
    await register('admin-1', { agent_id: LEGACY });
    expect((await agent(LEGACY))?.owner_user_id).toBe('operator-1');
  });

  it('a new agent registered by an operator is owned by that operator, out of reach of agent-role credentials', async () => {
    const id = (await register('operator-1')).body.data.agent_id as string;
    expect((await agent(id))?.owner_user_id).toBe('operator-1');
    expect((await heartbeat('agent-a', id)).status).toBe(404);
  });
});

describe('disabled is operator-only', () => {
  it('a heartbeat from the owning agent credential cannot move its agent out of disabled', async () => {
    expect((await heartbeat('operator-1', 'agent-of-a', 'disabled', {})).status).toBe(200);
    expect((await agent('agent-of-a'))?.status).toBe('disabled');

    const beat = await heartbeat('agent-a', 'agent-of-a', 'active', { jobs_completed: 4 });
    expect(beat.status).toBe(200);
    const row = await agent('agent-of-a');
    // Only the status is held: the heartbeat itself (counters, liveness) is still recorded.
    expect([row?.status, row?.total_jobs_completed]).toEqual(['disabled', 4]);
    expect(row?.last_heartbeat_at.toISOString()).not.toBe(OLD);
  });

  it('re-registration by the owning agent credential cannot move its agent out of disabled either', async () => {
    await heartbeat('operator-1', 'agent-of-a', 'disabled', {});
    const renamed = await register('agent-a', { agent_id: 'agent-of-a', hostname: 'renamed' });
    expect([renamed.status, renamed.body.data.status, renamed.body.data.hostname]).toEqual([200, 'disabled', 'renamed']);
    expect((await agent('agent-of-a'))?.status).toBe('disabled');
  });

  it('an agent-role credential cannot set disabled, and learns nothing about any agent from the refusal', async () => {
    for (const target of ['agent-of-a', 'agent-of-b', LEGACY, 'agent-missing']) {
      const response = await heartbeat('agent-a', target, 'disabled', {});
      expect([response.status, response.body.code]).toEqual([403, 'ROLE_REQUIRED']);
    }
    expect([(await agent('agent-of-a'))?.status, (await agent('agent-of-b'))?.status]).toEqual(['active', 'active']);
  });

  it('an operator disables and re-enables through the heartbeat, and re-registering re-enables', async () => {
    await heartbeat('operator-1', 'agent-of-a', 'disabled', {});
    expect((await agent('agent-of-a'))?.status).toBe('disabled');
    await heartbeat('admin-1', 'agent-of-a', 'active', {});
    expect((await agent('agent-of-a'))?.status).toBe('active');
    await heartbeat('operator-1', 'agent-of-a', 'disabled', {});
    await register('operator-1', { agent_id: 'agent-of-a' });
    expect((await agent('agent-of-a'))?.status).toBe('active');
  });
});

describe('heartbeat rate limit (600 per principal per hour)', () => {
  const invalid = (userId: string) =>
    request(app).post('/api/v1/agents/heartbeat').set(as(userId)).send({ agent_id: 'agent-of-b', status: 'bogus' });

  it('refuses the 601st heartbeat of a principal with 429 before any write, and leaves other principals alone', async () => {
    for (let i = 0; i < 600; i++) expect((await invalid('agent-a')).status).toBe(400);
    const limited = await heartbeat('agent-a', 'agent-of-a', 'active', { jobs_completed: 9 });
    expect(limited.status).toBe(429);
    expect(limited.headers['x-ratelimit-limit']).toBe('600');
    expect((await agent('agent-of-a'))?.total_jobs_completed).toBe(0);

    expect((await invalid('agent-b')).status).toBe(400);
    expect((await heartbeat('agent-b', 'agent-of-b')).status).toBe(200);
  }, 60_000);
});
