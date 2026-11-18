// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-2030, real PostgreSQL: the impact reads' evidence statement runs under `set_config('statement_timeout', $1, true)` in a
// `transaction`, as a NOSUPERUSER app login that owns nothing and holds SELECT, INSERT on the real 054 table. PGlite does
// not enforce statement_timeout, so only a real server proves that a stalled evidence read is cancelled with SQLSTATE 57014
// (and the pool client comes back), that the int4 ceiling is accepted, and that the planner reads the receipts through
// `idx_relationship_evidence_receipts_edge`. The stall is real contention: another session holds ACCESS EXCLUSIVE on the
// receipts table, so the app login's SELECT waits until the statement timeout cancels it.
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { PostgresClient } from '../../../database/src/postgres/client';
import { receiptTableSql } from '../../src/rest/routes/__tests__/fixtures/app-login';

const suffix = randomBytes(4).toString('hex');
const DATABASE = `hap2030_evidence_${suffix}`;
const LOGIN = `hap2030_app_${suffix}`;
// Disposable-container LOGIN password; never a deployed credential.
const password = randomUUID();
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const INCARNATION = randomUUID();
const OLD_INCARNATION = randomUUID();
const incarnations = new Map<string, string>();

const connect = (database: string, user: string, secret: string) => new PostgresClient({
  _host: process.env['POSTGRES_HOST'] || 'localhost', _port: Number(process.env['POSTGRES_PORT']),
  _database: database, _user: user, _password: secret,
});
const app: { client: PostgresClient | null } = { client: null };
// edge-evidence.ts asks for the client at call time: forward each access to the app login's connection.
const appClientForwarder = new Proxy({}, {
  get: (_target, key) => {
    if (!app.client) throw new Error('HAP-2030: app login client used before beforeAll connected it');
    const value: unknown = Reflect.get(app.client, key);
    return typeof value === 'function' ? value.bind(app.client) : value;
  },
});

jest.mock('@cmdb/database', () => ({
  ...jest.requireActual<object>('@cmdb/database'),
  getPostgresClient: () => appClientForwarder,
  // The graph side: the current incarnation of each CI. Plain function, not jest.fn: the config resets mock implementations.
  getNeo4jClient: () => ({
    getCIIncarnations: async (ids: string[]) => new Map(ids.map(id => [id, incarnations.get(id) ?? null])),
  }),
}));

import { EVIDENCE_STATEMENT, impactEvidenceTimeoutMs, loadEdgeEvidence, qualificationOf } from '../../src/rest/edge-evidence';

let admin: PostgresClient;
let owner: PostgresClient;
let createdRole = false;

const INSERT_RECEIPTS = `INSERT INTO relationship_evidence_receipts (organization_id, from_ci_id, to_ci_id, from_incarnation_id,
    to_incarnation_id, relationship_type, evidence_class, polarity, source_name, method, observed_at, observer, observer_type,
    correlation_id)
  SELECT $1::uuid, $2::text || i, $3::text || i, $4::uuid, $4::uuid, 'DEPENDS_ON', $5::text, $6::text, 'api', 'api',
    now() - (r::text || ' minutes')::interval, 'integration', 'user', gen_random_uuid()
  FROM generate_series($7::int, $8::int) i, generate_series(1, $9::int) r`;
const seed = (org: string, incarnation: string, evidenceClass: string, polarity: string, from: string, to: string, edges: [number, number], perEdge: number) =>
  owner.query(INSERT_RECEIPTS, [org, from, to, incarnation, evidenceClass, polarity, edges[0], edges[1], perEdge]);

beforeAll(async () => {
  const superuser = process.env['POSTGRES_USER'] || 'test';
  const secret = process.env['POSTGRES_PASSWORD'] || '';
  admin = connect(process.env['POSTGRES_DB'] || 'postgres', superuser, secret);
  await admin.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  createdRole = true;
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  owner = connect(DATABASE, superuser, secret);
  await owner.query(receiptTableSql()); // the real 054 table, index and append-only triggers
  await owner.query(`GRANT SELECT, INSERT ON public.relationship_evidence_receipts TO ${LOGIN}`); // what 054 grants cmdb_user
  // 30,000 receipts over 3,000 edges, plus the edges the assertions look at.
  await seed(ORG, INCARNATION, 'declared', 'supports', 'bulk-', 'bulk-to-', [0, 2999], 10);
  await seed(ORG, INCARNATION, 'declared', 'supports', 'edge-a', 'edge-b', [0, 0], 2);
  await seed(OTHER_ORG, INCARNATION, 'declared', 'supports', 'edge-a', 'edge-b', [0, 0], 5); // another organization's receipts
  await seed(ORG, OLD_INCARNATION, 'declared', 'contradicts', 'edge-a', 'edge-b', [0, 0], 3); // a former incarnation's receipts
  await owner.query('ANALYZE public.relationship_evidence_receipts');
  for (const id of ['edge-a0', 'edge-b0', 'edge-x', 'edge-y', 'bulk-0', 'bulk-to-0', 'bulk-1', 'bulk-to-1']) incarnations.set(id, INCARNATION);
  app.client = connect(DATABASE, LOGIN, password);
}, 180000);

afterAll(async () => {
  await app.client?.close();
  await owner?.close();
  if (!admin || !createdRole) return;
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  await admin.query(`DROP OWNED BY ${LOGIN}`);
  await admin.query(`DROP ROLE IF EXISTS ${LOGIN}`);
  await admin.close();
});

afterEach(() => { delete process.env['IMPACT_EVIDENCE_TIMEOUT_MS']; });

const EDGE = { from: 'edge-a0', to: 'edge-b0', type: 'DEPENDS_ON' };
const checkedOut = () => app.client!.pool.totalCount - app.client!.pool.idleCount;

describe('the evidence read as a NOSUPERUSER app login on real PostgreSQL', () => {
  it('runs as a login that is no superuser and owns no table', async () => {
    const facts = (await app.client!.query(`SELECT current_user::text AS who, session_user::text AS session_who,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
      pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.relationship_evidence_receipts'::regclass), 'MEMBER') AS owns
      `)).rows[0];
    expect(facts).toEqual({ who: LOGIN, session_who: LOGIN, rolsuper: false, owns: false });
  });

  it('counts only the receipts of its organization and the current incarnations of both endpoints', async () => {
    const missing = { from: 'edge-x', to: 'edge-y', type: 'DEPENDS_ON' };
    const qualified = await loadEdgeEvidence(ORG, [EDGE, missing], { timeoutMs: 1000 });
    const withReceipts = qualificationOf(qualified, EDGE.from, EDGE.to, EDGE.type);
    const without = qualificationOf(qualified, missing.from, missing.to, missing.type);
    // 2 own supports; the other organization's 5 and the former incarnation's 3 contradictions are inert
    expect(withReceipts).toMatchObject({ currentness: 'current', evidence: { support: { supports: 2, contradicts: 0 }, receipt_count: 2 } });
    expect(without).toMatchObject({ currentness: 'unsupported', evidence: { receipt_count: 0, last_supported_at: null } });
  });

  it('cancels an evidence statement that stalls past IMPACT_EVIDENCE_TIMEOUT_MS with 57014 and releases the connection', async () => {
    const holder: PoolClient = await owner.getClient();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE public.relationship_evidence_receipts IN ACCESS EXCLUSIVE MODE'); // the app login's SELECT must wait
      process.env['IMPACT_EVIDENCE_TIMEOUT_MS'] = '300';
      expect(impactEvidenceTimeoutMs()).toBe(300);
      const started = Date.now();

      await expect(loadEdgeEvidence(ORG, [EDGE], { timeoutMs: 1000 })).rejects.toMatchObject({ code: '57014' });

      expect(Date.now() - started).toBeLessThan(2500); // cancelled by the timeout, not by the lock being released
      expect(checkedOut()).toBe(0); // no pool client left checked out
      // SET LOCAL ended with the rolled-back transaction: the next checkout has no inherited timeout.
      expect((await app.client!.query("SELECT current_setting('statement_timeout') AS t")).rows[0].t).not.toBe('300ms');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // Once the contention is gone the same read succeeds, so the failure was the stall and not the statement.
    await expect(loadEdgeEvidence(ORG, [EDGE], { timeoutMs: 1000 })).resolves.toBeDefined();
  });

  it('accepts IMPACT_EVIDENCE_TIMEOUT_MS=2147483647, the largest int4 statement_timeout', async () => {
    process.env['IMPACT_EVIDENCE_TIMEOUT_MS'] = '2147483647';
    expect(impactEvidenceTimeoutMs()).toBe(2147483647);
    const qualified = await loadEdgeEvidence(ORG, [EDGE], { timeoutMs: 1000 });
    expect(qualified.size).toBe(1); // not 22023: PostgreSQL took the value
  });

  // HAP-2127 (sec L1): the statement timeout must be transaction-local. A session-level `set_config(..., false)` would leave it on
  // the pooled connection for the next, unrelated checkout. The connection the read used is proven to be the one inspected.
  it('leaves no statement_timeout behind on the connection a COMMITTED evidence read used', async () => {
    const pool = app.client!.pool;
    const baseline = await app.client!.getClient();
    const pooledDefault = (await baseline.query("SELECT current_setting('statement_timeout') AS t")).rows[0].t as string;
    baseline.release();
    process.env['IMPACT_EVIDENCE_TIMEOUT_MS'] = '4321';
    expect(pooledDefault).not.toBe('4321ms');
    const connect = pool.connect.bind(pool) as unknown as () => Promise<PoolClient>;
    const used: Array<number | null> = [];
    const spy = jest.spyOn(pool, 'connect') as unknown as jest.Mock<() => Promise<PoolClient>>;
    spy.mockImplementation(async () => {
      const client = await connect();
      used.push(client.processID);
      return client;
    });
    try {
      expect((await loadEdgeEvidence(ORG, [EDGE], { timeoutMs: 1000 })).size).toBe(1); // COMMITTED, not rolled back
    } finally {
      spy.mockRestore();
    }
    expect(used).toHaveLength(1);
    const again = await app.client!.getClient(); // the pool hands back its most recently released connection
    try {
      expect(again.processID).toBe(used[0]);
      expect((await again.query("SELECT current_setting('statement_timeout') AS t")).rows[0].t).toBe(pooledDefault);
    } finally {
      again.release();
    }
  });

  it('reads the receipts through idx_relationship_evidence_receipts_edge, not a scan of the table', async () => {
    const edges = Array.from({ length: 20 }, (_, i) => ({ from: `bulk-${i}`, to: `bulk-to-${i}`, type: 'DEPENDS_ON' }));
    const plan = (await app.client!.query(`EXPLAIN ${EVIDENCE_STATEMENT}`, [
      ORG, edges.map(edge => edge.from), edges.map(edge => edge.to), edges.map(edge => edge.type),
      edges.map(() => INCARNATION), edges.map(() => INCARNATION),
    ])).rows.map(row => row['QUERY PLAN']).join('\n');

    expect(plan).toMatch(/Index Scan using idx_relationship_evidence_receipts_edge on relationship_evidence_receipts/);
    expect(plan).not.toMatch(/Seq Scan on relationship_evidence_receipts/);
  });
});
