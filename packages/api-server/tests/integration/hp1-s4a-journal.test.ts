// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S4a acceptance (v16 §3, §4, §5.1–5.3, §15 J1/AP1/R44-M1, F0–F5, F7) on the
 * integration suite's disposable PostgreSQL/Timescale (all migrations) and
 * Neo4j 5.15 with the fence constraint. Mounted REST/GraphQL with real JWTs;
 * only the identity directory is stubbed. Pause/fault points use the
 * journal's deterministic seam; recovery is driven by the real sweep.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import neo4j, { Session } from 'neo4j-driver';
import { dec, enc, getNeo4jClient, getPostgresClient, JournalAbortedError, requeueFailedJournalGroup, setJournalSeam } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const users = {
  a: { _id: 's4a-a', _username: 's4a-a', _role: 'admin' as const, _enabled: true, _organizationId: A },
  b: { _id: 's4a-b', _username: 's4a-b', _role: 'admin' as const, _enabled: true, _organizationId: B },
  c: { _id: 's4a-c', _username: 's4a-c', _role: 'admin' as const, _enabled: true, _organizationId: C },
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
import { relationshipRoutes } from '../../src/rest/routes/relationship.routes';
import { itilRoutes } from '../../src/rest/routes/itil.routes';
import { analyticsRoutes } from '../../src/rest/routes/analytics.routes';
import { reconciliationRoutes } from '../../src/rest/routes/reconciliation.routes';
import { createGraphQLServer } from '../../src/graphql/server';
import { CIListUnavailableError, readCIList, writeReferencedCIs } from '../../src/read-admission';

type User = keyof typeof users;
const graph = getNeo4jClient();
const sql = getPostgresClient();
const jwt = new JWTService(loadConfig().auth.jwt);
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/cis', ciRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
app.use('/api/v1/itil', itilRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/reconciliation', reconciliationRoutes);
const auth = (user: User) => ({ authorization: `Bearer ${jwt.generateAccessToken(users[user]._id,
  users[user]._username, users[user]._role, users[user]._organizationId)}` });
const api = (user: User) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set(auth(user)),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set(auth(user)),
  post: (path: string, body: object) => request(app).post(`/api/v1${path}`).set(auth(user)).send(body),
  put: (path: string, body: object) => request(app).put(`/api/v1${path}`).set(auth(user)).send(body),
  patch: (path: string, body: object) => request(app).patch(`/api/v1${path}`).set(auth(user)).send(body),
  gql: (query: string) => request(app).post('/graphql').set(auth(user)).send({ query }),
});
const cypher = async (query: string, params: Record<string, unknown> = {}) => {
  const session = graph.getSession();
  try { return (await session.run(query, params)).records.map(record => record.toObject()); } finally { await session.close(); }
};
const rows = async (text: string, params: unknown[] = []) => (await sql.query(text, params)).rows;
const ops = (org: string, ci: string) => rows(`SELECT * FROM ci_reconciliation_operations
  WHERE organization_id = $1 AND ci_id = $2 ORDER BY created_at, id`, [org, ci]);
const fences = (opId: string) => cypher('MATCH (o:ReconciliationOp {op_id: $opId}) RETURN o{.*} AS o', { opId });
const node = async (id: string) => (await cypher('MATCH (c:CI {id: $id}) RETURN properties(c) AS p', { id }))[0]?.['p'] as
  Record<string, unknown> | undefined;
const history = (ci: string) => rows('SELECT * FROM ci_change_history WHERE ci_id = $1 ORDER BY changed_at', [ci]);
/** Make every pending op of an org recovery-eligible, then run the real sweep once. */
const sweep = async (org: string) => {
  await rows(`UPDATE ci_reconciliation_operations SET lease_expires_at = now() - interval '1 minute'
    WHERE organization_id = $1 AND state = 'pending'`, [org]);
  return graph.journal.sweep();
};
const id = (label: string) => `s4a-${label}-${randomUUID().slice(0, 8)}`;
/** Fixtures with a known id use the journaled engine: REST CI ids are server-issued (T5). */
const create = (user: User, ciId: string, extra: { metadata?: Record<string, unknown> } = {}) =>
  graph.createCI({ _id: ciId, name: ciId, _type: 'server', ...extra }, users[user]._organizationId, users[user]._id);
const seamOnce = (point: string, action: () => Promise<void>) => {
  let used = false;
  setJournalSeam(async (at, context) => {
    if (at === point && !used && !context.recovery) { used = true; await action(); }
  });
};
const GAP = { success: false, error: 'Conflict', message: 'CI is temporarily unavailable' };
let server: { stop(): Promise<void> };

beforeAll(async () => { ({ server } = await createGraphQLServer(app)); });
afterEach(() => setJournalSeam(undefined));
afterAll(async () => {
  await rows(`UPDATE ci_reconciliation_operations SET state = 'aborted' WHERE organization_id = ANY($1::uuid[])
    AND state IN ('pending', 'failed')`, [[A, B, C]]);
  await cypher('MATCH (c:CI) WHERE c.organization_id IN $orgs DETACH DELETE c', { orgs: [A, B, C] });
  await server?.stop();
});

it('X-30/M-6: without the fence constraint a journaled write is 503 before any journal row', async () => {
  await cypher('DROP CONSTRAINT reconciliation_op_fence_unique IF EXISTS');
  try {
    const name = id('gate');
    expect((await api('a').post('/cis', { name, type: 'server' })).status).toBe(503);
    expect(await rows('SELECT id FROM ci_reconciliation_operations WHERE organization_id = $1', [A])).toEqual([]);
    expect(await cypher('MATCH (c:CI {name: $name}) RETURN c', { name })).toEqual([]);
  } finally {
    await cypher('CREATE CONSTRAINT reconciliation_op_fence_unique IF NOT EXISTS FOR (o:ReconciliationOp) REQUIRE o.op_id IS UNIQUE');
  }
});

it('J1/X-23/H-6: a direct create is one committed intent plus one applied fence, no fence key, no history', async () => {
  const other = id('j1-peer');
  const created = await api('a').post('/cis', { name: 'j1', type: 'server' });
  const ci = created.body.data.id;
  expect([created.status, ci]).toEqual([201, expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)]);
  await create('a', other);
  expect((await api('a').put(`/cis/${ci}`, { name: 'renamed' })).status).toBe(200);
  expect((await api('a').post('/relationships', { from_id: ci, to_id: other, type: 'DEPENDS_ON' })).status).toBe(201);
  const journal = await ops(A, ci);
  expect(journal.map(op => [op.operation, op.state, op.actor, op.plan])).toEqual([
    ['direct_write', 'committed', 's4a-a', null], ['direct_write', 'committed', 's4a-a', null],
    ['relationship_write', 'committed', 's4a-a', null]]);
  for (const op of journal) {
    expect(await fences(op.id)).toEqual([{ o: expect.objectContaining(
      { op_id: op.id, organization_id: A, ci_id: ci, operation: op.operation, outcome: 'applied' }) }]);
  }
  const props = await node(ci);
  expect(Object.keys(props!).filter(key => /op_id|reconciliation/i.test(key))).toEqual([]);
  // F8/N-9 subset: no fence key or foreign org in CI, list, ITIL, relationship, ITIL-write or GraphQL outputs.
  const outputs = [`/cis/${ci}`, `/cis?search=${ci}`, `/itil/configuration-items/${ci}`, `/cis/${ci}/relationships`]
    .map(path => () => api('a').get(path)).concat(() => api('a').patch(`/itil/configuration-items/${ci}/lifecycle`, { stage: 'TEST' }),
      () => api('a').gql(`{ getCI(id:"${ci}") { _id _name _metadata } getCIs(limit: 5) { _id _metadata } }`));
  for (const output of outputs) expect(JSON.stringify((await output()).body)).not.toMatch(new RegExp(`op_id|ReconciliationOp|${B}`));
  expect(await history(ci)).toEqual([]);
});

it('AP1/X-11/X-17: an own pending gap is 409 on GET/PUT/history; foreign and missing stay one identical 404', async () => {
  const ci = id('ap1');
  await create('a', ci);
  await rows(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation,
      graph_effect, state, actor, epoch, plan, lease_expires_at)
    VALUES ($1, $1, $2, $3, 'api', 'direct_write', true, 'pending', 'seed', 0, NULL, now() + interval '5 minutes')`,
  [randomUUID(), A, ci]);
  expect((await api('a').get(`/cis/${ci}`)).body).toEqual(GAP);
  expect((await api('a').get(`/itil/configuration-items/${ci}/history`)).status).toBe(409);
  const put = await api('a').put(`/cis/${ci}`, { name: 'blocked' });
  expect([put.status, put.body]).toEqual([409, GAP]);
  expect((await node(ci))!['name']).toBe(ci);
  const foreign = await api('b').get(`/cis/${ci}`);
  const missing = await api('b').get(`/cis/${id('absent')}`);
  expect(foreign.status).toBe(404);
  expect(foreign.text).toBe(missing.text);
  expect((await api('b').put(`/cis/${ci}`, { name: 'x' })).text).toBe((await api('b').put(`/cis/${id('absent')}`, { name: 'x' })).text);
  expect((await api('a').get(`/cis?search=${ci}`)).body.pagination.total).toBe(0);
  await rows(`UPDATE ci_reconciliation_operations SET state = 'aborted' WHERE organization_id = $1 AND ci_id = $2
    AND actor = 'seed'`, [A, ci]);
});

it('R44-M1: a reused CI id never shows the former owner history; B rows stay B-stamped and B-owned', async () => {
  const ci = id('r44m1');
  const secret = `B_HISTORY_SECRET_${randomUUID()}`;
  await create('b', ci, { metadata: { note: secret } });
  const bIncarnation = (await node(ci))!['incarnation_id'];
  // The pre-S4 processor shape: B-stamped CI_UPDATED with a future timestamp, plus a legacy NULL row.
  await rows(`INSERT INTO ci_change_history (ci_id, change_type, change_source, new_values, changed_at,
      ci_incarnation_id, organization_id, correlation_id)
    VALUES ($1, 'updated', 'reconciliation', $2::jsonb, now() + interval '1 day', $3, $4, $5)`,
  [ci, JSON.stringify({ name: secret }), bIncarnation, B, randomUUID()]);
  await sql.pool.query('ALTER TABLE ci_change_history DROP CONSTRAINT ci_change_history_organization_required');
  try {
    await rows(`INSERT INTO ci_change_history (ci_id, change_type, change_source, new_values, ci_incarnation_id)
      VALUES ($1, 'updated', 'legacy', $2::jsonb, $3)`, [ci, JSON.stringify({ name: secret }), bIncarnation]);
  } finally {
    await sql.pool.query(`ALTER TABLE ci_change_history ADD CONSTRAINT ci_change_history_organization_required
      CHECK (organization_id IS NOT NULL) NOT VALID`);
  }
  expect((await api('b').delete(`/cis/${ci}`)).status).toBe(204);
  const deleted = (await history(ci)).filter(row => row.change_type === 'deleted');
  const [deleteOp] = (await ops(B, ci)).filter(op => op.operation === 'delete');
  expect(deleted).toHaveLength(1);
  expect(deleted[0]).toMatchObject({ organization_id: B, correlation_id: deleteOp.group_id, changed_by: 's4a-b' });
  expect(JSON.stringify(deleted[0].previous_values)).toContain(secret);

  await create('a', ci, { metadata: { created_at: '1999-01-01T00:00:00Z' } });
  // A merges a current value into its X: one journaled `update` whose T2 writes ONE A history row.
  await cypher('MATCH (c:CI {id: $id}) SET c.serial_number = $serial', { id: ci, serial: `serial-${ci}` });
  // R44-M2: B's retained field source, lineage and conflict for the reused id; A's current dimension row for the readers.
  await rows(`INSERT INTO ci_field_sources (organization_id, ci_id, field_name, field_value, source_name)
    VALUES ($1, $2, 'owner_note', $3, 'b-source')`, [B, ci, secret]);
  await rows(`INSERT INTO ci_source_lineage (organization_id, ci_id, source_name, source_id, confidence_score)
    VALUES ($1, $2, 'b-source', $3, 90)`, [B, ci, secret]);
  await rows(`INSERT INTO reconciliation_conflicts (organization_id, ci_id, conflict_type, source_data, detected_by)
    VALUES ($1, $2, 'field_conflict', $3::jsonb, 's4a-b')`, [B, ci, JSON.stringify({ secret })]);
  await rows(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id) VALUES ($1, $1, 'server', 'active', $2)`, [ci, A]);
  const merged = await api('a').post('/reconciliation/merge', { name: ci, ci_type: 'server', source: 'a-source',
    source_id: 'a-1', identifiers: { serial_number: `serial-${ci}` }, attributes: { owner_note: 'A_CURRENT' } });
  expect([merged.status, merged.body.data?.ci_id]).toEqual([200, ci]);
  const analytics = await api('a').get(`/analytics/change-history?ci_id=${ci}`);
  const itil = await api('a').get(`/itil/configuration-items/${ci}/history`);
  const graphql = await api('a').gql(`{ analytics { getChangeHistory(ciId:"${ci}") { _changeType _newValue _oldValue } } }`);
  expect([analytics.status, itil.status, graphql.status]).toEqual([200, 200, 200]);
  for (const body of [analytics.body, itil.body, graphql.body]) expect(JSON.stringify(body)).not.toContain(secret);
  expect(analytics.body.data.map((row: { change_type: string }) => row.change_type)).toEqual(['updated']);
  expect(itil.body.data).toHaveLength(1);
  expect(JSON.stringify(itil.body.data)).toContain('A_CURRENT');
  expect(graphql.body.data.analytics.getChangeHistory).toEqual([{ _changeType: 'updated', _newValue: 'A_CURRENT', _oldValue: null }]);
  const [mergeOp] = (await ops(A, ci)).filter(op => op.operation === 'update');
  expect(mergeOp.state).toBe('committed');
  const aRows = await rows('SELECT * FROM ci_change_history WHERE ci_id = $1 AND organization_id = $2', [ci, A]);
  expect(aRows.map(row => [row.change_type, row.changed_by, row.correlation_id])).toEqual([['updated', 's4a-a', mergeOp.group_id]]);
  const stamped = await rows('SELECT organization_id, count(*)::int AS n FROM ci_change_history WHERE ci_id = $1 GROUP BY 1 ORDER BY 1', [ci]);
  expect(stamped).toEqual(expect.arrayContaining([{ organization_id: B, n: 2 }, { organization_id: A, n: 1 }, { organization_id: null, n: 1 }]));
  const fields = await api('a').get(`/reconciliation/field-sources/${ci}`);
  expect(fields.body.data.fields).toEqual([expect.objectContaining({ field_name: 'owner_note', field_value: 'A_CURRENT', source_name: 'a-source' })]);
  expect(await rows('SELECT organization_id, field_value FROM ci_field_sources WHERE ci_id = $1 ORDER BY field_value', [ci]))
    .toEqual([{ organization_id: A, field_value: 'A_CURRENT' }, { organization_id: B, field_value: secret }]);
  const lineage = await api('a').get(`/reconciliation/lineage/${ci}`);
  expect(lineage.body.data.sources).toEqual([expect.objectContaining({ source_name: 'a-source', source_id: 'a-1' })]);
  const conflicts = await api('a').get('/reconciliation/conflicts');
  const gql = await api('a').gql(`{ _reconciliation { getCIFieldSources(_ciId: "${ci}") { _fields { _fieldName _fieldValue _sourceName } }
    getCILineage(_ciId: "${ci}") { _sources { _sourceId } } listConflicts { _ciId } } }`);
  expect(gql.body.data._reconciliation).toEqual({
    getCIFieldSources: { _fields: [{ _fieldName: 'owner_note', _fieldValue: 'A_CURRENT', _sourceName: 'a-source' }] },
    getCILineage: { _sources: [{ _sourceId: 'a-1' }] }, listConflicts: [] });
  expect([conflicts.body.data, conflicts.body.pagination.total]).toEqual([[], 0]); // B's conflict is not A's, nor counted
  for (const body of [fields.body, lineage.body, conflicts.body, gql.body]) expect(JSON.stringify(body)).not.toContain(secret);
  expect(await rows(`SELECT organization_id, source_id FROM ci_source_lineage WHERE ci_id = $1 ORDER BY organization_id = $2 DESC`,
    [ci, A])).toEqual([{ organization_id: A, source_id: 'a-1' }, { organization_id: B, source_id: secret }]);
});

it('F6 C-2/C-12/X-8/H-5 on real stores: holds and accept_target have no fence or graph effect; a stale conflict is superseded', async () => {
  const ci = id('f6');
  await create('a', ci);
  await cypher('MATCH (c:CI {id: $id}) SET c.serial_number = $id, c.name = "stored"', { id: ci });
  await rows(`INSERT INTO ci_field_sources (organization_id, ci_id, field_name, field_value, value_json, source_name)
    VALUES ($1, $2, 'name', 'stored', '"stored"', 'cmdb')`, [A, ci]);
  expect((await api('a').post('/reconciliation/rules', { name: `review-${ci}`, identification_rules: [],
    merge_strategies: [{ field_name: 'name', strategy: 'manual_review' }] })).status).toBe(201);
  const merge = (source: string, name: string) => api('a').post('/reconciliation/merge', { name: ci, ci_type: 'server', source,
    source_id: `${source}-1`, identifiers: { serial_number: ci }, attributes: { name } });
  const held = await merge('scan', 'v1');
  expect([held.status, held.body.data.status]).toEqual([202, 'pending_review']);
  const [c1] = held.body.data.conflict_ids;
  expect((await node(ci))!['name']).toBe('stored');
  // C-12: a same-source merge moves the stored value on, so c1 is stale; changed content supersedes it.
  expect((await merge('cmdb', 'stored2')).status).toBe(200);
  const [c2] = (await merge('scan', 'v2')).body.data.conflict_ids;
  expect(await rows('SELECT id, status, superseded_by FROM reconciliation_conflicts WHERE ci_id = $1 ORDER BY created_at', [ci]))
    .toEqual([{ id: c1, status: 'superseded', superseded_by: c2 }, { id: c2, status: 'pending', superseded_by: null }]);
  const [{ content_hash: revision }] = await rows('SELECT content_hash FROM reconciliation_conflicts WHERE id = $1', [c2]);
  const resolved = await api('a').post(`/reconciliation/conflicts/${c2}/resolve`, { resolution: 'accept_target', expected_revision: revision });
  expect([resolved.status, resolved.body.data.status]).toEqual([200, 'resolved']);
  const journal = await ops(A, ci);
  expect(journal.map(op => [op.operation, op.graph_effect, op.state])).toEqual([['direct_write', true, 'committed'],
    ['hold', false, 'committed'], ['update', true, 'committed'], ['hold', false, 'committed'], ['resolve_conflict', false, 'committed']]);
  for (const op of journal) expect(await fences(op.id)).toHaveLength(op.graph_effect ? 1 : 0);
  expect((await node(ci))!['name']).toBe('stored2');
  expect((await history(ci)).map(row => row.change_type)).toEqual(['updated']);
});

it('F0/X-14/N-7b: invalid shapes and reserved aliases are 400 before any journal row; the CI is unchanged', async () => {
  const ci = id('f0');
  const peer = id('f0-peer');
  await create('a', ci);
  await create('a', peer);
  const before = (await rows('SELECT count(*)::int AS n FROM ci_reconciliation_operations WHERE organization_id = $1', [A]))[0].n;
  let deep: unknown = 1;
  for (let depth = 0; depth < 33; depth++) deep = { d: deep };
  const ids101 = Array.from({ length: 101 }, (_, n) => `${ci}-${n}`);
  const cases: Array<[string, () => request.Test]> = [
    ['top-level alias', () => api('a').post('/cis', { _id: 'y', name: 'n', type: 'server' })],
    ['nested metadata alias', () => api('a').post('/cis', { name: 'n', type: 'server', metadata: { a: { _organization_id: B } } })],
    ['PUT id', () => api('a').put(`/cis/${ci}`, { id: 'other' })],
    ['PUT metadata op id', () => api('a').put(`/cis/${ci}`, { metadata: { __op_id: 1 } })],
    ['relationship alias', () => api('a').post('/relationships', { from_id: ci, to_id: peer, type: 'DEPENDS_ON', properties: { organization_id: B } })],
    ['relationship map value', () => api('a').post('/relationships', { from_id: ci, to_id: peer, type: 'DEPENDS_ON', properties: { m: { a: 1 } } })],
    ['256-unit id', () => api('a').put(`/cis/${'x'.repeat(256)}`, { name: 'n' })],
    ['U+0000', () => api('a').put(`/cis/${ci}`, { name: 'a\u0000b' })],
    ['lone surrogate member', () => api('a').put(`/cis/${ci}`, { metadata: { '\uD800': 1 } })],
    ['depth 33', () => api('a').put(`/cis/${ci}`, { metadata: deep as object })],
    ['65 537-byte value', () => api('a').put(`/cis/${ci}`, { metadata: { big: 'x'.repeat(65_537) } })],
    ['1 001-element array', () => api('a').put(`/cis/${ci}`, { metadata: { list: Array(1001).fill(1) } })],
    ['101 change CIs', () => api('a').post('/itil/changes', { changeType: 'NORMAL', description: 'x'.repeat(20), affectedCIIds: ids101,
      requestedBy: 'a', plannedStart: '2026-01-01T00:00:00Z', plannedDuration: 5, implementationPlan: 'x'.repeat(60) })],
    ['101 baseline CIs', () => api('a').post('/itil/baselines', { name: 'too-many', ciIds: ids101, createdBy: 'a' })],
    ['invalid auditDate', () => api('a').post(`/itil/configuration-items/${ci}/audit`, { auditDate: 'not-a-date' })],
    ['256-char merge source', () => api('a').post('/reconciliation/merge', { name: 'm', ci_type: 'server', source: 's'.repeat(256), source_id: 'f0', identifiers: { serial_number: ci } })],
  ];
  for (const [name, call] of cases) expect({ name, status: (await call()).status }).toEqual({ name, status: 400 });
  expect((await rows('SELECT count(*)::int AS n FROM ci_reconciliation_operations WHERE organization_id = $1', [A]))[0].n).toBe(before);
  expect((await node(ci))!['name']).toBe(ci);
});

it('X-27/X-27b/N-7c: delete and restore snapshots keep every Neo4j type; oversized plans are a 422 abort', async () => {
  const ci = id('typed');
  const original = {
    name: 'a\u0000b', i60: neo4j.int('1152921504606846976'), i5: neo4j.int(5), f5: 5, nan: NaN, negZero: -0,
    big: 1e300, tiny: 5e-324, floats: [1.5, 1e300], ints: [neo4j.int(1), neo4j.int(2)],
    metadata: '{"\\ud800":1,"$hp1":"int","v":"5"}',
  };
  await cypher(`CREATE (c:CI:Server {id: $id, organization_id: $org, incarnation_id: $inc, type: 'server'})
    SET c += $props, c.at = datetime('2026-01-01T00:00:00.000000005Z')`, { id: ci, org: A, inc: randomUUID(), props: original });
  const baseline = await api('a').post('/itil/baselines', { name: id('bl'), ciIds: [ci], createdBy: 'a' });
  expect(baseline.status).toBe(201);
  await cypher('MATCH (c:CI {id: $id}) SET c.i60 = 0, c.f5 = 0.5, c.name = "changed", c.nan = 1.0', { id: ci });
  const restored = await api('a').post(`/itil/baselines/${baseline.body.data.id}/restore`, { ciId: ci, performedBy: 'a' });
  expect(restored.status).toBe(200);
  const props = (await node(ci))!;
  expect(props).toMatchObject({ name: 'a\u0000b', metadata: original.metadata, big: 1e300, tiny: 5e-324, floats: [1.5, 1e300] });
  expect(neo4j.isInt(props['i60']) && String(props['i60'])).toBe('1152921504606846976');
  expect(neo4j.isInt(props['i5'])).toBe(true);
  expect(neo4j.isInt(props['f5'])).toBe(false);
  expect(Number.isNaN(props['nan'])).toBe(true);
  expect(Object.is(props['negZero'], -0)).toBe(true);
  expect((props['ints'] as unknown[]).every(value => neo4j.isInt(value))).toBe(true);

  // N-7c: reserved keys in a stored snapshot are dropped, never written; the org is unchanged.
  const spoofed = await rows(`INSERT INTO itil_baselines (id, name, baseline_type, baseline_data, created_by, organization_id)
    VALUES ($1, $2, 'configuration', $3::jsonb, 'a', $4) RETURNING id`, [randomUUID(), id('spoof'),
    JSON.stringify({ [ci]: enc({ name: 'r', __organization_id: B, _op_id: 'x', reconciliation_op_id: 'y', organizationId: B }) }), A]);
  expect((await api('a').post(`/itil/baselines/${spoofed[0].id}/restore`, { ciId: ci, performedBy: 'a' })).status).toBe(200);
  expect(Object.keys((await node(ci))!).filter(key => /op_id|organizationid|^_+organization/i.test(key))).toEqual([]);
  expect((await node(ci))!['organization_id']).toBe(A);

  expect((await api('a').delete(`/cis/${ci}`)).status).toBe(204);
  const [deleted] = (await history(ci)).filter(row => row.change_type === 'deleted');
  const snapshot = dec(deleted.previous_values) as Record<string, unknown>;
  expect(String(snapshot['i60'])).toBe('1152921504606846976');
  expect(neo4j.isInt(snapshot['i5']) && !neo4j.isInt(snapshot['f5'])).toBe(true);
  expect(String(snapshot['at'])).toBe('2026-01-01T00:00:00.000000005Z');
  expect(snapshot['name']).toBe('r');

  const wide = id('wide'); // §3.6 bounds each value, not the envelope: three 30 KiB properties still delete.
  await cypher("CREATE (c:CI {id: $id, organization_id: $org, name: 'w', a: $v, b: $v, c: $v})", { id: wide, org: A, v: 'x'.repeat(30_000) });
  expect((await api('a').delete(`/cis/${wide}`)).status).toBe(204);
  const huge = id('huge');
  await cypher("CREATE (c:CI {id: $id, organization_id: $org, name: 'h', metadata: $m})",
    { id: huge, org: A, m: JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }) });
  for (let attempt = 0; attempt < 2; attempt++) expect((await api('a').delete(`/cis/${huge}`)).status).toBe(422);
  const aborted = await ops(A, huge);
  expect(aborted.map(op => [op.state, op.last_error, op.plan])).toEqual([['aborted', 'plan_unrepresentable', null], ['aborted', 'plan_unrepresentable', null]]);
  for (const op of aborted) expect(await fences(op.id)).toEqual([]);
  expect(await node(huge)).toBeDefined();
});

it('F1 X-1/X-2/X-3/X-12: unproven outcomes stay gated until the fence decides; evidence is written exactly once', async () => {
  const ci = id('x1');
  await create('a', ci);
  seamOnce('beforeW', async () => { throw new Error('connection reset before send'); });
  const unsent = await api('a').put(`/cis/${ci}`, { name: 'never' });
  expect(unsent.status).toBe(503);
  expect(unsent.body.correlation_id).toEqual(expect.any(String));
  expect((await api('a').get(`/cis/${ci}`)).status).toBe(409);
  expect((await api('b').get(`/cis/${ci}`)).status).toBe(404);
  await sweep(A);
  const [, unsentOp] = await ops(A, ci);
  expect(unsentOp.state).toBe('aborted');
  expect(await fences(unsentOp.id)).toEqual([{ o: expect.objectContaining({ outcome: 'aborted' }) }]);
  expect((await node(ci))!['name']).toBe(ci);

  // Lost acknowledgement after the server committed the delete (X-2/X-12), then a lost T2 (X-3).
  for (const point of ['afterW', 'beforeT2']) {
    const target = id(point);
    await create('a', target);
    seamOnce(point, async () => { throw new Error('acknowledgement lost'); });
    expect((await api('a').delete(`/cis/${target}`)).status).toBe(503);
    expect(await node(target)).toBeUndefined();
    expect((await api('a').get(`/cis/${target}`)).body).toEqual(GAP);
    expect((await api('b').get(`/cis/${target}`)).status).toBe(404);
    await sweep(A);
    await sweep(A);
    expect((await ops(A, target)).map(op => op.state)).toEqual(['committed', 'committed']);
    expect((await history(target)).filter(row => row.change_type === 'deleted')).toHaveLength(1);
    expect((await api('a').get(`/cis/${target}`)).status).toBe(404);
  }
});

it('F2 X-4/X-10/X-13/X-22: outages back off, failed stays gated until corrective replay, cap is exactly 1 000', async () => {
  const ci = id('x4');
  await create('a', ci);
  seamOnce('afterW', async () => { throw new Error('lost'); });
  expect((await api('a').put(`/cis/${ci}`, { name: 'applied' })).status).toBe(503);
  setJournalSeam(async point => { if (point === 'beforeFence') throw new Error('Neo4j down'); });
  await sweep(A);
  const [, stalled] = await ops(A, ci);
  expect([stalled.state, stalled.attempts, stalled.claim_token]).toEqual(['pending', 1, null]);
  expect((await api('a').get(`/cis/${ci}`)).status).toBe(409);
  setJournalSeam(undefined);
  await sweep(A);
  expect((await ops(A, ci))[1].state).toBe('committed');
  expect((await node(ci))!['name']).toBe('applied');

  const failing = id('x10');
  await create('a', failing);
  setJournalSeam(async point => { if (point === 'beforeT2') throw Object.assign(new Error('check'), { code: '23514' }); });
  expect((await api('a').delete(`/cis/${failing}`)).status).toBe(503);
  await sweep(A);
  const [, failed] = await ops(A, failing);
  expect(failed.state).toBe('failed');
  expect((await api('a').get(`/cis/${failing}`)).status).toBe(409);
  setJournalSeam(undefined);
  expect(await requeueFailedJournalGroup(failed.id)).toBe(1);
  await sweep(A);
  expect((await ops(A, failing))[1].state).toBe('committed');
  expect((await history(failing)).filter(row => row.change_type === 'deleted')).toHaveLength(1);

  const planless = randomUUID();
  await rows(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation,
      graph_effect, state, actor, epoch, plan, lease_expires_at)
    VALUES ($1, $1, $2, $3, 'api', 'direct_write', true, 'pending', 'seed', 0, NULL, now())`, [planless, A, id('x13')]);
  await sweep(A);
  expect((await rows('SELECT state FROM ci_reconciliation_operations WHERE id = $1', [planless]))[0].state).toBe('aborted');

  const [p, q] = [id('cap-p'), id('cap-q')];
  await create('c', p);
  await create('c', q);
  await rows(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation,
      graph_effect, state, actor, epoch, plan, lease_expires_at)
    SELECT gen_random_uuid(), gen_random_uuid(), $1, 'cap-' || n, 'api', 'direct_write', true, 'pending', 'seed', 0,
      NULL, now() + interval '1 hour' FROM generate_series(1, 1000) n`, [C]);
  expect((await api('c').post('/cis', { name: 'n', type: 'server' })).status).toBe(503);
  expect((await api('c').get('/cis')).status).toBe(200);
  await create('b', id('cap-b'));
  await rows(`UPDATE ci_reconciliation_operations SET state = 'aborted' WHERE organization_id = $1 AND ci_id = 'cap-1'`, [C]);
  const inflight = () => rows(`SELECT count(*)::int AS n FROM ci_reconciliation_operations
    WHERE organization_id = $1 AND state IN ('pending', 'failed')`, [C]);
  expect((await api('c').post('/relationships', { from_id: p, to_id: q, type: 'DEPENDS_ON' })).status).toBe(503);
  expect((await inflight())[0].n).toBe(999);
  await create('c', id('cap-last'));
});

it('F2 X-9/X-23: a W sent after recovery fenced its op aborted rolls back whole; W never uses managed retries', async () => {
  const ci = id('x9');
  await create('a', ci);
  const managed = (['executeWrite', 'writeTransaction'] as const).map(name => jest.spyOn(Session.prototype, name));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  seamOnce('beforeW', async () => { entered.resolve(); await release.promise; });
  const late = api('a').put(`/cis/${ci}`, { name: 'late' }).then(response => response);
  await entered.promise;
  await sweep(A);
  const [, op] = await ops(A, ci);
  expect(op.state).toBe('aborted');
  release.resolve();
  expect((await late).body).toEqual({ success: false, error: 'Conflict', message: 'CI could not be reconciled' });
  expect((await node(ci))!['name']).toBe(ci);
  expect(await fences(op.id)).toEqual([{ o: expect.objectContaining({ outcome: 'aborted' }) }]);
  for (const spy of managed) expect(spy).not.toHaveBeenCalled();
});

it('F3 X-5/X-24/X-25: no id oracle or foreign overwrite, pending delete gates only its owner, a vanished target aborts without a fence', async () => {
  const [ci, free] = [id('x5'), id('x5-free')];
  await create('a', ci);
  const before = await node(ci);
  // T5: REST ids are server-issued; a taken and a free id are one identical 400 before any journal row or graph write.
  const taken = await api('b').post('/cis', { id: ci, name: 'stolen', type: 'server' });
  const unused = await api('b').post('/cis', { id: free, name: 'stolen', type: 'server' });
  expect([taken.status, taken.body, unused.text]).toEqual([400, { success: false, error: 'Bad Request', message: 'Invalid request' }, taken.text]);
  expect([await ops(B, ci), await ops(B, free), await node(free)]).toEqual([[], [], undefined]);
  // The engine path still cannot overwrite a foreign id: a definitive abort with no fence.
  await expect(create('b', ci)).rejects.toBeInstanceOf(JournalAbortedError);
  const [lost] = await ops(B, ci);
  expect([lost.state, await fences(lost.id), await node(ci)]).toEqual(['aborted', [], before]);

  const pendingDelete = id('x24');
  await create('b', pendingDelete);
  seamOnce('beforeT2', async () => { throw new Error('T2 held'); });
  expect((await api('b').delete(`/cis/${pendingDelete}`)).status).toBe(503);
  expect((await api('b').get(`/cis/${pendingDelete}`)).status).toBe(409);
  expect((await api('b').get(`/itil/configuration-items/${pendingDelete}`)).status).toBe(409);
  expect((await api('b').gql(`{ getCI(id:"${pendingDelete}") { _id } }`)).body.errors?.[0].extensions.code).toBe('CONFLICT');
  expect((await api('a').get(`/cis/${pendingDelete}`)).status).toBe(404);
  await sweep(B);
  expect((await api('b').get(`/cis/${pendingDelete}`)).status).toBe(404);
  expect((await history(pendingDelete)).filter(row => row.change_type === 'deleted')).toHaveLength(1);

  const vanishing = id('x25');
  await create('a', vanishing);
  seamOnce('beforeW', async () => { await cypher('MATCH (c:CI {id: $id}) DETACH DELETE c', { id: vanishing }); });
  expect((await api('a').put(`/cis/${vanishing}`, { name: 'late' })).status).toBe(404);
  const [, missed] = await ops(A, vanishing);
  expect([missed.state, missed.last_error]).toEqual(['aborted', 'target_missing']);
  expect(await fences(missed.id)).toEqual([]);
});

it('F4 X-16..X-21: writers and AP-P\'/AP-M\'\' readers on a CI with an in-flight W are refused, never interleaved', async () => {
  const [ci, peer] = [id('x17'), id('x17-peer')];
  await create('a', ci);
  await create('a', peer);
  const baseline = (await api('a').post('/itil/baselines', { name: id('x19'), ciIds: [ci], createdBy: 'a' })).body.data.id;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  seamOnce('beforeW', async () => { entered.resolve(); await release.promise; });
  const first = api('a').put(`/cis/${ci}`, { name: 'first' }).then(response => response);
  await entered.promise;
  const refused = await Promise.all([
    api('a').put(`/cis/${ci}`, { name: 'second' }),
    api('a').post('/relationships', { from_id: ci, to_id: peer, type: 'DEPENDS_ON' }),
    api('a').post(`/itil/baselines/${baseline}/restore`, { ciId: ci, performedBy: 'a' }),
    api('a').patch(`/itil/configuration-items/${ci}/lifecycle`, { stage: 'TEST' }),
    api('a').post('/itil/incidents', { affectedCIId: ci, description: 'incident on gap', reportedBy: 'a' }),
    api('a').post('/itil/baselines', { name: id('x21'), ciIds: [ci], createdBy: 'a' }),
    api('a').get(`/cis/${ci}`),
  ]);
  expect(refused.map(response => response.status)).toEqual([409, 409, 409, 409, 409, 409, 409]);
  release.resolve();
  expect((await first).status).toBe(200);
  expect((await node(ci))!['name']).toBe('first');
  expect((await api('a').post('/itil/incidents', { affectedCIId: ci, description: 'incident after gap', reportedBy: 'a' })).status).toBe(201);
});

it('F5 X-11/X-15a/X-29: lists mask own gaps from one membership point; a busy org fails only itself', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  seamOnce('beforeW', async () => { entered.resolve(); await release.promise; });
  let creating: Promise<unknown> | undefined;
  const seen: string[][] = [];
  const total = await readCIList(A, async pending => {
    seen.push(pending);
    if (!creating) {
      creating = api('a').post('/cis', { name: 'x15', type: 'server' }).then(response => response);
      await entered.promise;
    }
    return (await cypher('MATCH (c:CI) WHERE c.organization_id = $org AND NOT c.id IN $pending RETURN count(c) AS n',
      { org: A, pending }))[0]!['n'];
  });
  expect(seen).toHaveLength(2);
  release.resolve();
  const created = await creating as request.Response;
  expect([created.status, seen[1]]).toEqual([201, expect.arrayContaining([created.body.data.id])]);
  expect(Number(total)).toBe(Number((await cypher('MATCH (c:CI) WHERE c.organization_id = $org AND c.id <> $id RETURN count(c) AS n',
    { org: A, id: created.body.data.id }))[0]!['n']));

  // Own-org pessimistic cap: two held re-reads, a third A list 503s at once, B is unaffected.
  // Both optimistic phases bump the epoch before either takes its FOR SHARE lock; the third
  // changes only pending membership (an INSERT is not blocked by the share locks).
  const hold = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const bumped = Promise.withResolvers<void>();
  let [bumps, inPessimistic] = [0, 0];
  const busy = () => {
    let calls = 0;
    return readCIList(A, async () => {
      if (++calls === 1) {
        await rows('UPDATE ci_reconciliation_epochs SET epoch = epoch + 1 WHERE organization_id = $1', [A]);
        if (++bumps === 2) bumped.resolve();
        await bumped.promise;
      } else {
        if (++inPessimistic === 2) held.resolve();
        await hold.promise;
      }
      return 0;
    });
  };
  const reads = [busy(), busy()];
  await held.promise;
  const gap = id('x29');
  const third = readCIList(A, async () => {
    await rows(`INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation,
        graph_effect, state, actor, epoch, lease_expires_at)
      VALUES ($1, $1, $2, $3, 'api', 'direct_write', true, 'pending', 'seed', 0, now() + interval '5 minutes')`,
    [randomUUID(), A, gap]);
    return 0;
  });
  await expect(third).rejects.toBeInstanceOf(CIListUnavailableError);
  expect((await api('b').get('/cis')).status).toBe(200);
  hold.resolve();
  await Promise.allSettled(reads);
  await rows(`UPDATE ci_reconciliation_operations SET state = 'aborted' WHERE organization_id = $1 AND ci_id = $2`, [A, gap]);
});

it("F8 v16 §5.1: a queued T1 is served before a later reader (R1 -> T1 -> R2); other orgs never wait", async () => {
  const [x, y, z, bx] = [id('f8-x'), id('f8-y'), id('f8-z'), id('f8-bx')];
  await create('a', y);
  expect((await rows('SELECT hashtextextended($1::text, 4431) <> hashtextextended($2::text, 4431) AS distinct', [A, B]))[0].distinct).toBe(true);
  const blockedBy = async (pid: number) =>
    (await rows('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]))[0].n as number;
  // Real-time poll (5 s max): PG lock waits are only observable from another session, never as an event.
  const until = async (check: () => Promise<boolean>) => {
    for (let wait = 0; wait < 100 && !(await check()); wait++) {
      const tick = Promise.withResolvers<void>(); setTimeout(tick.resolve, 50); await tick.promise;
    }
  };
  const held = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const r1 = writeReferencedCIs(A, [x], async client => {
    held.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await release.promise;
  });
  const r1Pid = await held.promise;
  const t1 = api('a').put(`/cis/${y}`, { name: 'f8' }).then(response => response);
  await until(async () => (await blockedBy(r1Pid)) > 0);
  const [t1Pid] = (await rows('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [r1Pid])).map(row => row.pid);
  expect(t1Pid).toBeDefined();
  let entered = false;
  const r2 = writeReferencedCIs(A, [z], async client => {
    entered = true;
    return (await client.query(`SELECT count(*)::int AS n FROM ci_reconciliation_operations
      WHERE organization_id = $1 AND ci_id = $2`, [A, y])).rows[0].n as number;
  });
  await until(async () => entered || (await blockedBy(t1Pid)) > 0);
  expect(entered).toBe(false);
  await writeReferencedCIs(B, [bx], async () => undefined);
  release.resolve();
  await r1;
  expect(await r2).toBe(2);
  expect((await t1).status).toBe(200);
});
it('F7 H-2/H-4 and the old-then-new writer cutover: NULL-org history and global criticality upserts are refused', async () => {
  await expect(rows("INSERT INTO ci_change_history (ci_id, change_type, change_source) VALUES ('s4a-h2', 'x', 'old')"))
    .rejects.toMatchObject({ code: '23514' });
  await expect(rows(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at) VALUES ('s4a-crit', '{}', now())
    ON CONFLICT (ci_id) DO NOTHING`)).rejects.toMatchObject({ code: '42P10' });
  await expect(rows("INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at) VALUES ('s4a-crit', '{}', now())"))
    .rejects.toMatchObject({ code: '23514' });
  const upsert = (org: string) => rows(`INSERT INTO ci_criticality_scores (ci_id, factors, calculated_at, organization_id)
    VALUES ('s4a-crit', '{}', now(), $1) ON CONFLICT (organization_id, ci_id) WHERE organization_id IS NOT NULL
    DO UPDATE SET calculated_at = now()`, [org]);
  for (const org of [A, B, A]) await upsert(org);
  expect((await rows("SELECT organization_id FROM ci_criticality_scores WHERE ci_id = 's4a-crit' ORDER BY 1")).length).toBe(2);
  await rows("DELETE FROM ci_criticality_scores WHERE ci_id = 's4a-crit'");

  // M-1 for 036: a rerun changes nothing. M-2 (fresh initdb parity) is in hp1-s1-schema's initdb case.
  const contract = `SELECT
    (SELECT count(*) FROM pg_constraint WHERE conname IN ('ci_change_history_organization_required',
      'ci_criticality_scores_organization_required'))::int AS org_checks,
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'ci_criticality_scores'::regclass AND contype = 'p')::int AS pk,
    (SELECT count(*) FROM pg_indexes WHERE indexname IN ('ci_criticality_scores_org_ci_key',
      'ci_criticality_scores_legacy_ci_key'))::int AS keys`;
  const expected = { org_checks: 2, pk: 0, keys: 2 };
  await sql.pool.query(readFileSync(join(__dirname,
    '../../../database/src/postgres/migrations/036_history_criticality_org_contract.sql'), 'utf8'));
  expect((await rows(contract))[0]).toEqual(expected);

  const ci = id('h4');
  await create('a', ci);
  expect((await api('b').gql(`mutation { deleteCI(id:"${ci}") }`)).body.errors?.[0].extensions.code).toBe('NOT_FOUND');
  expect((await api('a').gql(`mutation { deleteCI(id:"${ci}") }`)).body.data).toEqual({ deleteCI: true });
  expect((await history(ci)).map(row => [row.change_type, row.organization_id])).toEqual([['deleted', A]]);
});
