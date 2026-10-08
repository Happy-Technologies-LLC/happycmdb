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
const USERS: Record<string, {
  _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string;
  _credentialEpoch?: number; _defaultPasswordSuspect?: boolean;
}> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
  'user-bad': { _id: 'user-bad', _username: 'bart', _role: 'admin', _enabled: true, _organizationId: 'not-a-uuid' },
};

// A plain class (not jest.fn): the unit config resets mock implementations
// before each test, and the AuthService is first built inside one.
// Users whose lookup never settles (a stalled store).
const HUNG_LOOKUPS = new Set<string>();
const DEFERRED_LOOKUPS = new Map<string, Promise<(typeof USERS)[string] | null>>();
const LOOKUP_COUNTS = new Map<string, number>();
const LOOKUP_WAITERS: Array<{ count: number; resolve: () => void }> = [];

function lookupStarted(count: number): Promise<void> {
  if ([...LOOKUP_COUNTS.values()].reduce((sum, n) => sum + n, 0) >= count) return Promise.resolve();
  return new Promise(resolve => LOOKUP_WAITERS.push({ count, resolve }));
}



jest.mock('../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: class {
    findUserById = (userId: string) => {
      LOOKUP_COUNTS.set(userId, (LOOKUP_COUNTS.get(userId) ?? 0) + 1);
      const total = [...LOOKUP_COUNTS.values()].reduce((sum, n) => sum + n, 0);
      for (const waiter of LOOKUP_WAITERS) {
        if (total >= waiter.count) waiter.resolve();
      }
      return DEFERRED_LOOKUPS.get(userId) ??
        (HUNG_LOOKUPS.has(userId) ? new Promise<never>(() => {}) : Promise.resolve(USERS[userId] ?? null));
    };
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

type Inbox = {
  status: 101;
  ws: WebSocket;
  next: () => Promise<Record<string, unknown>>;
  /** Resolves with the close code once the server closes the connection. */
  closed: Promise<number>;
};
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
    let onClose: (code: number) => void = () => {};
    const closed = new Promise<number>(res => (onClose = res));
    ws.on('close', code => onClose(code));
    ws.on('unexpected-response', (req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      req.destroy();
    });
    ws.on('error', reject);
    // The server registers the connection before sending the welcome message.
    ws.once('open', () => void next().then(() => resolve({ status: 101, ws, next, closed })));
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

/** Whichever comes first on a client: its next message or the server closing it. */
function firstOf(inbox: Inbox): Promise<{ message: Record<string, unknown> } | { closed: number }> {
  return Promise.race([inbox.closed.then(code => ({ closed: code })), inbox.next().then(message => ({ message }))]);
}

/** Replace the service with one whose timers (token expiry, re-check interval) run on Jest's fake clock. */
async function restartWithFakeClock(): Promise<void> {
  service.close();
  // Only clock-driven APIs are faked; socket I/O callbacks stay real.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  redisHandlers.length = 0;
  service = new WebSocketService();
  service.initialize(server);
  await new Promise(resolve => setImmediate(resolve));
}

beforeEach(async () => {
  DEFERRED_LOOKUPS.clear();
  LOOKUP_COUNTS.clear();
  LOOKUP_WAITERS.length = 0;
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
  jest.useRealTimers();
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

  describe('connection lifetime', () => {
    const AS_A = () => ({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] });
    const ORG_A_MESSAGE = { type: 'session_update', organizationId: ORG_A, data: { sessionId: 'a-later' } };

    it('closes the socket with 4001 when its token expires', async () => {
      await restartWithFakeClock();
      const options = AS_A();
      const a = await connected(options);
      const exp = jwt.decodeToken(options.protocols[1]!.slice('bearer.'.length))!.exp!;

      await jest.advanceTimersByTimeAsync(exp * 1000 - Date.now() + 1000);
      fromRedis(ORG_A_MESSAGE);

      expect(await firstOf(a)).toEqual({ closed: 4001 });
      expect(service.getStats().connectedClients).toBe(0);
    });

    it('closes the socket with 4001 once the re-check finds the user disabled', async () => {
      await restartWithFakeClock();
      const a = await connected(AS_A());
      USERS['user-a']!._enabled = false;
      try {
        await jest.advanceTimersByTimeAsync(5 * 60_000);
        fromRedis(ORG_A_MESSAGE);

        expect(await firstOf(a)).toEqual({ closed: 4001 });
      } finally {
        USERS['user-a']!._enabled = true;
      }
    });

    it('closes the socket with 4003 once the re-check finds the user in another organization', async () => {
      await restartWithFakeClock();
      const a = await connected(AS_A());
      USERS['user-a']!._organizationId = ORG_B;
      try {
        await jest.advanceTimersByTimeAsync(5 * 60_000);
        fromRedis(ORG_A_MESSAGE);

        expect(await firstOf(a)).toEqual({ closed: 4003 });
      } finally {
        USERS['user-a']!._organizationId = ORG_A;
      }
    });

    // HP1-S6 (v16 §1.1 WebSocket): an operator rotation bumps the credential
    // generation; a socket opened with a pre-rotation token must not keep
    // receiving tenant events until that token expires.
    it('closes the socket with 4001 once the re-check finds the credential generation rotated', async () => {
      await restartWithFakeClock();
      const a = await connected(AS_A());
      USERS['user-a']!._credentialEpoch = 1;
      try {
        await jest.advanceTimersByTimeAsync(5 * 60_000);
        fromRedis(ORG_A_MESSAGE);

        expect(await firstOf(a)).toEqual({ closed: 4001 });
      } finally {
        delete USERS['user-a']!._credentialEpoch;
      }
    });

    it('closes the socket with 4001 once the re-check finds the account marked default-password', async () => {
      await restartWithFakeClock();
      const a = await connected(AS_A());
      USERS['user-a']!._defaultPasswordSuspect = true;
      try {
        await jest.advanceTimersByTimeAsync(5 * 60_000);
        fromRedis(ORG_A_MESSAGE);

        expect(await firstOf(a)).toEqual({ closed: 4001 });
      } finally {
        delete USERS['user-a']!._defaultPasswordSuspect;
      }
    });

    it('closes the socket with 1011 when the re-check lookup never settles', async () => {
      await restartWithFakeClock();
      const a = await connected(AS_A());
      HUNG_LOOKUPS.add('user-a');
      try {
        await jest.advanceTimersByTimeAsync(5 * 60_000);
        fromRedis(ORG_A_MESSAGE);

        expect(await firstOf(a)).toEqual({ closed: 1011 });
      } finally {
        HUNG_LOOKUPS.delete('user-a');
      }
    });
  });

  it('holds re-check slots until stuck lookups settle and fails queued users closed', async () => {
    await restartWithFakeClock();
    const added: string[] = [];
    const releases: Array<() => void> = [];
    const inboxes: Inbox[] = [];
    const lookups = (id: string) => LOOKUP_COUNTS.get(id) ?? 0;
    try {
      for (let i = 0; i < 9; i++) {
        const id = `slow-${i}`;
        added.push(id);
        USERS[id] = { _id: id, _username: id, _role: 'operator', _enabled: true, _organizationId: ORG_A };
        inboxes.push(await connected({ protocols: ['cmdb.v1', `bearer.${tokenFor(id)}`] }));
        if (i < 8) {
          DEFERRED_LOOKUPS.set(id, new Promise(resolve => releases.push(() => resolve(USERS[id]!))));
        }
      }
      const ninth = added[8]!;

      // t=120s: the re-check starts 8 lookups; the 9th user waits for a slot.
      await jest.advanceTimersByTimeAsync(120_000);
      expect(added.slice(0, 8).map(lookups)).toEqual(Array(8).fill(2));
      expect(lookups(ninth)).toBe(1);

      // t=151s: the deadline closes every unresolved user, the queued one included,
      // while the 8 stuck lookups keep their slots: the 9th lookup never starts.
      await jest.advanceTimersByTimeAsync(31_000);
      fromRedis({ type: 'session_update', organizationId: ORG_A, data: { sessionId: 'after-deadline' } });
      expect(await Promise.all(inboxes.map(firstOf))).toEqual(Array(9).fill({ closed: 1011 }));
      expect(lookups(ninth)).toBe(1);

      // Next tick while all slots are still held: a new connection is queued, never
      // looked up, and fails closed at the deadline.
      const probe = await connected({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] });
      await jest.advanceTimersByTimeAsync(89_000 + 31_000);
      expect(lookups('user-a')).toBe(1);
      expect(await firstOf(probe)).toEqual({ closed: 1011 });

      // Once the real lookups settle, the slots are free again: the next tick looks
      // up user-b, keeps its socket, and it receives only its own org's messages.
      releases.forEach(release => release());
      await jest.advanceTimersByTimeAsync(0);
      const b = await connected({ headers: { Authorization: `Bearer ${tokenFor('user-b')}` } });
      await jest.advanceTimersByTimeAsync(89_000);
      expect(lookups('user-b')).toBe(2);
      fromRedis({ type: 'session_update', organizationId: ORG_A, data: { sessionId: 'a-only' } });
      fromRedis({ type: 'session_update', organizationId: ORG_B, data: { sessionId: 'b-only' } });
      expect(await firstOf(b)).toEqual({ message: expect.objectContaining({ organizationId: ORG_B }) });
      expect(service.getStats().connectedClients).toBe(1);
    } finally {
      releases.forEach(release => release());
      added.forEach(id => { delete USERS[id]; DEFERRED_LOOKUPS.delete(id); });
    }
  });

  it('cancels in-flight timeouts and queued re-checks when the service closes', async () => {
    await restartWithFakeClock();
    const added: string[] = [];
    const releases: Array<() => void> = [];
    try {
      for (let i = 0; i < 9; i++) {
        const id = `recheck-${i}`;
        added.push(id);
        USERS[id] = { _id: id, _username: id, _role: 'operator', _enabled: true, _organizationId: ORG_A };
        await connected({ protocols: ['cmdb.v1', `bearer.${tokenFor(id)}`] });
        if (i < 8) {
          DEFERRED_LOOKUPS.set(id, new Promise(resolve => {
            releases.push(() => resolve(USERS[id]!));
          }));
        }
      }
      await jest.advanceTimersByTimeAsync(2 * 60_000);
      expect(added.slice(0, 8).map(id => LOOKUP_COUNTS.get(id))).toEqual(Array(8).fill(2));
      expect(LOOKUP_COUNTS.get(added[8]!)).toBe(1);
      service.close();
      await new Promise(resolve => setImmediate(resolve));
      await jest.advanceTimersByTimeAsync(31_000); // ws close handshakes have their own 30s timers
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(LOOKUP_COUNTS.get(added[8]!)).toBe(1);
      releases.forEach(release => release());
      await new Promise(resolve => setImmediate(resolve));
      expect(LOOKUP_COUNTS.get(added[8]!)).toBe(1);
    } finally {
      releases.forEach(release => release());
      added.forEach(id => { delete USERS[id]; DEFERRED_LOOKUPS.delete(id); });
    }
  });

  it('bounds concurrent upgrade verification and releases admission after a peer closes', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `upgrade-${i}`);
    const releases: Array<() => void> = [];
    try {
      ids.forEach(id => {
        USERS[id] = { _id: id, _username: id, _role: 'operator', _enabled: true, _organizationId: ORG_A };
        DEFERRED_LOOKUPS.set(id, new Promise(resolve => {
          releases.push(() => resolve(USERS[id]!));
        }));
      });
      ids.slice(0, 8).forEach(id => {
        void connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(id)}`] }).catch(() => {});
      });
      await lookupStarted(8);
      const ninthUpgrade = new Promise<void>(resolve => server.once('upgrade', () => resolve()));
      const ninth = connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(ids[8]!)}`] });
      await ninthUpgrade;
      expect(LOOKUP_COUNTS.get(ids[8]!)).toBeUndefined();
      expect((await ninth).status).toBe(503);

      sockets[0]!.terminate();
      await new Promise(resolve => setImmediate(resolve));
      expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(ids[9]!)}`] })).status).toBe(503);
      releases[0]!();
      DEFERRED_LOOKUPS.delete(ids[9]!);
      expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(ids[9]!)}`] })).status).toBe(101);
    } finally {
      releases.forEach(release => release());
      ids.forEach(id => { delete USERS[id]; DEFERRED_LOOKUPS.delete(id); });
    }
  });


  it('cancels pending upgrade timers on shutdown and ignores late verification', async () => {
    await restartWithFakeClock();
    let resolveLookup: (user: (typeof USERS)[string]) => void = () => {};
    DEFERRED_LOOKUPS.set('user-a', new Promise(resolve => { resolveLookup = resolve; }));
    const pending = connect({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] });
    void pending.catch(() => {});
    await lookupStarted(1);
    service.close();
    await new Promise(resolve => setImmediate(resolve));
    expect(jest.getTimerCount()).toBe(0);
    resolveLookup(USERS['user-a']!);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.getStats().connectedClients).toBe(0);

    DEFERRED_LOOKUPS.delete('user-a');
    service = new WebSocketService();
    service.initialize(server);
    expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] })).status).toBe(101);
  });

  it('releases a full user quota when its access tokens expire', async () => {
    await restartWithFakeClock();
    const options = { protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] };
    const clients = await Promise.all(Array.from({ length: 4 }, () => connected(options)));
    expect((await connect(options)).status).toBe(503);
    const exp = jwt.decodeToken(options.protocols[1]!.slice('bearer.'.length))!.exp!;
    await jest.advanceTimersByTimeAsync(exp * 1000 - Date.now() + 1000);
    expect(await Promise.all(clients.map(client => client.closed))).toEqual([4001, 4001, 4001, 4001]);
    expect(service.getStats().connectedClients).toBe(0);
    expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] })).status).toBe(101);
  });
  it('limits active sockets by user, organization and globally, releasing user slots on close', async () => {
    const added: string[] = [];
    try {
      const options = { protocols: ['cmdb.v1', `bearer.${tokenFor('user-a')}`] };
      const userSockets = await Promise.all(Array.from({ length: 4 }, () => connected(options)));
      expect((await connect(options)).status).toBe(503);
      userSockets[0]!.ws.close();
      await userSockets[0]!.closed;
      expect((await connect(options)).status).toBe(101);

      service.close();
      service = new WebSocketService();
      service.initialize(server);
      for (let i = 0; i < 65; i++) {
        const id = `quota-${i}`;
        const org = `${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
        added.push(id);
        USERS[id] = { _id: id, _username: id, _role: 'operator', _enabled: true, _organizationId: org };
      }
      for (let i = 0; i < 64; i++) {
        expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(added[i]!)}`] })).status).toBe(101);
      }
      expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(added[64]!)}`] })).status).toBe(503);

      service.close();
      service = new WebSocketService();
      service.initialize(server);
      for (let i = 0; i < 17; i++) USERS[added[i]!]!._organizationId = ORG_B;
      for (let i = 0; i < 16; i++) {
        expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(added[i]!)}`] })).status).toBe(101);
      }
      expect((await connect({ protocols: ['cmdb.v1', `bearer.${tokenFor(added[16]!)}`] })).status).toBe(503);
    } finally {
      added.forEach(id => { delete USERS[id]; });
    }
  });
});
