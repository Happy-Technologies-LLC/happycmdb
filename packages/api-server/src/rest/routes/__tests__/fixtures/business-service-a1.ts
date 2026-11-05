// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1422 (PoR S1, brief §6 A1): the business-service route-table negative controls, shared by the PGlite unit suite
 * (business-service-tenant-isolation.test.ts) and the real-PostgreSQL integration suite
 * (tests/integration/database/hap1422-portfolio-app-login.integration.test.ts).
 *
 * Tenants T and T2 each own services with CI mappings, dependencies and facts. For every route in
 * businessServiceRoutes' own route table, T calls it with T2's service_id. The call must return 404, byte-identical to
 * the same call with a service_id that does not exist, and must leave every portfolio row of both tenants unchanged.
 * The same call with T's own service_id is the positive control: it must succeed under the same login, so a 404 or
 * identical 500 caused by a missing grant cannot pass as isolation. The two routes with no :service_id (list, create)
 * prove that T2's identifiers never reach a response or a row.
 * A route added to the router without an entry in the controls fails its own test and the route-table test.
 * HAP-1424 (PoR S3): the same controls cover serviceOfferingRoutes (T calls each with T2's offering_id), and scenario 3
 * proves the composite (service_id, organization_id) foreign key refuses, at the database and as the app login, an
 * offering of T that names T2's service.
 * HAP-1425 (PoR S4): the list control also proves a tenant_id or organization_id parameter is 400 (scenario 4); the
 * viewer users and API keys of the two C1 consumers (HappyHive, HIVE) serve business-service-c1-consumer.ts.
 */

import { createHash, randomBytes } from 'crypto';
import type { Express, Router } from 'express';
import request from 'supertest';

export const T = '6a1d2c3b-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
export const T2 = '9b8a7c6d-5e4f-4321-8fed-cba987654321';
export const T2_SECRET = 'T2 Secret Payroll';
const BASE = '/api/v1/business-services';
const OFFERINGS = '/api/v1/service-offerings';
const MISSING = 'bs-does-not-exist';
const MISSING_OFFERING = 'so-does-not-exist';

/** The users the auth repository fake returns; the token's organization is the only tenant input. */
export const A1_USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean;
  _organizationId: string }> = {
  'user-t': { _id: 'user-t', _username: 'tess', _role: 'operator', _enabled: true, _organizationId: T },
  'user-t2': { _id: 'user-t2', _username: 'tom', _role: 'operator', _enabled: true, _organizationId: T2 },
  // HAP-1425 (PoR S4): HappyHive's and HIVE's consumer principals in T, each a viewer holding a viewer API key.
  'happyhive-t': { _id: 'happyhive-t', _username: 'happyhive', _role: 'viewer', _enabled: true, _organizationId: T },
  'hive-t': { _id: 'hive-t', _username: 'hive', _role: 'viewer', _enabled: true, _organizationId: T },
};

/** HAP-1425: the consumer principals' API keys (generated per run), and the key records the auth repository fake returns by hash. */
export const CONSUMER_KEYS: Record<'happyhive' | 'hive', string> = {
  happyhive: randomBytes(32).toString('hex'), hive: randomBytes(32).toString('hex'),
};
export const A1_API_KEYS: Record<string, { _id: string; _userId: string; _role: string; _enabled: boolean }> = Object.fromEntries(
  Object.entries(CONSUMER_KEYS).map(([consumer, key]) => [createHash('sha256').update(key).digest('hex'),
    { _id: `key-${consumer}-t`, _userId: `${consumer}-t`, _role: 'viewer', _enabled: true }]));

/** Neo4j fake: which tenant owns each CI (the owned-CI filter of POST /cis and the /context walk). */
const GRAPH_OWNERS: Record<string, string> = { 'ci-t': T, 'ci-t-free': T, 'ci-t2': T2, 'ci-t2-free': T2 };
export const a1GraphClient = {
  getCI: async (id: string, organizationId: string) => GRAPH_OWNERS[id] === organizationId ? { id } : null,
  getSession: () => ({
    run: async (_query: string, params: { ids: string[]; organizationId: string }) => ({
      records: params.ids.filter(id => GRAPH_OWNERS[id] === params.organizationId).map(id => ({ get: () => id })),
    }),
    close: async () => undefined,
  }),
  getDependencyGraph: async () => ({ nodes: [], edges: [] }),
};

/** Every T and T2 row; run by the table owner after the tables are emptied of both tenants' rows. */
export const A1_SEED_SQL = `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
  operational_status, lifecycle, organization_id) VALUES
  ('bs-t', 'T App', 'application', 'application', 'high', 'active', 'planned', '${T}'),
  ('bs-t-db', 'T Database', 'data', 'data', 'critical', 'active', 'planned', '${T}'),
  ('bs-t-solo', 'T Solo', 'compute', 'compute', 'low', 'active', 'planned', '${T}'),
  ('bs-t2', '${T2_SECRET}', 'application', 'application', 'high', 'active', 'planned', '${T2}'),
  ('bs-t2-db', 'T2 Database', 'data', 'data', 'critical', 'active', 'planned', '${T2}'),
  ('bs-t2-solo', 'T2 Solo', 'compute', 'compute', 'low', 'active', 'planned', '${T2}');
INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, tbm_attributes, is_current, organization_id) VALUES
  ('ci-t', 'T CI', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 10}', TRUE, '${T}'),
  ('ci-t-free', 'T Free CI', 'server', 'active', '{}', TRUE, '${T}'),
  ('ci-t2', 'T2 CI', 'server', 'active', '{"resource_tower": "compute", "monthly_cost": 70}', TRUE, '${T2}'),
  ('ci-t2-free', 'T2 Free CI', 'server', 'active', '{}', TRUE, '${T2}');
INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type, confidence_score) VALUES
  ('ci-t', 'bs-t', 'hosts', 1), ('ci-t2', 'bs-t2', 'hosts', 1);
INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type) VALUES
  ('bs-t', 'bs-t-db', 'technical'), ('bs-t2', 'bs-t2-db', 'technical');
INSERT INTO fact_business_service_incidents (service_id, incident_date, incident_count, mttr_minutes, sla_breaches) VALUES
  ('bs-t', CURRENT_DATE - 1, 1, 10, 0), ('bs-t2', CURRENT_DATE - 1, 900, 1000, 40);
INSERT INTO fact_business_service_changes (service_id, change_date, change_count, successful_count) VALUES
  ('bs-t', CURRENT_DATE - 1, 2, 2), ('bs-t2', CURRENT_DATE - 1, 8, 0);
-- T2's pending journal operations on CI ids T also maps: hidden from T only if the journal filter drops its tenant.
INSERT INTO ci_reconciliation_operations (id, group_id, organization_id, ci_id, origin, operation, graph_effect, state,
  actor, epoch, lease_expires_at) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', '${T2}', 'ci-t', 'api', 'update', TRUE,
    'pending', 't2-actor', 1, NOW() + INTERVAL '1 hour'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b2', '${T2}', 'ci-t-free', 'api', 'update',
    TRUE, 'pending', 't2-actor', 1, NOW() + INTERVAL '1 hour');
INSERT INTO service_offerings (offering_id, service_id, organization_id, name) VALUES
  ('so-t', 'bs-t', '${T}', 'T Desk'), ('so-t2', 'bs-t2', '${T2}', '${T2_SECRET} Desk');`;
/** The tables the snapshot compares (all readable by the app login). */
export const A1_SEEDED_TABLES = ['dim_business_services', 'business_service_dependencies', 'ci_business_service_mappings',
  'fact_business_service_incidents', 'fact_business_service_changes', 'cmdb.dim_ci', 'service_offerings'];
/** The tables the table owner empties before A1_SEED_SQL. */
export const A1_TRUNCATE_SQL = `TRUNCATE ${[...A1_SEEDED_TABLES, 'ci_reconciliation_operations'].join(', ')} RESTART IDENTITY CASCADE;`;

type Rows = (sql: string, params?: unknown[]) => Promise<unknown[]>;
/** `service` is the route's own id: a service_id, or an offering_id on the offering routes. */
type Ids = { service: string; child?: string };
type RouteControl =
  | {
    /** The request, for a parent service_id and the route's second id (a path :ci_id/:depends_on_service_id or body id). */
    send: (ids: Ids) => request.Test;
    /** T2's service, and for writes a T2 child a leak would change. */
    foreign: Ids;
    /** T's own service with T2's child id: identical to the same service with a missing child id. */
    foreignChild?: { child: string; missing: string };
    /** Positive control under the same login; `shows` must appear in its body. */
    own: Ids & { status: number; shows?: string };
  }
  | { check: () => Promise<void> };

/** Status, content type and body bytes: what a client can observe of a 404. */
const observable = (res: request.Response) => ({ status: res.status, type: res.headers['content-type'], text: res.text });

type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };
/** The router's own route table, as `METHOD path`. */
export function routeTable(router: Router): string[] {
  // Express sets Route#methods at runtime; its typings omit it.
  const layers: RouteLayer[] = router.stack as unknown as RouteLayer[];
  return layers.flatMap(({ route }) => route
    ? Object.keys(route.methods).filter(m => m !== '_all').map(m => `${m.toUpperCase()} ${route.path}`)
    : []);
}

/**
 * Defines the A1 describe blocks: the route-table tests and one named test per route. `app` mounts `router` at
 * /api/v1/business-services and `offeringRouter` at /api/v1/service-offerings behind the real AuthMiddleware; `rows`
 * runs SQL as the app login the routes use.
 */
export function defineA1RouteSuite({ app, router, offeringRouter, tokenForT, rows }: {
  app: Express; router: Router; offeringRouter: Router; tokenForT: () => string; rows: Rows;
}): void {
  const auth = () => ({ Authorization: `Bearer ${tokenForT()}` });
  const get = (path: string) => request(app).get(`${BASE}${path}`).set(auth());
  /** Every portfolio row of both tenants, including the hash-chained audit log the writes append to. */
  const snapshot = () => Promise.all([...A1_SEEDED_TABLES, 'audit_log'].map(table => rows(`SELECT * FROM ${table} ORDER BY 1`)));

  const controls: Record<string, RouteControl> = {
    'GET /': {
      check: async () => {
        const list = await get('?limit=100');
        expect(list.status).toBe(200);
        expect(list.body.items.map((s: { service_id: string }) => s.service_id).filter((id: string) => id.startsWith('bs-t'))
          .sort()).toEqual(['bs-t', 'bs-t-db', 'bs-t-solo']);
        expect(list.text).not.toContain('bs-t2');
        expect(list.text).not.toContain(T2);
        // HAP-1425 scenario 4: the tenant is never a query input; naming it is refused (400), not ignored.
        for (const steer of [`organization_id=${T2}`, `tenant_id=${T2}`]) {
          const steered = await get(`?limit=100&${steer}`);
          expect(steered.status).toBe(400);
          expect(steered.text).not.toContain(T2_SECRET);
        }
        const searched = await get(`?search=${encodeURIComponent(T2_SECRET)}`);
        expect(searched.status).toBe(200);
        expect(searched.body.items).toEqual([]);
      },
    },
    'POST /': {
      check: async () => {
        const before = await snapshot();
        const create = (body: object) => request(app).post(BASE).set(auth())
          .send({ name: 'T New', service_classification: 'application', tbm_tower: 'application', business_criticality: 'low', ...body });
        for (const steer of [{ service_id: 'bs-t2' }, { organization_id: T2 }]) {
          const res = await create(steer);
          expect(res.status).toBe(400);
          expect(res.text).not.toContain(T2_SECRET);
        }
        expect(await snapshot()).toEqual(before);
        const own = await create({});
        expect(own.status).toBe(201);
        expect(await rows('SELECT organization_id FROM dim_business_services WHERE service_id = $1', [own.body.data.service_id]))
          .toEqual([{ organization_id: T }]);
      },
    },
    'GET /:service_id': {
      send: ({ service }) => get(`/${service}`), foreign: { service: 'bs-t2' }, own: { service: 'bs-t', status: 200 },
    },
    'PATCH /:service_id': {
      send: ({ service }) => request(app).patch(`${BASE}/${service}`).set(auth()).set('If-Match', '"1"').send({ name: 'Renamed' }),
      foreign: { service: 'bs-t2' }, own: { service: 'bs-t', status: 200 },
    },
    'DELETE /:service_id': {
      // bs-t2-solo has no links, so a leak would delete it rather than 409.
      send: ({ service }) => request(app).delete(`${BASE}/${service}`).set(auth()),
      foreign: { service: 'bs-t2-solo' }, own: { service: 'bs-t-solo', status: 200 },
    },
    'GET /:service_id/cis': {
      send: ({ service }) => get(`/${service}/cis`), foreign: { service: 'bs-t2' },
      // T2's pending journal row on ci-t must not hide T's own mapping.
      own: { service: 'bs-t', status: 200, shows: '"ci-t"' },
    },
    'POST /:service_id/cis': {
      send: ({ service, child }) => request(app).post(`${BASE}/${service}/cis`).set(auth()).send({ ci_ids: [child] }),
      foreign: { service: 'bs-t2', child: 'ci-t-free' },
      foreignChild: { child: 'ci-t2-free', missing: 'ci-does-not-exist' },
      own: { service: 'bs-t', child: 'ci-t-free', status: 201 },
    },
    'DELETE /:service_id/cis/:ci_id': {
      send: ({ service, child }) => request(app).delete(`${BASE}/${service}/cis/${child}`).set(auth()),
      foreign: { service: 'bs-t2', child: 'ci-t2' },
      foreignChild: { child: 'ci-t2', missing: 'ci-does-not-exist' },
      own: { service: 'bs-t', child: 'ci-t', status: 200 },
    },
    'GET /:service_id/dependencies': {
      send: ({ service }) => get(`/${service}/dependencies`), foreign: { service: 'bs-t2' }, own: { service: 'bs-t', status: 200 },
    },
    'GET /:service_id/context': {
      send: ({ service }) => get(`/${service}/context`), foreign: { service: 'bs-t2' },
      own: { service: 'bs-t', status: 200, shows: '"ci-t"' },
    },
    'POST /:service_id/dependencies': {
      send: ({ service, child }) => request(app).post(`${BASE}/${service}/dependencies`).set(auth())
        .send({ depends_on_service_id: child }),
      foreign: { service: 'bs-t2', child: 'bs-t2-solo' },
      foreignChild: { child: 'bs-t2-solo', missing: MISSING },
      own: { service: 'bs-t', child: 'bs-t-solo', status: 201 },
    },
    'DELETE /:service_id/dependencies/:depends_on_service_id': {
      send: ({ service, child }) => request(app).delete(`${BASE}/${service}/dependencies/${child}`).set(auth()),
      foreign: { service: 'bs-t2', child: 'bs-t2-db' },
      foreignChild: { child: 'bs-t2-db', missing: MISSING },
      own: { service: 'bs-t', child: 'bs-t-db', status: 200 },
    },
    'GET /:service_id/health': {
      send: ({ service }) => get(`/${service}/health`), foreign: { service: 'bs-t2' }, own: { service: 'bs-t', status: 200 },
    },
    'GET /:service_id/costs': {
      send: ({ service }) => get(`/${service}/costs`), foreign: { service: 'bs-t2' }, own: { service: 'bs-t', status: 200 },
    },
    'GET /:service_id/offerings': {
      send: ({ service }) => get(`/${service}/offerings`), foreign: { service: 'bs-t2' },
      own: { service: 'bs-t', status: 200, shows: '"so-t"' },
    },
    'POST /:service_id/offerings': {
      send: ({ service }) => request(app).post(`${BASE}/${service}/offerings`).set(auth()).send({ name: 'T New Desk' }),
      foreign: { service: 'bs-t2' }, own: { service: 'bs-t', status: 201 },
    },
  };
  const offeringControls: Record<string, RouteControl> = {
    'GET /:offering_id': {
      send: ({ service }) => request(app).get(`${OFFERINGS}/${service}`).set(auth()), foreign: { service: 'so-t2' },
      own: { service: 'so-t', status: 200, shows: '"bs-t"' },
    },
    'PATCH /:offering_id': {
      send: ({ service }) => request(app).patch(`${OFFERINGS}/${service}`).set(auth()).set('If-Match', '"1"')
        .send({ name: 'Renamed Desk' }),
      foreign: { service: 'so-t2' }, own: { service: 'so-t', status: 200 },
    },
  };

  const runControl = async (control: RouteControl | undefined, route: string, missing: string) => {
    if (!control) throw new Error(`${route} has no cross-tenant negative control`);
    if ('check' in control) {
      await control.check();
      return;
    }
    const before = await snapshot();
    const foreign = await control.send(control.foreign);
    const absent = await control.send({ ...control.foreign, service: missing });
    expect(foreign.status).toBe(404);
    expect(observable(foreign)).toEqual(observable(absent));
    expect(foreign.text).not.toContain(T2_SECRET);
    if (control.foreignChild) {
      const ownParentForeignChild = await control.send({ service: control.own.service, child: control.foreignChild.child });
      const ownParentMissingChild = await control.send({ service: control.own.service, child: control.foreignChild.missing });
      expect(ownParentForeignChild.status).toBe(404);
      expect(observable(ownParentForeignChild)).toEqual(observable(ownParentMissingChild));
    }
    // Neither T2's rows and children nor T's changed; no audit row was appended.
    expect(await snapshot()).toEqual(before);

    const own = await control.send(control.own);
    expect({ status: own.status, success: own.body.success }).toEqual({ status: control.own.status, success: true });
    if (control.own.shows !== undefined) expect(own.text).toContain(control.own.shows);
  };
  const routes = routeTable(router);
  const offeringRoutes = routeTable(offeringRouter);

  describe('A1: every business-service route refuses T2\'s service_id exactly as a missing one, under the app login', () => {
    it('the route table and the negative controls name the same routes', () => {
      expect(routes).toHaveLength(16);
      expect([...routes].sort()).toEqual(Object.keys(controls).sort());
    });

    it.each(routes)('%s', route => runControl(controls[route], route, MISSING));
  });

  describe('HAP-1424 scenario 4: every service-offering route refuses T2\'s offering_id exactly as a missing one', () => {
    it('the route table and the negative controls name the same routes', () => {
      expect([...offeringRoutes].sort()).toEqual(Object.keys(offeringControls).sort());
    });

    it.each(offeringRoutes)('%s', route => runControl(offeringControls[route], route, MISSING_OFFERING));
  });

  describe('HAP-1424 scenario 3: the database refuses an offering whose service belongs to another tenant', () => {
    it('INSERT or UPDATE of T\'s offering naming T2\'s service fails the composite foreign key as the app login', async () => {
      const insert = (service: string) => rows(`INSERT INTO service_offerings (offering_id, service_id, organization_id, name)
        VALUES ($1, $2, $3, 'Steered')`, [`so-guard-${service}`, service, T]);
      await expect(insert('bs-t2')).rejects.toMatchObject({ code: '23503' });
      await expect(rows(`UPDATE service_offerings SET service_id = 'bs-t2' WHERE offering_id = 'so-t'`))
        .rejects.toMatchObject({ code: '23503' });
      // Positive control: the same login inserts under T's own service, so the refusal is the guard, not a privilege.
      await insert('bs-t');
      expect(await rows(`SELECT offering_id, service_id, organization_id FROM service_offerings
        WHERE offering_id IN ('so-t', 'so-guard-bs-t', 'so-guard-bs-t2') ORDER BY 1`)).toEqual([
        { offering_id: 'so-guard-bs-t', service_id: 'bs-t', organization_id: T },
        { offering_id: 'so-t', service_id: 'bs-t', organization_id: T },
      ]);
    });
  });
}
