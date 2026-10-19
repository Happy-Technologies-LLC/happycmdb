// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for /api/v1/tbm/*: Postgres service ownership and
 * :BusinessService node ownership must both match the caller. Global licenses
 * require platform-admin authority and omit pending/failed journal entries.
 *
 * Exercised through mounted REST and GraphQL with real JWT and API-key
 * authentication; authorization uses the verified principal, not headers.
 *
 * Ownership and cost-trend SQL runs on PGlite hosted in a forked child process
 * (../../routes/__tests__/fixtures/pglite-host.cjs) with the
 * dim_business_services and cmdb.dim_ci DDL read verbatim from
 * 001_complete_schema.sql plus 008_business_service_organization_scope.sql
 * and 011_ci_organization_scope.sql. Neo4j is a recording session over a
 * small in-memory graph that applies each organization_id predicate a
 * statement actually contains: without it, every :BusinessService node is
 * reachable by id, whoever owns it.
 */

import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { fork } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import express from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
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
const pgQuery = async (input: string | { text: string; values: unknown[]; query_timeout?: number },
  params: unknown[] = []) => {
  pgQueries++;
  return { rows: await send('query', typeof input === 'string' ? input : input.text,
    typeof input === 'string' ? params : input.values) };
};
// Plain functions (not jest.fn): the unit config resets mock implementations.
const pgClient = { query: pgQuery, pool: { query: pgQuery } };

type Params = Record<string, unknown>;
const cypherRuns: Array<{ query: string; params: Params }> = [];
const int = (n: number) => ({ toNumber: () => n });
const record = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// The graph: each :BusinessService node carries organization_id (FD-16 c) or,
// when not yet backfilled, none.
const GRAPH_SERVICES: Record<string, { name: string; cost: number; tower: string; organizationId?: string }> = {
  'bs-a-app': { name: 'A App', cost: 100, tower: 'compute', organizationId: ORG_A },
  'bs-b-app': { name: 'B Secret App', cost: 7, tower: 'data', organizationId: ORG_B },
  // Present in Neo4j with no owning Postgres row at all.
  'bs-graph-only': { name: 'Graph Only', cost: 13, tower: 'network' },
  // Owned by org A in Postgres (a client-chosen id), but the node is org B's.
  'bs-hijack': { name: 'B Hijacked Node', cost: 5000, tower: 'data', organizationId: ORG_B },
  // Owned by org A in Postgres, but the node has no organization (not backfilled).
  'bs-orphan': { name: 'Orphan Node', cost: 300, tower: 'network' },
};
const CAPABILITY = {
  id: 'cap-1',
  name: 'Shared Capability',
  realizedBy: ['bs-a-app', 'bs-b-app', 'bs-graph-only', 'bs-hijack', 'bs-orphan'],
};
const REALIZES_OWNED_FILTER = /WHERE service\.id IN \$orgServiceIds/;
const REALIZES_NODE_ORG_FILTER = /WHERE service\.id IN \$orgServiceIds AND service\.organization_id = \$organizationId/;
const SERVICE_NODE_ORG_FILTER = /MATCH \(service:BusinessService \{id: \$serviceId\}\)\s+WHERE service\.organization_id = \$organizationId\s/;

const LICENSES = [
  { id: 'lic-a', name: 'A License', type: 'software', organization_id: ORG_A, tbm_monthly_cost: 3 },
  { id: 'lic-b', name: 'B License', type: 'software', organization_id: ORG_B, tbm_monthly_cost: 5 },
  { id: 'lic-pending', name: 'Pending', type: 'software', organization_id: ORG_A.toUpperCase(), tbm_monthly_cost: 99 },
  { id: 'lic-failed', name: 'Failed', type: 'software', organization_id: ORG_B, tbm_monthly_cost: 99 },
];
let licenseRows = LICENSES;
// Each owned service also has one pending/failed CI cost. The fake applies the
// pending predicate only when the Cypher actually carries it.
function serviceCost(id: string, cypher: string, params: Params): number {
  const base = GRAPH_SERVICES[id]!.cost;
  const gapId = id === 'bs-a-app' ? 'lic-pending' : id === 'bs-b-app' ? 'lic-failed' : null;
  if (!gapId) return base;
  return base + (cypher.includes('NOT ci.id IN $pending') &&
    (params['pending'] as string[] | undefined)?.includes(gapId) ? 0 : 999);
}
const neo4jSession = {
  run: async (query: string, params: Params = {}) => {
    cypherRuns.push({ query, params });
    if (query.includes("MATCH (ci:CI {type: 'software'})")) {
      if (licenseRows.length > 100 && !query.includes('LIMIT 100')) {
        throw new Error('Unbounded global software CI response');
      }
      const offset = Number(params['offset'] ?? 0);
      const count = query.includes('LIMIT 100') ? 100 : licenseRows.length;
      return { records: licenseRows.slice(offset, offset + count)
        .map(ci => record({ ci: { properties: ci } })) };
    }
    // A statement without the node-org predicate matches every organization's node, as Neo4j would.
    const nodeInOrg = (id: string, filter: RegExp) =>
      !filter.test(query) || GRAPH_SERVICES[id]?.organizationId === params['organizationId'];
    if (query.includes('BusinessCapability')) {
      const capability = params['capabilityId'] === 'cap-b'
        ? { id: 'cap-b', name: 'B Only', realizedBy: ['bs-b-app'] }
        : params['capabilityId'] === 'cap-a'
          ? { id: 'cap-a', name: 'A Only', realizedBy: ['bs-a-app'] }
        : params['capabilityId'] === CAPABILITY.id ? CAPABILITY : null;
      if (!capability) return { records: [] };
      const allowed = REALIZES_OWNED_FILTER.test(query) ? (params['orgServiceIds'] as string[] | undefined) ?? [] : null;
      const services = capability.realizedBy.filter(id =>
        (allowed === null || allowed.includes(id)) && nodeInOrg(id, REALIZES_NODE_ORG_FILTER));
      if (services.length === 0 && query.includes('MATCH (cap:BusinessCapability {id: $capabilityId})-[:REALIZES]->')) {
        return { records: [] };
      }
      return {
        records: [record({
          capabilityId: capability.id,
          capabilityName: capability.name,
          serviceIds: services,
          totalCost: services.reduce((sum, id) => sum + serviceCost(id, query, params), 0),
          ciCount: int(services.length),
        })],
      };
    }
    if (query.includes('BusinessService {id: $serviceId}')) {
      const serviceId = params['serviceId'] as string;
      const service = GRAPH_SERVICES[serviceId];
      if (service === undefined || !nodeInOrg(serviceId, SERVICE_NODE_ORG_FILTER)) return { records: [] };
      return {
        records: [record({
          serviceId,
          serviceName: service.name,
          totalCost: serviceCost(serviceId, query, params),
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

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string; _platformAdmin?: boolean }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  'admin-a': { _id: 'admin-a', _username: 'ada', _role: 'admin', _enabled: true, _organizationId: ORG_A },
  'admin-b': { _id: 'admin-b', _username: 'bea', _role: 'admin', _enabled: true, _organizationId: ORG_B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
  'user-bad': { _id: 'user-bad', _username: 'bart', _role: 'admin', _enabled: true, _organizationId: 'not-a-uuid' },
  'platform': { _id: 'platform', _username: 'platform', _role: 'admin', _enabled: true, _platformAdmin: true },
};
const KEY_A = randomBytes(32).toString('hex');
const KEY_B = randomBytes(32).toString('hex');
const KEY_PLATFORM = randomBytes(32).toString('hex');
const KEY_NONE = randomBytes(32).toString('hex');
const API_KEYS: Record<string, { _id: string; _userId: string; _role: string; _enabled: boolean }> = {
  [createHash('sha256').update(KEY_A).digest('hex')]: { _id: 'key-a', _userId: 'admin-a', _role: 'admin', _enabled: true },
  [createHash('sha256').update(KEY_B).digest('hex')]: { _id: 'key-b', _userId: 'admin-b', _role: 'admin', _enabled: true },
  [createHash('sha256').update(KEY_NONE).digest('hex')]: { _id: 'key-none', _userId: 'user-none', _role: 'admin', _enabled: true },
  [createHash('sha256').update(KEY_PLATFORM).digest('hex')]: { _id: 'key-platform', _userId: 'platform', _role: 'admin', _enabled: true },
};

jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async (hash: string) => API_KEYS[hash] ?? null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import type { TokenPayload, UserRole } from '../../../auth/types';
import { tbmRoutes } from '../../routes/tbm.routes';
import { connectorResolvers } from '../../../graphql/resolvers/connector.resolvers';
import { tbmResolvers } from '../../../graphql/resolvers/tbm.resolvers';
import { connectorRoutes } from '../../routes/connector.routes';

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
  ('bs-hijack', 'A Claims B Node', 'data', 'data', 'high', 'active', '${ORG_A}'),
  ('bs-orphan', 'A Claims Orphan Node', 'data', 'data', 'high', 'active', '${ORG_A}'),
  ('bs-b-app', 'B Secret App', 'application', 'application', 'medium', 'active', '${ORG_B}');
INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, tbm_attributes, organization_id) VALUES
  ('ci-a', 'A', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 100}', '${ORG_A}'),
  ('ci-a2', 'A2', 'server', 'active', '{"resource_tower": "storage", "monthly_cost": 20}', '${ORG_A}'),
  ('ci-b', 'B', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 7}', '${ORG_B}');`;
// Every service id org A owns in Postgres, sorted.
const A_OWNED_IDS = ['bs-a-app', 'bs-a-db', 'bs-hijack', 'bs-orphan'];

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => {
  const user = USERS[userId]!;
  return {
    Authorization: `Bearer ${jwt.generateAccessToken(userId, user._username, user._role as UserRole, organizationId)}`,
  };
};
const AS_A = bearer('user-a', ORG_A);
const AS_ADMIN_A = bearer('admin-a', ORG_A);
const AS_PLATFORM = bearer('platform');

const PRINCIPALS = [AS_ADMIN_A, bearer('admin-b', ORG_B), { 'x-api-key': KEY_A }, { 'x-api-key': KEY_B }];
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/tbm', tbmRoutes);
app.use('/api/v1/connectors', connectorRoutes);
const graphqlApp = express();
let graphqlServer: ApolloServer;

const queryCount = () => pgQueries + cypherRuns.length;

beforeAll(async () => {
  await send('exec', baseDdl());
  for (const migration of ['008_business_service_organization_scope.sql', '011_ci_organization_scope.sql']) {
    await send('exec', `BEGIN;\n${readFileSync(join(MIGRATIONS, migration), 'utf8')}\nCOMMIT;`);
  }
  const provenanceDdl = readFileSync(join(MIGRATIONS, '028_change_history_reconciliation_org_provenance.sql'), 'utf8');
  const journal = provenanceDdl.match(/CREATE TABLE IF NOT EXISTS ci_reconciliation_operations \([\s\S]*?\n\);/);
  const epochs = provenanceDdl.match(/CREATE TABLE IF NOT EXISTS ci_reconciliation_epochs \([\s\S]*?\n\);/);
  if (!journal || !epochs) throw new Error('Missing S1 journal tables');
  await send('exec', `${journal[0]}\n${epochs[0]}`);
  await send('exec', SEED);
  await send('exec', `INSERT INTO ci_reconciliation_operations
    (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state, actor, epoch, lease_expires_at)
    VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '${ORG_A}', 'lic-pending', 'api', 'update', true, 'pending', 'test', 1, NOW()),
           ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', '${ORG_B}', 'lic-failed', 'api', 'update', true, 'failed', 'test', 1, NOW());`);
  graphqlServer = new ApolloServer({
    typeDefs: `type Query {
      health: String
      costsByCapability(id: ID!): CapabilityCost!
      costsByBusinessService(id: ID!): BusinessServiceCost!
      costTrends(months: Int = 6): [MonthlyCostData!]!
      costSummary: String
      costsByTower: String
      costAllocations(ciId: String!): String
      licenses: [SoftwareLicense!]!
      upcomingRenewals: [SoftwareLicense!]!
    }
      type CapabilityCost { capabilityId: ID!, capabilityName: String!, totalMonthlyCost: Float!, supportingServices: Int! }
      type BusinessServiceCost { serviceId: ID!, serviceName: String!, totalMonthlyCost: Float! }
      type MonthlyCostData { month: String!, totalCost: Float!, ciCount: Int! }
      type SoftwareLicense { id: ID!, name: String!, monthlyCost: Float! }
      type ConnectorMutationResult { success: Boolean, message: String }
      type Mutation {
        installConnector(connectorType: String!, version: String): ConnectorMutationResult
        updateConnector(connectorType: String!, version: String): ConnectorMutationResult
        uninstallConnector(connectorType: String!): ConnectorMutationResult
        allocateCosts(input: CostAllocationInput!): String
        importGLData: String
      }
      input CostAllocationInput { sourceId: String!, targetType: String!, targetIds: [String!]! }`,
    resolvers: { Query: {
      health: () => 'ok',
      costsByCapability: tbmResolvers.Query.costsByCapability,
      costsByBusinessService: tbmResolvers.Query.costsByBusinessService,
      costTrends: tbmResolvers.Query.costTrends,
      costSummary: tbmResolvers.Query.costSummary,
      costsByTower: tbmResolvers.Query.costsByTower,
      costAllocations: tbmResolvers.Query.costAllocations,
      licenses: tbmResolvers.Query.licenses,
      upcomingRenewals: tbmResolvers.Query.upcomingRenewals,
    }, Mutation: {
      installConnector: connectorResolvers.Mutation.installConnector,
      updateConnector: connectorResolvers.Mutation.updateConnector,
      uninstallConnector: connectorResolvers.Mutation.uninstallConnector,
      allocateCosts: tbmResolvers.Mutation.allocateCosts,
      importGLData: tbmResolvers.Mutation.importGLData,
    } },
  });
  await graphqlServer.start();
  graphqlApp.use('/graphql', express.json(), getAuthMiddleware().authenticate(),
    expressMiddleware(graphqlServer, { context: async ({ req }) => ({
      user: (req as typeof req & { user: TokenPayload }).user,
      credentialType: (req as typeof req & { credentialType?: 'jwt' | 'api-key' }).credentialType,
      _neo4jClient: { getSession: () => neo4jSession }, _loaders: {},
    }) }));
});

afterAll(async () => {
  await graphqlServer.stop();
  host.kill();
});

beforeEach(() => {
  pgQueries = 0;
  cypherRuns.length = 0;
  licenseRows = LICENSES;
});

const DENIED_ROUTES: Array<[string, string, object | null]> = [
  ['get', '/api/v1/tbm/costs/summary', null],
  ['get', '/api/v1/tbm/costs/by-tower', null],
  ['get', '/api/v1/tbm/costs/allocations/ci-1', null],
  ['post', '/api/v1/tbm/costs/allocate', { sourceId: 'ci-1', targetType: 'business_service', targetIds: ['bs-a-app'] }],
  ['post', '/api/v1/tbm/gl/import', { records: [{ accountNumber: '1', accountName: 'x', costPool: 'p' }] }],
];
const SCOPED_ROUTES: Array<[string, string, object | null]> = [
  ['get', '/api/v1/tbm/costs/by-service/bs-a-app', null],
  ['get', '/api/v1/tbm/costs/by-capability/cap-1', null],
  ['get', '/api/v1/tbm/costs/trends', null],
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

  it('by-service is 404 when the Neo4j node belongs to another org even though Postgres ownership passes', async () => {
    const hijack = await request(app).get('/api/v1/tbm/costs/by-service/bs-hijack').set(AS_A);
    const missing = await request(app).get('/api/v1/tbm/costs/by-service/bs-missing').set(AS_A);

    expect(hijack.status).toBe(404);
    expect(hijack.text).toBe(missing.text);
    expect(hijack.text).not.toContain('B Hijacked Node');
  });

  it('by-service is 404 for a Neo4j node with no organization_id', async () => {
    const orphan = await request(app).get('/api/v1/tbm/costs/by-service/bs-orphan').set(AS_A);
    const missing = await request(app).get('/api/v1/tbm/costs/by-service/bs-missing').set(AS_A);

    expect(orphan.status).toBe(404);
    expect(orphan.text).toBe(missing.text);
    expect(orphan.text).not.toContain('Orphan Node');
  });

  it('API key service access is own-org only, with foreign and missing IDs indistinguishable', async () => {
    const foreign = await request(app).get('/api/v1/tbm/costs/by-service/bs-b-app').set({ 'x-api-key': KEY_A });
    const missing = await request(app).get('/api/v1/tbm/costs/by-service/bs-missing').set({ 'x-api-key': KEY_A });
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(missing.text);
    const own = await request(app).get('/api/v1/tbm/costs/by-service/bs-b-app').set({ 'x-api-key': KEY_B });
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ serviceName: 'B Secret App', totalMonthlyCost: 7 });
  });

});

describe('fail closed without an organization claim', () => {
  it.each(SCOPED_ROUTES)(
    '%s %s -> 403 with zero queries when the token has no organization claim',
    async (method, path, body) => {
      for (const headers of [bearer('user-none'), bearer('user-bad', 'not-a-uuid'), { 'x-api-key': KEY_NONE }]) {
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
    expect([...(cypherRuns[0]!.params['orgServiceIds'] as string[])].sort()).toEqual(A_OWNED_IDS);
  });

  it('by-capability excludes nodes of other orgs', async () => {
    // bs-hijack (B's node) and bs-orphan (no org) are owned by A in Postgres and realize cap-1.
    const res = await request(app).get('/api/v1/tbm/costs/by-capability/cap-1').set(AS_A);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ totalMonthlyCost: 100, supportingServices: 1 });
    expect(cypherRuns.map(run => run.params['organizationId'])).toEqual([ORG_A]);
  });

  it("the Cypher receives the token org's ids, never a request-supplied org", async () => {
    const res = await request(app)
      .get(`/api/v1/tbm/costs/by-capability/cap-1?organization_id=${ORG_B}&organizationId=${ORG_B}`)
      .set({ ...AS_A, 'x-organization-id': ORG_B });

    expect(res.status).toBe(200);
    expect(res.body.data.totalMonthlyCost).toBe(100);
    for (const run of cypherRuns) {
      expect([...(run.params['orgServiceIds'] as string[])].sort()).toEqual(A_OWNED_IDS);
      expect(JSON.stringify(run.params)).not.toContain(ORG_B);
    }
    expect(cypherRuns.length).toBeGreaterThan(0);
  });

  it('foreign-only capability and missing capability share one not-found response; own capability remains available via API key', async () => {
    const foreign = await request(app).get('/api/v1/tbm/costs/by-capability/cap-b').set({ 'x-api-key': KEY_A });
    const missing = await request(app).get('/api/v1/tbm/costs/by-capability/cap-missing').set({ 'x-api-key': KEY_A });
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(missing.text);
    const own = await request(app).get('/api/v1/tbm/costs/by-capability/cap-b').set({ 'x-api-key': KEY_B });
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ capabilityName: 'B Only', totalMonthlyCost: 7 });
  });
});

describe('global TBM reads and control', () => {
  it.each(DENIED_ROUTES)('%s %s: every principal gets the same static denial without data access', async (method, path, body) => {
    for (const headers of [...PRINCIPALS, bearer('user-none'), { 'x-api-key': KEY_NONE }]) {
      const res = await call(method, path, body, { ...headers, 'x-organization-id': ORG_B });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Platform administrator access unavailable' });
    }
    expect(queryCount()).toBe(0);
  });
  it('platform JWT reads both orgs but omits pending and failed license rows; tenant and platform API keys cannot read', async () => {
    for (const path of ['/api/v1/tbm/licenses', '/api/v1/tbm/licenses/renewals']) {
      for (const headers of [...PRINCIPALS, { 'x-api-key': KEY_PLATFORM }]) {
        const denied = await request(app).get(path).set(headers);
        expect(denied.status).toBe(403);
      }
      expect(queryCount()).toBe(0);
      const allowed = await request(app).get(path).set(AS_PLATFORM);
      expect(allowed.status).toBe(200);
      expect(allowed.body).toMatchObject({ success: true, count: 2 });
      expect(allowed.body.data.map((license: { id: string }) => license.id)).toEqual(['lic-a', 'lic-b']);
      pgQueries = 0;
      cypherRuns.length = 0;
    }
  });

  it('never reports a complete license inventory when the 101st committed row exists', async () => {
    licenseRows = Array.from({ length: 101 }, (_, i) => ({
      id: `lic-renewal-${String(i).padStart(4, '0')}`,
      name: `Renewal ${i}`, type: 'software', organization_id: i % 2 ? ORG_A : ORG_B,
      license_expiry_date: '2026-10-20', tbm_monthly_cost: 1,
    }));
    try {
      for (const path of ['/api/v1/tbm/licenses', '/api/v1/tbm/licenses/renewals?days=365']) {
        const res = await request(app).get(path).set(AS_PLATFORM);
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ success: false, error: 'Service Unavailable' });
      }
      for (const field of ['licenses', 'upcomingRenewals']) {
        const res = await request(graphqlApp).post('/graphql').set(AS_PLATFORM)
          .send({ query: `query { ${field} { id } }` });
        expect(res.body.errors?.[0].extensions.code).toBe('SERVICE_UNAVAILABLE');
        expect(res.body.data).toBeNull();
      }
      licenseRows.pop();
      const expected = licenseRows.map(ci => ci.id);
      for (const path of ['/api/v1/tbm/licenses', '/api/v1/tbm/licenses/renewals?days=365']) {
        const exact = await request(app).get(path).set(AS_PLATFORM);
        expect(exact.status).toBe(200);
        expect(exact.body.count).toBe(100);
        expect(exact.body.data.map((ci: { id: string }) => ci.id)).toEqual(expected);
      }
      for (const field of ['licenses', 'upcomingRenewals']) {
        const exact = await request(graphqlApp).post('/graphql').set(AS_PLATFORM)
          .send({ query: `query { ${field} { id } }` });
        expect(exact.body.errors).toBeUndefined();
        expect(exact.body.data[field].map((ci: { id: string }) => ci.id)).toEqual(expected);
      }
    } finally {
      licenseRows = LICENSES;
    }
  });

  it('returns the committed 101st license after 100 pending entries via mounted REST', async () => {
    const pendingLicenses = Array.from({ length: 100 }, (_, i) => ({
      id: `lic-bulk-${String(i).padStart(3, '0')}`,
      name: `Pending ${i}`, type: 'software', organization_id: ORG_A, tbm_monthly_cost: 1,
    }));
    licenseRows = [...pendingLicenses, { ...LICENSES[0], id: 'lic-committed-101' }];
    await send('exec', `INSERT INTO ci_reconciliation_operations
      (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state, actor, epoch, lease_expires_at)
      SELECT gen_random_uuid(), gen_random_uuid(), '${ORG_A}', 'lic-bulk-' || lpad(i::text, 3, '0'),
        'api', 'update', true, 'pending', 'test', 1, NOW()
      FROM generate_series(0, 99) AS i`);
    try {
      const rest = await request(app).get('/api/v1/tbm/licenses').set(AS_PLATFORM);
      expect(rest.status).toBe(200);
      expect(rest.body.data.map((ci: { id: string }) => ci.id)).toEqual(['lic-committed-101']);
      const gql = await request(graphqlApp).post('/graphql').set(AS_PLATFORM)
        .send({ query: 'query { licenses { id } }' });
      expect(gql.body.errors).toBeUndefined();
      expect(gql.body.data.licenses).toEqual([{ id: 'lic-committed-101' }]);
    } finally {
      licenseRows = LICENSES;
      await send('exec', `DELETE FROM ci_reconciliation_operations
        WHERE organization_id = '${ORG_A}' AND ci_id LIKE 'lic-bulk-%'`);
    }
  });

  it('fails closed within finite work when a long pending-license backlog precedes eligible rows', async () => {
    licenseRows = Array.from({ length: 2200 }, (_, i) => ({
      id: `lic-gap-${String(i).padStart(4, '0')}`,
      name: `Pending ${i}`, type: 'software', organization_id: ORG_A, tbm_monthly_cost: 1,
    }));
    licenseRows.push({ ...LICENSES[0], id: 'lic-after-gaps' });
    await send('exec', `INSERT INTO ci_reconciliation_operations
      (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state, actor, epoch, lease_expires_at)
      SELECT gen_random_uuid(), gen_random_uuid(), '${ORG_A}', 'lic-gap-' || lpad(i::text, 4, '0'),
        'api', 'update', true, 'pending', 'test', 1, NOW()
      FROM generate_series(0, 2199) AS i`);
    try {
      const rest = await request(app).get('/api/v1/tbm/licenses').set(AS_PLATFORM);
      expect(rest.status).toBe(503);
      expect(rest.body.error).toBe('Service Unavailable');
      expect(cypherRuns).toHaveLength(20);
      cypherRuns.length = 0;
      const gql = await request(graphqlApp).post('/graphql').set(AS_PLATFORM)
        .send({ query: 'query { licenses { id } }' });
      expect(gql.body.errors?.[0].extensions.code).toBe('SERVICE_UNAVAILABLE');
      expect(cypherRuns).toHaveLength(20);
      cypherRuns.length = 0;
      const renewals = await request(app).get('/api/v1/tbm/licenses/renewals?days=365').set(AS_PLATFORM);
      expect(renewals.status).toBe(503);
      expect(renewals.body.error).toBe('Service Unavailable');
      expect(cypherRuns).toHaveLength(20);
    } finally {
      licenseRows = LICENSES;
      await send('exec', `DELETE FROM ci_reconciliation_operations
        WHERE organization_id = '${ORG_A}' AND ci_id LIKE 'lic-gap-%'`);
    }
  });

  it('cost trends remain scoped to verified caller organization for sessions and API keys', async () => {
    for (const headers of [AS_ADMIN_A, { 'x-api-key': KEY_A }]) {
      const res = await request(app).get('/api/v1/tbm/costs/trends').set({ ...headers, 'x-organization-id': ORG_B });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, count: 1, data: [{ totalCost: 120, ciCount: 2 }] });
    }
    for (const headers of [bearer('admin-b', ORG_B), { 'x-api-key': KEY_B }]) {
      const res = await request(app).get('/api/v1/tbm/costs/trends').set(headers);
      expect(res.body).toMatchObject({ success: true, count: 1, data: [{ totalCost: 7, ciCount: 1 }] });
    }
  });
});

describe('mounted REST connector control', () => {
  const controls: Array<[string, string, object | null]> = [
    ['post', '/api/v1/connectors/install', { connector_type: 'test' }],
    ['put', '/api/v1/connectors/test/update', {}],
    ['delete', '/api/v1/connectors/test', null],
    ['post', '/api/v1/connectors/test/verify', null],
    ['post', '/api/v1/connectors/cache/refresh', null],
  ];
  it.each(controls)('%s %s uniformly refuses admin sessions and API keys before data access', async (method, path, body) => {
    for (const headers of [...PRINCIPALS, bearer('user-none'), { 'x-api-key': KEY_NONE }]) {
      const res = await call(method, path, body, { ...headers, 'x-organization-id': ORG_B });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Platform administrator access unavailable' });
    }
    expect(queryCount()).toBe(0);
  });
});

describe('mounted GraphQL connector lifecycle', () => {
  it.each(['installConnector', 'updateConnector', 'uninstallConnector'])('%s denies both organizations and both principal types before side effects', async name => {
    for (const headers of [...PRINCIPALS, bearer('user-none'), { 'x-api-key': KEY_NONE }]) {
      const response = await request(graphqlApp).post('/graphql').set({ ...headers, 'x-organization-id': ORG_B })
        .send({ query: `mutation { ${name}(connectorType: "test") { success message } }` });
      expect(response.body.errors?.[0]).toMatchObject({
        message: 'Platform administrator access unavailable',
        extensions: { code: 'FORBIDDEN' },
      });
      expect(response.body.data?.[name]).toBeNull();
    }
    expect(queryCount()).toBe(0);
  });
});

describe('mounted GraphQL global TBM operations', () => {
  const operations = [
    'query { costSummary }',
    'query { costsByTower }',
    'query { costAllocations(ciId: "ci-a") }',
    'query { licenses { id name } }',
    'query { upcomingRenewals { id name } }',
    'mutation { allocateCosts(input: { sourceId: "ci-a", targetType: "BUSINESS_SERVICE", targetIds: ["bs-a-app"] }) }',
    'mutation { importGLData }',
  ];
  it.each(operations)('%s refuses both orgs and API keys with no DB activity', async query => {
    for (const headers of [...PRINCIPALS, { 'x-api-key': KEY_NONE }]) {
      const response = await request(graphqlApp).post('/graphql').set(headers).send({ query });
      expect(response.body.errors?.[0]).toMatchObject({
        message: 'Platform administrator access unavailable',
        extensions: { code: 'FORBIDDEN' },
      });
    }
    expect(queryCount()).toBe(0);
  });
  it('GraphQL platform JWT filters pending and failed rows, while platform API keys are refused before graph access', async () => {
    const denied = await request(graphqlApp).post('/graphql').set({ 'x-api-key': KEY_PLATFORM })
      .send({ query: 'query { licenses { id } }' });
    expect(denied.body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    expect(queryCount()).toBe(0);
    const allowed = await request(graphqlApp).post('/graphql').set(AS_PLATFORM)
      .send({ query: 'query { licenses { id name monthlyCost } upcomingRenewals { id } }' });
    expect(allowed.body.errors).toBeUndefined();
    expect(allowed.body.data).toEqual({
      licenses: [
        { id: 'lic-a', name: 'A License', monthlyCost: 3 },
        { id: 'lic-b', name: 'B License', monthlyCost: 5 },
      ],
      upcomingRenewals: [{ id: 'lic-a' }, { id: 'lic-b' }],
    });
  });
});

const TENANT_QUERIES = {
  service: (id: string) => `query { costsByBusinessService(id: "${id}") { serviceId serviceName totalMonthlyCost } }`,
  capability: (id: string) => `query { costsByCapability(id: "${id}") { capabilityId capabilityName totalMonthlyCost supportingServices } }`,
  trends: 'query { costTrends { totalCost ciCount } }',
};
function gql(query: string, headers: object) {
  return request(graphqlApp).post('/graphql').set(headers).send({ query });
}

describe('mounted GraphQL tenant TBM reads', () => {
  it.each([AS_ADMIN_A, { 'x-api-key': KEY_A }])('returns only owned services and capabilities for a verified org A principal', async headers => {
    const ownService = await gql(TENANT_QUERIES.service('bs-a-app'), headers);
    expect(ownService.body).toMatchObject({
      data: { costsByBusinessService: { serviceId: 'bs-a-app', serviceName: 'A App', totalMonthlyCost: 100 } },
    });
    const ownCapability = await gql(TENANT_QUERIES.capability('cap-1'), headers);
    expect(ownCapability.body).toMatchObject({
      data: { costsByCapability: { capabilityId: 'cap-1', totalMonthlyCost: 100, supportingServices: 1 } },
    });

    for (const [kind, foreignId, missingId, message] of [
      ['service', 'bs-b-app', 'bs-missing', 'Business service not found'],
      ['capability', 'cap-b', 'cap-missing', 'Business capability not found'],
    ] as const) {
      const foreign = await gql(TENANT_QUERIES[kind](foreignId), headers);
      const missing = await gql(TENANT_QUERIES[kind](missingId), headers);
      expect(foreign.body.data).toBeNull();
      expect(foreign.body.errors?.[0]).toMatchObject({ message, extensions: { code: 'NOT_FOUND' } });
      expect(foreign.body).toEqual(missing.body);
      expect(JSON.stringify(foreign.body)).not.toContain('B Secret App');
    }
    for (const id of ['bs-graph-only', 'bs-hijack', 'bs-orphan']) {
      const res = await gql(TENANT_QUERIES.service(id), headers);
      const missing = await gql(TENANT_QUERIES.service('bs-missing'), headers);
      expect(res.body).toEqual(missing.body);
    }
  });

  it.each([bearer('admin-b', ORG_B), { 'x-api-key': KEY_B }])('isolates org B with JWT and API key', async headers => {
    const service = await gql(TENANT_QUERIES.service('bs-b-app'), headers);
    expect(service.body.data?.costsByBusinessService).toMatchObject({ serviceName: 'B Secret App', totalMonthlyCost: 7 });
    const capability = await gql(TENANT_QUERIES.capability('cap-b'), headers);
    expect(capability.body.data?.costsByCapability).toMatchObject({ capabilityName: 'B Only', totalMonthlyCost: 7 });
    const foreign = await gql(TENANT_QUERIES.service('bs-a-app'), headers);
    const missing = await gql(TENANT_QUERIES.service('bs-missing'), headers);
    expect(foreign.body.errors?.[0]).toMatchObject({ message: 'Business service not found', extensions: { code: 'NOT_FOUND' } });
    expect(foreign.body).toEqual(missing.body);
    const foreignCapability = await gql(TENANT_QUERIES.capability('cap-a'), headers);
    const missingCapability = await gql(TENANT_QUERIES.capability('cap-missing'), headers);
    expect(foreignCapability.body.errors?.[0]).toMatchObject({ message: 'Business capability not found', extensions: { code: 'NOT_FOUND' } });
    expect(foreignCapability.body).toEqual(missingCapability.body);
  });

  it.each([bearer('user-none'), bearer('user-bad', 'not-a-uuid'), { 'x-api-key': KEY_NONE }])('fails closed without a valid organization before database access', async headers => {
    for (const query of [TENANT_QUERIES.service('bs-a-app'), TENANT_QUERIES.capability('cap-1'), TENANT_QUERIES.trends]) {
      const res = await gql(query, headers);
      expect(res.body.errors?.[0]).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    }
    expect(queryCount()).toBe(0);
  });

  it('trends use only the verified principal organization for both authentication modes', async () => {
    for (const headers of [AS_ADMIN_A, { 'x-api-key': KEY_A }]) {
      const res = await gql(TENANT_QUERIES.trends, { ...headers, 'x-organization-id': ORG_B });
      expect(res.body.data?.costTrends).toEqual([{ totalCost: 120, ciCount: 2 }]);
    }
    for (const headers of [bearer('admin-b', ORG_B), { 'x-api-key': KEY_B }]) {
      const res = await gql(TENANT_QUERIES.trends, headers);
      expect(res.body.data?.costTrends).toEqual([{ totalCost: 7, ciCount: 1 }]);
    }
    const denied = await gql(TENANT_QUERIES.trends, AS_A);
    expect(denied.body.errors?.[0]).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });

  it('prefers Authorization bearer identity over a conflicting X-API-Key for tenant reads and trends', async () => {
    for (const [headers, ownId, ownCost, foreignId, capabilityId, trendCost] of [
      [{ ...AS_ADMIN_A, 'x-api-key': KEY_B }, 'bs-a-app', 100, 'bs-b-app', 'cap-1', 120],
      [{ ...bearer('admin-b', ORG_B), 'x-api-key': KEY_A }, 'bs-b-app', 7, 'bs-a-app', 'cap-b', 7],
    ] as const) {
      const own = await gql(TENANT_QUERIES.service(ownId), headers);
      expect(own.body.data?.costsByBusinessService.totalMonthlyCost).toBe(ownCost);
      const capability = await gql(TENANT_QUERIES.capability(capabilityId), headers);
      expect(capability.body.data?.costsByCapability.totalMonthlyCost).toBe(ownCost);
      const foreign = await gql(TENANT_QUERIES.service(foreignId), headers);
      const missing = await gql(TENANT_QUERIES.service('bs-missing'), headers);
      expect(foreign.body).toEqual(missing.body);
      const trends = await gql(TENANT_QUERIES.trends, headers);
      expect(trends.body.data?.costTrends).toEqual([{ totalCost: trendCost, ciCount: ownCost === 100 ? 2 : 1 }]);
    }
  });
});
