// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Missing-parent semantics for GET /api/v1/business-services/:service_id/cis
 * and /dependencies, exercised through the real businessServiceRoutes behind
 * the real AuthMiddleware/AuthService (JWT verification) mounted at the
 * production path.
 *
 * Substitutions (no live Neo4j/PostgreSQL in this suite):
 * - Neo4jAuthRepository -> in-memory user store (one enabled viewer user).
 * - getPostgresClient -> in-memory tables evaluating the controller's SQL
 *   shapes with real LEFT/INNER JOIN semantics and $1 binding. Unknown SQL
 *   throws, so an unrecognised query cannot silently produce rows.
 */

import express from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no client connects (DB access is substituted).
Object.assign(process.env, {
  JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters-long',
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

type Row = Record<string, unknown>;
const tables = {
  dim_business_services: [] as Row[],
  ci_business_service_mappings: [] as Row[],
  business_service_dependencies: [] as Row[],
};
const queryLog: string[] = [];
const paramLog: unknown[][] = [];
let failNextQuery = false;

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const byCreatedDesc = (a: Row, b: Row) =>
  (b.created_at as Date).getTime() - (a.created_at as Date).getTime();

function evaluate(sql: string, params: unknown[]): Row[] {
  const s = norm(sql);
  const id = params[0];
  const parent = tables.dim_business_services.filter(p => p.service_id === id);
  const mappings = () =>
    tables.ci_business_service_mappings
      .filter(m => m.service_id === id)
      .sort(byCreatedDesc)
      .map(m => ({ ci_id: m.ci_id, mapping_type: m.mapping_type, confidence_score: m.confidence_score, created_at: m.created_at }));
  const deps = () =>
    tables.business_service_dependencies
      .filter(d => d.service_id === id)
      .flatMap(d => {
        const t = tables.dim_business_services.find(x => x.service_id === d.depends_on_service_id);
        return t ? [{ d, t }] : [];
      })
      .sort((a, b) => byCreatedDesc(a.d, b.d))
      .map(({ d, t }) => ({
        depends_on_service_id: d.depends_on_service_id,
        depends_on_name: t.name,
        service_classification: t.service_classification,
        business_criticality: t.business_criticality,
        dependency_type: d.dependency_type,
        created_at: d.created_at,
      }));
  const leftJoin = (rows: Row[], nullRow: Row) =>
    parent.length === 0 ? [] : rows.length ? rows : [nullRow];

  if (s.includes('FROM ci_business_service_mappings m WHERE m.service_id = $1')) return mappings();
  if (s.includes('FROM dim_business_services s LEFT JOIN ci_business_service_mappings m ON m.service_id = s.service_id WHERE s.service_id = $1'))
    return leftJoin(mappings(), { ci_id: null, mapping_type: null, confidence_score: null, created_at: null });
  if (s.includes('FROM business_service_dependencies d JOIN dim_business_services s ON d.depends_on_service_id = s.service_id WHERE d.service_id = $1'))
    return deps();
  if (s.includes('FROM dim_business_services p LEFT JOIN ( business_service_dependencies d JOIN dim_business_services s ON d.depends_on_service_id = s.service_id ) ON d.service_id = p.service_id WHERE p.service_id = $1'))
    return leftJoin(deps(), {
      depends_on_service_id: null, depends_on_name: null, service_classification: null,
      business_criticality: null, dependency_type: null, created_at: null,
    });
  throw new Error(`unsupported SQL in substrate: ${s}`);
}

const pgClient = {
  // Plain function (not jest.fn): the unit config resets mock implementations.
  query: async (sql: string, params: unknown[] = []) => {
    queryLog.push(norm(sql));
    paramLog.push(params);
    if (failNextQuery) {
      failNextQuery = false;
      throw new Error('connection terminated unexpectedly');
    }
    return { rows: evaluate(sql, params) };
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

const NOT_FOUND = { success: false, error: 'Business service not found' };
const t = (iso: string) => new Date(iso);

function buildApp() {
  // Mirrors server.ts: authenticate once on /api/v1, then the router.
  const app = express();
  app.use(express.json());
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
  return app;
}

describe('business-service child reads: missing-parent semantics', () => {
  const app = buildApp();
  const token = new JWTService(loadConfig().auth.jwt).generateAccessToken(VIEWER_ID, 'viewer', 'viewer');
  const auth = { Authorization: `Bearer ${token}` };

  beforeEach(() => {
    queryLog.length = 0;
    paramLog.length = 0;
    failNextQuery = false;
    tables.dim_business_services = [
      { service_id: 'bs-empty', name: 'Empty', service_classification: 'compute', business_criticality: 'low' },
      { service_id: 'bs-app', name: 'App', service_classification: 'application', business_criticality: 'high' },
      { service_id: 'bs-db', name: 'Database Tier', service_classification: 'data', business_criticality: 'critical' },
      { service_id: 'bs-net', name: 'Network', service_classification: 'network', business_criticality: 'medium' },
      { service_id: 'bs-other', name: 'Other', service_classification: 'security', business_criticality: 'low' },
    ];
    tables.ci_business_service_mappings = [
      { ci_id: 'ci-old', service_id: 'bs-app', mapping_type: 'hosts', confidence_score: 0.5, created_at: t('2026-01-01T00:00:00Z') },
      { ci_id: 'ci-new', service_id: 'bs-app', mapping_type: 'supports', confidence_score: 1, created_at: t('2026-02-01T00:00:00Z') },
      { ci_id: 'ci-foreign', service_id: 'bs-other', mapping_type: 'hosts', confidence_score: 1, created_at: t('2026-03-01T00:00:00Z') },
    ];
    tables.business_service_dependencies = [
      { service_id: 'bs-app', depends_on_service_id: 'bs-net', dependency_type: 'infrastructure', created_at: t('2026-01-01T00:00:00Z') },
      { service_id: 'bs-app', depends_on_service_id: 'bs-db', dependency_type: 'platform', created_at: t('2026-02-01T00:00:00Z') },
      { service_id: 'bs-other', depends_on_service_id: 'bs-db', dependency_type: 'application', created_at: t('2026-03-01T00:00:00Z') },
    ];
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

    it('rejects anonymous requests with 401 before any data access', async () => {
      const res = await request(app).get(`/api/v1/business-services/bs-app/${child}`);
      expect(res.status).toBe(401);
      expect(queryLog).toEqual([]);
    });

    it('surfaces a database failure as 500, not an empty 200', async () => {
      failNextQuery = true;
      const res = await request(app).get(`/api/v1/business-services/bs-app/${child}`).set(auth);
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('connection terminated unexpectedly');
    });

    it('binds an injection-shaped service_id as a parameter and treats it as unknown', async () => {
      const hostile = "bs-app' OR '1'='1";
      const res = await request(app)
        .get(`/api/v1/business-services/${encodeURIComponent(hostile)}/${child}`)
        .set(auth);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(paramLog).toEqual([[hostile]]);
      expect(queryLog).toHaveLength(1);
      expect(queryLog[0]).not.toContain(hostile);
    });
  });

  it('returns only the service\'s own mappings, newest first, with the pre-change projection', async () => {
    const res = await request(app).get('/api/v1/business-services/bs-app/cis').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [
        { ci_id: 'ci-new', mapping_type: 'supports', confidence_score: 1, created_at: '2026-02-01T00:00:00.000Z' },
        { ci_id: 'ci-old', mapping_type: 'hosts', confidence_score: 0.5, created_at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    expect(queryLog).toHaveLength(1);
  });

  it('returns only the service\'s own dependencies with target metadata, newest first', async () => {
    const res = await request(app).get('/api/v1/business-services/bs-app/dependencies').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [
        {
          depends_on_service_id: 'bs-db', depends_on_name: 'Database Tier', service_classification: 'data',
          business_criticality: 'critical', dependency_type: 'platform', created_at: '2026-02-01T00:00:00.000Z',
        },
        {
          depends_on_service_id: 'bs-net', depends_on_name: 'Network', service_classification: 'network',
          business_criticality: 'medium', dependency_type: 'infrastructure', created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(queryLog).toHaveLength(1);
  });

  it('does not leak the null-extended discriminator row as a child entry', async () => {
    const [cis, deps] = await Promise.all([
      request(app).get('/api/v1/business-services/bs-net/cis').set(auth),
      request(app).get('/api/v1/business-services/bs-net/dependencies').set(auth),
    ]);
    expect(cis.body).toEqual({ success: true, data: [] });
    expect(deps.body).toEqual({ success: true, data: [] });
  });
});
