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
      req.user = { _role: req.headers.authorization?.slice(7), _organizationId: '11111111-1111-4111-8111-111111111111' };
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

it('refuses every ITIL record GraphQL field for every role without PostgreSQL access', async () => {
  const app = express();
  const { server } = await createGraphQLServer(app);
  try {
    for (const role of ['viewer', 'operator', 'admin']) {
      for (const operation of [...recordQueries, ...recordMutations]) {
        const response = await request(app).post('/graphql').set('Authorization', `Bearer ${role}`)
          .send({ query: operation });
        expect(response.body.errors?.[0]).toMatchObject({
          message: 'ITIL records unavailable', extensions: { code: 'FORBIDDEN' },
        });
        expect(query).not.toHaveBeenCalled();
      }
    }
  } finally {
    await server.stop();
  }
});
