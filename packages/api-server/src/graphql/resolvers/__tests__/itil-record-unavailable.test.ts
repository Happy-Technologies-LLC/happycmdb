// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const query = jest.fn();
jest.mock('@cmdb/database', () => ({
  Neo4jClient: jest.fn(),
  getPostgresClient: () => ({ pool: { query } }),
  getNeo4jClient: () => ({ getSession: jest.fn() }),
  getUnifiedCredentialService: () => ({}),
  queueManager: { getQueue: jest.fn() },
}));
jest.mock('@cmdb/identity-resolution', () => ({ getIdentityReconciliationEngine: () => ({}) }));
jest.mock('@cmdb/integration-framework', () => ({}));
jest.mock('../../../auth/auth-bootstrap', () => ({
  getAuthMiddleware: () => ({
    authenticate: () => (req: Request & { user?: object }, _res: Response, next: NextFunction) => {
      const actor = req.headers.authorization?.slice(7);
      req.user = { _role: actor?.replace('-b', ''), _organizationId:
        actor === 'noorg' ? undefined : actor?.endsWith('-b') ? '22222222-2222-4222-8222-222222222222' :
          '11111111-1111-4111-8111-111111111111' };
      next();
    },
  }),
}));

import { createGraphQLServer } from '../../server';

const recordQueries = [
  '{ incidents { total } }',
  '{ incident(id: "missing") { id } }',
  '{ incidentMetrics { totalIncidents } }',
  '{ changes { total } }',
  '{ change(id: "missing") { id } }',
  '{ changeMetrics { totalChanges } }',
];
const recordMutations = [
  'mutation { createIncident(input: {affectedCIId: "ci-a", description: "x", reportedBy: "x"}) { incident { id } } }',
  'mutation { updateIncident(id: "missing", input: {}) { id } }',
  'mutation { resolveIncident(id: "missing", resolution: "x", resolvedBy: "x") { id } }',
  'mutation { createChange(input: {changeType: STANDARD, description: "x", affectedCIIds: ["ci-a"], requestedBy: "x", plannedStart: "2026-01-01", plannedDuration: 1, implementationPlan: "x"}) { id } }',
  'mutation { updateChange(id: "missing", input: {}) { id } }',
  'mutation { approveChange(id: "missing") { id } }',
  'mutation { implementChange(id: "missing") { id } }',
  'mutation { closeChange(id: "missing", result: SUCCESS, closedBy: "x") { id } }',
];

it('returns safe 503 for absent ITIL tables before querying record rows', async () => {
  query.mockImplementation(async () => ({ rows: [{ available: false }] }));
  const app = express();
  const { server } = await createGraphQLServer(app);
  try {
    for (const operation of [...recordQueries, ...recordMutations]) {
      const response = await request(app).post('/graphql').set('Authorization', 'Bearer operator')
        .send({ query: operation });
      expect(response.body.errors?.[0]).toMatchObject({
        message: 'ITIL records unavailable', extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }
    expect(query.mock.calls.every(call => String(call[0]).includes('pg_attribute'))).toBe(true);
  } finally {
    await server.stop();
  }
});

it('serves owned GraphQL record and gives foreign and absent ids the same 404', async () => {
  const ownedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const missingId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  query.mockReset();
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('pg_attribute')) return { rows: [{ available: true }] };
    if (sql.includes('FROM itil_incidents WHERE id')) {
      return { rows: params[0] === ownedId && params[1] === '22222222-2222-4222-8222-222222222222'
        ? [{ id: ownedId, incident_number: 'INC-B', description: 'B incident', status: 'new',
          impact: 'medium', urgency: 'medium', affected_ci_id: 'ci-b', reported_by: 'bob', priority: 3 }] : [] };
    }
    throw new Error('Unexpected record query');
  });
  const app = express();
  const { server } = await createGraphQLServer(app);
  try {
    const get = (id: string, actor: string) => request(app).post('/graphql')
      .set('Authorization', `Bearer ${actor}`).send({ query: `{ incident(id: \"${id}\") { id incidentNumber } }` });
    const owned = await get(ownedId, 'viewer-b');
    expect(owned.body.data?.incident).toEqual({ id: ownedId, incidentNumber: 'INC-B' });
    const foreign = await get(ownedId, 'viewer');
    const missing = await get(missingId, 'viewer');
    expect(foreign.body.errors?.[0]).toMatchObject({ message: 'Incident not found', extensions: { code: 'NOT_FOUND' } });
    expect(foreign.body.errors?.[0].message).toBe(missing.body.errors?.[0].message);
  } finally {
    await server.stop();
  }
});

it('refuses organization-less GraphQL record access before catalog or data SQL', async () => {
  query.mockReset();
  const app = express();
  const { server } = await createGraphQLServer(app);
  try {
    const response = await request(app).post('/graphql').set('Authorization', 'Bearer noorg')
      .send({ query: '{ incidents { total } }' });
    expect(response.body.errors?.[0]).toMatchObject({
      message: 'Organization claim required', extensions: { code: 'FORBIDDEN' },
    });
    expect(query).not.toHaveBeenCalled();
  } finally {
    await server.stop();
  }
});

it('maps a scoped owned change through the mounted GraphQL list and conceals it from A', async () => {
  const owned = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', change_number: 'CHG-B',
    change_type: 'normal', description: 'B change', affected_ci_ids: ['ci-b'],
    requested_by: 'bob', created_at: new Date('2026-10-01T00:00:00Z'),
    scheduled_start: new Date('2026-10-02T00:00:00Z'), scheduled_end: new Date('2026-10-02T01:00:00Z'),
    implementation_plan: 'B plan', status: 'closed', outcome: 'successful' };
  query.mockReset();
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('pg_attribute')) return { rows: [{ available: true }] };
    if (sql.includes('FROM itil_changes')) {
      const visible = params[0] === '22222222-2222-4222-8222-222222222222';
      return { rows: sql.includes('COUNT(*)') ? [{ total: visible ? '1' : '0' }] : visible ? [owned] : [] };
    }
    throw new Error('Unexpected record query');
  });
  const app = express();
  const { server } = await createGraphQLServer(app);
  try {
    const get = (actor: string) => request(app).post('/graphql')
      .set('Authorization', `Bearer ${actor}`)
      .send({ query: '{ changes { total items { changeNumber status result plannedDuration } } }' });
    const a = await get('viewer');
    const b = await get('viewer-b');
    expect(a.body.errors).toBeUndefined();
    expect(a.body.data?.changes).toEqual({ total: 0, items: [] });
    expect(b.body.errors).toBeUndefined();
    expect(b.body.data?.changes).toEqual({ total: 1, items: [{
      changeNumber: 'CHG-B', status: 'CLOSED', result: 'SUCCESS', plannedDuration: 60,
    }] });
  } finally {
    await server.stop();
  }
});
