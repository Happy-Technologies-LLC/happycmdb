// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The production ETL dimension writers (Neo4jToPostgresJob and
 * processSyncCIsToDatamart) run concurrently against the disposable
 * integration PostgreSQL. Two runs see the same 011-backfilled CI, one with
 * an org-A node and one with an org-B node. Only one may write the next
 * current version: the other must re-read that version under the per-CI lock
 * and refuse it, as a node of another organization.
 *
 * Neo4j is a fixed node per run; PostgreSQL is real, so the lock, the
 * READ COMMITTED re-read and the non-unique current-row index are real.
 * Two sync-cis batches whose ids share a lock key (hashtext collision) must
 * also both commit, not deadlock.
 */

import type { Pool, PoolClient } from 'pg';
import type { Job } from 'bullmq';
import { PostgresClient } from '../../../database/src/postgres/client';

const INTERNAL = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const mockPg = new PostgresClient({
  _host: process.env.POSTGRES_HOST || 'localhost',
  _port: Number(process.env.POSTGRES_PORT) || 5432,
  _database: process.env.POSTGRES_DB || 'cmdb_test',
  _user: process.env.POSTGRES_USER || 'test',
  _password: process.env.POSTGRES_PASSWORD || 'testpassword',
});
// One batch of node rows per processSyncCIsToDatamart run.
let mockSyncNodes: Array<Array<Record<string, unknown>>> = [];
// The pool processSyncCIsToDatamart takes connections from; set per test.
let mockSyncPool: { connect: () => Promise<PoolClient> } | undefined;

// processSyncCIsToDatamart reads its clients from the package singletons.
jest.mock('@cmdb/database', () => ({
  UNSCOPED_CI_ACCESS: Symbol('UNSCOPED_CI_ACCESS'),
  getPostgresClient: () => ({ pool: mockSyncPool }),
  getNeo4jClient: () => ({
    getSession: () => ({
      run: async () => ({ records: mockSyncNodes.shift()!.map(node => ({ get: (key: string) => node[key] })) }),
      close: async () => undefined,
    }),
  }),
}));

import { Neo4jToPostgresJob } from '../../src/jobs/neo4j-to-postgres.job';
import { processSyncCIsToDatamart } from '../../src/jobs/sync-cis-to-datamart.job';
import { FullRefreshJob } from '../../src/jobs/full-refresh.job';
import { ReconciliationJob } from '../../src/jobs/reconciliation.job';
import { DataMartClient } from '../../../database/src/clients/datamart.client';

const rawQuery = mockPg.query.bind(mockPg);

afterAll(async () => { await mockPg.close(); });

async function backfilled(ciId: string): Promise<void> {
  await rawQuery(`INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, org_backfilled, tbm_attributes)
    VALUES ($1, 'backfilled', 'server', 'active', 'production', TRUE, $2, TRUE, '{"monthly_cost":75}')`,
  [ciId, INTERNAL]);
}

/**
 * Wraps each new connection so the first transaction pauses after its
 * current-row SELECT for ciId while the second transaction runs. An unlocked
 * writer's second transaction then reads the same backfilled row, writes its
 * version and commits before the first resumes from its stale read. A locked
 * writer's second transaction first requests the per-CI lock, which waits for
 * the first transaction, so the first resumes as soon as that is sent.
 */
function interleave(connect: () => Promise<PoolClient>, ciId: string): () => Promise<PoolClient> {
  let connections = 0;
  let releaseFirst!: () => void;
  const secondDoneOrWaiting = new Promise<void>(resolve => { releaseFirst = resolve; });
  return async () => {
    const client = await connect();
    const order = ++connections;
    const query = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<any>;
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') return async (sql: string, params?: unknown[]) => {
          if (order === 2 && sql.includes('pg_advisory_xact_lock')) {
            const pending = query(sql, params);
            releaseFirst();
            return pending;
          }
          const result = await query(sql, params ?? []);
          if (order === 2 && /^(COMMIT|ROLLBACK)$/.test(sql.trim())) {
            releaseFirst();
          }
          if (order === 1 && /^\s*SELECT[\s\S]*FROM cmdb\.dim_ci\s+WHERE ci_id = \$1 AND is_current = true/i.test(sql)
              && params?.[0] === ciId) {
            await secondDoneOrWaiting;
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PoolClient;
  };
}

async function expectOneOrganizationClaimed(ciId: string): Promise<void> {
  const rows = (await rawQuery(
    `SELECT is_current, organization_id, org_backfilled, tbm_attributes->>'monthly_cost' AS monthly_cost
     FROM cmdb.dim_ci WHERE ci_id = $1 ORDER BY ci_key`, [ciId]
  )).rows;
  const current = rows.filter(row => row.is_current);
  expect(current).toHaveLength(1);
  const winner = current[0].organization_id;
  expect([ORG_A, ORG_B]).toContain(winner);
  // The losing organization got no version at all; the backfill stays internal with its cost.
  expect(rows.filter(row => row.organization_id !== INTERNAL && row.organization_id !== winner)).toEqual([]);
  expect(rows.filter(row => row.organization_id === INTERNAL)).toEqual([
    { is_current: false, organization_id: INTERNAL, org_backfilled: false, monthly_cost: '75' },
  ]);
}

test('concurrent neo4j-to-postgres runs for org A and org B write one current version of a backfilled CI', async () => {
  const ciId = `etl-claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await backfilled(ciId);
  const node = (organizationId: string) => ({
    id: ciId, name: `claimed ${organizationId}`, type: 'server', status: 'active', environment: 'production',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', discovered_at: '2026-01-01T00:00:00Z',
    organization_id: organizationId,
  });
  const neo4jFor = (organizationId: string) => ({
    getSession: () => ({
      run: async () => ({ records: [{ get: () => ({ properties: node(organizationId) }) }] }),
      close: async () => undefined,
    }),
  });
  const getClient = jest.spyOn(mockPg, 'getClient').mockImplementation(
    interleave(() => (mockPg.pool as Pool).connect(), ciId)
  );
  const run = (organizationId: string) => new Neo4jToPostgresJob(neo4jFor(organizationId) as any, mockPg).execute({
    id: `etl-${organizationId}`,
    data: { incrementalSince: '2026-01-01T00:00:00Z' },
    updateProgress: async () => undefined,
  } as unknown as Job);

  try {
    await Promise.all([run(ORG_A), run(ORG_B)]);
    await expectOneOrganizationClaimed(ciId);
  } finally {
    getClient.mockRestore();
    await rawQuery('DELETE FROM cmdb.fact_discovery WHERE ci_key IN (SELECT ci_key FROM cmdb.dim_ci WHERE ci_id = $1)', [ciId]);
    await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
  }
}, 30000);

test('concurrent sync-cis-to-datamart runs for org A and org B write one current version of a backfilled CI', async () => {
  const ciId = `sync-claim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await backfilled(ciId);
  const node = (organizationId: string) => ({
    ci_id: ciId, ci_name: `claimed ${organizationId}`, ci_type: 'server', ci_status: 'active',
    environment: 'production', organization_id: organizationId,
  });
  mockSyncNodes = [[node(ORG_A)], [node(ORG_B)]];
  const pool = mockPg.pool as Pool;
  // Only the job's connections are interleaved; pool.query (used below) is not.
  mockSyncPool = { connect: interleave(() => pool.connect(), ciId) };
  const run = (organizationId: string) => processSyncCIsToDatamart({
    id: `sync-${organizationId}`,
    data: { incrementalSince: '2026-01-01T00:00:00Z' },
    updateProgress: async () => undefined,
  } as unknown as Job);

  try {
    const results = await Promise.all([run(ORG_A), run(ORG_B)]);
    expect(results.map(result => result.errors)).toEqual([[], []]);
    await expectOneOrganizationClaimed(ciId);
  } finally {
    mockSyncPool = undefined;
    await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
  }
}, 30000);

/**
 * Wraps each new connection so the first transaction pauses after its first
 * per-CI lock until the second transaction's first lock is granted or waiting.
 */
function interleaveLocks(connect: () => Promise<PoolClient>): () => Promise<PoolClient> {
  let connections = 0;
  let releaseFirst!: () => void;
  const secondLocking = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstLocked = false;
  let secondLocked = false;
  // PostgreSQL signals no event when a backend starts waiting for a lock, so
  // pg_locks is polled until the lock request is either waiting or answered.
  const grantedOrWaiting = async (pid: number, pending: Promise<unknown>) => {
    let answered = false;
    const answer = () => { answered = true; };
    pending.then(answer, answer);
    while (!answered) {
      const { rows } = await rawQuery(
        `SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`, [pid]);
      if (rows.length > 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  return async () => {
    const client = await connect();
    const order = ++connections;
    const query = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<any>;
    const pid: number = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') return async (sql: string, params?: unknown[]) => {
          const lock = sql.includes('pg_advisory_xact_lock');
          if (order === 2 && lock && !secondLocked) {
            secondLocked = true;
            const pending = query(sql, params ?? []);
            void grantedOrWaiting(pid, pending).then(() => releaseFirst());
            return pending;
          }
          const result = await query(sql, params ?? []);
          if (order === 1 && lock && !firstLocked) {
            firstLocked = true;
            await secondLocking;
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PoolClient;
  };
}

test('sync-cis-to-datamart batches whose ids share a lock key do not deadlock', async () => {
  // p < q < r as strings, and hashtext(p) = hashtext(r): locks taken in id
  // order are K(p), K(q) for {p, q} but K(q), K(p) for {q, r}.
  const [p, q, r] = ['ci-330527', 'ci-5', 'ci-99917'];
  const keys = (await rawQuery('SELECT hashtext($1) AS p, hashtext($2) AS q, hashtext($3) AS r', [p, q, r])).rows[0];
  expect(keys.p).toBe(keys.r);
  expect(keys.q).not.toBe(keys.p);
  const ids = [p, q, r];
  await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = ANY($1::varchar[])', [ids]);
  const node = (ciId: string) => ({
    ci_id: ciId, ci_name: ciId, ci_type: 'server', ci_status: 'active', environment: 'production',
  });
  mockSyncNodes = [[node(p), node(q)], [node(q), node(r)]];
  const pool = mockPg.pool as Pool;
  const connect = interleaveLocks(() => pool.connect());
  let connections = 0;
  mockSyncPool = { connect: () => { connections++; return connect(); } };
  const run = (name: string) => processSyncCIsToDatamart({
    id: name, data: { incrementalSince: '2026-01-01T00:00:00Z' }, updateProgress: async () => undefined,
  } as unknown as Job);

  try {
    const results = await Promise.all([run('sync-pq'), run('sync-qr')]);
    expect(results.map(result => result.errors)).toEqual([[], []]);
    // One connection per run: no batch was retried after a deadlock, which
    // the transient-lock retry would otherwise hide.
    expect(connections).toBe(2);
    expect((await rawQuery(`SELECT ci_id FROM cmdb.dim_ci
      WHERE ci_id = ANY($1::varchar[]) AND is_current ORDER BY ci_id`, [ids])).rows).toEqual(
      [{ ci_id: p }, { ci_id: q }, { ci_id: r }]);
  } finally {
    mockSyncPool = undefined;
    await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = ANY($1::varchar[])', [ids]);
  }
}, 30000);

describe('every other dim_ci writer waits for, then refuses, a concurrent claim of a new CI', () => {
  const CURRENT_ROW_READ = /^\s*SELECT[\s\S]*FROM cmdb\.dim_ci\s+WHERE ci_id = \$1 AND is_current = true/i;
  const ciNode = (ciId: string, organizationId: string) => ({
    id: ciId, name: `claimed ${organizationId}`, type: 'server', status: 'active', environment: 'production',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', discovered_at: '2026-01-01T00:00:00Z',
    organization_id: organizationId,
  });
  // One :CI node: every CI read returns it; it has no relationships.
  const graphOf = (node: Record<string, unknown>) => ({
    getSession: () => ({
      run: async (cypher: string) => ({
        records: cypher.includes('-[rel]->') ? [] : [{ get: () => ({ properties: node }) }],
      }),
      close: async () => undefined,
    }),
    getCI: async (id: string) => id === node.id
      ? { _id: node.id, name: node.name, _type: node.type, _status: node.status, _updated_at: node.updated_at, _metadata: {} }
      : null,
  });

  /**
   * Runs neo4j-to-postgres for org B's node of a new ci_id and pauses it right
   * after its locked current-row read (which sees no row). Then runs `second`.
   * An unlocked writer inserts and commits before the pause ends; a locked one
   * requests the per-CI lock and waits. Either way the pause then ends, so
   * org B's version commits, and `second` (if locked) re-reads it.
   */
  async function raceBehindPausedClaim(ciId: string, second: () => Promise<unknown>): Promise<'done' | 'rejected'> {
    let releaseFirst!: () => void;
    const released = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markPaused!: () => void;
    const paused = new Promise<void>(resolve => { markPaused = resolve; });
    let pausedOnce = false;
    const pool = mockPg.pool as Pool;
    const getClient = jest.spyOn(mockPg, 'getClient').mockImplementation(async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (sql: string, params?: unknown[]) => Promise<any>;
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') return async (sql: string, params?: unknown[]) => {
            const result = await query(sql, params ?? []);
            if (!pausedOnce && CURRENT_ROW_READ.test(sql) && params?.[0] === ciId) {
              pausedOnce = true;
              markPaused();
              await released;
            }
            return result;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    });
    try {
      const first = new Neo4jToPostgresJob(graphOf(ciNode(ciId, ORG_B)) as any, mockPg).execute({
        id: 'claim-b', data: { incrementalSince: '2026-01-01T00:00:00Z' }, updateProgress: async () => undefined,
      } as unknown as Job);
      await paused;
      let settled = false;
      const outcome = second().then(() => 'done' as const, () => 'rejected' as const)
        .finally(() => { settled = true; });
      // PostgreSQL signals no event when a backend starts waiting for a lock, so
      // pg_locks is polled until the second writer waits or has finished.
      while (!settled) {
        const { rows } = await rawQuery(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        if (rows.length > 0) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      releaseFirst();
      await first;
      return await outcome;
    } finally {
      getClient.mockRestore();
    }
  }

  const currentRows = async (ciId: string) => (await rawQuery(
    'SELECT organization_id, ci_name FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current', [ciId])).rows;
  const cleanUp = async (ciId: string) => {
    await rawQuery('DELETE FROM cmdb.fact_discovery WHERE ci_key IN (SELECT ci_key FROM cmdb.dim_ci WHERE ci_id = $1)', [ciId]);
    await rawQuery('DELETE FROM cmdb.dim_ci WHERE ci_id = $1', [ciId]);
  };
  const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  test('full refresh', async () => {
    const ciId = uniqueId('refresh-claim');
    try {
      await raceBehindPausedClaim(ciId, () => new FullRefreshJob(graphOf(ciNode(ciId, ORG_A)) as any, mockPg).execute({
        id: 'refresh-a', data: { truncateTables: false, rebuildIndexes: false }, updateProgress: async () => undefined,
      } as unknown as Job));
      expect(await currentRows(ciId)).toEqual([{ organization_id: ORG_B, ci_name: `claimed ${ORG_B}` }]);
    } finally {
      await cleanUp(ciId);
    }
  }, 30000);

  test('neo4j-wins reconciliation insert', async () => {
    const ciId = uniqueId('reconcile-claim');
    try {
      await raceBehindPausedClaim(ciId, () => new ReconciliationJob(graphOf(ciNode(ciId, ORG_A)) as any, mockPg).execute({
        id: 'reconcile-a', data: { ciIds: [ciId], autoResolve: true, conflictStrategy: 'neo4j-wins' },
        updateProgress: async () => undefined,
      } as unknown as Job));
      expect(await currentRows(ciId)).toEqual([{ organization_id: ORG_B, ci_name: `claimed ${ORG_B}` }]);
    } finally {
      await cleanUp(ciId);
    }
  }, 30000);

  test('DataMartClient first insert', async () => {
    const ciId = uniqueId('datamart-claim');
    try {
      const outcome = await raceBehindPausedClaim(ciId, () => new DataMartClient(mockPg).upsertCI({
        ci_id: ciId, ciname: `claimed ${ORG_A}`, ci_type: 'server', ci_status: 'active', organization_id: ORG_A,
      }));
      expect(outcome).toBe('rejected');
      expect(await currentRows(ciId)).toEqual([{ organization_id: ORG_B, ci_name: `claimed ${ORG_B}` }]);
    } finally {
      await cleanUp(ciId);
    }
  }, 30000);
});
