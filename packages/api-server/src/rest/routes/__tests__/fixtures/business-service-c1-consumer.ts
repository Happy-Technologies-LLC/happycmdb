// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1425 (PoR S4, brief §6 A4/N4): the C1 consumer surface, shared like fixtures/business-service-a1.ts by the PGlite
 * unit suite (business-service-tenant-isolation.test.ts) and the real-PostgreSQL integration suite
 * (tests/integration/database/hap1422-portfolio-app-login.integration.test.ts); every statement runs as the app login on
 * the A1 seed. Scenarios 1-4: the cursor-paged list (Suite Contracts v2 common paging rule: an altered, foreign-tenant or
 * expired cursor is 404). Scenario 5: HappyHive's and HIVE's consumer principals (viewer API keys in T) are refused on
 * every POST, PATCH and DELETE in both routers' own route tables, one named test per route.
 */

import type { Express, Router } from 'express';
import request from 'supertest';
import { loadConfig } from '@cmdb/common';
import { encodeListCursor, LIST_CURSOR_TTL_MS } from '../../../../services/c1-list-cursor';
import { A1_SEEDED_TABLES, CONSUMER_KEYS, routeTable, T, T2, T2_SECRET } from './business-service-a1';

const BASE = '/api/v1/business-services';
const OFFERINGS = '/api/v1/service-offerings';
const CURSOR_NOT_FOUND = '{"success":false,"error":"Cursor not found"}';

type Rows = (sql: string, params?: unknown[]) => Promise<unknown[]>;
type Item = { service_id: string; tenant_id: string; offerings: Array<{ offering_id: string }> };
type Page = { status: number; text: string; body: { items: Item[]; next_cursor: string | null; as_of: string } };

export function defineC1ConsumerSuite({ app, router, offeringRouter, rows, tokenFor }: {
  app: Express; router: Router; offeringRouter: Router; rows: Rows; tokenFor: (tenant: typeof T | typeof T2) => string;
}): void {
  const list = (query: string, tenant = T): Promise<Page> =>
    request(app).get(`${BASE}${query}`).set({ Authorization: `Bearer ${tokenFor(tenant)}` });
  const ids = (page: Page) => page.body.items.map(item => item.service_id);
  const cursorQuery = (cursor: string) => `?limit=1&cursor=${encodeURIComponent(cursor)}`;

  describe('HAP-1425 scenarios 1-4: the C1 list pages by an opaque cursor bound to the token\'s tenant', () => {
    it('scenario 1: 120 services page 50/50/20 in a stable order, each exactly once, while services are inserted', async () => {
      // 117 more T services sharing one created_at: their order is the service_id tiebreak.
      await rows(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
          business_criticality, operational_status, organization_id, created_at)
        SELECT 'bs-t-page-' || lpad(g::text, 3, '0'), 'T Paged ' || g, 'application', 'application', 'low', 'active', $1,
          TIMESTAMP '2026-01-01 00:00:00'
        FROM generate_series(1, 117) g`, [T]);
      const seeded = (await rows('SELECT service_id FROM dim_business_services WHERE organization_id = $1', [T]) as
        Array<{ service_id: string }>).map(row => row.service_id).sort();
      expect(seeded).toHaveLength(120);

      const pages: Page[] = [await list('?limit=50')];
      // Between page reads: one service sorting before the cursor (an offset page would shift onto a row it already
      // served) and one created through the route, sorting after every seeded row.
      await rows(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
          business_criticality, operational_status, organization_id, created_at)
        VALUES ('bs-t-early', 'T Early', 'application', 'application', 'low', 'active', $1, TIMESTAMP '2000-01-01 00:00:00')`, [T]);
      const created = await request(app).post(BASE).set({ Authorization: `Bearer ${tokenFor(T)}` })
        .send({ name: 'T Inserted', service_classification: 'application', tbm_tower: 'application', business_criticality: 'low' });
      expect(created.status).toBe(201);
      while (pages.at(-1)!.body.next_cursor !== null && pages.length < 5) {
        pages.push(await list(`?limit=50&cursor=${encodeURIComponent(pages.at(-1)!.body.next_cursor!)}`));
      }

      expect(pages.map(page => [page.status, page.body.items.length])).toEqual([[200, 50], [200, 50], [200, 21]]);
      const served = pages.flatMap(ids);
      expect(new Set(served).size).toBe(served.length);
      expect(served.filter(id => seeded.includes(id)).sort()).toEqual(seeded);
      expect(served.slice(0, 117)).toEqual(seeded.filter(id => id.startsWith('bs-t-page-')));
      expect(served.at(-1)).toBe(created.body.data.service_id);
      expect(served).not.toContain('bs-t-early');
      for (const page of pages) {
        expect(page.body.items.every(item => item.tenant_id === T)).toBe(true);
        expect(Number.isNaN(Date.parse(page.body.as_of))).toBe(false);
      }
      // Each item is the C1 service read, offerings[] included (HAP-1424).
      expect(pages.flatMap(page => page.body.items).find(item => item.service_id === 'bs-t')?.offerings)
        .toEqual([expect.objectContaining({ offering_id: 'so-t' })]);
    });

    it('scenario 2: ?lifecycle=live returns only live services; an unknown lifecycle is 400', async () => {
      await rows(`UPDATE dim_business_services SET lifecycle = 'live', owner_principal_id = 'owner-t'
        WHERE service_id IN ('bs-t', 'bs-t-db', 'bs-t2')`);
      const live = await list('?lifecycle=live');
      expect([live.status, ids(live)]).toEqual([200, ['bs-t', 'bs-t-db']]);
      expect((await list('?lifecycle=active')).status).toBe(400);
    });

    it('scenario 3: a cursor replayed by another tenant, altered or expired is 404', async () => {
      const first = await list('?limit=1');
      const cursor = first.body.next_cursor!;
      expect(typeof cursor).toBe('string');
      // Positive control: T continues with its own cursor.
      const own = await list(cursorQuery(cursor));
      expect([own.status, own.body.items.length]).toEqual([200, 1]);
      expect(ids(own)).not.toEqual(ids(first));

      const foreign = await list(cursorQuery(cursor), T2);
      const altered = await list(cursorQuery(`${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`));
      const position = { ts: '2000-01-01 00:00:00', id: 'bs-a' };
      const fresh = await list(cursorQuery(encodeListCursor(T, position)));
      const expired = await list(cursorQuery(encodeListCursor(T, position, Date.now() - LIST_CURSOR_TTL_MS - 1000)));
      expect(fresh.status).toBe(200);
      for (const refused of [foreign, altered, expired]) {
        expect([refused.status, refused.text]).toEqual([404, CURSOR_NOT_FOUND]);
      }
      expect(foreign.text).not.toContain(T2_SECRET);
    });
  });

  describe('HAP-1425 scenario 5: HappyHive\'s and HIVE\'s consumer principals are refused on every write route', () => {
    const params: Record<string, string> = {
      ':service_id': 'bs-t', ':offering_id': 'so-t', ':ci_id': 'ci-t', ':depends_on_service_id': 'bs-t-db',
    };
    const writes = [
      ...routeTable(router).map(route => [route, BASE] as const),
      ...routeTable(offeringRouter).map(route => [route, OFFERINGS] as const),
    ].filter(([route]) => /^(POST|PATCH|DELETE) /.test(route))
      .map(([route, base]) => route.replace(' ', ` ${base}`).replace(/\/$/, ''));
    const snapshot = () => Promise.all([...A1_SEEDED_TABLES, 'audit_log'].map(table => rows(`SELECT * FROM ${table} ORDER BY 1`)));

    it('positive control: both consumer keys read the list and a service (200)', async () => {
      const header = loadConfig().auth.apiKeys.headerName;
      for (const key of Object.values(CONSUMER_KEYS)) {
        expect((await request(app).get(BASE).set(header, key)).status).toBe(200);
        expect((await request(app).get(`${BASE}/bs-t`).set(header, key)).status).toBe(200);
      }
    });

    it.each(writes)('%s', async route => {
      const [method, path] = route.split(' ') as [string, string];
      const url = path.replace(/:[a-z_]+/g, param => params[param]!);
      const header = loadConfig().auth.apiKeys.headerName;
      const before = await snapshot();
      for (const key of Object.values(CONSUMER_KEYS)) {
        const res = await request(app)[method.toLowerCase() as 'post' | 'patch' | 'delete'](url).set(header, key)
          .set('If-Match', '"1"').send({ name: 'Consumer Write', ci_ids: ['ci-t-free'], depends_on_service_id: 'bs-t-solo' });
        expect(res.status).toBe(403);
      }
      expect(await snapshot()).toEqual(before);
    });
  });
}
