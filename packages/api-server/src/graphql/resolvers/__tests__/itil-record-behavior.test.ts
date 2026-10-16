// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { fork } from 'child_process';
import { readFileSync } from 'fs';
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
      req.user = { _role: 'operator', _organizationId: req.headers.authorization === 'Bearer B' ? B : A };
      next();
    },
  }),
}));

import { createGraphQLServer } from '../../server';
import { itilNestedRecords } from '../itil-record.resolvers';
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
