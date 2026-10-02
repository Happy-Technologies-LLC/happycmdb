// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * /ws upgrade authentication and per-organization delivery, exercised
 * through a real HTTP server on 127.0.0.1 (ephemeral port) and real `ws`
 * clients, behind the real AuthService (JWT verification, org re-read from
 * the user record).
 *
 * Substitutions: Neo4jAuthRepository -> in-memory users; Redis -> an
 * in-process fake whose captured 'message' handler stands in for the
 * cross-instance `ai:realtime` channel.
 */

import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { inspect } from 'util';
import { randomBytes } from 'crypto';
import WebSocket from 'ws';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

// Plain functions (not jest.fn): the unit config resets mock implementations.
const redisHandlers: Array<(channel: string, message: string) => void> = [];
const fakeRedis = {
  publish: async () => 0,
  duplicate: () => ({
    subscribe: async () => 1,
    on: (event: string, handler: (channel: string, message: string) => void) => {
      if (event === 'message') redisHandlers.push(handler);
    },
  }),
};

jest.mock('@cmdb/database', () => ({
  getRedisClient: () => fakeRedis,
  getNeo4jClient: () => ({}),
}));

// bcrypt's native binding is only used for password hashing/login, which the
// token verification path exercised here never calls.
jest.mock('bcrypt', () => ({}));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
  'user-bad': { _id: 'user-bad', _username: 'bart', _role: 'admin', _enabled: true, _organizationId: 'not-a-uuid' },
};

// A plain class (not jest.fn): the unit config resets mock implementations
// before each test, and the AuthService is first built inside one.
jest.mock('../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: class {
    findUserById = async (userId: string) => USERS[userId] ?? null;
  },
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig, logger } from '@cmdb/common';
import { JWTService } from '../../auth/jwt.service';
import { getAuthService } from '../../auth/auth-bootstrap';
import { WebSocketService } from '../websocket.service';

const jwt = new JWTService(loadConfig().auth.jwt);
const tokenFor = (userId: string) =>
  jwt.generateAccessToken(userId, USERS[userId]!._username, 'operator', USERS[userId]!._organizationId);

type Inbox = { status: 101; ws: WebSocket; next: () => Promise<Record<string, unknown>> };
type Outcome = { status: number } | Inbox;

let server: Server;
let service: WebSocketService;
let url: string;
const sockets: WebSocket[] = [];

/** Open a client; resolves with the HTTP status of a refused upgrade, or 101 and the open client after its welcome message. */
function connect(options: { protocols?: string[]; headers?: Record<string, string> } = {}): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options.protocols ?? [], { headers: options.headers });
    sockets.push(ws);
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    const next = () =>
      new Promise<Record<string, unknown>>(res => {
        const queued = queue.shift();
        if (queued) res(queued);
        else waiters.push(res);
      });
    ws.on('message', data => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    });
    ws.on('unexpected-response', (req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      req.destroy();
    });
    ws.on('error', reject);
    // The server registers the connection before sending the welcome message.
    ws.once('open', () => void next().then(() => resolve({ status: 101, ws, next })));
  });
}

async function connected(options: Parameters<typeof connect>[0]): Promise<Inbox> {
  const outcome = await connect(options);
  if (!('ws' in outcome)) throw new Error(`upgrade refused with ${outcome.status}`);
  return outcome;
}

/** A message arriving on the shared `ai:realtime` channel (as published by any instance). */
function fromRedis(message: Record<string, unknown>): void {
  expect(redisHandlers).toHaveLength(1);
  redisHandlers[0]!('ai:realtime', JSON.stringify({ timestamp: new Date().toISOString(), ...message }));
}

beforeEach(async () => {
  redisHandlers.length = 0;
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  service = new WebSocketService();
  service.initialize(server);
  // Let the Redis subscription register its message handler.
  await new Promise(resolve => setImmediate(resolve));
});

afterEach(async () => {
  sockets.splice(0).forEach(ws => ws.terminate());
  service.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

describe('WebSocket /ws authentication and tenancy', () => {
  it('upgrade without a token is rejected with 401', async () => {
    expect((await connect()).status).toBe(401);
    expect((await connect({ protocols: ['cmdb.v1'] })).status).toBe(401);
    expect(service.getStats().connectedClients).toBe(0);
  });

  it('upgrade with a token lacking an org claim is rejected with 403', async () => {
    expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-none')}`] })).status).toBe(403);
    expect((await connect({ headers: { Authorization: `Bearer ${tokenFor('user-bad')}` } })).status).toBe(403);
    expect(service.getStats().connectedClients).toBe(0);
  });

  it('org A client does not receive an org B broadcast', async () => {
    const a = await connected({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] });
    const b = await connected({ headers: { Authorization: `Bearer ${tokenFor('user-b')}` } });

    fromRedis({ type: 'session_update', organizationId: ORG_B, data: { sessionId: 'b-secret' } });
    fromRedis({ type: 'session_update', organizationId: ORG_A, data: { sessionId: 'a-session' } });

    expect(await a.next()).toMatchObject({ organizationId: ORG_A, data: { sessionId: 'a-session' } });
    expect(await b.next()).toMatchObject({ organizationId: ORG_B, data: { sessionId: 'b-secret' } });
  });

  it('a message without an organization id is not delivered', async () => {
    const a = await connected({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] });

    fromRedis({ type: 'cost_alert', data: { message: 'unscoped', currentCost: 9, budget: 1 } });
    fromRedis({ type: 'pattern_learned', organizationId: ORG_A, data: { pattern: 'a-pattern' } });

    expect(await a.next()).toMatchObject({ type: 'pattern_learned', data: { pattern: 'a-pattern' } });
  });

  it('the token is not written to logs', async () => {
    const lines: string[] = [];
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      jest.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        lines.push(inspect(args, { depth: 10 }));
        return logger;
      }) as never);
    }
    const verifyToken = jest.spyOn(getAuthService(), 'verifyToken');

    const valid = tokenFor('user-a');
    const forged = `${valid.slice(0, -4)}AAAA`;
    const orgless = tokenFor('user-none');

    const a = await connected({ protocols: ['cmdb.v1', `bearer.${valid}`] });
    // The selected subprotocol is never the bearer entry, so the token is not echoed.
    expect(a.ws.protocol).toBe('cmdb.v1');
    expect((await connect({ protocols: ['cmdb.v1', `bearer.${forged}`] })).status).toBe(401);
    expect((await connect({ headers: { Authorization: `Bearer ${orgless}` } })).status).toBe(403);

    expect(verifyToken.mock.calls.map(([token]) => token)).toEqual([valid, forged, orgless]);
    expect(lines.length).toBeGreaterThan(0);
    for (const token of [valid, forged, orgless]) {
      expect(lines.filter(line => line.includes(token))).toEqual([]);
    }
  });
});
