// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-918 (#44 bullet 3): mounted reconciliation REST routes answer an authenticated caller
 * without a verified organization with 403 before any HP1 data access. JWT verification,
 * authenticate(), requirePermission() and requireOrganization() are production code; only the
 * identity directory (the user read authenticate() makes) is substituted. The spies sit on the
 * drivers, so every pooled SQL statement and every Neo4j session or statement (journal driver
 * included) is counted.
 */
import express from 'express';
import request from 'supertest';
import { Driver, Session } from 'neo4j-driver';
import { Client, Pool } from 'pg';
import { decode } from 'jsonwebtoken';
import { loadConfig } from '@cmdb/common';
import { auditMiddleware } from '../../src/middleware/audit.middleware';

const A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const PARAM = 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3';
// Admins: requirePermission('write'|'admin') runs before requireOrganization on the write
// routes, so only an admin caller without an organization reaches the organization guard.
const users: Record<string, { _id: string; _username: string; _role: 'admin'; _enabled: boolean; _organizationId?: string }> = {
  'b3-admin-a': { _id: 'b3-admin-a', _username: 'b3-admin-a', _role: 'admin', _enabled: true, _organizationId: A },
  'b3-admin-none': { _id: 'b3-admin-none', _username: 'b3-admin-none', _role: 'admin', _enabled: true },
};
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (id: string) => users[id] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { reconciliationRoutes } from '../../src/rest/routes/reconciliation.routes';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/reconciliation', reconciliationRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);

type Route = { method: 'get' | 'post' | 'put' | 'delete'; path: string; body?: object };
const rule = { name: 'b3', identification_rules: [{ attribute: 'serial_number', priority: 1, match_type: 'exact', match_confidence: 90 }] };
// Every pair reconciliation.routes.ts mounts, with valid bodies: without the organization guard
// each request would reach its data path.
const ROUTES: Route[] = [
  { method: 'post', path: '/match', body: { identifiers: { serial_number: 'b3' } } },
  { method: 'post', path: '/merge', body: { name: 'b3', ci_type: 'server', source: 'b3', source_id: 'b3-1', identifiers: { serial_number: 'b3' } } },
  { method: 'get', path: '/conflicts' },
  { method: 'post', path: '/conflicts/:id/resolve', body: { resolution: 'accept_source', expected_revision: '0'.repeat(64) } },
  { method: 'get', path: '/rules' },
  { method: 'post', path: '/rules', body: rule },
  { method: 'put', path: '/rules/:id', body: rule },
  { method: 'delete', path: '/rules/:id' },
  { method: 'get', path: '/source-authorities' },
  { method: 'put', path: '/source-authorities/:source', body: { authority_score: 5 } },
  { method: 'get', path: '/lineage/:ci_id' },
  { method: 'get', path: '/field-sources/:ci_id' },
];
const label = ({ method, path }: Route) => `${method.toUpperCase()} ${path}`;

// An admin token whose organization claim is the user's own unless a (stale) claim is given.
const token = (user: string, claim = users[user]._organizationId) =>
  jwt.generateAccessToken(user, users[user]._username, 'admin', claim);
function send(bearer: string, { method, path, body }: Route) {
  const call = request(app)[method](`/api/v1/reconciliation${path.replace(/:\w+/g, PARAM)}`).set('authorization', `Bearer ${bearer}`);
  return body ? call.send(body) : call;
}

/** Driver-level data access since the last call: SQL pool/client work and Neo4j sessions/statements. */
function dataAccess() {
  const sql = [jest.spyOn(Pool.prototype, 'connect'), jest.spyOn(Pool.prototype, 'query'), jest.spyOn(Client.prototype, 'query')];
  const sessions = jest.spyOn(Driver.prototype, 'session');
  const statements = jest.spyOn(Session.prototype, 'run');
  return () => {
    const count = { sql: sql.reduce((n, spy) => n + spy.mock.calls.length, 0), neo4jSessions: sessions.mock.calls.length, neo4jStatements: statements.mock.calls.length };
    [...sql, sessions, statements].forEach(spy => spy.mockClear());
    return count;
  };
}

it('the covered routes are exactly the mounted reconciliation routes', () => {
  type RouteLayer = { handle: unknown; route?: { path: string; methods: Record<string, boolean> } };
  const layers = reconciliationRoutes.stack as unknown as RouteLayer[]; // express types the stack loosely
  const mounted = layers.flatMap(({ route }) => route ? Object.keys(route.methods).map(method => `${method.toUpperCase()} ${route.path}`) : []);
  expect(mounted.sort()).toEqual(ROUTES.map(label).sort());
  // A sub-router or path-scoped use() would mount routes this list cannot see.
  expect(layers.filter(({ route }) => !route).map(({ handle }) => handle)).toEqual([auditMiddleware]);
});

// Runs before the positive control: the journal schema gate caches readiness per module, and a
// cold gate is what would query if it ever ran ahead of requireOrganization().
it('an authenticated admin without an organization gets 403 with zero SQL and Neo4j access on every route', async () => {
  // Primary: a JWT with no organization claim. Also a stale org-A claim, which authenticate() must
  // replace with the user's current (absent) organization.
  const callers = { 'no org claim': token('b3-admin-none'), 'stale org-A claim': token('b3-admin-none', A) };
  expect(decode(callers['no org claim'])).not.toHaveProperty('_organizationId');
  const taken = dataAccess();
  const outcomes = [];
  for (const [caller, bearer] of Object.entries(callers)) {
    for (const route of ROUTES) {
      const response = await send(bearer, route);
      outcomes.push({ caller, route: label(route), status: response.status, body: response.body, ...taken() });
    }
  }
  expect(outcomes).toEqual(Object.keys(callers).flatMap(caller => ROUTES.map(route => ({
    caller, route: label(route), status: 403, body: { _error: 'Forbidden', _message: 'Organization claim required' },
    sql: 0, neo4jSessions: 0, neo4jStatements: 0,
  }))));
});

// The journal schema gate caches readiness per module, so per-route counts differ; every control
// route must touch the stores, and together they must exercise every spy.
it('positive control: an organization admin reaches data, and every spy counts it', async () => {
  const taken = dataAccess();
  const controls = ROUTES.filter(route => ['GET /conflicts', 'GET /rules', 'GET /source-authorities', 'POST /match'].includes(label(route)));
  const outcomes = [];
  const seen = { sql: false, neo4jSessions: false, neo4jStatements: false };
  for (const route of controls) {
    const response = await send(token('b3-admin-a'), route);
    const { sql, neo4jSessions, neo4jStatements } = taken();
    Object.assign(seen, { sql: seen.sql || sql > 0, neo4jSessions: seen.neo4jSessions || neo4jSessions > 0, neo4jStatements: seen.neo4jStatements || neo4jStatements > 0 });
    outcomes.push({ route: label(route), status: response.status, accessed: sql + neo4jSessions + neo4jStatements > 0 });
  }
  expect(outcomes).toEqual(controls.map(route => ({ route: label(route), status: 200, accessed: true })));
  expect(seen).toEqual({ sql: true, neo4jSessions: true, neo4jStatements: true });
});
