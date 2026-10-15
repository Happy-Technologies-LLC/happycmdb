// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const reply = pending.get(id)!;
  pending.delete(id);
  if (error) reply.reject(Object.assign(new Error(error), { code }));
  else reply.resolve(rows);
});
function sql(text: string, params: unknown[] = [], mode?: 'exec'): Promise<unknown[]> {
  const id = serial++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op: mode ?? (/^\s*(SELECT|WITH|UPDATE|DELETE|INSERT)/i.test(text) ? 'query' : 'exec'), sql: text, params });
  return promise;
}
const query = async (text: string, params?: unknown[]) => ({ rows: await sql(text, params) });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const I = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LEGACY_I = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LEGACY_C = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ciNodes: Record<string, string> = { 'ci-a': A, 'ci-b': B };
jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ pool: { query } }),
  getNeo4jClient: () => ({ getCI: async (id: string, org: string) =>
    ciNodes[id] === org ? { id, organization_id: org, type: 'server', environment: 'test' } : null }),
  getAuditService: () => ({}),
}));
jest.mock('../../../middleware/audit.middleware', () => ({ auditMiddleware: (_req: Request, _res: Response, next: NextFunction) => next() }));
jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    requireOrganization: () => (req: Request & { user?: { _organizationId?: string } }, res: Response, next: NextFunction) => {
      if (!req.user?._organizationId) res.status(403).json({ success: false, error: 'Organization required' });
      else next();
    },
    requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  }),
}));
import { itilRoutes } from '../itil.routes';
import { processSyncIncidentsToDatamart } from '../../../../../etl-processor/src/jobs/sync-incidents-to-datamart.job';
const app = express();
app.use(express.json());
app.use((req: Request & { user?: { _organizationId?: string } }, _res, next) => {
  req.user = { _organizationId: req.get('x-org') === 'A' ? A : req.get('x-org') === 'B' ? B : undefined };
  next();
});
app.use('/itil', itilRoutes);
const migrationDir = join(__dirname, '../../../../../database/src/postgres/migrations');
const original = readFileSync(join(migrationDir, '001_complete_schema.sql'), 'utf8');
const tableDDL = (name: string) => {
  const match = original.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
  if (!match) throw new Error(`Missing ${name} DDL`);
  return match[0];
};
beforeAll(async () => {
  await sql(['itil_baselines', 'itil_incidents', 'itil_changes'].map(tableDDL).join('\n'), [], 'exec');
  await sql(`CREATE UNIQUE INDEX idx_itil_baselines_unique_name ON itil_baselines(name);
    INSERT INTO itil_baselines(id, name, baseline_type, baseline_data, created_by)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'legacy', 'configuration', '{}', 'legacy');
    INSERT INTO itil_incidents(id, incident_number, title, impact, urgency, priority, affected_ci_id, reported_by)
      VALUES ('${LEGACY_I}', 'INC-legacy', 'legacy', 'high', 'high', 1, 'ci-a', 'legacy');
    INSERT INTO itil_changes(id, change_number, title, change_type, affected_ci_ids, requested_by)
      VALUES ('${LEGACY_C}', 'CHG-legacy', 'legacy', 'normal', ARRAY['ci-a'], 'legacy');`, [], 'exec');
  for (const file of ['012_itil_baseline_organization_scope.sql', '013_itil_baseline_org_name_unique.sql',
    '035_itil_record_ownership.sql']) await sql(readFileSync(join(migrationDir, file), 'utf8'), [], 'exec');
  await sql(`CREATE SCHEMA cmdb;
    CREATE TABLE cmdb.dim_ci(ci_id text, ci_key text, ci_name text, ci_type text,
      bsm_attributes jsonb, organization_id uuid, is_current boolean, org_backfilled boolean);`, [], 'exec');
}, 30000);
afterAll(() => host.kill());
beforeEach(async () => {
  await sql(`DELETE FROM itil_incidents WHERE organization_id IS NOT NULL;
    DELETE FROM itil_changes WHERE organization_id IS NOT NULL;
    INSERT INTO itil_incidents(id, incident_number, title, impact, urgency, priority, affected_ci_id, status, reported_by, organization_id)
      VALUES ('${I}', 'INC-B', 'B incident', 'medium', 'medium', 3, 'ci-b', 'new', 'bob', '${B}');
    INSERT INTO itil_changes(id, change_number, title, change_type, affected_ci_ids, requested_by, organization_id)
      VALUES ('${C}', 'CHG-B', 'B change', 'normal', ARRAY['ci-b'], 'bob', '${B}');`, [], 'exec');
});

const auth = (org: string) => ({ 'x-org': org });
const incidentMutation = (path: string, body: object = {}) => request(app).post(`/itil/incidents/${path}`).set(auth('A')).send(body);
const changeMutation = (path: string, body: object = {}) => request(app).post(`/itil/changes/${path}`).set(auth('A')).send(body);

it('conceals foreign, absent and NULL incidents/changes on every mounted detail and mutation', async () => {
  const beforeIncident = await sql('SELECT * FROM itil_incidents WHERE id = $1', [I]);
  const beforeChange = await sql('SELECT * FROM itil_changes WHERE id = $1', [C]);
  const incidentOps = [
    (id: string) => request(app).get(`/itil/incidents/${id}`).set(auth('A')),
    (id: string) => request(app).get(`/itil/incidents/${id}/priority`).set(auth('A')),
    (id: string) => request(app).patch(`/itil/incidents/${id}`).set(auth('A')).send({ status: 'CLOSED' }),
    (id: string) => incidentMutation(`${id}/resolve`, { resolution: 'resolved after diagnostics', resolvedBy: 'alice' }),
  ];
  const changeOps = [
    (id: string) => request(app).get(`/itil/changes/${id}`).set(auth('A')),
    (id: string) => request(app).get(`/itil/changes/${id}/risk-assessment`).set(auth('A')),
    (id: string) => request(app).patch(`/itil/changes/${id}`).set(auth('A')).send({ status: 'APPROVED' }),
    (id: string) => changeMutation(`${id}/approve`),
    (id: string) => changeMutation(`${id}/implement`),
    (id: string) => changeMutation(`${id}/close`, { result: 'SUCCESS', closedBy: 'alice' }),
  ];
  for (const [ops, foreign, legacy] of [[incidentOps, I, LEGACY_I], [changeOps, C, LEGACY_C]] as const) {
    for (const op of ops) {
      const forbidden = await op(foreign);
      const absent = await op(MISSING);
      const unowned = await op(legacy);
      expect(forbidden.status).toBe(404);
      expect(JSON.stringify(forbidden.body)).toBe(JSON.stringify(absent.body));
      expect(JSON.stringify(unowned.body)).toBe(JSON.stringify(absent.body));
    }
  }
  expect(await sql('SELECT * FROM itil_incidents WHERE id = $1', [I])).toEqual(beforeIncident);
  expect(await sql('SELECT * FROM itil_changes WHERE id = $1', [C])).toEqual(beforeChange);
});

it('scopes lists, affectedCIId, counts and metrics and stamps created rows from request identity', async () => {
  const incidents = await request(app).get('/itil/incidents').set(auth('A'));
  const affected = await request(app).get('/itil/incidents?affectedCIId=ci-b').set(auth('A'));
  const changes = await request(app).get('/itil/changes').set(auth('A'));
  expect([incidents.body.pagination.total, affected.body.pagination.total, changes.body.pagination.total]).toEqual([0, 0, 0]);
  await sql(`UPDATE itil_incidents SET status = 'resolved',
      resolved_at = reported_at + INTERVAL '2 hours' WHERE id = '${I}';
    INSERT INTO itil_incidents(id, incident_number, title, impact, urgency, priority,
      affected_ci_id, reported_by, reported_at, organization_id)
      VALUES ('99999999-9999-4999-8999-999999999999', 'INC-B2', 'B second',
        'medium', 'medium', 3, 'ci-b', 'bob', now() + INTERVAL '4 hours', '${B}');
    UPDATE itil_changes SET status = 'closed', outcome = 'successful' WHERE id = '${C}';`, [], 'exec');
  const paths = ['incident-summary', 'change-success-rate', 'mttr', 'mtbf'];
  const metrics = await Promise.all(paths.map(path => request(app).get(`/itil/metrics/${path}`).set(auth('A'))));
  expect(metrics.map(result => result.status)).toEqual([200, 200, 200, 200]);
  expect(metrics[0]?.body.data).toEqual([]);
  expect(metrics[1]?.body.data.successfulChanges).toBe(0);
  expect(metrics[2]?.body.data.mttr).toBe('0.00');
  expect(metrics[1]?.body.data.successRate).toBe('0.00');
  expect(metrics[3]?.body.data.mtbf).toBe('0.00');
  expect((await request(app).get('/itil/metrics/incident-summary').set(auth('B'))).body.data.length).toBeGreaterThan(0);
  expect((await request(app).get('/itil/metrics/change-success-rate').set(auth('B'))).body.data.successfulChanges).toBe(1);
  const foreignCI = await request(app).post('/itil/incidents').set(auth('A'))
    .send({ affectedCIId: 'ci-b', description: 'foreign CI investigation', reportedBy: 'alice' });
  expect(foreignCI.status).toBe(404);
  const own = await request(app).post('/itil/incidents').set(auth('A'))
    .send({ affectedCIId: 'ci-a', description: 'local CI investigation', reportedBy: 'alice' });
  expect(own.status).toBe(201);
  expect(own.body.data.organization_id).toBe(A);
  const change = await request(app).post('/itil/changes').set(auth('A')).send({
    changeType: 'NORMAL', description: 'local CI patch rollout', affectedCIIds: ['ci-a'], requestedBy: 'alice',
    plannedStart: '2026-11-01T00:00:00Z', plannedDuration: 60,
    implementationPlan: 'drain workload, patch system, restart, and confirm all health checks',
  });
  const mixed = await request(app).post('/itil/changes').set(auth('A')).send({
    changeType: 'NORMAL', description: 'mixed CI patch rollout', affectedCIIds: ['ci-a', 'ci-b'], requestedBy: 'alice',
    plannedStart: '2026-11-01T00:00:00Z', plannedDuration: 60,
    implementationPlan: 'drain workload, patch system, restart, and confirm all health checks',
  });
  expect(mixed.status).toBe(404);
  expect(change.status).toBe(201);
  expect(change.body.data.organization_id).toBe(A);
  const filteredIncidents = await request(app).get('/itil/incidents?status=NEW').set(auth('A'));
  const filteredChanges = await request(app).get('/itil/changes?status=DRAFT').set(auth('A'));
  expect(filteredIncidents.body.pagination.total).toBe(1);
  expect(filteredChanges.body.pagination.total).toBe(1);
  expect((await request(app).get('/itil/incidents').set(auth('B'))).body.pagination.total).toBe(2);
  expect((await request(app).get('/itil/changes').set(auth('B'))).body.pagination.total).toBe(1);
});

it('ETL does not copy recycled A dimension data into B or legacy incidents', async () => {
  await sql(`INSERT INTO cmdb.dim_ci(ci_id, ci_key, ci_name, ci_type, bsm_attributes,
      organization_id, is_current, org_backfilled)
    VALUES ('ci-b', 'recycled', 'A SECRET', 'server', '{}', '${A}', true, false);
    UPDATE itil_incidents SET business_impact = '{}' WHERE id = '${I}';`, [], 'exec');
  const result = await processSyncIncidentsToDatamart({
    id: 'etl-test', data: { incrementalSince: '2000-01-01T00:00:00Z',
      includeChanges: false, calculateSLAs: false },
  } as Parameters<typeof processSyncIncidentsToDatamart>[0]);
  expect(result.incidentsEnriched).toBe(0);
  const rows = await sql(`SELECT id, business_impact::text AS impact FROM itil_incidents
    WHERE id IN ($1, $2) ORDER BY id`, [I, LEGACY_I]);
  expect(JSON.stringify(rows)).not.toContain('A SECRET');
});
