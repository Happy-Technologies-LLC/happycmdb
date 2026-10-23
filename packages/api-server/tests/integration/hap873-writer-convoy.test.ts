// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-873 (HAP-850 X-29): org A's journal writers queued behind A's admission lock must not exhaust the shared
// PostgreSQL pool that org B needs. Integration PostgreSQL/Neo4j, real routers and JWTs; A's pessimistic reader is
// A's admission ShareLock held from a dedicated connection outside the shared pool, which also observes pg_locks.
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const [A, B] = [randomUUID(), randomUUID()];
const users = {
  a: { _id: 'hap873-a', _username: 'hap873-a', _role: 'admin' as const, _enabled: true, _organizationId: A },
  b: { _id: 'hap873-b', _username: 'hap873-b', _role: 'admin' as const, _enabled: true, _organizationId: B },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
  })),
}));
jest.mock('@cmdb/event-processor', () => ({ // no Kafka in the integration stores
  ...jest.requireActual<object>('@cmdb/event-processor'), getEventProducer: () => ({ emit: async () => [] }),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { ciRoutes } from '../../src/rest/routes/ci.routes';

type User = keyof typeof users;
const [graph, sql, jwt] = [getNeo4jClient(), getPostgresClient(), new JWTService(loadConfig().auth.jwt)];
const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate()).use('/api/v1/cis', ciRoutes);
const auth = (user: User) => ({ authorization: `Bearer ${jwt.generateAccessToken(users[user]._id,
  users[user]._username, users[user]._role, users[user]._organizationId)}` });
const list = (user: User) => request(app).get('/api/v1/cis').set(auth(user));
const put = (user: User, ci: string) => request(app).put(`/api/v1/cis/${ci}`).set(auth(user)).send({ name: `${ci}-x` }).then();
const create = (user: User, ci: string) => graph.createCI({ _id: ci, name: ci, _type: 'server' }, users[user]._organizationId, users[user]._id);
const ids = (label: string, count: number) => Array.from({ length: count }, () => `hap873-${label}-${randomUUID().slice(0, 8)}`);
const epoch = async (org: string) => Number((await sql.query('SELECT epoch FROM ci_reconciliation_epochs WHERE organization_id = $1', [org])).rows[0]?.epoch ?? 0);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The org's admission ShareLock (a pessimistic reader's mode), held outside the shared pool until release(). */
async function holdAdmissionShareLock(org: string) {
  const { options } = sql.pool; // pg-pool hides `password` from enumeration
  const holder = new Client({ ...options, password: options.password });
  await holder.connect().then(() => holder.query('BEGIN'));
  await holder.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 4431))', [org]);
  return {
    waitingT1s: async () => (await holder.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'
      AND objsubid = 1 AND mode = 'ExclusiveLock' AND NOT granted
      AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1::text, 4431)`, [org])).rows[0].n as number,
    release: async () => { await holder.query('COMMIT').catch(() => undefined); await holder.end(); },
  };
}

afterAll(async () => { // shared integration stores
  await sql.query(`UPDATE ci_reconciliation_operations SET state = 'aborted'
    WHERE organization_id = ANY($1::uuid[]) AND state IN ('pending', 'failed')`, [[A, B]]);
  const session = graph.getSession();
  try { await session.run('MATCH (c:CI) WHERE c.organization_id IN $orgs DETACH DELETE c', { orgs: [A, B] }); }
  finally { await session.close(); }
  await sql.query('DELETE FROM cmdb.dim_ci WHERE organization_id = ANY($1::uuid[])', [[A, B]]);
});

it('queues org A writers behind its admission lock with one T1 in PostgreSQL; org B reads and writes proceed', async () => {
  const [cis, [own]] = [ids('a', 24), ids('b', 1)];
  for (const ci of cis) await create('a', ci);
  await create('b', own!);
  expect((await list('b')).status).toBe(200);
  const [epochA, epochB] = [await epoch(A), await epoch(B)];
  const lock = await holdAdmissionShareLock(A);
  const writes = cis.map(ci => put('a', ci));
  try {
    while (await lock.waitingT1s() === 0) await wait(50);
    await wait(500); // every A write reaches T1 by now; real time: PG lock waits have no event to await
    const [started, read] = [Date.now(), await list('b')];
    expect([read.status, Date.now() - started < 1000]).toEqual([200, true]);
    expect((await put('b', own!)).status).toBe(200);
    expect(await lock.waitingT1s()).toBe(1);
  } finally { await lock.release(); await Promise.allSettled(writes); }
  expect((await Promise.all(writes)).map(response => response.status)).toEqual(cis.map(() => 200));
  expect([await epoch(A) - epochA, await epoch(B) - epochB]).toEqual([24, 1]);
  // Each T1 bumped A's epoch under the exclusive lock: 24 distinct consecutive epochs, every operation committed.
  expect((await sql.query(`SELECT count(*) FILTER (WHERE state = 'committed')::int AS committed,
      count(DISTINCT epoch)::int AS epochs, min(epoch)::int AS first, max(epoch)::int AS last
    FROM ci_reconciliation_operations WHERE organization_id = $1 AND epoch > $2`, [A, epochA])).rows[0])
    .toEqual({ committed: 24, epochs: 24, first: epochA + 1, last: epochA + 24 });
}, 60_000);

it('expires queued org A writers inside the one 12 s admission budget with the existing 503', async () => {
  const cis = ids('t', 4);
  for (const ci of cis) await create('a', ci);
  const lock = await holdAdmissionShareLock(A);
  try {
    const started = Date.now();
    const writes = cis.map(ci => put('a', ci).then(({ status, body }) => [status, body, Date.now() - started]));
    await wait(1000);
    expect((await list('b')).status).toBe(200);
    const unavailable = { success: false, error: 'Service Unavailable', message: 'CI write temporarily unavailable' };
    for (const [status, body, elapsed] of await Promise.all(writes)) {
      expect([status, body, elapsed > 11_000 && elapsed < 13_000]).toEqual([503, unavailable, true]);
    }
  } finally { await lock.release(); }
}, 30_000);
