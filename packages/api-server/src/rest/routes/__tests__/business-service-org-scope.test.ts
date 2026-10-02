// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for business services (migration 008 + org-filtered routes)
 * and for the CIs they map and cost (migration 011), exercised through the
 * real businessServiceRoutes and architectureRoutes behind the real
 * AuthMiddleware/AuthService (JWT and API-key verification) mounted at the
 * production paths.
 *
 * SQL is executed by PGlite hosted in a forked child process
 * (fixtures/pglite-host.cjs). Schema: the CREATE TABLE blocks read verbatim
 * from 001_complete_schema.sql (PGlite has no TimescaleDB, so the fact tables
 * are plain tables), then 008_business_service_organization_scope.sql and
 * 011_ci_organization_scope.sql applied verbatim over pre-existing (legacy,
 * org-less) rows.
 *
 * Substitutions: Neo4jAuthRepository -> in-memory users/API keys;
 * getPostgresClient -> IPC client to that PGlite process; Neo4j -> {} (the
 * architecture analysis only reaches Neo4j for services with mapped CIs,
 * which these tests do not analyze).
 */

import { fork } from 'child_process';
import { createHash, randomBytes } from 'crypto';
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

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  // Keep the SQLSTATE so handlers see the same `code` the pg driver sets.
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const db = {
  exec: (sql: string) => send('exec', sql),
  rows: <T>(sql: string, params: unknown[] = []) => send('query', sql, params) as Promise<T[]>,
};

let queryCount = 0;
// One-shot hook run right after the next statement that reads
// dim_business_services returns: simulates another transaction committing
// between two statements of the same request.
let afterParentRead: (() => Promise<unknown>) | null = null;
const pgClient = {
  // Plain function (not jest.fn): the unit config resets mock implementations.
  query: async (sql: string, params: unknown[] = []) => {
    queryCount++;
    const rows = await send('query', sql, params);
    if (afterParentRead !== null && sql.includes('dim_business_services')) {
      const interleave = afterParentRead;
      afterParentRead = null;
      await interleave();
    }
    return { rows };
  },
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
}));

// bcrypt's native binding is only used for password hashing/login, which the
// token/API-key verification paths exercised here never call.
jest.mock('bcrypt', () => ({}));

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: INTERNAL_ORG },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
  'user-bad': { _id: 'user-bad', _username: 'bart', _role: 'admin', _enabled: true, _organizationId: 'not-a-uuid' },
};
const API_KEY_B = randomBytes(32).toString('hex');
const API_KEY_NONE = randomBytes(32).toString('hex');
const sha256 = (key: string) => createHash('sha256').update(key).digest('hex');
const API_KEYS: Record<string, { _id: string; _userId: string; _role: string; _enabled: boolean }> = {
  [sha256(API_KEY_B)]: { _id: 'key-b', _userId: 'user-b', _role: 'operator', _enabled: true },
  [sha256(API_KEY_NONE)]: { _id: 'key-none', _userId: 'user-none', _role: 'admin', _enabled: true },
};

jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async (keyHash: string) => API_KEYS[keyHash] ?? null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig, logger } from '@cmdb/common';
import { getMigrationStatus } from '../../../../../database/src/postgres/migrator';
import type { PostgresClient } from '../../../../../database/src/postgres/client';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { businessServiceRoutes } from '../business-service.routes';
import { architectureRoutes } from '../architecture.routes';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const DDL_TABLES = [
  'dim_business_services',
  'business_service_dependencies',
  'ci_business_service_mappings',
  'fact_business_service_incidents',
  'fact_business_service_changes',
  'cmdb.dim_ci',
];
const NOT_FOUND = { success: false, error: 'Business service not found' };

function baseDdl(): string {
  const sql = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  return 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + DDL_TABLES.map(table => {
    const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  }).join('\n');
}

// Pre-migration rows: the column lists have no organization_id because 001 has none.
const LEGACY_SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status) VALUES
  ('bs-legacy-1', 'Legacy One', 'compute', 'compute', 'low', 'active'),
  ('bs-legacy-2', 'Legacy Two', 'data', 'data', 'high', 'inactive');
INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, is_current) VALUES
  ('ci-legacy', 'Legacy CI (v1)', 'server', 'active', FALSE),
  ('ci-legacy', 'Legacy CI', 'server', 'active', TRUE);`;

// Org A (internal) and org B each own services with children and facts.
const SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id, created_at) VALUES
  ('bs-a-app', 'A App', 'application', 'application', 'high', 'active', '${INTERNAL_ORG}', '2026-01-02 00:00:00'),
  ('bs-a-db', 'A Database', 'data', 'data', 'critical', 'active', '${INTERNAL_ORG}', '2026-01-01 00:00:00'),
  ('bs-a-empty', 'A Empty', 'compute', 'compute', 'low', 'active', '${INTERNAL_ORG}', '2026-01-03 00:00:00'),
  ('bs-b-app', 'B App', 'application', 'application', 'medium', 'active', '${ORG_B}', '2026-01-02 00:00:00'),
  ('bs-b-db', 'B Secret Database', 'data', 'data', 'critical', 'active', '${ORG_B}', '2026-01-01 00:00:00');
INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type, confidence_score, created_at) VALUES
  ('ci-a', 'bs-a-app', 'hosts', 1, '2026-01-01 00:00:00'),
  ('ci-b', 'bs-b-app', 'hosts', 1, '2026-01-01 00:00:00');
INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type, created_at) VALUES
  ('bs-a-app', 'bs-a-db', 'platform', '2026-01-01 00:00:00'),
  ('bs-b-app', 'bs-b-db', 'platform', '2026-01-01 00:00:00');
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES
  ('bs-a-app', CURRENT_DATE - 1, 3, 30, 1),
  ('bs-b-app', CURRENT_DATE - 1, 900, 1000, 40);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-a-app', CURRENT_DATE - 1, 4, 3),
  ('bs-b-app', CURRENT_DATE - 1, 8, 0);
INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, tbm_attributes, is_current, organization_id) VALUES
  ('ci-a', 'A', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 100}', TRUE, '${INTERNAL_ORG}'),
  ('ci-a2', 'A2', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 1}', TRUE, '${INTERNAL_ORG}'),
  ('ci-b', 'B', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 7}', TRUE, '${ORG_B}'),
  ('ci-b2', 'B2', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 2}', TRUE, '${ORG_B}'),
  ('ci-b3', 'B3', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 3}', TRUE, '${ORG_B}');`;

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(userId, USERS[userId]!._username, 'operator', organizationId)}`,
});
const AS_A = bearer('user-a', INTERNAL_ORG);
const AS_B = bearer('user-b', ORG_B);

function buildApp() {
  // Mirrors server.ts: authenticate once on /api/v1, then the routers.
  const app = express();
  app.use(express.json());
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
  app.use('/api/v1/architecture', architectureRoutes);
  return app;
}
const app = buildApp();

async function orgOf(serviceId: string): Promise<string | undefined> {
  const rows = await db.rows<{ organization_id: string }>(
    'SELECT organization_id FROM dim_business_services WHERE service_id = $1', [serviceId]
  );
  return rows[0]?.organization_id;
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await db.rows<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${sql}`, params);
  return rows[0]!.n;
}

// Legacy rows exist before 008/011 run; their post-migration state is
// captured once, then every test reseeds both organizations.
let backfilled: Array<{ service_id: string; organization_id: string }> = [];
let ciBackfilled: Array<{ ci_name: string; organization_id: string; org_backfilled: boolean }> = [];

// cmdb.dim_ci columns and indexes: [columns, indexes].
type DimCiSchema = [unknown[], unknown[]];
const dimCiSchema = (): Promise<DimCiSchema> => Promise.all([
  db.rows(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'cmdb' AND table_name = 'dim_ci' ORDER BY ordinal_position`),
  db.rows(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'cmdb' AND tablename = 'dim_ci' ORDER BY indexname`),
]);
// Before 011 (008-010 do not touch cmdb.dim_ci).
let dimCiSchemaBefore011: DimCiSchema;
const UP_011 = readFileSync(join(MIGRATIONS, '011_ci_organization_scope.sql'), 'utf8');

beforeAll(async () => {
  await db.exec(baseDdl() + LEGACY_SEED);
  await db.exec(`BEGIN;\n${readFileSync(join(MIGRATIONS, '008_business_service_organization_scope.sql'), 'utf8')}\nCOMMIT;`);
  backfilled = await db.rows('SELECT service_id, organization_id FROM dim_business_services ORDER BY service_id');
  dimCiSchemaBefore011 = await dimCiSchema();
  await db.exec(`BEGIN;\n${UP_011}\nCOMMIT;`);
  ciBackfilled = await db.rows('SELECT ci_name, organization_id, org_backfilled FROM cmdb.dim_ci ORDER BY ci_key');
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  await db.exec(`TRUNCATE ${DDL_TABLES.join(', ')} RESTART IDENTITY CASCADE;${SEED}`);
  queryCount = 0;
  afterParentRead = null;
});

// getMigrationStatus only calls query(). Like node-postgres, a query without
// parameters uses the simple protocol, which accepts several statements
// (ensureMigrationsTable sends three).
const migratorClient = {
  query: async (sql: string, params?: unknown[]) =>
    params?.length ? pgClient.query(sql, params) : { rows: await send('exec', sql) },
} as unknown as PostgresClient;

describe('migration 008_business_service_organization_scope', () => {
  it('backfills every pre-existing service to the internal organization', () => {
    expect(backfilled).toEqual([
      { service_id: 'bs-legacy-1', organization_id: INTERNAL_ORG },
      { service_id: 'bs-legacy-2', organization_id: INTERNAL_ORG },
    ]);
  });

  it('leaves organization_id NOT NULL with no default, so an org-less insert fails', async () => {
    const [column] = await db.rows<{ is_nullable: string; column_default: string | null; data_type: string }>(
      `SELECT is_nullable, column_default, data_type FROM information_schema.columns
       WHERE table_name = 'dim_business_services' AND column_name = 'organization_id'`
    );
    expect(column).toEqual({ is_nullable: 'NO', column_default: null, data_type: 'uuid' });
    await expect(db.exec(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
      business_criticality, operational_status) VALUES ('bs-orphan', 'Orphan', 'compute', 'compute', 'low', 'active')`))
      .rejects.toThrow(/organization_id/);
  });

  it('indexes organization_id for the org-scoped list', async () => {
    const [index] = await db.rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_dim_business_services_organization'`
    );
    expect(index?.indexdef).toMatch(/\(organization_id, created_at DESC\)/);
  });

  it('is safe to re-run (no-op on an already migrated table)', async () => {
    await db.exec(readFileSync(join(MIGRATIONS, '008_business_service_organization_scope.sql'), 'utf8'));
    expect(await orgOf('bs-b-app')).toBe(ORG_B);
    expect(await orgOf('bs-a-app')).toBe(INTERNAL_ORG);
  });

  it('ships a rollback the migrator never discovers', async () => {
    // Real migrator discovery over the real directory (creates cmdb.schema_migrations in PGlite).
    const names = (await getMigrationStatus(migratorClient, MIGRATIONS)).map(m => m._name);
    expect(names).toContain('008_business_service_organization_scope.sql');
    expect(names.filter(name => /down|rollback/.test(name))).toEqual([]);
  });

  it('rolls back cleanly with the manual down script, and 008 re-applies afterwards', async () => {
    const up = readFileSync(join(MIGRATIONS, '008_business_service_organization_scope.sql'), 'utf8');
    const down = readFileSync(join(MIGRATIONS, 'rollback/008_business_service_organization_scope.down.sql'), 'utf8');
    await getMigrationStatus(migratorClient, MIGRATIONS); // ensures cmdb.schema_migrations
    await db.exec(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
      VALUES ('008_business_service_organization_scope.sql', 'x') ON CONFLICT DO NOTHING`);
    try {
      await db.exec(down);

      expect(await db.rows(`SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dim_business_services' AND column_name = 'organization_id'`)).toEqual([]);
      expect(await db.rows(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_dim_business_services_organization'`)).toEqual([]);
      expect(await db.rows(`SELECT 1 FROM cmdb.schema_migrations
        WHERE migration_name = '008_business_service_organization_scope.sql'`)).toEqual([]);
      // A pre-008 API's org-less insert works again.
      await db.exec(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
        business_criticality, operational_status) VALUES ('bs-pre-008', 'Pre', 'compute', 'compute', 'low', 'active')`);
    } finally {
      await db.exec(up);
    }
    expect(await orgOf('bs-pre-008')).toBe(INTERNAL_ORG);
  });
});

describe('migration 011_ci_organization_scope', () => {
  it('migration 011 backfills existing dim_ci rows to the internal org', async () => {
    // Every SCD version of a legacy CI, current or not, marked as a backfill label.
    expect(ciBackfilled).toEqual([
      { ci_name: 'Legacy CI (v1)', organization_id: INTERNAL_ORG, org_backfilled: true },
      { ci_name: 'Legacy CI', organization_id: INTERNAL_ORG, org_backfilled: true },
    ]);
    // NOT NULL with no default: a writer that names no organization fails.
    const [column] = await db.rows<{ is_nullable: string; column_default: string | null; data_type: string }>(
      `SELECT is_nullable, column_default, data_type FROM information_schema.columns
       WHERE table_schema = 'cmdb' AND table_name = 'dim_ci' AND column_name = 'organization_id'`
    );
    expect(column).toEqual({ is_nullable: 'NO', column_default: null, data_type: 'uuid' });
    await expect(db.exec(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status)
      VALUES ('ci-orphan', 'Orphan', 'server', 'active')`)).rejects.toThrow(/organization_id/);
    // Rows written after 011 are never marked as backfill labels.
    await db.exec(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, organization_id)
      VALUES ('ci-post-011', 'Post', 'server', 'active', '${INTERNAL_ORG}')`);
    expect(await db.rows(`SELECT org_backfilled FROM cmdb.dim_ci WHERE ci_id = 'ci-post-011'`))
      .toEqual([{ org_backfilled: false }]);
  });

  it('migrator discovers 011 and not the rollback file', async () => {
    // Real migrator discovery over the real directory.
    const names = (await getMigrationStatus(migratorClient, MIGRATIONS)).map(m => m._name);
    expect(names.indexOf('011_ci_organization_scope.sql'))
      .toBe(names.indexOf('010_business_service_views_org_functions.sql') + 1);
    expect(names.filter(name => /down|rollback/.test(name))).toEqual([]);
  });

  it('rollback/011 restores 010 state', async () => {
    const down = readFileSync(join(MIGRATIONS, 'rollback/011_ci_organization_scope.down.sql'), 'utf8');
    await getMigrationStatus(migratorClient, MIGRATIONS); // ensures cmdb.schema_migrations
    await db.exec(`INSERT INTO cmdb.schema_migrations (migration_name, checksum)
      VALUES ('011_ci_organization_scope.sql', 'x') ON CONFLICT DO NOTHING`);
    try {
      await db.exec(down);

      expect(await dimCiSchema()).toEqual(dimCiSchemaBefore011);
      expect(await db.rows(`SELECT 1 FROM cmdb.schema_migrations
        WHERE migration_name = '011_ci_organization_scope.sql'`)).toEqual([]);
      // A pre-011 writer's org-less insert works again.
      await db.exec(`INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status)
        VALUES ('ci-pre-011', 'Pre', 'server', 'active')`);
    } finally {
      await db.exec(`BEGIN;\n${UP_011}\nCOMMIT;`);
    }
    // 011 re-applies over the rolled-back table, every row in the internal organization.
    expect(await db.rows(`SELECT DISTINCT organization_id FROM cmdb.dim_ci`)).toEqual([{ organization_id: INTERNAL_ORG }]);
  });
});

describe('fail closed without an organization claim', () => {
  const noClaim = bearer('user-none');
  const malformedClaim = bearer('user-bad');
  // Fixed arity: a shorter row would make jest pass `done` as the body.
  const ROUTES: Array<[string, string, object | null]> = [
    ['get', '/api/v1/business-services', null],
    ['get', '/api/v1/business-services/bs-a-app', null],
    ['get', '/api/v1/business-services/bs-a-app/cis', null],
    ['get', '/api/v1/business-services/bs-a-app/dependencies', null],
    ['get', '/api/v1/business-services/bs-a-app/health', null],
    ['get', '/api/v1/business-services/bs-a-app/costs', null],
    ['post', '/api/v1/business-services', {
      service_id: 'bs-new', name: 'New One', service_classification: 'compute', tbm_tower: 'compute', business_criticality: 'low',
    }],
    ['patch', '/api/v1/business-services/bs-a-app', { name: 'Renamed' }],
    ['delete', '/api/v1/business-services/bs-a-app', null],
    ['post', '/api/v1/business-services/bs-a-app/cis', { ci_ids: ['ci-x'] }],
    ['delete', '/api/v1/business-services/bs-a-app/cis/ci-a', null],
    ['post', '/api/v1/business-services/bs-a-app/dependencies', { depends_on_service_id: 'bs-a-empty' }],
    ['delete', '/api/v1/business-services/bs-a-app/dependencies/bs-a-db', null],
    ['get', '/api/v1/architecture/business-services/bs-a-empty/analysis', null],
  ];

  it.each(ROUTES)('%s %s -> 403 before any data access (JWT without claim, malformed claim, API key)', async (method, path, body) => {
    const apiKeyHeader = { [loadConfig().auth.apiKeys.headerName]: API_KEY_NONE };
    for (const headers of [noClaim, malformedClaim, apiKeyHeader]) {
      const req = request(app)[method as 'get'](path).set(headers);
      const res = await (body === null ? req : req.send(body));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ _error: 'Forbidden', _message: 'Organization claim required' });
    }
    expect(queryCount).toBe(0);
    expect(await count('dim_business_services')).toBe(5);
  });
});

describe('two-organization isolation', () => {
  describe.each(['', '/cis', '/dependencies', '/health', '/costs'])('GET /api/v1/business-services/:id%s', suffix => {
    it("returns exactly the missing-service 404 for another organization's service", async () => {
      const foreign = await request(app).get(`/api/v1/business-services/bs-a-app${suffix}`).set(AS_B);
      const missing = await request(app).get(`/api/v1/business-services/bs-missing${suffix}`).set(AS_B);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(NOT_FOUND);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual(foreign.body);
    });

    it('serves the owning organization', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-a-app${suffix}`).set(AS_A);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  it('lists and counts only the caller organization, including under filters', async () => {
    const a = await request(app).get('/api/v1/business-services').set(AS_A);
    expect(a.body.data.map((s: { service_id: string }) => s.service_id)).toEqual(['bs-a-empty', 'bs-a-app', 'bs-a-db']);
    expect(a.body.pagination.total).toBe(3);

    const b = await request(app).get('/api/v1/business-services?business_criticality=critical').set(AS_B);
    expect(b.body.data.map((s: { service_id: string }) => s.service_id)).toEqual(['bs-b-db']);
    expect(b.body.pagination.total).toBe(1);

    const search = await request(app).get('/api/v1/business-services?search=Secret').set(AS_A);
    expect(search.body).toMatchObject({ data: [], pagination: { total: 0 } });
  });

  it("returns the owner's rows with the owner's organization_id", async () => {
    const res = await request(app).get('/api/v1/business-services/bs-b-app').set(AS_B);
    expect(res.body.data).toMatchObject({ service_id: 'bs-b-app', organization_id: ORG_B, mapped_cis_count: 1, dependencies_count: 1 });
  });

  it("returns only the owner's child rows and metrics", async () => {
    const cis = await request(app).get('/api/v1/business-services/bs-b-app/cis').set(AS_B);
    expect(cis.body.data.map((m: { ci_id: string }) => m.ci_id)).toEqual(['ci-b']);
    const health = await request(app).get('/api/v1/business-services/bs-a-app/health').set(AS_A);
    expect(health.body.data.incidents).toMatchObject({ incidents_7d: 3 });
    const costs = await request(app).get('/api/v1/business-services/bs-a-app/costs').set(AS_A);
    expect(costs.body.data).toMatchObject({ ci_count: 1, total_monthly_cost: '100' });
  });

  it("serves #26's weighted MTTR, zero-default SLA and deduplicated costs per organization", async () => {
    // ci-shared is mapped into org A twice (two mapping types).
    await db.exec(`
      INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES
        ('bs-a-app', CURRENT_DATE - 10, 7, 90, 2),
        ('bs-b-app', CURRENT_DATE - 5, 100, 10, 5);
      INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES
        ('ci-shared', 'bs-a-app', 'supports'), ('ci-shared', 'bs-a-app', 'enables');
      INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, tbm_attributes, is_current, organization_id) VALUES
        ('ci-shared', 'Shared', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 50}', TRUE, '${INTERNAL_ORG}');`);
    const get = async (headers: object, path: string) => {
      const res = await request(app).get(`/api/v1/business-services/${path}`).set(headers);
      return [res.status, res.body.data ?? res.body];
    };

    // Weighted by incident_count: A (3*30 + 7*90) / 10 = 72; B (900*1000 + 100*10) / 1000 = 901.
    expect(await get(AS_A, 'bs-a-app/health')).toEqual([200, expect.objectContaining({
      incidents: { incidents_7d: 3, incidents_30d: 10, avg_mttr_30d: 72, sla_breaches_30d: 3 },
    })]);
    expect(await get(AS_B, 'bs-b-app/health')).toEqual([200, expect.objectContaining({
      incidents: { incidents_7d: 1000, incidents_30d: 1000, avg_mttr_30d: 901, sla_breaches_30d: 45 },
    })]);
    // Empty window: 0 breaches for A even though B's services have breaches.
    expect(await get(AS_A, 'bs-a-empty/health')).toEqual([200, expect.objectContaining({
      incidents: { incidents_7d: 0, incidents_30d: 0, avg_mttr_30d: null, sla_breaches_30d: 0 },
    })]);

    // ci-shared costs once, and each organization's costs count only its own CIs.
    expect(await get(AS_A, 'bs-a-app/costs'))
      .toEqual([200, { ci_count: 2, total_monthly_cost: '150', cost_by_tower: { compute: 150 } }]);
    expect(await get(AS_B, 'bs-b-app/costs'))
      .toEqual([200, { ci_count: 1, total_monthly_cost: '7', cost_by_tower: { compute: 7 } }]);

    for (const metric of ['health', 'costs']) {
      expect(await get(AS_B, `bs-a-app/${metric}`)).toEqual([404, NOT_FOUND]);
    }
  });

  it('mapping an org B CI into an org A service is 404 and writes nothing', async () => {
    // A stale cross-org mapping row (from before CI scoping): re-posting it is
    // an update through ON CONFLICT and must be refused the same way.
    await db.exec(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type, confidence_score)
      VALUES ('ci-b', 'bs-a-app', 'hosts', 1)`);
    const mappings = () => db.rows(
      'SELECT ci_id, service_id, mapping_type, confidence_score, updated_at FROM ci_business_service_mappings ORDER BY id'
    );
    const before = await mappings();
    const post = (body: object) => request(app).post('/api/v1/business-services/bs-a-app/cis').set(AS_A).send(body);

    const CI_NOT_FOUND = { success: false, error: 'CI not found' };
    for (const body of [
      { ci_ids: ['ci-b'] },
      // One foreign CI refuses the whole request, including the caller's own CI.
      { ci_ids: ['ci-a2', 'ci-b'] },
      { ci_ids: ['ci-b'], mapping_type: 'hosts', confidence_score: 0.1 },
    ]) {
      const res = await post(body);
      expect([res.status, res.body]).toEqual([404, CI_NOT_FOUND]);
    }
    expect(await mappings()).toEqual(before);
    // The same body as a CI that does not exist anywhere.
    const missing = await post({ ci_ids: ['ci-missing'] });
    expect([missing.status, missing.body]).toEqual([404, CI_NOT_FOUND]);
  });

  it('/costs excludes a CI owned by another org even if a stale mapping row exists', async () => {
    await db.exec(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type)
      VALUES ('ci-b', 'bs-a-app', 'supports')`);
    const res = await request(app).get('/api/v1/business-services/bs-a-app/costs').set(AS_A);
    expect([res.status, res.body.data]).toEqual([200, { ci_count: 1, total_monthly_cost: '100', cost_by_tower: { compute: 100 } }]);
  });

  it('never joins a dependency target from another organization', async () => {
    // A cross-org edge can only exist from before scoping; the read must not surface it.
    await db.exec(`INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
      VALUES ('bs-a-app', 'bs-b-db', 'data')`);
    const res = await request(app).get('/api/v1/business-services/bs-a-app/dependencies').set(AS_A);
    expect(res.body.data.map((d: { depends_on_service_id: string }) => d.depends_on_service_id)).toEqual(['bs-a-db']);
    expect(JSON.stringify(res.body)).not.toContain('B Secret Database');
  });

  it("cannot update, delete or re-parent children of another organization's service", async () => {
    const attempts = [
      request(app).patch('/api/v1/business-services/bs-a-app').set(AS_B).send({ name: 'Hijacked' }),
      request(app).delete('/api/v1/business-services/bs-a-app').set(AS_B),
      request(app).post('/api/v1/business-services/bs-a-app/cis').set(AS_B).send({ ci_ids: ['ci-b'] }),
      request(app).post('/api/v1/business-services/bs-a-app/dependencies').set(AS_B).send({ depends_on_service_id: 'bs-a-db' }),
      // Own parent, foreign target: still unknown to B.
      request(app).post('/api/v1/business-services/bs-b-app/dependencies').set(AS_B).send({ depends_on_service_id: 'bs-a-db' }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }

    const unmap = await request(app).delete('/api/v1/business-services/bs-a-app/cis/ci-a').set(AS_B);
    const undepend = await request(app).delete('/api/v1/business-services/bs-a-app/dependencies/bs-a-db').set(AS_B);
    expect([unmap.status, unmap.body]).toEqual([404, { success: false, error: 'CI mapping not found' }]);
    expect([undepend.status, undepend.body]).toEqual([404, { success: false, error: 'Dependency not found' }]);

    const [row] = await db.rows<{ name: string }>(`SELECT name FROM dim_business_services WHERE service_id = 'bs-a-app'`);
    expect(row?.name).toBe('A App');
    expect(await count(`ci_business_service_mappings WHERE service_id = 'bs-a-app'`)).toBe(1);
    expect(await count(`business_service_dependencies WHERE service_id IN ('bs-a-app', 'bs-b-app')`)).toBe(2);
  });

  it('lets the owner write its own services and children', async () => {
    const patch = await request(app).patch('/api/v1/business-services/bs-b-app').set(AS_B).send({ name: 'B App v2' });
    expect(patch.status).toBe(200);
    const map = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B).send({ ci_ids: ['ci-b2', 'ci-b3'] });
    expect(map.status).toBe(201);
    expect(map.body.data.map((m: { ci_id: string }) => m.ci_id).sort()).toEqual(['ci-b2', 'ci-b3']);
    const unmap = await request(app).delete('/api/v1/business-services/bs-b-app/cis/ci-b').set(AS_B);
    expect(unmap.status).toBe(200);
    const dep = await request(app).delete('/api/v1/business-services/bs-b-app/dependencies/bs-b-db').set(AS_B);
    expect(dep.status).toBe(200);
    const redo = await request(app).post('/api/v1/business-services/bs-b-app/dependencies').set(AS_B)
      .send({ depends_on_service_id: 'bs-b-db' });
    expect(redo.status).toBe(201);
    const self = await request(app).post('/api/v1/business-services/bs-b-app/dependencies').set(AS_B)
      .send({ depends_on_service_id: 'bs-b-app' });
    expect(self.status).toBe(400);
    const del = await request(app).delete('/api/v1/business-services/bs-b-db').set(AS_B);
    expect(del.status).toBe(200);
    expect(await orgOf('bs-b-db')).toBeUndefined();
  });

  it('scopes the API-key path to the key owner organization', async () => {
    const headers = { [loadConfig().auth.apiKeys.headerName]: API_KEY_B };
    const list = await request(app).get('/api/v1/business-services').set(headers);
    expect(list.body.data.map((s: { service_id: string }) => s.service_id)).toEqual(['bs-b-app', 'bs-b-db']);
    const foreign = await request(app).get('/api/v1/business-services/bs-a-app').set(headers);
    expect(foreign.status).toBe(404);
  });

  it('scopes the architecture analysis to the caller organization', async () => {
    const foreign = await request(app).get('/api/v1/architecture/business-services/bs-a-empty/analysis').set(AS_B);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(NOT_FOUND);
    const own = await request(app).get('/api/v1/architecture/business-services/bs-a-empty/analysis').set(AS_A);
    expect(own.status).toBe(200);
    expect(own.body.analysis).toMatchObject({ business_service_id: 'bs-a-empty', business_service_name: 'A Empty' });
  });
});

describe('writes take the organization from the token only', () => {
  const NEW_SERVICE = {
    service_id: 'bs-b-new', name: 'B New', service_classification: 'compute', tbm_tower: 'compute', business_criticality: 'low',
  };

  it("creates the service in the caller's organization", async () => {
    const res = await request(app).post('/api/v1/business-services').set(AS_B).send(NEW_SERVICE);
    expect(res.status).toBe(201);
    expect(res.body.data.organization_id).toBe(ORG_B);
    expect(await orgOf('bs-b-new')).toBe(ORG_B);
  });

  it("cannot take over another organization's service_id through create", async () => {
    const res = await request(app).post('/api/v1/business-services').set(AS_B).send({ ...NEW_SERVICE, service_id: 'bs-a-app' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: 'Business service with this ID already exists' });
    const [row] = await db.rows<{ name: string; organization_id: string }>(
      `SELECT name, organization_id FROM dim_business_services WHERE service_id = 'bs-a-app'`
    );
    expect(row).toEqual({ name: 'A App', organization_id: INTERNAL_ORG });
  });

  it('rejects organization_id in a create body and writes nothing', async () => {
    const res = await request(app).post('/api/v1/business-services').set(AS_B).send({ ...NEW_SERVICE, organization_id: INTERNAL_ORG });
    expect(res.status).toBe(400);
    expect(res.body._details).toEqual([expect.objectContaining({ _field: 'organization_id', _type: 'any.unknown' })]);
    expect(await orgOf('bs-b-new')).toBeUndefined();
  });

  it('rejects organization_id in an update body and leaves the tenant unchanged', async () => {
    const res = await request(app).patch('/api/v1/business-services/bs-b-app').set(AS_B)
      .send({ name: 'Moved', organization_id: INTERNAL_ORG });
    expect(res.status).toBe(400);
    expect(await orgOf('bs-b-app')).toBe(ORG_B);
    const a = await request(app).get('/api/v1/business-services/bs-b-app').set(AS_A);
    expect(a.status).toBe(404);
  });
});

describe('POST /cis rejects ci_ids the mapping table cannot hold', () => {
  it('POST /cis with duplicate ci_ids is 400 and writes nothing', async () => {
    const res = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B)
      .send({ ci_ids: ['ci-b2', 'ci-b2'] });
    expect(res.status).toBe(400);
    expect(res.body._details).toEqual([expect.objectContaining({ _field: 'ci_ids.1', _type: 'array.unique' })]);
    expect(await count(`ci_business_service_mappings WHERE service_id = 'bs-b-app'`)).toBe(1);
  });

  it('POST /cis with a 101-char ci_id is 400', async () => {
    const res = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B)
      .send({ ci_ids: ['ci-b2', 'c'.repeat(101)] });
    expect(res.status).toBe(400);
    expect(res.body._details).toEqual([expect.objectContaining({ _field: 'ci_ids.1', _type: 'string.max' })]);
    expect(await count(`ci_business_service_mappings WHERE service_id = 'bs-b-app'`)).toBe(1);
  });

  it('POST /cis with a NUL character in a ci_id is 400 and writes nothing', async () => {
    const res = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B)
      .send({ ci_ids: ['ci-\u0000'] });
    expect(res.status).toBe(400);
    expect(res.body._details).toEqual([expect.objectContaining({ _field: 'ci_ids.0', _type: 'string.pattern.base' })]);
    expect(await count(`ci_business_service_mappings WHERE service_id = 'bs-b-app'`)).toBe(1);
  });

  it('POST /cis measures the 100 limit in characters, not UTF-16 units', async () => {
    // U+1F600 is one character (one PostgreSQL VARCHAR position) but two UTF-16 units.
    const longest = '\u{1F600}'.repeat(100);
    const ok = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B).send({ ci_ids: [longest] });
    expect(ok.status).toBe(201);
    expect(await db.rows(`SELECT ci_id FROM ci_business_service_mappings WHERE service_id = 'bs-b-app' AND ci_id <> 'ci-b'`))
      .toEqual([{ ci_id: longest }]);

    const over = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B)
      .send({ ci_ids: [`${longest}\u{1F600}`] });
    expect(over.status).toBe(400);
    expect(over.body._details).toEqual([expect.objectContaining({ _field: 'ci_ids.0', _type: 'string.max' })]);
  });

  it('POST /cis with distinct unpaired surrogates is 400 and writes nothing', async () => {
    // Distinct in JS, but UTF-8 encoding turns both into U+FFFD: the same stored ci_id.
    const res = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B)
      .send({ ci_ids: ['ci-\ud800', 'ci-\udbff'] });
    expect(res.status).toBe(400);
    expect(res.body._details).toEqual([expect.objectContaining({ _field: 'ci_ids.0', _type: 'string.pattern.base' })]);
    expect(await count(`ci_business_service_mappings WHERE service_id = 'bs-b-app'`)).toBe(1);
  });

  it('POST /cis with thousands of non-string ci_ids stops at the first bad item', async () => {
    // Validation must stop at ci_ids[0]: if it went on, Joi's .unique() would
    // also run, comparing non-string items pairwise (quadratic in the count).
    const ci_ids = Array.from({ length: 5000 }, (_, i) => [i]);
    const res = await request(app).post('/api/v1/business-services/bs-b-app/cis').set(AS_B).send({ ci_ids });
    expect(res.status).toBe(400);
    expect(res.body._details).toEqual([expect.objectContaining({ _field: 'ci_ids.0', _type: 'string.base' })]);
  });
});

describe('the tenant is re-read from the user record on every request', () => {
  const userA = USERS['user-a']!;

  it("moves an already-issued token with its user's organization", async () => {
    try {
      userA._organizationId = ORG_B;
      const own = await request(app).get('/api/v1/business-services/bs-a-app').set(AS_A);
      expect([own.status, own.body]).toEqual([404, NOT_FOUND]);
      const list = await request(app).get('/api/v1/business-services').set(AS_A);
      expect(list.body.data.map((s: { service_id: string }) => s.service_id)).toEqual(['bs-b-app', 'bs-b-db']);

      delete userA._organizationId;
      const removed = await request(app).get('/api/v1/business-services').set(AS_A);
      expect(removed.status).toBe(403);
    } finally {
      userA._organizationId = INTERNAL_ORG;
    }
  });

  it('rejects a refresh token presented as a bearer token', async () => {
    const refresh = jwt.generateRefreshToken('user-a', 'alice', 'operator');
    const res = await request(app).get('/api/v1/business-services/bs-a-app').set({ Authorization: `Bearer ${refresh}` });
    expect(res.status).toBe(401);
    expect(queryCount).toBe(0);
  });
});

describe('parent and children are read in one org-filtered snapshot', () => {
  // Right after the request reads bs-a-empty (org A, no children), org B
  // deletes it and recreates the same global service_id with its own children.
  const recreateAsOrgB = () => db.exec(`
    DELETE FROM dim_business_services WHERE service_id = 'bs-a-empty';
    INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
      operational_status, organization_id) VALUES ('bs-a-empty', 'B Takeover', 'data', 'data', 'critical', 'active', '${ORG_B}');
    INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES ('ci-b-secret', 'bs-a-empty', 'hosts');
    INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
      VALUES ('bs-a-empty', 'bs-b-db', 'data');`);

  it("GET /:id never counts another organization's children", async () => {
    afterParentRead = recreateAsOrgB;
    const res = await request(app).get('/api/v1/business-services/bs-a-empty').set(AS_A);
    expect(afterParentRead).toBeNull(); // the interleave ran
    expect(await orgOf('bs-a-empty')).toBe(ORG_B);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'A Empty', organization_id: INTERNAL_ORG, mapped_cis_count: 0, dependencies_count: 0,
    });
  });

  it("the architecture analysis never analyzes another organization's CIs", async () => {
    afterParentRead = recreateAsOrgB;
    const res = await request(app).get('/api/v1/architecture/business-services/bs-a-empty/analysis').set(AS_A);
    expect(afterParentRead).toBeNull();
    expect(res.status).toBe(200);
    expect(res.body.analysis).toMatchObject({
      business_service_name: 'A Empty', dependency_graph_summary: { total_cis: 0 },
    });
  });
});

describe('failures: generic 500 body, diagnostics in the server log', () => {
  it('logs name/message/code/stack but returns no driver text', async () => {
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    await db.exec('ALTER TABLE ci_business_service_mappings RENAME TO ci_business_service_mappings_offline');
    try {
      const res = await request(app).get('/api/v1/business-services/bs-a-app/cis').set(AS_A);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'Failed to get mapped CIs' });

      expect(logged).toHaveBeenCalledWith('Error getting mapped CIs', {
        service_id: 'bs-a-app',
        error: {
          name: 'Error',
          message: expect.stringMatching(/ci_business_service_mappings.*does not exist/),
          code: '42P01',
          stack: expect.stringContaining('does not exist'),
        },
      });
    } finally {
      await db.exec('ALTER TABLE ci_business_service_mappings_offline RENAME TO ci_business_service_mappings');
    }
  });
});
