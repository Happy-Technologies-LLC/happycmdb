// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1925 (BW5, BW6, BW7): `open_drift_count`, `configuration_coverage` and the KPI history (`kpi_history`, `kpi_delta`) on
 * GET /analytics/dashboard.
 *
 * The SQL statements (latest drift per CI incarnation; lineage match; the snapshot insert and series read) run on real
 * PostgreSQL (PGlite, hosted in a forked child by ../../routes/__tests__/fixtures/pglite-host.cjs) over the DDL of
 * 001_complete_schema.sql plus the organization and incarnation columns of 025/028/030, and migration 056 itself. The history
 * transaction runs as the NOBYPASSRLS login cmdb_app (SET LOCAL ROLE after BEGIN), so the row level security policy applies
 * to it as in production. Neo4j is an in-memory node map that applies the
 * `organization_id = $organizationId` and `id IN $ciIds` predicates a statement actually contains, so a statement
 * that drops its organization predicate sees every organization's CIs. The snapshot table is append-only and is never
 * truncated: every BW7 test uses its own organization id.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { fork } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Request, Response } from 'express';
import neo4j from 'neo4j-driver';

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual<object>('@cmdb/common'),
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: jest.fn(), getPostgresClient: jest.fn() }));
// The auth middleware imported by the controller pulls in bcrypt's native binding, unused here.
jest.mock('bcrypt', () => ({}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { AnalyticsController } from '../analytics.controller';
import {
  COVERAGE_SCAN_MAX_CIS, OPEN_DRIFT_MAX_CIS, readEstateKpiHistory, recordEstateKpiSnapshot, type EstateKpis,
} from '../../../services/estate-kpi.service';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
/** Valid v4 UUID for test id n (the incarnation check accepts only well-formed ones). */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const host = fork(join(__dirname, '../../routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<Record<string, any>[]>>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, any>[]; error?: string }) => {
  const call = pending.get(id)!;
  pending.delete(id);
  if (error) call.reject(new Error(error));
  else call.resolve(rows);
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const call = Promise.withResolvers<Record<string, any>[]>();
  pending.set(id, call);
  host.send({ id, op, sql: text, params });
  return call.promise;
}

let failDriftSql = false;
const pgQuery = async (text: string, params: unknown[] = []) => {
  if (failDriftSql && text.includes('drift_detection_results')) throw new Error('relation "drift_detection_results" does not exist');
  return { rows: await sql(text, params) };
};

/** Statements the history connection ran, and which of them to fail (the insert or the series read). */
let historyLog: string[] = [];
let failHistory: 'insert' | 'select' | null = null;
const historyRelease = jest.fn();
const historyClient = {
  query: async (text: string, params: unknown[] = []) => {
    historyLog.push(text.trim().split(/\s+/)[0]!);
    if (failHistory === 'insert' && text.includes('INSERT INTO public.estate_kpi_snapshots')) throw new Error('insert failed');
    if (failHistory === 'select' && text.includes('SELECT to_char')) throw new Error('select failed');
    const rows = await sql(text, params);
    if (text === 'BEGIN') await sql('SET LOCAL ROLE cmdb_app', [], 'exec');
    return { rows };
  },
  release: historyRelease,
};

interface Node { id: string; organization_id: string; incarnation_id: string; owner?: string; metadata?: string }
const graph = new Map<string, Node>();
let graphRuns: string[] = [];
const rec = (row: Record<string, unknown>) => ({ get: (key: string) => row[key] });
const session = {
  close: async () => undefined,
  run: async (cypher: string, params: Record<string, any> = {}) => {
    graphRuns.push(cypher);
    // Each organization_id predicate a statement contains is applied; a statement without one sees every organization.
    let nodes = [...graph.values()];
    if (cypher.includes('ci.organization_id = $organizationId')) nodes = nodes.filter(n => n.organization_id === params['organizationId']);
    if (cypher.includes('COUNT(ci) as total_cis')) return { records: [rec({ total_cis: neo4j.int(nodes.length) })] };
    if (cypher.includes('ci.id IN $ciIds')) {
      const ids = new Set<string>(params['ciIds']);
      return { records: nodes.filter(n => ids.has(n.id)).map(n => rec({ ciId: n.id, incarnationId: n.incarnation_id })) };
    }
    if (cypher.includes('AS owner')) {
      const limit = (params['rowLimit'] as { toNumber(): number }).toNumber();
      return { records: nodes.slice(0, limit).map(n => rec({
        ciId: n.id, owner: n.owner ?? null, metadata: n.owner === undefined ? n.metadata ?? null : null })) };
    }
    return { records: [] };
  },
};

const addCI = (id: string, org: string, extra: Partial<Node> = {}): Node => {
  const node = { id, organization_id: org, incarnation_id: uuid(Number(id.replace(/\D/g, '')) + 100_000), ...extra };
  graph.set(id, node);
  return node;
};
/** A detection run of a CI's incarnation; `at` orders runs (minutes after a fixed instant). */
const detect = (ci: Node, org: string, hasDrift: boolean, at: number, incarnation = ci.incarnation_id) =>
  sql(`INSERT INTO drift_detection_results (ci_id, has_drift, drift_score, detected_at, ci_incarnation_id, organization_id)
       VALUES ($1, $2, 10, '2026-01-01T00:00:00Z'::timestamptz + ($3 || ' minutes')::interval, $4::uuid, $5::uuid)`,
  [ci.id, hasDrift, String(at), incarnation, org]);
const reportedBy = (ci: Node | string, org: string, source = 'nmap') =>
  sql(`INSERT INTO ci_source_lineage (ci_id, source_name, source_id, organization_id) VALUES ($1, $2, $3, $4::uuid)`,
    [typeof ci === 'string' ? ci : ci.id, source, `${source}-1`, org]);

async function dashboard(org = ORG_A, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  (getPostgresClient as jest.Mock).mockReturnValue({ query: pgQuery, getClient: async () => historyClient });
  (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: () => session });
  const out = { status: jest.fn().mockReturnThis(), json: jest.fn(), body: undefined as unknown };
  out.json.mockImplementation((body: unknown) => { out.body = body; return out; });
  await new AnalyticsController().getDashboardStats(
    { user: { _organizationId: org }, ...extra } as unknown as Request, out as unknown as Response);
  expect(out.status).not.toHaveBeenCalled();
  return out.body as Record<string, unknown>;
}

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  const table = (name: string) => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))![0];
  await sql([table('baseline_snapshots'), table('drift_detection_results'), table('ci_source_lineage'),
    'ALTER TABLE drift_detection_results ADD COLUMN organization_id UUID, ADD COLUMN ci_incarnation_id UUID;',
    'ALTER TABLE ci_source_lineage ADD COLUMN organization_id UUID, ADD COLUMN last_correlation_id UUID;',
    'CREATE ROLE cmdb_app NOSUPERUSER NOBYPASSRLS;',
    `BEGIN;\n${readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/056_estate_kpi_snapshots.sql'), 'utf8')}\nCOMMIT;`,
  ].join('\n'), [], 'exec');
}, 60_000);
afterAll(() => { host.kill(); });
beforeEach(async () => {
  graph.clear();
  graphRuns = [];
  failDriftSql = false;
  failHistory = null;
  historyLog = [];
  historyRelease.mockClear();
  jest.useRealTimers();
  await sql('TRUNCATE drift_detection_results, ci_source_lineage', [], 'exec');
});

describe('getDashboardStats: open_drift_count (BW5)', () => {
  it('is 0, not null, for an organization with no CIs', async () => {
    const body = await dashboard();
    expect(body['open_drift_count']).toBe(0);
    expect(body['unavailable']).toEqual(['health_score']);
  });

  it('is 0 when CIs exist but none has ever drifted', async () => {
    const clean = addCI('ci-1', ORG_A);
    await detect(clean, ORG_A, false, 1);
    addCI('ci-2', ORG_A);
    expect((await dashboard())['open_drift_count']).toBe(0);
  });

  it('counts a CI once when its latest detection shows drift, however many detections it has', async () => {
    const open = addCI('ci-1', ORG_A);
    await detect(open, ORG_A, true, 1);
    await detect(open, ORG_A, true, 2);
    await detect(open, ORG_A, true, 3);
    expect((await dashboard())['open_drift_count']).toBe(1);
  });

  it('closes drift on a later clean detection and reopens it on a later drifted one', async () => {
    const closed = addCI('ci-1', ORG_A);
    await detect(closed, ORG_A, true, 1);
    await detect(closed, ORG_A, false, 2);
    const reopened = addCI('ci-2', ORG_A);
    await detect(reopened, ORG_A, false, 1);
    await detect(reopened, ORG_A, true, 2);
    expect((await dashboard())['open_drift_count']).toBe(1);
  });

  it('never counts another organization: its CIs, rows naming its CIs, or rows stamped for it', async () => {
    const mine = addCI('ci-1', ORG_A);
    await detect(mine, ORG_A, true, 1);
    // B's own CI, drifted in B's organization.
    const foreign = addCI('ci-2', ORG_B);
    await detect(foreign, ORG_B, true, 1);
    // A row stamped A that names a CI B owns in the graph (graph ownership decides).
    const moved = addCI('ci-3', ORG_B);
    await detect(moved, ORG_A, true, 1);
    // A row stamped B that names A's CI and incarnation (the row's organization decides).
    const mineNamedByB = addCI('ci-4', ORG_A);
    await detect(mineNamedByB, ORG_B, true, 1);
    expect((await dashboard(ORG_A))['open_drift_count']).toBe(1);
    // B owns only ci-2 in the graph; ci-3 (stamped A) and ci-4 (graph-owned by A) are not B's.
    expect((await dashboard(ORG_B))['open_drift_count']).toBe(1);
  });

  it('does not count drift of a replaced incarnation, a deleted CI or a legacy row without incarnation', async () => {
    const replaced = addCI('ci-1', ORG_A);
    await detect(replaced, ORG_A, true, 1, uuid(999_999));
    const deleted = addCI('ci-2', ORG_A);
    await detect(deleted, ORG_A, true, 1);
    graph.delete(deleted.id);
    const legacy = addCI('ci-3', ORG_A);
    await sql(`INSERT INTO drift_detection_results (ci_id, has_drift, detected_at, organization_id)
               VALUES ($1, true, now(), $2::uuid)`, [legacy.id, ORG_A]);
    expect((await dashboard())['open_drift_count']).toBe(0);
  });

  it('is null and named in unavailable when the drift read fails, and the rest of the payload is unchanged', async () => {
    addCI('ci-1', ORG_A);
    failDriftSql = true;
    const body = await dashboard();
    expect(body['open_drift_count']).toBeNull();
    expect(body['unavailable']).toEqual(['health_score', 'open_drift_count']);
    expect(body['total_cis']).toBe(1);
    expect(body['configuration_coverage']).toEqual({ with_owner_and_source: 0, total: 1, ratio: 0 });
  });

  it('is null (never a partial count) above the bound, without asking the graph', async () => {
    await sql(`INSERT INTO drift_detection_results (ci_id, has_drift, detected_at, ci_incarnation_id, organization_id)
               SELECT 'bulk-' || n, true, now(), $2::uuid, $1::uuid FROM generate_series(1, ${OPEN_DRIFT_MAX_CIS + 1}) n`,
    [ORG_A, uuid(1)]);
    const body = await dashboard();
    expect(body['open_drift_count']).toBeNull();
    expect(body['unavailable']).toContain('open_drift_count');
    expect(graphRuns.some(cypher => cypher.includes('ci.id IN $ciIds'))).toBe(false);
  });
});

describe('getDashboardStats: configuration_coverage (BW6)', () => {
  it('is {0, 0, null} for an organization with no CIs: the ratio is null, never 0 or NaN', async () => {
    addCI('ci-1', ORG_B, { owner: 'bob' });
    const body = await dashboard();
    expect(body['configuration_coverage']).toEqual({ with_owner_and_source: 0, total: 0, ratio: null });
  });

  it('counts only CIs that have both an owner and a discovery source', async () => {
    const both = addCI('ci-1', ORG_A, { owner: 'alice' });
    await reportedBy(both, ORG_A);
    addCI('ci-2', ORG_A, { owner: 'bob' }); // owner only
    const sourceOnly = addCI('ci-3', ORG_A);
    await reportedBy(sourceOnly, ORG_A);
    addCI('ci-4', ORG_A); // neither
    const body = await dashboard();
    expect(body['configuration_coverage']).toEqual({ with_owner_and_source: 1, total: 4, ratio: 0.25 });
    expect(body['unavailable']).toEqual(['health_score']);
  });

  it('takes the owner from the BW2 normalized projection and ignores blank owners', async () => {
    const fromMetadata = addCI('ci-1', ORG_A, { metadata: JSON.stringify({ owned_by: ' carol ' }) });
    await reportedBy(fromMetadata, ORG_A);
    const blankOwner = addCI('ci-2', ORG_A, { owner: '   ' });
    await reportedBy(blankOwner, ORG_A);
    // A stored top-level owner shadows metadata, even when it is blank.
    const shadowed = addCI('ci-3', ORG_A, { owner: '', metadata: JSON.stringify({ owner: 'dave' }) });
    await reportedBy(shadowed, ORG_A);
    const unparseable = addCI('ci-4', ORG_A, { metadata: '{not json' });
    await reportedBy(unparseable, ORG_A);
    expect((await dashboard())['configuration_coverage']).toEqual({ with_owner_and_source: 1, total: 4, ratio: 0.25 });
  });

  it('counts a CI with several lineage rows once, and never counts another organization', async () => {
    const twice = addCI('ci-1', ORG_A, { owner: 'alice' });
    await reportedBy(twice, ORG_A, 'nmap');
    await reportedBy(twice, ORG_A, 'ssh');
    // Lineage stamped for B only: not a source for A's CI.
    const foreignLineage = addCI('ci-2', ORG_A, { owner: 'bob' });
    await reportedBy(foreignLineage, ORG_B);
    // B's own fully covered CI is neither in A's numerator nor its denominator.
    const theirs = addCI('ci-3', ORG_B, { owner: 'zed' });
    await reportedBy(theirs, ORG_B);
    expect((await dashboard(ORG_A))['configuration_coverage']).toEqual({ with_owner_and_source: 1, total: 2, ratio: 0.5 });
    expect((await dashboard(ORG_B))['configuration_coverage']).toEqual({ with_owner_and_source: 1, total: 1, ratio: 1 });
  });

  it('is null and named in unavailable above the scan bound', async () => {
    for (let i = 1; i <= COVERAGE_SCAN_MAX_CIS + 1; i++) addCI(`ci-${i}`, ORG_A, { owner: 'alice' });
    const body = await dashboard();
    expect(body['configuration_coverage']).toBeNull();
    expect(body['unavailable']).toEqual(['health_score', 'configuration_coverage']);
    expect(body['total_cis']).toBe(COVERAGE_SCAN_MAX_CIS + 1);
  });
});

describe('getDashboardStats: payload compatibility', () => {
  it('keeps every earlier key and adds only kpi_history and kpi_delta to the BW5/BW6 payload', async () => {
    const body = await dashboard(randomUUID());
    expect(Object.keys(body).sort()).toEqual([
      'by_environment', 'by_status', 'by_type', 'ci_health', 'configuration_coverage', 'critical_relationships', 'health_score',
      'kpi_delta', 'kpi_history', 'open_drift_count', 'recent_discoveries', 'total_cis', 'unavailable',
    ]);
    expect(body['health_score']).toBeNull();
    expect(body['critical_relationships']).toBe(0);
    expect(body['unavailable']).toEqual(['health_score']);
  });
});

describe('getDashboardStats: KPI history (BW7)', () => {
  const DAY1 = '2026-03-10T12:00:00Z';
  /** Only Date is faked: PGlite's IPC and the promise machinery keep running on the real timers. */
  const clockAt = (iso: string) => jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'queueMicrotask', 'performance', 'hrtime'],
  });
  const rowsOf = (org: string) => sql(
    `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, metric, value::float8 AS value FROM public.estate_kpi_snapshots
     WHERE organization_id = $1::uuid ORDER BY snapshot_date, metric`, [org]);
  const history = (body: Record<string, unknown>) => body['kpi_history'] as Record<string, Array<{ date: string; value: number }>>;
  const delta = (body: Record<string, unknown>) => body['kpi_delta'] as Record<string, number | null>;

  it('records one row per available figure on the first read of a UTC day and never rewrites it on a later read', async () => {
    clockAt(DAY1);
    const org = randomUUID();
    addCI('ci-1', org, { owner: 'alice' });
    const first = await dashboard(org);
    // health_score is unavailable in this harness (no ITIL tables), so it is not recorded; the other three are.
    expect(first['health_score']).toBeNull();
    expect(await rowsOf(org)).toEqual([
      { date: '2026-03-10', metric: 'configuration_coverage_ratio', value: 0 },
      { date: '2026-03-10', metric: 'open_drift_count', value: 0 },
      { date: '2026-03-10', metric: 'total_cis', value: 1 }]);
    // The estate changes, later the same UTC day: the current figure moves, the day's recorded value does not.
    addCI('ci-2', org, { owner: 'bob' });
    const second = await dashboard(org);
    expect(second['total_cis']).toBe(2);
    expect(history(second)['total_cis']).toEqual([{ date: '2026-03-10', value: 1 }]);
    expect(await rowsOf(org)).toHaveLength(3);
  });

  it('records no row for an unavailable figure and leaves it out of the series (never a 0)', async () => {
    clockAt(DAY1);
    const org = randomUUID();
    // No CIs: health_score is null (unavailable here anyway) and the coverage ratio is null; the drift read fails.
    failDriftSql = true;
    const body = await dashboard(org);
    expect(body['open_drift_count']).toBeNull();
    expect(body['configuration_coverage']).toEqual({ with_owner_and_source: 0, total: 0, ratio: null });
    expect((await rowsOf(org)).map(row => row['metric'])).toEqual(['total_cis']);
    expect(history(body)).toEqual({
      health_score: [], open_drift_count: [], configuration_coverage_ratio: [], total_cis: [{ date: '2026-03-10', value: 0 }] });
  });

  it('adds a point on the next UTC day, and kpi_delta is the latest recorded value minus the previous one', async () => {
    const org = randomUUID();
    clockAt(DAY1);
    addCI('ci-1', org, { owner: 'alice' });
    await dashboard(org);
    clockAt('2026-03-11T00:00:01Z');
    addCI('ci-2', org);
    const body = await dashboard(org);
    expect(history(body)['total_cis']).toEqual([{ date: '2026-03-10', value: 1 }, { date: '2026-03-11', value: 2 }]);
    expect(delta(body)['total_cis']).toBe(1);
    expect(delta(body)['open_drift_count']).toBe(0);
    // A gap day has no point and no filler: the delta compares the two newest RECORDED days.
    clockAt('2026-03-20T09:00:00Z');
    addCI('ci-3', org);
    const later = await dashboard(org);
    expect(history(later)['total_cis'].map(point => point.date)).toEqual(['2026-03-10', '2026-03-11', '2026-03-20']);
    expect(delta(later)['total_cis']).toBe(1);
  });

  it('has a null delta for a metric with fewer than 2 points and [] for a metric with none', async () => {
    clockAt(DAY1);
    const org = randomUUID();
    addCI('ci-1', org, { owner: 'alice' });
    const body = await dashboard(org);
    expect(delta(body)).toEqual({ health_score: null, open_drift_count: null, configuration_coverage_ratio: null, total_cis: null });
    expect(history(body)['health_score']).toEqual([]);
    expect(history(body)['total_cis']).toHaveLength(1);
  });

  it('returns only the newest 10 recorded days, ascending', async () => {
    clockAt('2026-04-30T12:00:00Z');
    const org = randomUUID();
    // Eleven earlier recorded days (value = day of month, in random insertion order), then today's read makes twelve.
    await sql(`INSERT INTO public.estate_kpi_snapshots (organization_id, snapshot_date, metric, value)
               SELECT $1::uuid, DATE '2026-04-30' - d, 'total_cis', 30 - d FROM generate_series(1, 11) d ORDER BY random()`, [org]);
    addCI('ci-1', org);
    const body = await dashboard(org);
    const series = history(body)['total_cis'];
    expect(series).toHaveLength(10);
    expect(series.map(point => point.date)).toEqual(
      ['2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24', '2026-04-25', '2026-04-26', '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30']);
    expect(series.slice(0, 9).map(point => point.value)).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(series[9]).toEqual({ date: '2026-04-30', value: 1 });
    expect(delta(body)['total_cis']).toBe(-28);
  });

  it('never shows one organization the snapshots of another, and never writes a row for another organization', async () => {
    clockAt(DAY1);
    const [orgA, orgB] = [randomUUID(), randomUUID()];
    addCI('ci-a', orgA, { owner: 'alice' });
    addCI('ci-b1', orgB);
    addCI('ci-b2', orgB);
    await sql(`INSERT INTO public.estate_kpi_snapshots (organization_id, snapshot_date, metric, value) VALUES ($1::uuid, '2026-03-01', 'total_cis', 999)`, [orgB]);
    const forA = await dashboard(orgA);
    expect(history(forA)['total_cis']).toEqual([{ date: '2026-03-10', value: 1 }]);
    expect((await rowsOf(orgB)).map(row => row['value'])).toEqual([999]);
    expect((await rowsOf(orgA)).map(row => row['metric'])).toEqual(['configuration_coverage_ratio', 'open_drift_count', 'total_cis']);
    const forB = await dashboard(orgB);
    expect(history(forB)['total_cis']).toEqual([{ date: '2026-03-01', value: 999 }, { date: '2026-03-10', value: 2 }]);
    expect(history(await dashboard(orgA))['total_cis']).toEqual([{ date: '2026-03-10', value: 1 }]);
  });

  it('takes the organization from the verified identity, not from the query string or a header', async () => {
    clockAt(DAY1);
    const [token, other] = [randomUUID(), randomUUID()];
    addCI('ci-t', token, { owner: 'alice' });
    addCI('ci-o1', other);
    addCI('ci-o2', other);
    const body = await dashboard(token, { query: { organization_id: other }, headers: { 'x-organization-id': other }, body: { organization_id: other } });
    expect(history(body)['total_cis']).toEqual([{ date: '2026-03-10', value: 1 }]);
    expect(await rowsOf(other)).toEqual([]);
    expect(await rowsOf(token)).toHaveLength(3);
  });

  it.each([['insert' as const], ['select' as const]])(
    'still returns the dashboard with current figures when the history %s fails, with null history and kpi_history unavailable', async failure => {
      clockAt(DAY1);
      const org = randomUUID();
      addCI('ci-1', org, { owner: 'alice' });
      failHistory = failure;
      const body = await dashboard(org);
      expect(body['total_cis']).toBe(1);
      expect(body['open_drift_count']).toBe(0);
      expect(body['configuration_coverage']).toEqual({ with_owner_and_source: 0, total: 1, ratio: 0 });
      expect(body['kpi_history']).toBeNull();
      expect(body['kpi_delta']).toBeNull();
      expect(body['unavailable']).toEqual(['health_score', 'kpi_history']);
      // The failed transaction was rolled back and its connection released, never left open.
      expect(historyLog.at(-1)).toBe('ROLLBACK');
      expect(historyRelease).toHaveBeenCalledTimes(failure === 'insert' ? 1 : 2); // a failed series read follows a committed write
    });

  it('keeps the organization predicate in its own SQL: on a connection that bypasses row level security, org B is still invisible', async () => {
    clockAt(DAY1);
    const [orgA, orgB] = [randomUUID(), randomUUID()];
    // The harness superuser bypasses RLS (as a bootstrap owner login does), so only the statement's own predicate confines it.
    const superuser = { query: async (text: string, params: unknown[] = []) => ({ rows: await sql(text, params) }), release: jest.fn() };
    const pg = { getClient: async () => superuser } as unknown as Parameters<typeof readEstateKpiHistory>[0];
    await sql(`INSERT INTO public.estate_kpi_snapshots (organization_id, snapshot_date, metric, value)
               VALUES ($1::uuid, '2026-03-01', 'total_cis', 7), ($2::uuid, '2026-03-01', 'total_cis', 999)`, [orgA, orgB]);
    const kpis = { health_score: null, ci_health: null, open_drift_count: 0, configuration_coverage: null, unavailable: [] };
    await recordEstateKpiSnapshot(pg, orgA, kpis, 3);
    expect((await readEstateKpiHistory(pg, orgA)).kpi_history['total_cis']).toEqual([
      { date: '2026-03-01', value: 7 }, { date: '2026-03-10', value: 3 }]);
    expect((await rowsOf(orgB)).map(row => row['value'])).toEqual([999]);
  });

  it('records and reads a health_score and a coverage ratio, rounds float noise out of a delta, and skips a null ratio', async () => {
    const org = randomUUID();
    const kpis = (score: number | null, ratio: number | null): EstateKpis => ({
      health_score: score, ci_health: null, open_drift_count: 2,
      configuration_coverage: ratio === null ? null : { with_owner_and_source: 1, total: 4, ratio }, unavailable: [] });
    const pg = { getClient: async () => historyClient } as unknown as Parameters<typeof recordEstateKpiSnapshot>[0];
    clockAt(DAY1);
    await recordEstateKpiSnapshot(pg, org, kpis(87.3, null), 4);
    clockAt('2026-03-11T12:00:00Z');
    await recordEstateKpiSnapshot(pg, org, kpis(87.5, 0.25), 4);
    const { kpi_history, kpi_delta } = await readEstateKpiHistory(pg, org);
    expect(kpi_history['health_score']).toEqual([{ date: '2026-03-10', value: 87.3 }, { date: '2026-03-11', value: 87.5 }]);
    expect(kpi_delta['health_score']).toBe(0.2);
    expect(kpi_history['configuration_coverage_ratio']).toEqual([{ date: '2026-03-11', value: 0.25 }]);
    expect(kpi_delta['configuration_coverage_ratio']).toBeNull();
  });

  it('releases the history connection after every successful transaction too', async () => {
    clockAt(DAY1);
    const org = randomUUID();
    addCI('ci-1', org);
    await dashboard(org);
    expect(historyRelease).toHaveBeenCalledTimes(2); // the snapshot write and the series read
    expect(historyLog.filter(statement => statement === 'COMMIT')).toHaveLength(2);
  });
});
