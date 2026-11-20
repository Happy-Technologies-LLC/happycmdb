// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { fork } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const host = fork(join(__dirname, '../../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(new Error(error));
  else reply.resolve(rows);
});
function sql(text: string, params: unknown[] = [], mode: 'query' | 'exec' = 'query'): Promise<unknown[]> {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op: mode, sql: text, params });
  return promise;
}
const query = (text: string, params?: unknown[]) => sql(text, params).then(rows => ({ rows }));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ciNodes = new Map<string, string>();
const getCI = jest.fn();
const getSession = jest.fn();
jest.mock('@cmdb/database', () => ({
  ...jest.requireActual<object>('@cmdb/database/journal/encoding'),
  Neo4jClient: jest.fn(),
  getPostgresClient: () => ({ query, pool: { query } }),
  getNeo4jClient: () => ({ getSession, getCI }),
  getUnifiedCredentialService: () => ({}),
  queueManager: { getQueue: jest.fn() },
}));
jest.mock('@cmdb/identity-resolution', () => ({ getIdentityReconciliationEngine: () => ({}) }));
jest.mock('@cmdb/integration-framework', () => ({}));
jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    authenticate: () => (req: Request & { user?: object }, _res: Response, next: NextFunction) => {
      req.user = { _userId: 'gql-user', _role: 'operator', _organizationId: req.headers.authorization === 'Bearer B' ? B : A };
      next();
    },
  }),
}));

import { createGraphQLServer } from '../../server';
import { itilNestedRecords, itilRecordQueries } from '../itil-record.resolvers';
import type { GraphQLContext } from '../index';

const migrationDir = join(__dirname, '../../../../../database/src/postgres/migrations');
const schema = readFileSync(join(migrationDir, '001_complete_schema.sql'), 'utf8');
function tableDDL(name: string): string {
  const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
  if (!match) throw new Error(`Missing ${name} DDL`);
  return match[0];
}
const app = express();
let server: Awaited<ReturnType<typeof createGraphQLServer>>['server'];
beforeAll(async () => {
  await sql(['itil_baselines', 'itil_incidents', 'itil_changes'].map(tableDDL).join('\n'), [], 'exec');
  const migration = readFileSync(join(migrationDir, '028_change_history_reconciliation_org_provenance.sql'), 'utf8');
  const journalTable = migration.match(/CREATE TABLE IF NOT EXISTS ci_reconciliation_operations \([\s\S]*?\n\);/);
  if (!journalTable) throw new Error('Missing journal DDL');
  await sql(journalTable[0], [], 'exec');
  for (const file of ['012_itil_baseline_organization_scope.sql', '013_itil_baseline_org_name_unique.sql',
    '035_itil_record_ownership.sql']) await sql(readFileSync(join(migrationDir, file), 'utf8'), [], 'exec');
  const hap922 = join(migrationDir, '040_itil_change_implementation_fields.sql');
  if (existsSync(hap922)) await sql(readFileSync(hap922, 'utf8'), [], 'exec');
  ({ server } = await createGraphQLServer(app));
}, 30000);
afterAll(async () => { await server?.stop(); host.kill(); });
beforeEach(async () => {
  await sql('DELETE FROM itil_incidents; DELETE FROM itil_changes;', [], 'exec');
  ciNodes.clear();
  ciNodes.set('ci-a', A);
  ciNodes.set('ci-b', B);
  getSession.mockImplementation(() => ({
    run: async (_cypher: string, params: { id: string; organizationId: string }) => ({
      records: ciNodes.get(params.id) === params.organizationId ? [
        { get: () => ({ properties: { id: params.id, organization_id: params.organizationId, name: params.id } }) },
      ] : [],
    }),
    close: async () => {},
  }));
  getCI.mockImplementation(async (id: string, org: string) =>
    ciNodes.get(id) === org ? { id, organization_id: org } : null);
});
const graphql = (text: string, org = 'A') => request(app).post('/graphql')
  .set('Authorization', `Bearer ${org}`).send({ query: text });
const seedChange = (id: string, status: string, type = 'normal', ids = ['ci-a'], org = A) => sql(
  `INSERT INTO itil_changes(id, change_number, title, change_type, affected_ci_ids, requested_by,
    scheduled_start, scheduled_end, implementation_plan, status, organization_id)
    VALUES ($1, $2, 'historic change', $3, $4, 'alice',
      '2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z', 'planned work', $5, $6)`,
  [id, `CHG-${id}`, type, ids, status, org]);

it('filters both physical REQUESTED statuses in top-level counts and nested CI changes', async () => {
  await seedChange('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'draft');
  await seedChange('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'pending_approval');
  await seedChange('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'approved');
  await seedChange('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'pending_approval', 'normal', ['ci-a'], B);
  const response = await graphql('{ changes(status: REQUESTED) { total items { id status } } }');
  expect(response.body.errors).toBeUndefined();
  expect(response.body.data?.changes).toEqual({ total: 2, items: expect.arrayContaining([
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'REQUESTED' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'REQUESTED' },
  ]) });
  const nested = await itilNestedRecords.changes('ci-a', { status: 'REQUESTED' },
    { user: { _organizationId: A } } as GraphQLContext);
  expect(nested.map(row => row.id).sort()).toEqual([
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ]);
});

it('serializes an owned persisted major change in detail, page and metrics', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await seedChange(id, 'draft', 'major');
  const response = await graphql(`{ change(id: "${id}") { changeType }
    changes { items { changeType } } changeMetrics { byType { changeType count } } }`);
  expect(response.body.errors).toBeUndefined();
  expect(response.body.data).toMatchObject({ change: { changeType: 'MAJOR' },
    changes: { items: [{ changeType: 'MAJOR' }] },
    changeMetrics: { byType: [{ changeType: 'MAJOR', count: 1 }] } });
});

it('preserves incident and change reads when an owned affected CI has been deleted', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await sql(`INSERT INTO itil_incidents(id, incident_number, title, impact, urgency, priority,
    affected_ci_id, reported_by, organization_id) VALUES ($1, 'INC-A', 'historic incident',
      'medium', 'medium', 3, 'ci-a', 'alice', $2)`, [id, A]);
  await seedChange(id, 'draft', 'normal', ['ci-a', 'ci-c', 'ci-b']);
  ciNodes.set('ci-c', A);
  ciNodes.delete('ci-a');
  const response = await graphql(`{ incident(id: "${id}") { id affectedCI { _id } }
    change(id: "${id}") { id affectedCIs { _id } } }`);
  expect(response.body.errors).toBeUndefined();
  expect(response.body.data).toEqual({ incident: { id, affectedCI: null },
    change: { id, affectedCIs: [null, { _id: 'ci-c' }, null] } });
});

it('refuses oversized affected-CI writes and bounds legacy graph reads by distinct IDs', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const repeated = Array(101).fill('ci-a');
  const create = await request(app).post('/graphql').set('Authorization', 'Bearer A').send({
    query: `mutation ($ids: [ID!]!) { createChange(input: {
      changeType: NORMAL, description: "change with many affected CIs", affectedCIIds: $ids,
      requestedBy: "alice", plannedStart: "2026-10-02T00:00:00Z", plannedDuration: 60,
      implementationPlan: "drain workload, patch system, restart, and confirm all health checks"
    }) { id } }`, variables: { ids: repeated },
  });
  expect(create.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  expect(getCI).not.toHaveBeenCalled();
  await seedChange(id, 'draft', 'normal', repeated);
  getSession.mockClear();
  const historical = await graphql(`{ change(id: "${id}") { affectedCIs { _id } } }`);
  expect(historical.body.errors).toBeUndefined();
  expect(historical.body.data?.change?.affectedCIs).toHaveLength(repeated.length);
  expect(historical.body.data.change.affectedCIs.every((ci: { _id: string }) => ci._id === 'ci-a')).toBe(true);
  expect(getSession).toHaveBeenCalledTimes(1);
  await sql('UPDATE itil_changes SET affected_ci_ids = $1 WHERE id = $2', [
    Array.from({ length: 101 }, (_, index) => `ci-${index}`), id,
  ]);
  getSession.mockClear();
  const oversized = await graphql(`{ change(id: "${id}") { affectedCIs { _id } } }`);
  expect(oversized.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  expect(getSession).not.toHaveBeenCalled();
});

it('HAP-922: updateChange persists implementedBy and actualDuration; change and changes read them back', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await seedChange(id, 'approved');
  await seedChange(foreign, 'approved', 'normal', ['ci-b'], B);
  const update = (target: string, input: string) => graphql(`mutation { updateChange(id: "${target}", input: ${input})
    { id status implementedBy actualDuration } }`);
  const results = [];
  for (const input of ['{ implementedBy: "alice" }', '{ actualDuration: 45 }',
    '{ status: IMPLEMENTED, implementedBy: "bob", actualDuration: 90 }']) results.push((await update(id, input)).body);
  expect(results).toEqual([
    { data: { updateChange: { id, status: 'APPROVED', implementedBy: 'alice', actualDuration: null } } },
    { data: { updateChange: { id, status: 'APPROVED', implementedBy: 'alice', actualDuration: 45 } } },
    { data: { updateChange: { id, status: 'IMPLEMENTED', implementedBy: 'bob', actualDuration: 90 } } },
  ]);
  const read = await graphql(`{ change(id: "${id}") { implementedBy actualDuration }
    changes { items { id implementedBy actualDuration } } }`);
  expect(read.body).toEqual({ data: { change: { implementedBy: 'bob', actualDuration: 90 },
    changes: { items: [{ id, implementedBy: 'bob', actualDuration: 90 }] } } });
  const rows = await sql('SELECT * FROM itil_changes ORDER BY id');
  // Foreign is indistinguishable from missing; GraphQL bypasses Joi, so the controller bounds apply.
  const input = '{ implementedBy: "mallory", actualDuration: 5 }';
  const [foreignBody, missingBody] = [(await update(foreign, input)).body,
    (await update('dddddddd-dddd-4ddd-8ddd-dddddddddddd', input)).body];
  expect(foreignBody.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
  expect(JSON.stringify(foreignBody)).toBe(JSON.stringify(missingBody));
  const rejected = [];
  for (const bad of ['{ actualDuration: -5 }', `{ implementedBy: "${'x'.repeat(256)}" }`, '{ implementedBy: "nul\\u0000" }']) {
    rejected.push((await update(id, bad)).body.errors?.[0]?.extensions?.code);
  }
  expect(rejected).toEqual(['BAD_USER_INPUT', 'BAD_USER_INPUT', 'BAD_USER_INPUT']);
  expect(await sql('SELECT * FROM itil_changes ORDER BY id')).toEqual(rows);
});

it('updateChange status APPROVED records the verified principal and refuses a non-pre-approval change', async () => {
  const pending = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const closed = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await seedChange(pending, 'pending_approval');
  await seedChange(closed, 'closed');
  const approve = (id: string) => graphql(`mutation { updateChange(id: "${id}", input: { status: APPROVED }) { id status } }`);
  const refusedBefore = await sql('SELECT * FROM itil_changes WHERE id = $1', [closed]);
  const refused = await approve(closed);
  expect(refused.body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
  expect(await sql('SELECT * FROM itil_changes WHERE id = $1', [closed])).toEqual(refusedBefore);
  const approved = await approve(pending);
  expect(approved.body).toEqual({ data: { updateChange: { id: pending, status: 'APPROVED' } } });
  expect(await sql('SELECT status, approved_by, approved_at IS NOT NULL AS stamped FROM itil_changes WHERE id = $1', [pending]))
    .toEqual([{ status: 'approved', approved_by: 'gql-user', stamped: true }]);
  const back = await graphql(`mutation { updateChange(id: "${pending}", input: { status: REQUESTED }) { status } }`);
  expect(back.body.data).toEqual({ updateChange: { status: 'REQUESTED' } });
  expect(await sql('SELECT approved_by, approved_at FROM itil_changes WHERE id = $1', [pending]))
    .toEqual([{ approved_by: null, approved_at: null }]);
});

const seedIncident = (id: string, number: string, priority = 3, ci = 'ci-a', org = A) => sql(
  `INSERT INTO itil_incidents(id, incident_number, title, impact, urgency, priority,
    affected_ci_id, reported_by, organization_id) VALUES ($1, $2, 'paged incident',
      'medium', 'medium', $3, $4, 'alice', $5)`, [id, number, priority, ci, org]);
const INC = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const ctxA = { user: { _organizationId: A } } as GraphQLContext;

describe('GraphQL paging and priority arguments are bounded like the REST Joi schemas', () => {
  const badPages = ['page: 0', 'page: -3', 'limit: 0', 'limit: -1'];
  const expectRefusal = (body: { data: unknown; errors?: { extensions?: { code?: string } }[] }) => {
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(body.data).toBeNull();
  };

  it.each([...badPages, 'priority: 0', 'priority: 6'])('incidents(%s) is BAD_USER_INPUT', async (arg) => {
    await seedIncident(INC[0], 'INC-1');
    expectRefusal((await graphql(`{ incidents(${arg}) { total pages } }`)).body);
  });

  it.each(badPages)('changes(%s) is BAD_USER_INPUT', async (arg) => {
    await seedChange(INC[0], 'draft');
    expectRefusal((await graphql(`{ changes(${arg}) { total pages } }`)).body);
  });

  // The request-admission layer already answers HTTP limit > 100 (GRAPHQL_REQUEST_LIMIT_EXCEEDED), so the
  // REST-mirrored 1..1000 bound is only reachable, and only asserted, at the resolver.
  it.each(['incidents', 'changes'] as const)('%s resolver refuses limit 1001 and accepts limit 1000', async (name) => {
    await seedIncident(INC[0], 'INC-1');
    await seedChange(INC[0], 'draft');
    await expect(itilRecordQueries[name](null, { limit: 1001 }, ctxA)).rejects
      .toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const page = await itilRecordQueries[name](null, { page: 1, limit: 1000 }, ctxA);
    expect(page).toMatchObject({ total: 1, page: 1, limit: 1000, pages: 1 });
    expect(page.items).toHaveLength(1);
  });

  it('keeps valid paging, defaults and the priority filter working', async () => {
    await seedIncident(INC[0], 'INC-1', 3);
    await seedIncident(INC[1], 'INC-2', 1);
    await seedIncident(INC[2], 'INC-B', 3, 'ci-b', B);
    await seedChange(INC[0], 'draft');
    await seedChange(INC[1], 'draft');
    const page = (await graphql('{ incidents(page: 1, limit: 100) { total page limit pages items { id } } }')).body;
    expect(page.errors).toBeUndefined();
    expect(page.data.incidents).toMatchObject({ total: 2, page: 1, limit: 100, pages: 1 });
    expect(page.data.incidents.items.map((row: { id: string }) => row.id).sort()).toEqual([INC[0], INC[1]]);
    const defaults = (await graphql('{ incidents { total page limit pages } changes { total page limit pages } }')).body;
    expect(defaults.data).toEqual({ incidents: { total: 2, page: 1, limit: 50, pages: 1 },
      changes: { total: 2, page: 1, limit: 50, pages: 1 } });
    const second = (await graphql('{ changes(page: 2, limit: 1) { total page limit pages items { id } } }')).body;
    expect(second.errors).toBeUndefined();
    expect(second.data.changes).toMatchObject({ total: 2, page: 2, limit: 1, pages: 2 });
    expect(second.data.changes.items).toHaveLength(1);
    expect(Number.isInteger(second.data.changes.pages)).toBe(true);
    const filtered = (await graphql('{ incidents(priority: 3) { total items { id priority } } }')).body;
    expect(filtered.data.incidents).toEqual({ total: 1, items: [{ id: INC[0], priority: 3 }] });
    const orgB = (await graphql('{ incidents(page: 1, limit: 10) { total items { id } } }', 'B')).body;
    expect(orgB.data.incidents).toEqual({ total: 1, items: [{ id: INC[2] }] });
  });

  it('nested CI incidents clamp the limit to 1..100 like nested changes', async () => {
    await seedIncident(INC[0], 'INC-1');
    await seedIncident(INC[1], 'INC-2');
    expect(await itilNestedRecords.incidents('ci-a', { limit: -5 }, ctxA)).toHaveLength(1);
    expect(await itilNestedRecords.incidents('ci-a', { limit: 500 }, ctxA)).toHaveLength(2);
  });

  it('updateIncident refuses priority outside 1..5 and leaves the row unchanged', async () => {
    await seedIncident(INC[0], 'INC-1', 3);
    const update = (priority: number) => graphql(`mutation { updateIncident(id: "${INC[0]}",
      input: { priority: ${priority} }) { id priority } }`);
    const before = await sql('SELECT * FROM itil_incidents ORDER BY id');
    for (const bad of [9, 0, 6, -1]) expectRefusal((await update(bad)).body);
    expect(await sql('SELECT * FROM itil_incidents ORDER BY id')).toEqual(before);
    const ok = (await update(2)).body;
    expect(ok.errors).toBeUndefined();
    expect(ok.data.updateIncident).toEqual({ id: INC[0], priority: 2 });
    expect(await sql('SELECT priority FROM itil_incidents WHERE id = $1', [INC[0]])).toEqual([{ priority: 2 }]);
  });
});
