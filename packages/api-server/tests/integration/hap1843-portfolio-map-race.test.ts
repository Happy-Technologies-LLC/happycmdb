// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1843 on real PostgreSQL: two portfolio import applies carry one HappyHive service source id with different
// targets. A third connection holds back the first apply after it planned, at a lock its write path takes, while the
// second applies in full; then the holder lets go. The first apply's map insert (ON CONFLICT DO NOTHING) writes
// nothing, the stored row names another target, so it rolls back and is 409 concurrent_import: no map, service,
// offering or audit row of its own survives. Real routes, JWTs, PostgresClient and audit chain.
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = randomUUID();
const user = { _id: `hap1843-${A.slice(0, 8)}`, _username: 'hap1843', _role: 'operator' as const, _enabled: true,
  _organizationId: A, _scopes: ['portfolio:import'] };
// Plain class, not jest.fn: the integration config resets mock implementations before each test.
jest.mock('../../src/auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: class {
    findUserById = async (id: string) => (id === user._id ? user : null);
  },
}));

import { JWTService } from '../../src/auth/jwt.service';
import { getAuthMiddleware } from '../../src/auth/auth-bootstrap';
import { portfolioImportRoutes } from '../../src/rest/routes/portfolio-import.routes';

const sql = getPostgresClient();
const app = express().use('/api/v1', getAuthMiddleware().authenticate()).use('/api/v1/portfolio/imports', portfolioImportRoutes);
const bearer = `Bearer ${new JWTService(loadConfig().auth.jwt).generateAccessToken(user._id, user._username, user._role, A)}`;
const tag = A.slice(0, 8);
/** A tenant-A HappyHive export of the given services (none: only the Unassigned legacy service). */
const file = (...services: { source_id: string; name: string }[]) => [JSON.stringify({ kind: 'header',
  source_system: 'happyhive', exported_at: '2026-11-10T00:00:00Z', organization_id: A,
  row_counts: { service: services.length, ci: 0, relationship: 0, service_ci: 0 } }),
...services.map(service => JSON.stringify({ kind: 'service', ...service, status: 'active' }))].join('\n') + '\n';
const apply = (body: string) => request(app).post('/api/v1/portfolio/imports?mode=apply').set('authorization', bearer)
  .set('content-type', 'application/x-ndjson').send(body).then();
const CONFLICT = { success: false, error: 'Conflict', code: 'concurrent_import' };
const seed = (id: string, name: string) => sql.query(`INSERT INTO dim_business_services (service_id, name,
  service_classification, tbm_tower, business_criticality, operational_status, organization_id)
  VALUES ($1, $2, 'application', 'application', 'high', 'active', $3)`, [id, name, A]);
const mapRows = (sourceId: string) => sql.query(`SELECT target_id FROM portfolio_import_map
  WHERE organization_id = $1 AND source_system = 'happyhive' AND kind = 'service' AND source_id = $2`, [A, sourceId])
  .then(result => result.rows);
const bindAudits = (serviceId: string) => sql.query(`SELECT changes->0->>'new_value' AS new_value FROM audit_log
  WHERE organization_id = $1 AND entity_type = 'BUSINESS_SERVICE' AND action = 'UPDATE' AND entity_id = $2`, [A, serviceId])
  .then(result => result.rows);

/** Waits until `count` backends of this database wait on a lock in a statement starting `prefix`. */
async function waitingOn(prefix: string, count: number): Promise<void> {
  let waiting = 0;
  // Polled from the pool, not the holder: pg_stat_activity is a snapshot held for the rest of the reading transaction.
  for (const deadline = Date.now() + 30_000; waiting < count && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 50));
    waiting = (await sql.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND starts_with(query, $1)`, [prefix])).rows[0].n;
  }
  expect(waiting).toBe(count);
}

/** A third connection that holds `lock` (statements run in one open transaction) until `release` ends it. */
async function holding<T>(lock: (holder: Client) => Promise<unknown>, race: (release: (end: 'COMMIT' | 'ROLLBACK') =>
  Promise<void>) => Promise<T>): Promise<T> {
  const { options } = sql.pool; // pg-pool hides `password` from enumeration
  const holder = new Client({ ...options, password: options.password });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await lock(holder);
    return await race(async end => {
      await holder.query(end);
    });
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
}

const BIND_LOCK = 'SELECT version FROM dim_business_services WHERE service_id = $1 AND organization_id = $2 FOR UPDATE';

beforeAll(async () => {
  // The tenant's Unassigned legacy service first, so no run below creates it.
  expect((await apply(file())).status).toBe(201);
});

it('a bind that lost the source id to another bind of a different service is 409 concurrent_import: one map row, one audit row, both the winner\'s', async () => {
  const [late, early] = [`bs-hap1843-late-${tag}`, `bs-hap1843-early-${tag}`];
  await seed(late, `HAP-1843 Late ${tag}`);
  await seed(early, `HAP-1843 Early ${tag}`);
  const source = randomUUID();
  const [lost, won] = await holding(holder => holder.query(BIND_LOCK, [late, A]), async release => {
    // Planned a name match to `late`, then waits on its row lock in bindService.
    const first = apply(file({ source_id: source, name: `HAP-1843 Late ${tag}` }));
    await waitingOn(BIND_LOCK, 1);
    // Plans after `first` did (no map row for the source id yet) and binds it to `early`.
    const second = await apply(file({ source_id: source, name: `HAP-1843 Early ${tag}` }));
    await release('COMMIT');
    return [await first, second];
  });

  expect([lost.status, won.status].sort()).toEqual([201, 409]);
  expect(lost.body).toEqual(CONFLICT);
  expect(won.body.mapping[1]).toEqual({ kind: 'service', source_id: source, target_id: early, action: 'match',
    reason: 'name_match' });
  expect(await mapRows(source)).toEqual([{ target_id: early }]);
  expect([await bindAudits(early), await bindAudits(late)]).toEqual([[{ new_value: source }], []]);
});

it('a create that lost the source id to a bind is 409 concurrent_import: no service, offering or audit row of its own survives', async () => {
  const bound = `bs-hap1843-bound-${tag}`;
  await seed(bound, `HAP-1843 Bound ${tag}`);
  const source = randomUUID();
  const created = `HAP-1843 Created ${tag}`;
  const [lost, won] = await holding(
    // An uncommitted row with the same (tenant, source) key: createService's INSERT waits on its unique index entry.
    holder => holder.query(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
      business_criticality, operational_status, organization_id, source_system, source_id)
      VALUES ($1, 'holder', 'application', 'application', 'high', 'active', $2, 'happyhive', $3)`,
    [`bs-hap1843-holder-${tag}`, A, source]),
    async release => {
      // Planned a create (no service of that name), then waits in createService's service INSERT.
      const first = apply(file({ source_id: source, name: created }));
      await waitingOn('INSERT INTO dim_business_services (service_id, name, description,', 1);
      const second = await apply(file({ source_id: source, name: `HAP-1843 Bound ${tag}` }));
      await release('ROLLBACK');
      return [await first, second];
    });

  expect([lost.status, won.status].sort()).toEqual([201, 409]);
  expect(lost.body).toEqual(CONFLICT);
  expect(won.body.mapping[1]).toEqual({ kind: 'service', source_id: source, target_id: bound, action: 'match',
    reason: 'name_match' });
  expect(await mapRows(source)).toEqual([{ target_id: bound }]);
  expect((await sql.query(`SELECT service_id FROM dim_business_services WHERE organization_id = $1
    AND (name = $2 OR source_id = $3)`, [A, created, source])).rows).toEqual([]);
  expect((await sql.query(`SELECT offering_id FROM service_offerings WHERE organization_id = $1 AND source_id = $2`,
    [A, source])).rows).toEqual([]);
  // Every CREATE audit row of this tenant names a service or offering that exists: the loser's two were rolled back.
  expect((await sql.query(`SELECT entity_id FROM audit_log a WHERE a.organization_id = $1 AND a.action = 'CREATE'
    AND a.entity_type IN ('BUSINESS_SERVICE', 'SERVICE_OFFERING')
    AND NOT EXISTS (SELECT 1 FROM dim_business_services s WHERE s.service_id = a.entity_id)
    AND NOT EXISTS (SELECT 1 FROM service_offerings o WHERE o.offering_id = a.entity_id)`, [A])).rows).toEqual([]);
  expect(await bindAudits(bound)).toEqual([{ new_value: source }]);
});

it('a replay of the same bind that finds its own map row already written is 201 with no second audit row', async () => {
  const service = `bs-hap1843-replay-${tag}`;
  await seed(service, `HAP-1843 Replay ${tag}`);
  const body = file({ source_id: randomUUID(), name: `HAP-1843 Replay ${tag}` });
  const results = await holding(holder => holder.query(BIND_LOCK, [service, A]), async release => {
    // Both planned the same name match and wait on the row lock; each binds the same source id to the same service.
    const runs = Promise.all([apply(body), apply(body)]);
    await waitingOn(BIND_LOCK, 2);
    await release('COMMIT');
    return runs;
  });

  expect(results.map(res => res.status)).toEqual([201, 201]);
  expect(results.map(res => res.body.mapping[1].target_id)).toEqual([service, service]);
  expect((await sql.query(`SELECT count(*)::int AS n FROM portfolio_import_map WHERE organization_id = $1
    AND kind = 'service' AND target_id = $2`, [A, service])).rows).toEqual([{ n: 1 }]);
  expect(await bindAudits(service)).toHaveLength(1);
});
