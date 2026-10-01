// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for /api/v1/tbm/* (FD-2: Postgres dim_business_services
 * .organization_id is the tenant authority; Neo4j :BusinessService carries no
 * org; FD-3 b: global TBM aggregates are admin-only until CI tenancy lands).
 *
 * Exercised through the real tbmRoutes behind the real AuthMiddleware /
 * AuthService (JWT verification), mounted at the production path.
 *
 * Ownership SQL runs on PGlite hosted in a forked child process
 * (../../routes/__tests__/fixtures/pglite-host.cjs) with the
 * dim_business_services DDL read verbatim from 001_complete_schema.sql plus
 * 008_business_service_organization_scope.sql. Neo4j is a recording session
 * over a small in-memory graph in which every :BusinessService node, whoever
 * owns it in Postgres, is reachable by id.
 */

import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, '../../routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}

// Every data access is counted: Postgres through the client or its pool, Neo4j per Cypher run.
let pgQueries = 0;
const pgQuery = async (sql: string, params: unknown[] = []) => {
  pgQueries++;
  return { rows: await send('query', sql, params) };
};
// Plain functions (not jest.fn): the unit config resets mock implementations.
const pgClient = { query: pgQuery, pool: { query: pgQuery } };

type Params = Record<string, unknown>;
const cypherRuns: Array<{ query: string; params: Params }> = [];
const int = (n: number) => ({ toNumber: () => n });
const record = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });

// The graph as seeded by cypher: no org on any node.
const GRAPH_SERVICES: Record<string, { name: string; cost: number; tower: string }> = {
  'bs-a-app': { name: 'A App', cost: 100, tower: 'compute' },
  'bs-b-app': { name: 'B Secret App', cost: 7, tower: 'data' },
  // Present in Neo4j with no owning Postgres row at all.
  'bs-graph-only': { name: 'Graph Only', cost: 13, tower: 'network' },
};
const CAPABILITY = { id: 'cap-1', name: 'Shared Capability', realizedBy: ['bs-a-app', 'bs-b-app', 'bs-graph-only'] };
// The tenancy filter must bind to the REALIZES optional match itself.
const REALIZES_OWNED_FILTER =
  /OPTIONAL MATCH \(cap\)-\[:REALIZES\]->\(service:BusinessService\)\s+WHERE service\.id IN \$orgServiceIds\s/;

const neo4jSession = {
  run: async (query: string, params: Params = {}) => {
    cypherRuns.push({ query, params });
    if (query.includes('BusinessCapability')) {
      if (params['capabilityId'] !== CAPABILITY.id) return { records: [] };
      // Emulates `OPTIONAL MATCH (cap)-[:REALIZES]->(service) WHERE service.id IN $orgServiceIds`;
      // a query without that filter on the REALIZES match traverses every realizing service.
      const allowed = REALIZES_OWNED_FILTER.test(query) ? (params['orgServiceIds'] as string[] | undefined) ?? [] : null;
      const services = CAPABILITY.realizedBy.filter(id => allowed === null || allowed.includes(id));
      return {
        records: [record({
          capabilityId: CAPABILITY.id,
          capabilityName: CAPABILITY.name,
          serviceIds: services,
          totalCost: services.reduce((sum, id) => sum + GRAPH_SERVICES[id]!.cost, 0),
          ciCount: int(services.length),
        })],
      };
    }
    if (query.includes('BusinessService {id: $serviceId}')) {
      const service = GRAPH_SERVICES[params['serviceId'] as string];
      if (service === undefined) return { records: [] };
      return {
        records: [record({
          serviceId: params['serviceId'],
          serviceName: service.name,
          totalCost: service.cost,
          ciCount: int(1),
          towers: [service.tower],
        })],
      };
    }
    // Global CI aggregates: an empty graph answer.
    return { records: [] };
  },
  close: async () => undefined,
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({ getSession: () => neo4jSession }),
  getAuditService: () => ({}),
}));

// bcrypt's native binding is only used for password hashing/login, never on token verification.
jest.mock('bcrypt', () => ({}));

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  'admin-a': { _id: 'admin-a', _username: 'ada', _role: 'admin', _enabled: true, _organizationId: ORG_A },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
  'user-bad': { _id: 'user-bad', _username: 'bart', _role: 'admin', _enabled: true, _organizationId: 'not-a-uuid' },
};

jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import type { UserRole } from '../../../auth/types';
import { tbmRoutes } from '../../routes/tbm.routes';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const DDL_TABLES = ['dim_business_services', 'cmdb.dim_ci'];

function baseDdl(): string {
  const sql = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  return 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + DDL_TABLES.map(table => {
    const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  }).join('\n');
}

const SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id) VALUES
  ('bs-a-app', 'A App', 'application', 'application', 'high', 'active', '${ORG_A}'),
  ('bs-a-db', 'A Database', 'data', 'data', 'critical', 'active', '${ORG_A}'),
  ('bs-b-app', 'B Secret App', 'application', 'application', 'medium', 'active', '${ORG_B}');`;

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => {
  const user = USERS[userId]!;
  return {
    Authorization: `Bearer ${jwt.generateAccessToken(userId, user._username, user._role as UserRole, organizationId)}`,
  };
};
const AS_A = bearer('user-a', ORG_A);
const AS_ADMIN_A = bearer('admin-a', ORG_A);

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/tbm', tbmRoutes);

const queryCount = () => pgQueries + cypherRuns.length;

beforeAll(async () => {
  await send('exec', baseDdl());
  await send('exec', `BEGIN;\n${readFileSync(join(MIGRATIONS, '008_business_service_organization_scope.sql'), 'utf8')}\nCOMMIT;`);
  await send('exec', SEED);
});

afterAll(() => {
  host.kill();
});

beforeEach(() => {
  pgQueries = 0;
  cypherRuns.length = 0;
});

// Fixed arity: a shorter row would make jest pass `done` as the body.
const GLOBAL_ROUTES: Array<[string, string, object | null]> = [
  ['get', '/api/v1/tbm/costs/summary', null],
  ['get', '/api/v1/tbm/costs/by-tower', null],
  ['get', '/api/v1/tbm/costs/trends', null],
  ['get', '/api/v1/tbm/costs/allocations/ci-1', null],
  ['post', '/api/v1/tbm/costs/allocate', { sourceId: 'ci-1', targetType: 'business_service', targetIds: ['bs-a-app'] }],
  ['post', '/api/v1/tbm/gl/import', { records: [{ accountNumber: '1', accountName: 'x', costPool: 'p' }] }],
  ['get', '/api/v1/tbm/licenses', null],
  ['get', '/api/v1/tbm/licenses/renewals', null],
];
const SCOPED_ROUTES: Array<[string, string, object | null]> = [
  ['get', '/api/v1/tbm/costs/by-service/bs-a-app', null],
  ['get', '/api/v1/tbm/costs/by-capability/cap-1', null],
];

function call(method: string, path: string, body: object | null, headers: object) {
  const req = request(app)[method as 'get'](path).set(headers);
  return body === null ? req : req.send(body);
}

describe('GET /api/v1/tbm/costs/by-service/:id', () => {
  it("by-service/:id for another org's service is 404 and identical to a missing id", async () => {
    const foreign = await request(app).get('/api/v1/tbm/costs/by-service/bs-b-app').set(AS_A);
    const graphOnly = await request(app).get('/api/v1/tbm/costs/by-service/bs-graph-only').set(AS_A);
    const missing = await request(app).get('/api/v1/tbm/costs/by-service/bs-missing').set(AS_A);

    expect(foreign.status).toBe(404);
    expect(graphOnly.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.text).toBe(missing.text);
    expect(graphOnly.text).toBe(missing.text);
    expect(foreign.text).not.toContain('B Secret App');
    // Ownership is decided in Postgres before any Cypher runs.
    expect(cypherRuns).toEqual([]);

    const own = await request(app).get('/api/v1/tbm/costs/by-service/bs-a-app').set(AS_A);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ serviceId: 'bs-a-app', serviceName: 'A App', totalMonthlyCost: 100 });
  });
});

describe('fail closed without an organization claim', () => {
  it.each([...GLOBAL_ROUTES, ...SCOPED_ROUTES])(
    '%s %s -> 403 with zero queries when the token has no organization claim',
    async (method, path, body) => {
      for (const headers of [bearer('user-none'), bearer('user-bad', 'not-a-uuid')]) {
        const res = await call(method, path, body, headers);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ _error: 'Forbidden', _message: 'Organization claim required' });
      }
      expect(queryCount()).toBe(0);
    }
  );
});

describe('GET /api/v1/tbm/costs/by-capability/:id', () => {
  it("by-capability only traverses the caller org's service ids", async () => {
    const res = await request(app).get('/api/v1/tbm/costs/by-capability/cap-1').set(AS_A);

    expect(res.status).toBe(200);
    // Only bs-a-app (100) realizes cap-1 for org A; B's service and the graph-only node are not traversed.
    expect(res.body.data).toMatchObject({ capabilityId: 'cap-1', totalMonthlyCost: 100, supportingServices: 1 });
    expect(cypherRuns).toHaveLength(1);
    expect([...(cypherRuns[0]!.params['orgServiceIds'] as string[])].sort()).toEqual(['bs-a-app', 'bs-a-db']);
  });

  it("the Cypher receives the token org's ids, never a request-supplied org", async () => {
    const res = await request(app)
      .get(`/api/v1/tbm/costs/by-capability/cap-1?organization_id=${ORG_B}&organizationId=${ORG_B}`)
      .set({ ...AS_A, 'x-organization-id': ORG_B });

    expect(res.status).toBe(200);
    expect(res.body.data.totalMonthlyCost).toBe(100);
    for (const run of cypherRuns) {
      expect([...(run.params['orgServiceIds'] as string[])].sort()).toEqual(['bs-a-app', 'bs-a-db']);
      expect(JSON.stringify(run.params)).not.toContain(ORG_B);
    }
    expect(cypherRuns.length).toBeGreaterThan(0);
  });
});

describe('global TBM aggregates (FD-3 b)', () => {
  it.each(GLOBAL_ROUTES)('%s %s: global aggregates are 403 for a non-admin org member', async (method, path, body) => {
    const res = await call(method, path, body, AS_A);
    expect(res.status).toBe(403);
    expect(queryCount()).toBe(0);
  });

  it('an admin with an organization claim still reaches the global summary', async () => {
    const res = await request(app).get('/api/v1/tbm/costs/summary').set(AS_ADMIN_A);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
