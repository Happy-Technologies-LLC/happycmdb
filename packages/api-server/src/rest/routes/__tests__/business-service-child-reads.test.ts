// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Missing-parent semantics for GET /api/v1/business-services/:service_id/cis,
 * /dependencies, /health and /costs, exercised through the real
 * businessServiceRoutes behind the real AuthMiddleware/AuthService (JWT
 * verification) mounted at the production path.
 *
 * SQL is executed by PGlite (PostgreSQL compiled to WASM) hosted in a forked
 * child process (fixtures/pglite-host.cjs). Its
 * schema is `CREATE SCHEMA IF NOT EXISTS cmdb;` plus the CREATE TABLE
 * statements read verbatim from
 * packages/database/src/postgres/migrations/001_complete_schema.sql
 * (dim_business_services, business_service_dependencies,
 * ci_business_service_mappings, fact_business_service_incidents,
 * fact_business_service_changes, cmdb.dim_ci); no other tables, indexes or
 * extensions. PGlite has no TimescaleDB, so only the CREATE TABLE blocks are
 * extracted (not create_hypertable) and the two fact tables are plain tables.
 *
 * Substitutions: Neo4jAuthRepository -> in-memory user store (one enabled
 * viewer user); getPostgresClient -> IPC client to that PGlite process;
 * TimescaleDB hypertables -> plain PostgreSQL tables.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
Object.assign(process.env, {
  JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters-long',
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const db = { exec: (sql: string) => send('exec', sql) };

let queryCount = 0;
const pgClient = {
  // Plain function (not jest.fn): the unit config resets mock implementations.
  query: async (sql: string, params: unknown[] = []) => {
    queryCount++;
    return { rows: await send('query', sql, params) };
  },
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => pgClient,
  getNeo4jClient: () => ({}),
  getAuditService: () => ({}),
}));

// bcrypt's native binding is only used for password hashing/login, which the
// JWT verification path exercised here never calls.
jest.mock('bcrypt', () => ({}));

const VIEWER_ID = 'viewer-user-1';
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) =>
      userId === VIEWER_ID
        ? { _id: VIEWER_ID, _username: 'viewer', _role: 'viewer', _enabled: true }
        : null,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { businessServiceRoutes } from '../business-service.routes';

const MIGRATION = join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql');
const DDL_TABLES = [
  'dim_business_services',
  'business_service_dependencies',
  'ci_business_service_mappings',
  'fact_business_service_incidents',
  'fact_business_service_changes',
  'cmdb.dim_ci',
];
const NOT_FOUND = { success: false, error: 'Business service not found' };

function productionDdl(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  return 'CREATE SCHEMA IF NOT EXISTS cmdb;\n' + DDL_TABLES.map(table => {
    const name = table.replace('.', '\\.');
    const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in ${MIGRATION}`);
    return match[0];
  }).join('\n');
}

const SEED = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status) VALUES
  ('bs-empty', 'Empty', 'compute', 'compute', 'low', 'active'),
  ('bs-app', 'App', 'application', 'application', 'high', 'active'),
  ('bs-db', 'Database Tier', 'data', 'data', 'critical', 'active'),
  ('bs-net', 'Network', 'network', 'network', 'medium', 'active'),
  ('bs-other', 'Other', 'security', 'security', 'low', 'active');
INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type, confidence_score, created_at) VALUES
  ('ci-old', 'bs-app', 'hosts', 0.5, '2026-01-01 00:00:00'),
  ('ci-new', 'bs-app', 'supports', 1, '2026-02-01 00:00:00'),
  ('ci-foreign', 'bs-other', 'hosts', 1, '2026-03-01 00:00:00');
INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type, created_at) VALUES
  ('bs-app', 'bs-net', 'infrastructure', '2026-01-01 00:00:00'),
  ('bs-app', 'bs-db', 'platform', '2026-02-01 00:00:00'),
  ('bs-other', 'bs-db', 'application', '2026-03-01 00:00:00');
INSERT INTO fact_business_service_incidents (service_id, incident_date, mttr_minutes, sla_breaches) VALUES
  ('bs-app', CURRENT_DATE - 1, 30, 1),
  ('bs-app', CURRENT_DATE - 10, 90, 2),
  ('bs-app', CURRENT_DATE - 60, 500, 9),
  ('bs-other', CURRENT_DATE - 3, 1000, 40);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-app', CURRENT_DATE - 2, 4, 3),
  ('bs-app', CURRENT_DATE - 20, 6, 6),
  ('bs-app', CURRENT_DATE - 90, 10, 1),
  ('bs-other', CURRENT_DATE - 3, 8, 0);
INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, tbm_attributes, is_current) VALUES
  ('ci-new', 'New', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 100}', TRUE),
  ('ci-new', 'New (historical)', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 999}', FALSE),
  ('ci-old', 'Old', 'storage', 'active', '{"resource_tower": "storage", "monthly_cost": 50.5}', TRUE),
  ('ci-foreign', 'Foreign', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 7}', TRUE);
`;

const CHILD_TABLE: Record<string, string> = {
  cis: 'ci_business_service_mappings',
  dependencies: 'business_service_dependencies',
};

// PGlite parses TIMESTAMP (without time zone) as UTC; the expectations below
// are the JSON serialisation of those Date values.
const APP_CIS = [
  { ci_id: 'ci-new', mapping_type: 'supports', confidence_score: 1, created_at: '2026-02-01T00:00:00.000Z' },
  { ci_id: 'ci-old', mapping_type: 'hosts', confidence_score: 0.5, created_at: '2026-01-01T00:00:00.000Z' },
];
const APP_DEPENDENCIES = [
  {
    depends_on_service_id: 'bs-db', depends_on_name: 'Database Tier', service_classification: 'data',
    business_criticality: 'critical', dependency_type: 'platform', created_at: '2026-02-01T00:00:00.000Z',
  },
  {
    depends_on_service_id: 'bs-net', depends_on_name: 'Network', service_classification: 'network',
    business_criticality: 'medium', dependency_type: 'infrastructure', created_at: '2026-01-01T00:00:00.000Z',
  },
];
const APP_CHILDREN: Record<string, unknown[]> = { cis: APP_CIS, dependencies: APP_DEPENDENCIES };

function buildApp() {
  // Mirrors server.ts: authenticate once on /api/v1, then the router.
  const app = express();
  app.use(express.json());
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
  return app;
}

// File-scope lifecycle: both describe blocks share one PGlite process, so the
// schema is created once and the host is killed only after the last block.
beforeAll(async () => {
  await db.exec(productionDdl());
});

afterAll(() => {
  host.kill();
});

describe('business-service child reads: missing-parent semantics (PGlite)', () => {
  const app = buildApp();
  const token = new JWTService(loadConfig().auth.jwt).generateAccessToken(VIEWER_ID, 'viewer', 'viewer');
  const auth = { Authorization: `Bearer ${token}` };

  beforeEach(async () => {
    await db.exec(`TRUNCATE ${DDL_TABLES.join(', ')} RESTART IDENTITY CASCADE;${SEED}`);
    queryCount = 0;
  });

  describe.each(['cis', 'dependencies'])('GET /api/v1/business-services/:service_id/%s', child => {
    it('returns 404 with the parent envelope for an unknown service', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-missing/${child}`).set(auth);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    });

    it('returns 200 with data [] for an existing service without children', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-empty/${child}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: [] });
    });

    it('returns only the service\'s own children with the pre-change projection, newest first', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-app/${child}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: APP_CHILDREN[child] });
    });

    it('rejects anonymous requests with 401 before any data access', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-app/${child}`);
      expect(res.status).toBe(401);
      expect(queryCount).toBe(0);
    });

    it('surfaces an engine failure as 500, not an empty 200', async () => {
      await db.exec(`ALTER TABLE ${CHILD_TABLE[child]} RENAME TO ${CHILD_TABLE[child]}_offline`);
      try {
        const res = await request(app).get(`/api/v1/business-services/bs-app/${child}`).set(auth);
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/does not exist/);
      } finally {
        await db.exec(`ALTER TABLE ${CHILD_TABLE[child]}_offline RENAME TO ${CHILD_TABLE[child]}`);
      }
    });

    it('treats injection-shaped ids as unknown services and leaves data intact', async () => {
      for (const hostile of ["bs-app' OR '1'='1", `bs-app'; DROP TABLE ${CHILD_TABLE[child]}; --`]) {
        const res = await request(app)
          .get(`/api/v1/business-services/${encodeURIComponent(hostile)}/${child}`)
          .set(auth);
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      const res = await request(app).get(`/api/v1/business-services/bs-app/${child}`).set(auth);
      expect(res.body).toEqual({ success: true, data: APP_CHILDREN[child] });
    });
  });
});

// Driver serialisation, observed in HAP-187 validation (docs/archive/HAP-187-validation.md):
// through PGlite, int8 COUNT/SUM arrive as JS numbers, AVG/ratio values as
// numbers, NUMERIC total_monthly_cost as the string '150.5', and json
// cost_by_tower as a parsed object.
const EMPTY_METRICS: Record<string, unknown> = {
  health: {
    incidents: { incidents_7d: 0, incidents_30d: 0, avg_mttr_30d: null, sla_breaches_30d: null },
    changes: { changes_7d: 0, changes_30d: 0, success_rate_30d: null },
  },
  costs: { ci_count: 0, total_monthly_cost: null, cost_by_tower: null },
};
const APP_METRICS: Record<string, unknown> = {
  // COUNT(*) counts daily fact rows and success_rate_30d is an all-time ratio
  // (no date filter): pre-existing semantics, preserved here on purpose.
  health: {
    incidents: { incidents_7d: 1, incidents_30d: 2, avg_mttr_30d: 60, sla_breaches_30d: 3 },
    changes: { changes_7d: 1, changes_30d: 2, success_rate_30d: 50 },
  },
  // The non-current ci-new row (999) and bs-other's ci-foreign are excluded.
  costs: { ci_count: 2, total_monthly_cost: '150.5', cost_by_tower: { compute: 100, storage: 50.5 } },
};
const METRIC_TABLE: Record<string, string> = {
  health: 'fact_business_service_incidents',
  costs: 'ci_business_service_mappings',
};

describe('business-service metric reads: missing-parent semantics (PGlite)', () => {
  const app = buildApp();
  const token = new JWTService(loadConfig().auth.jwt).generateAccessToken(VIEWER_ID, 'viewer', 'viewer');
  const auth = { Authorization: `Bearer ${token}` };

  beforeEach(async () => {
    await db.exec(`TRUNCATE ${DDL_TABLES.join(', ')} RESTART IDENTITY CASCADE;${SEED}`);
    queryCount = 0;
  });

  describe.each(['health', 'costs'])('GET /api/v1/business-services/:service_id/%s', metric => {
    it('returns 404 with the parent envelope for an unknown service', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-missing/${metric}`).set(auth);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    });

    it('returns 200 with zero/null metrics for an existing service without data', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-empty/${metric}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: EMPTY_METRICS[metric] });
    });

    it('returns only the service\'s own metrics with the pre-change expressions', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`).set(auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: APP_METRICS[metric] });
    });

    it('rejects anonymous requests with 401 before any data access', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`);
      expect(res.status).toBe(401);
      expect(queryCount).toBe(0);
    });

    it('surfaces an engine failure as 500, not an empty 200', async () => {
      await db.exec(`ALTER TABLE ${METRIC_TABLE[metric]} RENAME TO ${METRIC_TABLE[metric]}_offline`);
      try {
        const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`).set(auth);
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/does not exist/);
      } finally {
        await db.exec(`ALTER TABLE ${METRIC_TABLE[metric]}_offline RENAME TO ${METRIC_TABLE[metric]}`);
      }
    });

    it('treats injection-shaped ids as unknown services and leaves data intact', async () => {
      for (const hostile of ["bs-app' OR '1'='1", `bs-app'; DROP TABLE ${METRIC_TABLE[metric]}; --`]) {
        const res = await request(app)
          .get(`/api/v1/business-services/${encodeURIComponent(hostile)}/${metric}`)
          .set(auth);
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND);
      }
      const res = await request(app).get(`/api/v1/business-services/bs-app/${metric}`).set(auth);
      expect(res.body).toEqual({ success: true, data: APP_METRICS[metric] });
    });
  });
});
