// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Two overlapping ChangeDetectionJob runs (the worker runs jobs concurrently,
 * under READ COMMITTED) see the same change. cmdb.fact_ci_changes has no
 * unique index, so the NOT EXISTS check alone lets both insert it.
 *
 * Neo4j is a fixed node per run; PostgreSQL is real, so the transaction
 * boundaries, the per-CI advisory lock and the READ COMMITTED re-read are
 * real. The run that first reaches its INSERT is held there until the other
 * run commits or is waiting on the advisory lock, so the interleaving that
 * duplicates the row without the lock is forced, not left to timing.
 */

import type { PoolClient } from 'pg';
import type { Job } from 'bullmq';
import { PostgresClient } from '../../../database/src/postgres/client';

const ORG_A = '11111111-1111-4111-8111-111111111111';

const mockPg = new PostgresClient({
  _host: process.env.POSTGRES_HOST || 'localhost',
  _port: Number(process.env.POSTGRES_PORT) || 5432,
  _database: process.env.POSTGRES_DB || 'cmdb_test',
  _user: process.env.POSTGRES_USER || 'test',
  _password: process.env.POSTGRES_PASSWORD || 'testpassword',
});

// The package index opens a Redis connection at import (bullmq queue-manager).
jest.mock('@cmdb/database', () => ({
  UNSCOPED_CI_ACCESS: Symbol('UNSCOPED_CI_ACCESS'),
}));

import { ChangeDetectionJob } from '../../src/jobs/change-detection.job';

const rawQuery = mockPg.query.bind(mockPg);

afterAll(async () => { await mockPg.close(); });

/**
 * Wraps each connection so the first transaction to finish its INSERT ...
 * WHERE NOT EXISTS pauses before COMMIT until another connection commits,
 * rolls back, or requests an advisory lock. Its row is still uncommitted, so
 * an unlocked second run finds nothing recorded, inserts and commits while the
 * first is paused: a duplicate. A locked second run first requests the lock,
 * which waits for the first run, so the first resumes as soon as that request
 * is sent (or is already waiting) and commits before the second run checks.
 */
function interleave(connect: () => Promise<PoolClient>): () => Promise<PoolClient> {
  let releasePaused!: () => void;
  const otherProgressed = new Promise<void>(resolve => { releasePaused = resolve; });
  let paused: PoolClient | undefined;
  const lockWaiters = new Set<PoolClient>();
  return async () => {
    const client = await connect();
    const query = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<any>;
    const proxy: PoolClient = new Proxy(client, {
      get(target, property) {
        if (property === 'query') return async (sql: string, params?: unknown[]) => {
          const isLock = sql.includes('pg_advisory_xact_lock');
          if (isLock) {
            lockWaiters.add(proxy);
            // This run's request waits behind a lock holder: it is the progress a paused run waits for.
            if (paused !== undefined && paused !== proxy) releasePaused();
          }
          let result;
          try {
            result = await query(sql, params ?? []);
          } finally {
            if (isLock) lockWaiters.delete(proxy);
          }
          if (/^(COMMIT|ROLLBACK)$/.test(sql.trim()) && paused !== undefined && paused !== proxy) {
            releasePaused();
          }
          if (/^\s*INSERT INTO cmdb\.fact_ci_changes/i.test(sql) && paused === undefined) {
            paused = proxy;
            // Another run already waiting on the lock this run holds is progress already made.
            if ([...lockWaiters].some(waiter => waiter !== proxy)) releasePaused();
            await otherProgressed;
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PoolClient;
    return proxy;
  };
}

test('two overlapping change-detection runs over the same change insert exactly one fact row', async () => {
  const ciId = `cd-concurrent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = '2026-01-01T00:00:00.000Z';
  await rawQuery(
    `INSERT INTO cmdb.dim_time (date_key, full_date, year, quarter, month, month_name, week, day_of_month,
                                day_of_week, day_name, is_weekend)
     VALUES (20260101, '2026-01-01', 2026, 1, 1, 'January', 1, 1, 4, 'Thursday', FALSE)
     ON CONFLICT (date_key) DO NOTHING`
  );
  const { rows: [dim] } = await rawQuery(
    `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, effective_from, effective_to,
                              is_current, organization_id, org_backfilled)
     VALUES ($1, 'concurrent', 'server', 'active', 'production', '2026-01-01T12:00:00Z', '9999-12-31',
             TRUE, $2, FALSE) RETURNING ci_key`,
    [ciId, ORG_A]
  );
  const node = {
    id: ciId, name: 'concurrent', type: 'server', status: 'active', environment: 'production',
    created_at: createdAt, updated_at: createdAt, metadata: '{}', organization_id: ORG_A,
  };
  const neo4jClient = {
    getSession: () => ({
      run: async () => ({ records: [{ get: () => ({ properties: node }) }] }),
      close: async () => undefined,
    }),
  };
  const getClient = jest.spyOn(mockPg, 'getClient').mockImplementation(interleave(() => mockPg.pool.connect()));
  const run = (id: string) => new ChangeDetectionJob(neo4jClient as any, mockPg).execute({
    id,
    data: { since: '2025-12-31T00:00:00.000Z' },
    updateProgress: async () => undefined,
  } as unknown as Job);

  try {
    const results = await Promise.all([run('cd-1'), run('cd-2')]);

    const rows = (await rawQuery(
      'SELECT ci_key, change_type, field_name FROM cmdb.fact_ci_changes WHERE ci_key = $1', [dim.ci_key]
    )).rows;
    expect(rows).toEqual([{ ci_key: dim.ci_key, change_type: 'created', field_name: '*' }]);
    expect(results.map(result => result.changesDetected)).toEqual([1, 1]);
    expect(results.map(result => result.changesRecorded).sort()).toEqual([0, 1]);
  } finally {
    getClient.mockRestore();
    await rawQuery('DELETE FROM cmdb.fact_ci_changes WHERE ci_key = $1', [dim.ci_key]);
    await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
  }
}, 30000);
