// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1652 on real PostgreSQL: two concurrent portfolio import applies whose files carry different HappyHive source
// ids for one service name both plan a name match to the same tenant service. A third connection holds that service
// row FOR UPDATE until both binders wait on it in bindService, so both planned before either bound. Exactly one binds
// (one map row, one BUSINESS_SERVICE UPDATE audit row); the other re-checks the map under the lock and is 409
// concurrent_import with no map or audit row. Real routes, JWTs, PostgresClient and audit chain.
import { randomUUID } from 'crypto';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { getPostgresClient } from '@cmdb/database';
import { loadConfig } from '@cmdb/common';

const A = randomUUID();
const user = { _id: `hap1652-${A.slice(0, 8)}`, _username: 'hap1652', _role: 'operator' as const, _enabled: true,
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
const SERVICE = `bs-hap1652-${A.slice(0, 8)}`;
const NAME = `HAP-1652 Billing ${A.slice(0, 8)}`;
/** A tenant-A HappyHive export of services named NAME, one per source id (none: only the Unassigned legacy service). */
const file = (...sourceIds: string[]) => [JSON.stringify({ kind: 'header', source_system: 'happyhive',
  exported_at: '2026-11-10T00:00:00Z', organization_id: A,
  row_counts: { service: sourceIds.length, ci: 0, relationship: 0, service_ci: 0 } }),
...sourceIds.map(id => JSON.stringify({ kind: 'service', source_id: id, name: NAME, status: 'active' }))].join('\n') + '\n';
const apply = (body: string) => request(app).post('/api/v1/portfolio/imports?mode=apply').set('authorization', bearer)
  .set('content-type', 'application/x-ndjson').send(body).then();

beforeAll(async () => {
  await sql.query(`INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
    business_criticality, operational_status, organization_id) VALUES ($1, $2, 'application', 'application', 'high',
    'active', $3)`, [SERVICE, NAME, A]);
  // The tenant's Unassigned legacy service first, so the racing runs below create nothing but race only to bind.
  expect((await apply(file())).status).toBe(201);
});

it('two applies racing to bind one service from different source ids: one binds, the other is 409 concurrent_import with no map or audit row', async () => {
  const { options } = sql.pool; // pg-pool hides `password` from enumeration
  const holder = new Client({ ...options, password: options.password });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM dim_business_services WHERE service_id = $1 AND organization_id = $2 FOR UPDATE',
      [SERVICE, A]);
    const sources = [randomUUID(), randomUUID()];
    const runs = Promise.all(sources.map(id => apply(file(id))));
    // Both runs planned the name match and now wait on the held row lock in bindService. Polled from the pool, not
    // the holder: pg_stat_activity is a snapshot held for the rest of the reading transaction.
    let waiting = 0;
    for (const deadline = Date.now() + 30_000; waiting < 2 && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 50));
      waiting = (await sql.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE 'SELECT version FROM dim_business_services%FOR UPDATE'`)).rows[0].n;
    }
    expect(waiting).toBe(2);
    await holder.query('COMMIT');
    const results = await runs;

    const statuses = results.map(res => res.status);
    expect([...statuses].sort()).toEqual([201, 409]);
    const winner = sources[statuses.indexOf(201)]!;
    const loser = results[statuses.indexOf(409)]!;
    expect(loser.body).toEqual({ success: false, error: 'Conflict', code: 'concurrent_import' });
    expect(results[statuses.indexOf(201)]!.body.mapping[1])
      .toEqual({ kind: 'service', source_id: winner, target_id: SERVICE, action: 'match', reason: 'name_match' });
    expect((await sql.query(`SELECT source_id FROM portfolio_import_map WHERE organization_id = $1 AND kind = 'service'
      AND target_id = $2`, [A, SERVICE])).rows).toEqual([{ source_id: winner }]);
    expect((await sql.query(`SELECT changes->0->>'old_value' AS old_value, changes->0->>'new_value' AS new_value
      FROM audit_log WHERE entity_type = 'BUSINESS_SERVICE' AND action = 'UPDATE' AND entity_id = $1`, [SERVICE])).rows)
      .toEqual([{ old_value: null, new_value: winner }]);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
});
