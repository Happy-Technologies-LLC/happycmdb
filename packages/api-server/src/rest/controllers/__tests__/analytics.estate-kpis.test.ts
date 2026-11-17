// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1925 (BW5, BW6): `open_drift_count` and `configuration_coverage` on GET /analytics/dashboard.
 *
 * The two SQL statements (latest drift per CI incarnation; lineage match) run on real PostgreSQL (PGlite, hosted in a
 * forked child by ../../routes/__tests__/fixtures/pglite-host.cjs) over the DDL of 001_complete_schema.sql plus the
 * organization and incarnation columns of 025/028/030. Neo4j is an in-memory node map that applies the
 * `organization_id = $organizationId` and `id IN $ciIds` predicates a statement actually contains, so a statement
 * that drops its organization predicate sees every organization's CIs.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { fork } from 'child_process';
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
import { COVERAGE_SCAN_MAX_CIS, OPEN_DRIFT_MAX_CIS } from '../../../services/estate-kpi.service';

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

async function dashboard(org = ORG_A): Promise<Record<string, unknown>> {
  (getPostgresClient as jest.Mock).mockReturnValue({ query: pgQuery });
  (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: () => session });
  const out = { status: jest.fn().mockReturnThis(), json: jest.fn(), body: undefined as unknown };
  out.json.mockImplementation((body: unknown) => { out.body = body; return out; });
  await new AnalyticsController().getDashboardStats(
    { user: { _organizationId: org } } as unknown as Request, out as unknown as Response);
  expect(out.status).not.toHaveBeenCalled();
  return out.body as Record<string, unknown>;
}

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  const table = (name: string) => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))![0];
  await sql([table('baseline_snapshots'), table('drift_detection_results'), table('ci_source_lineage'),
    'ALTER TABLE drift_detection_results ADD COLUMN organization_id UUID, ADD COLUMN ci_incarnation_id UUID;',
    'ALTER TABLE ci_source_lineage ADD COLUMN organization_id UUID, ADD COLUMN last_correlation_id UUID;'].join('\n'), [], 'exec');
}, 60_000);
afterAll(() => { host.kill(); });
beforeEach(async () => {
  graph.clear();
  graphRuns = [];
  failDriftSql = false;
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
  it('keeps every earlier key and adds only open_drift_count, configuration_coverage and unavailable', async () => {
    const body = await dashboard();
    expect(Object.keys(body).sort()).toEqual([
      'by_environment', 'by_status', 'by_type', 'configuration_coverage', 'critical_relationships', 'health_score',
      'open_drift_count', 'recent_discoveries', 'total_cis', 'unavailable',
    ]);
    expect(body['health_score']).toBeNull();
    expect(body['critical_relationships']).toBe(0);
  });
});
