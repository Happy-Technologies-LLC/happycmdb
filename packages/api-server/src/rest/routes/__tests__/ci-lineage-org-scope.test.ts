// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration 011 CI lineage, end to end: rows the 011 backfill left in the
 * internal organization (org_backfilled) are synced by the real
 * Neo4jToPostgresJob, then read through the public paths an organization has
 * to CI cost: POST /api/v1/business-services/:id/cis (mapping),
 * GET /api/v1/business-services/:id/costs and GET /api/v1/tbm/costs/trends.
 *
 * A pre-011 ci_id can carry the history of an earlier CI (deleted, id
 * reused). Neither a node now naming org B, nor a sync whose batches failed,
 * may give org B any of that history: its cost (monthly_cost 999 below) must
 * never appear on org B's reads.
 *
 * SQL runs on PGlite in a forked child (fixtures/pglite-host.cjs): the CREATE
 * TABLE blocks read verbatim from 001_complete_schema.sql, then 008 and 011
 * verbatim. Substitutions: Neo4jAuthRepository -> in-memory users;
 * getPostgresClient -> IPC client to PGlite; the job's Neo4j -> fixed :CI
 * nodes.
 */

import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import type { Job } from 'bullmq';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
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
// Plain functions (not jest.fn): the unit config resets mock implementations.
const query = async (sql: string, params: unknown[] = []) => ({ rows: await send('query', sql, params) });
const pgClient = {
  query,
  pool: { query },
  // One PGlite connection: BEGIN/COMMIT around the callback is a real transaction.
  transaction: async <T>(callback: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
    await send('exec', 'BEGIN');
    try {
      const result = await callback({ query });
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
  UNSCOPED_CI_ACCESS: Symbol('UNSCOPED_CI_ACCESS'),
}));
jest.mock('bcrypt', () => ({}));

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId: string }> = {
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  'admin-b': { _id: 'admin-b', _username: 'bea', _role: 'admin', _enabled: true, _organizationId: ORG_B },
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
import type { Neo4jClient, PostgresClient } from '@cmdb/database';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import type { UserRole } from '../../../auth/types';
import { businessServiceRoutes } from '../business-service.routes';
import { tbmRoutes } from '../tbm.routes';
import { Neo4jToPostgresJob } from '../../../../../etl-processor/src/jobs/neo4j-to-postgres.job';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const DDL_TABLES = ['dim_business_services', 'ci_business_service_mappings', 'cmdb.dim_ci', 'cmdb.fact_discovery'];

function schemaDdl(): string {
  const sql = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  return 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + DDL_TABLES.map(table => {
    const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  }).join('\n');
}

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string) => {
  const user = USERS[userId]!;
  return { Authorization: `Bearer ${jwt.generateAccessToken(userId, user._username, user._role as UserRole, user._organizationId)}` };
};
const AS_B = bearer('user-b');
const AS_ADMIN_B = bearer('admin-b');

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/business-services', businessServiceRoutes);
app.use('/api/v1/tbm', tbmRoutes);

// The job's Neo4j: the :CI nodes that currently exist.
let nodes: Array<Record<string, unknown>> = [];
const neo4jClient = {
  getSession: () => ({
    run: async () => ({ records: nodes.map(properties => ({ get: () => ({ properties }) })) }),
    close: async () => undefined,
  }),
  getRelationships: async () => [],
} as unknown as Neo4jClient;
const node = (id: string, organizationId: string) => ({
  id, name: id, type: 'server', status: 'active', environment: 'production', organization_id: organizationId,
  created_at: '2020-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', discovered_at: '2026-01-01T00:00:00Z',
  metadata: JSON.stringify({ discovery_source: 'test', discovery_method: 'manual' }),
});

// complete: every node is visited (no incrementalSince); one CI per batch.
async function sync(complete: boolean): Promise<void> {
  const data = complete ? { batchSize: 1 } : { batchSize: 1, incrementalSince: '2026-01-01T00:00:00Z' };
  const job = { id: 'job-1', data, updateProgress: async () => undefined };
  await new Neo4jToPostgresJob(neo4jClient, pgClient as unknown as PostgresClient).execute(job as unknown as Job);
}

// History 011 left behind for a ci_id: two versions, both internal and
// marked as backfill labels, costing 999 a month, effective this month.
const backfilledHistory = (ciId: string) => send('exec', `INSERT INTO cmdb.dim_ci
  (ci_id, ci_name, ci_type, ci_status, environment, tbm_attributes, is_current, organization_id, org_backfilled) VALUES
  ('${ciId}', '${ciId}', 'server', 'active', 'production', '{"resource_tower": "compute", "monthly_cost": 999}', FALSE, '${INTERNAL_ORG}', TRUE),
  ('${ciId}', '${ciId}', 'server', 'active', 'production', '{"resource_tower": "compute", "monthly_cost": 999}', TRUE, '${INTERNAL_ORG}', TRUE);`);

const mapIntoB = (ciId: string) =>
  request(app).post('/api/v1/business-services/bs-b/cis').set(AS_B).send({ ci_ids: [ciId] });
const costsOfB = async () => (await request(app).get('/api/v1/business-services/bs-b/costs').set(AS_B)).body;
const trendsOfB = async () => (await request(app).get('/api/v1/tbm/costs/trends').set(AS_ADMIN_B)).body;

beforeAll(async () => {
  await send('exec', schemaDdl());
  for (const migration of ['008_business_service_organization_scope.sql', '011_ci_organization_scope.sql']) {
    await send('exec', `BEGIN;\n${readFileSync(join(MIGRATIONS, migration), 'utf8')}\nCOMMIT;`);
  }
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  await send('exec', `TRUNCATE ${DDL_TABLES.join(', ')} RESTART IDENTITY CASCADE;
    INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
      operational_status, organization_id) VALUES ('bs-b', 'B App', 'application', 'application', 'medium', 'active', '${ORG_B}');`);
  nodes = [];
});

it("a reused pre-011 CI id gives org B none of the earlier lineage's cost (mapping, /costs, trends)", async () => {
  // An earlier CI's history under ci-reused; org B's node now carries the id.
  await backfilledHistory('ci-reused');
  nodes = [node('ci-reused', ORG_B)];
  await sync(false);

  // Org B owns the CI from now on and can map it ...
  const mapped = await mapIntoB('ci-reused');
  expect(mapped.status).toBe(201);
  // ... but reads only what was written from its own node: no earlier version, no earlier tbm_attributes.
  const costs = await costsOfB();
  expect(costs.data).toEqual({ ci_count: 1, total_monthly_cost: '0', cost_by_tower: { compute: 0 } });
  const trends = await trendsOfB();
  expect(trends.success).toBe(true);
  expect(trends.data.map((point: { totalCost: number }) => point.totalCost)).toEqual([0]);
  expect(JSON.stringify([costs, trends])).not.toContain('999');
});

it("a CI that keeps failing to load does not keep a deleted CI's backfill window open for a later reuse of its id", async () => {
  // ci-gone's node no longer exists. The complete sync right after 011 has a
  // CI that keeps failing to load (an external_id longer than cmdb.dim_ci holds).
  await backfilledHistory('ci-gone');
  nodes = [{ ...node('ci-failing', INTERNAL_ORG), external_id: 'x'.repeat(201) }];
  await sync(true);

  // Org B later creates a CI with the deleted id.
  nodes = [node('ci-gone', ORG_B)];
  await sync(false);

  const mapped = await mapIntoB('ci-gone');
  expect([mapped.status, mapped.body]).toEqual([404, { success: false, error: 'CI not found' }]);
  const trends = await trendsOfB();
  expect([trends.success, trends.data]).toEqual([true, []]);
  expect(JSON.stringify(await costsOfB())).not.toContain('999');
}, 20000);

it("org A's invalid discovery values or metadata in the same sync batch do not stop org B mapping its CI", async () => {
  // Through POST/PUT /api/v1/cis an org-A write user can store any metadata.
  const long = 'x'.repeat(51);
  nodes = [
    { ...node('a-long-method', ORG_A), metadata: JSON.stringify({ discovery_source: 'test', discovery_method: long }) },
    { ...node('a-long-source', ORG_A), metadata: JSON.stringify({ discovery_source: long, discovery_method: 'manual' }) },
    { ...node('a-bad-metadata', ORG_A), metadata: '{not json' },
    node('ci-b-new', ORG_B),
  ];
  // One batch for every node.
  const result = await new Neo4jToPostgresJob(neo4jClient, pgClient as unknown as PostgresClient).execute({
    id: 'job-1', data: { batchSize: 100, incrementalSince: '2026-01-01T00:00:00Z' }, updateProgress: async () => undefined,
  } as unknown as Job);

  const mapped = await mapIntoB('ci-b-new');
  expect(mapped.status).toBe(201);
  // The two overlong CIs are skipped and counted; the unreadable one was skipped at extraction.
  expect(result.errors).toBe(2);
  expect(await send('query', `SELECT ci_id FROM cmdb.dim_ci WHERE ci_id LIKE 'a-%'`)).toEqual([]);
}, 20000);
