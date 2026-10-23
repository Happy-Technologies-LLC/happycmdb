// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-873 (HAP-850 X-29): org A's journal writers queued behind A's admission lock must not exhaust the shared
// PostgreSQL pool that org B needs. Integration PostgreSQL/Neo4j, real routers and JWTs; A's pessimistic reader is
// A's admission ShareLock held from a dedicated connection outside the shared pool, which also observes pg_locks.
// HAP-879 (R-873b): the same holds for A's AP-P′ referenced writes (POST /itil/incidents) queued behind A's T1.
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
import { itilRoutes } from '../../src/rest/routes/itil.routes';

type User = keyof typeof users;
const [graph, sql, jwt] = [getNeo4jClient(), getPostgresClient(), new JWTService(loadConfig().auth.jwt)];
const app = express().use(express.json()).use('/api/v1', getAuthMiddleware().authenticate()).use('/api/v1/cis', ciRoutes)
  .use('/api/v1/itil', itilRoutes);
const auth = (user: User) => ({ authorization: `Bearer ${jwt.generateAccessToken(users[user]._id,
  users[user]._username, users[user]._role, users[user]._organizationId)}` });
const list = (user: User) => request(app).get('/api/v1/cis').set(auth(user));
const put = (user: User, ci: string) => request(app).put(`/api/v1/cis/${ci}`).set(auth(user)).send({ name: `${ci}-x` }).then();
const create = (user: User, ci: string) => graph.createCI({ _id: ci, name: ci, _type: 'server' }, users[user]._organizationId, users[user]._id);
const incident = (user: User, ci: string) => request(app).post('/api/v1/itil/incidents').set(auth(user))
  .send({ affectedCIId: ci, description: 'hap879 referenced write', reportedBy: user }).then();
/** The org's incidents; `cis` scopes the read to one test's CIs (org A is shared by every test in this file). */
const incidents = async (org: string, cis?: string[]) => (await sql.query(`SELECT affected_ci_id FROM itil_incidents
  WHERE organization_id = $1 AND ($2::text[] IS NULL OR affected_ci_id = ANY($2::text[]))`, [org, cis ?? null]))
  .rows.map(row => row.affected_ci_id as string);
const ids = (label: string, count: number) => Array.from({ length: count }, () => `hap873-${label}-${randomUUID().slice(0, 8)}`);
const epoch = async (org: string) => Number((await sql.query('SELECT epoch FROM ci_reconciliation_epochs WHERE organization_id = $1', [org])).rows[0]?.epoch ?? 0);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const unavailable = { success: false, error: 'Service Unavailable', message: 'CI write temporarily unavailable' };

/** The org's admission ShareLock (a pessimistic reader's mode), held outside the shared pool until release(). */
async function holdAdmissionShareLock(org: string) {
  const { options } = sql.pool; // pg-pool hides `password` from enumeration
  const holder = new Client({ ...options, password: options.password });
  await holder.connect().then(() => holder.query('BEGIN'));
  await holder.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 4431))', [org]);
  const locks = async (mode: 'ExclusiveLock' | 'ShareLock', granted: boolean) => (await holder.query(`SELECT count(*)::int AS n
    FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND mode = $2 AND granted = $3
      AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1::text, 4431)`, [org, mode, granted])).rows[0].n as number;
  return {
    waitingT1s: () => locks('ExclusiveLock', false),
    locks,
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
  await sql.query('DELETE FROM itil_incidents WHERE organization_id = ANY($1::uuid[])', [[A, B]]);
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
    for (const [status, body, elapsed] of await Promise.all(writes)) {
      expect([status, body, elapsed > 11_000 && elapsed < 13_000]).toEqual([503, unavailable, true]);
    }
  } finally { await lock.release(); }
}, 30_000);

it('queues org A referenced writes behind its waiting T1 with one shared-lock waiter in PostgreSQL; org B reads and writes proceed', async () => {
  const [[t1Ci, referenced, gap], [own]] = [ids('879a', 3), ids('879b', 1)];
  for (const ci of [t1Ci, referenced, gap]) await create('a', ci!);
  await create('b', own!);
  await sql.query(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation,
      graph_effect, state, actor, epoch, lease_expires_at)
    VALUES ($1, $1, $2, $3, 'api', 'direct_write', true, 'pending', 'seed', 0, now() + interval '5 minutes')`, [randomUUID(), A, gap]);
  expect((await list('b')).status).toBe(200);
  const [epochA, epochB] = [await epoch(A), await epoch(B)];
  const lock = await holdAdmissionShareLock(A);
  const t1 = put('a', t1Ci!);
  let writes: Promise<request.Response>[] = [];
  try {
    while (await lock.waitingT1s() === 0) await wait(50);
    // Each queued shared request waits behind A's waiting T1 (F8′); the last one references a CI in a gap.
    writes = [...Array.from({ length: 24 }, () => incident('a', referenced!)), incident('a', gap!)];
    while (await lock.locks('ShareLock', false) === 0) await wait(50);
    await wait(500); // every A write reaches its lock wait by now; real time: PG lock waits have no event to await
    const [started, read] = [Date.now(), await list('b')];
    expect([read.status, Date.now() - started < 1000]).toEqual([200, true]);
    expect((await put('b', own!)).status).toBe(200);
    expect([await lock.waitingT1s(), await lock.locks('ShareLock', false)]).toEqual([1, 1]);
  } finally { await lock.release(); await Promise.allSettled([t1, ...writes]); }
  // Released inside the 5 s budget: A's T1 first, then every referenced write, gap-checked under the shared lock.
  expect([(await t1).status, ...(await Promise.all(writes)).map(response => response.status)])
    .toEqual([200, ...Array.from({ length: 24 }, () => 201), 409]);
  expect([await incidents(A, [t1Ci!, referenced!, gap!]), await incidents(B)])
    .toEqual([Array.from({ length: 24 }, () => referenced), []]);
  expect([await epoch(A) - epochA, await epoch(B) - epochB]).toEqual([1, 1]);
}, 60_000);

it('expires queued org A referenced writes inside the one 5 s lock budget with the existing 503 and releases them', async () => {
  const [t1Ci, referenced] = ids('879r', 2);
  for (const ci of [t1Ci, referenced]) await create('a', ci!);
  const lock = await holdAdmissionShareLock(A);
  const t1 = put('a', t1Ci!);
  let writes: Promise<unknown>[] = [];
  try {
    while (await lock.waitingT1s() === 0) await wait(50);
    const started = Date.now();
    writes = Array.from({ length: 4 }, () =>
      incident('a', referenced!).then(({ status, body }) => [status, body, Date.now() - started]));
    await wait(1000);
    expect((await list('b')).status).toBe(200);
    for (const [status, body, elapsed] of await Promise.all(writes) as [number, object, number][]) {
      expect([status, body, elapsed > 4_500 && elapsed < 6_500]).toEqual([503, unavailable, true]);
    }
    // Nothing is left waiting or holding A's lock but the holder and its queued T1; no client waits on the pool.
    expect([await lock.waitingT1s(), await lock.locks('ShareLock', false), await lock.locks('ShareLock', true),
      sql.pool.waitingCount]).toEqual([1, 0, 1, 0]);
  } finally { await lock.release(); await Promise.allSettled([t1, ...writes]); }
  expect((await t1).status).toBe(200);
  expect((await incident('a', referenced!)).status).toBe(201);
  expect(await incidents(A, [t1Ci!, referenced!])).toEqual([referenced]);
}, 30_000);
