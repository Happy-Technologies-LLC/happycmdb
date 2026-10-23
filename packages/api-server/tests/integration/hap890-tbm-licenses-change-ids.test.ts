// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-890 on the integration suite's disposable PostgreSQL/Timescale (all migrations) and Neo4j 5.15.
 * Mounted REST with real JWTs; only the identity directory is stubbed.
 * - X-28 (v16 §15 #17): the platform-wide TBM license readers bind SKIP as a Neo4j Integer, and the
 *   mounted admin-global list applies AP-R across three T1/T2 timings.
 * - X-14 (§15 #8): a 256-unit or U+0000 change affectedCIIds is a 400 before the owned-CI lookup and the journal.
 */
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import neo4j from 'neo4j-driver';
import { Client } from 'pg';
import { getNeo4jClient, getPostgresClient, setJournalSeam } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = randomUUID();
const B = randomUUID();
const users = {
  a: { _id: 'hap890-a', _username: 'hap890-a', _role: 'admin' as const, _enabled: true, _organizationId: A },
  b: { _id: 'hap890-b', _username: 'hap890-b', _role: 'admin' as const, _enabled: true, _organizationId: B },
  p: { _id: 'hap890-p', _username: 'hap890-p', _role: 'admin' as const, _enabled: true, _organizationId: undefined,
    _platformAdmin: true },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => Object.values(users).find(user => user._id === id) ?? null,
  })),
}));
// No Kafka in the integration stores; post-commit notification is best-effort (v16 §3.3 step 7).
jest.mock('@cmdb/event-processor', () => ({
  ...jest.requireActual<object>('@cmdb/event-processor'), getEventProducer: () => ({ emit: async () => [] }),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { ciRoutes } from '../../src/rest/routes/ci.routes';
import { itilRoutes } from '../../src/rest/routes/itil.routes';
import { tbmRoutes } from '../../src/rest/routes/tbm.routes';
import { tbmResolvers } from '../../src/graphql/resolvers/tbm.resolvers';
import type { GraphQLContext } from '../../src/graphql/resolvers/index';

type User = keyof typeof users;
const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
app.use('/api/v1/itil', itilRoutes);
app.use('/api/v1/tbm', tbmRoutes);
const auth = (user: User) => ({ authorization: `Bearer ${jwt.generateAccessToken(users[user]._id,
  users[user]._username, users[user]._role, users[user]._organizationId)}` });
const cypher = async (query: string, params: Record<string, unknown> = {}) => {
  const session = graph.getSession();
  try { return (await session.run(query, params)).records.map(record => record.toObject()); } finally { await session.close(); }
};
const rows = async (text: string, params: unknown[] = []) => (await sql.query(text, params)).rows;
const id = (label: string) => `hap890-${label}-${randomUUID().slice(0, 8)}`;
/** Fixtures with a known id use the journaled engine: REST CI ids are server-issued (T5). */
const create = (user: 'a' | 'b', ciId: string) =>
  graph.createCI({ _id: ciId, name: ciId, _type: 'server' }, users[user]._organizationId, users[user]._id);
const rename = (user: User, ciId: string, name: string) =>
  request(app).put(`/api/v1/cis/${ciId}`).set(auth(user)).send({ name }).then(response => response);
/** Hold the next non-recovery journal step at `point` until released. */
const holdAt = (point: string) => {
  const [entered, release] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let used = false;
  setJournalSeam(async (at, context) => {
    if (at === point && !used && !context.recovery) { used = true; entered.resolve(); await release.promise; }
  });
  return { entered: entered.promise, release: release.resolve };
};
/** Runs `inside` once, after the `nth` shared-pool query containing `marker` returns and before its caller resumes. */
const afterPoolQuery = (marker: string, nth: number, inside: () => Promise<unknown>) => {
  const query = sql.pool.query.bind(sql.pool);
  let seen = 0;
  jest.spyOn(sql.pool, 'query').mockImplementation((async (...args: Parameters<typeof query>) => {
    const result = await query(...args);
    if (JSON.stringify(args[0]).includes(marker) && ++seen === nth) await inside();
    return result;
  }) as typeof query);
};

const vendor = id('vendor');
const [mine, theirs] = [id('x28-a'), id('x28-b')];
/** The mounted admin-global list, vendor-scoped to this suite: [200, {id: name}], else [status, body]. */
const licenses = async () => {
  const response = await request(app).get(`/api/v1/tbm/licenses?vendor=${vendor}`).set(auth('p'));
  return [response.status, response.status !== 200 ? response.body
    : Object.fromEntries(response.body.data.map((ci: { id: string; name: string }) => [ci.id, ci.name]))];
};
const listed = (theirName: string) => [200, { [mine]: mine, [theirs]: theirName }];

beforeAll(async () => {
  await create('a', mine);
  await create('b', theirs);
  await cypher(`MATCH (c:CI) WHERE c.id IN $ids SET c.type = 'software', c.vendor = $vendor,
    c.license_expiry_date = date() + duration({days: 1})`, { ids: [mine, theirs], vendor });
});
afterEach(() => setJournalSeam(undefined));
afterAll(async () => {
  await rows(`UPDATE ci_reconciliation_operations SET state = 'aborted' WHERE organization_id = ANY($1::uuid[])
    AND state IN ('pending', 'failed')`, [[A, B]]);
  await cypher('MATCH (c:CI) WHERE c.organization_id IN $orgs DETACH DELETE c', { orgs: [A, B] });
  await rows('DELETE FROM itil_changes WHERE organization_id = $1', [A]);
  await rows('DELETE FROM cmdb.dim_ci WHERE organization_id = ANY($1::uuid[])', [[A, B]]); // shared integration DB
});

it('X-28: /tbm/licenses, /tbm/licenses/renewals and the GraphQL license reader page real Neo4j with an Integer SKIP', async () => {
  const ours = (list: { id?: unknown }[]) => list.map(ci => ci.id).filter(ciId => ciId === mine || ciId === theirs).sort();
  const context = { credentialType: 'jwt', user: { _userId: users.p._id }, _neo4jClient: graph } as unknown as GraphQLContext;
  const graphql = (read: Promise<Record<string, unknown>[]>) => read.then(ours, (error: Error) => error.message);
  const renewals = await request(app).get('/api/v1/tbm/licenses/renewals?days=365').set(auth('p'));
  const direct = await cypher(`MATCH (ci:CI {type: 'software'}) WHERE ci.vendor = $vendor
    RETURN ci.id AS id ORDER BY ci.license_expiry_date ASC, ci.id SKIP $offset LIMIT 100`, { vendor, offset: neo4j.int(0) });
  const both = [mine, theirs].sort();
  expect([ours(direct), await licenses(), renewals.status, ours(renewals.body.data ?? []), // control: the same page, Integer-bound
    await graphql(tbmResolvers.Query.licenses(null, { vendor }, context)),
    await graphql(tbmResolvers.Query.upcomingRenewals(null, { days: 365 }, context))])
    .toEqual([both, listed(theirs), 200, both, both, both]);
});

it('X-28: the mounted admin-global list omits a CI in its org\'s gap, shows the pre-W state after its lookup, never 503s', async () => {
  const pause = holdAt('beforeT2'); // (1) B's T1+W committed with T2 held before the platform read: omitted
  const write = rename('b', theirs, 'x28-w');
  await pause.entered;
  const held = await licenses();
  pause.release();
  const first = [held, (await write).status, await licenses()]; // control: B's write commits; the next read lists its W state
  // (2) B's whole write after the gap lookup (the marker is filterGlobalCIGaps' alone, not the (3) seed): pre-W shown
  afterPoolQuery('SELECT * FROM unnest($1::uuid[], $2::text[])', 1, async () =>
    expect((await rename('b', theirs, 'x28-late')).status).toBe(200));
  const second = [await licenses(), await licenses()];
  await rows(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state,
      actor, epoch, plan, lease_expires_at) SELECT gen_random_uuid(), gen_random_uuid(), org, ci, 'api', 'direct_write', true, 'pending',
      'hap890-seed', 0, NULL, now() + interval '5 minutes' FROM unnest($1::uuid[], $2::text[]) AS t(org, ci)`, [[A, B], [mine, theirs]]);
  const concurrent = await Promise.all([licenses(), licenses()]); // (3) both orgs in a gap, two concurrent platform reads
  await rows(`UPDATE ci_reconciliation_operations SET state = 'aborted' WHERE actor = 'hap890-seed' AND ci_id = ANY($1)`, [[mine, theirs]]);
  expect([first, second, concurrent, await licenses()]).toEqual([[[200, { [mine]: mine }], 200, listed('x28-w')],
    [listed('x28-w'), listed('x28-late')], [[200, {}], [200, {}]], listed('x28-late')]);
});

it('X-14: a 256-unit or U+0000 change affectedCIIds is 400 before the owned-CI lookup and any journal access; a valid id creates', async () => {
  const ci = id('x14');
  await create('a', ci);
  const change = (affectedCIIds: string[]) => request(app).post('/api/v1/itil/changes').set(auth('a')).send({
    changeType: 'NORMAL', description: 'hap890 affected CI validation', affectedCIIds, requestedBy: 'alice',
    plannedStart: '2026-11-01T00:00:00Z', plannedDuration: 60,
    implementationPlan: 'drain workload, patch system, restart, and confirm all health checks' });
  const changes = async () => (await rows('SELECT count(*)::int AS n FROM itil_changes WHERE organization_id = $1', [A]))[0].n;
  const lookups = jest.spyOn(graph, 'getCI');
  // Journal access on any pooled client: the AP-P' admission lock or a ci_reconciliation_* statement.
  const queries = jest.spyOn(Client.prototype, 'query');
  const journal = () => queries.mock.calls.filter(([text]) =>
    /ci_reconciliation|pg_advisory_xact_lock/.test(JSON.stringify(text))).length;
  const overlong = 'c'.repeat(256); // 256 UTF-16 units; the bound is 255
  const created = await change([ci]); // control: the normal path looks the CI up and writes through the journal gate
  const control = [created.status, lookups.mock.calls.length, journal() > 0, await changes()];
  const [looked, journaled] = [lookups.mock.calls.length, journal()];
  // v16 §3.6 shapes: overlong, overlong after a valid id, and a non-length one (U+0000 is not storable; Joi passes it).
  const rejected = [await change([overlong]), await change([ci, overlong]), await change([`${ci}\u0000`])];
  const invalid = { success: false, error: 'Bad Request', message: 'Invalid request' };
  expect([control, rejected.map(response => [response.status, response.body]), lookups.mock.calls.length - looked,
    journal() - journaled, await changes()]).toEqual([[201, 1, true, 1], [[400, invalid], [400, invalid], [400, invalid]], 0, 0, 1]);
});
