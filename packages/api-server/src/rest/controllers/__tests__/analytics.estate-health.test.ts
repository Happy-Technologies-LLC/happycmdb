// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1923 (BW1, BW4): `health_score` and `ci_health` on GET /analytics/dashboard.
 *
 * The open-incident statement runs on real PostgreSQL (PGlite, hosted in a forked child by
 * ../../routes/__tests__/fixtures/pglite-host.cjs) over the itil_incidents DDL of 001_complete_schema.sql plus the
 * organization column of 035. Neo4j is an in-memory node map that applies the `organization_id = $organizationId`
 * and `id IN $ciIds` predicates a statement actually contains, so a statement that drops its organization predicate
 * sees every organization's CIs.
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
import { OPEN_INCIDENT_MAX_CIS } from '../../../services/estate-kpi.service';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

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

const graph = new Map<string, { id: string; organization_id: string }>();
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
      return { records: nodes.filter(n => ids.has(n.id)).map(n => rec({ ciId: n.id })) };
    }
    return { records: [] };
  },
};

const addCI = (id: string, org: string) => graph.set(id, { id, organization_id: org });
let incidentSerial = 0;
const incident = (ci: string, priority: number, status: string, org: string | null) => sql(
  `INSERT INTO itil_incidents (incident_number, title, impact, urgency, priority, affected_ci_id, status, reported_by,
     organization_id) VALUES ($1, 't', 'high', 'high', $2, $3, $4, 'x', $5)`,
  [`INC-${incidentSerial++}`, priority, ci, status, org]);

async function dashboard(org = ORG_A): Promise<Record<string, any>> {
  (getPostgresClient as jest.Mock).mockReturnValue({ query: async (text: string, params: unknown[] = []) => ({ rows: await sql(text, params) }) });
  (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: () => session });
  const out = { status: jest.fn().mockReturnThis(), json: jest.fn(), body: undefined as unknown };
  out.json.mockImplementation((body: unknown) => { out.body = body; return out; });
  await new AnalyticsController().getDashboardStats(
    { user: { _organizationId: org } } as unknown as Request, out as unknown as Response);
  expect(out.status).not.toHaveBeenCalled();
  return out.body as Record<string, any>;
}

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  const table = (name: string) => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))![0];
  // The BW5/BW6 statements of the same payload need their tables to exist (empty) so `unavailable` stays exact.
  await sql([table('itil_incidents'), table('baseline_snapshots'), table('drift_detection_results'), table('ci_source_lineage'),
    'ALTER TABLE itil_incidents ADD COLUMN organization_id uuid;',
    'ALTER TABLE drift_detection_results ADD COLUMN organization_id UUID, ADD COLUMN ci_incarnation_id UUID;',
    'ALTER TABLE ci_source_lineage ADD COLUMN organization_id UUID, ADD COLUMN last_correlation_id UUID;'].join('\n'), [], 'exec');
}, 60_000);
afterAll(() => { host.kill(); });
beforeEach(async () => {
  graph.clear();
  graphRuns = [];
  await sql('DELETE FROM itil_incidents', [], 'exec');
});

describe('getDashboardStats: health_score and ci_health (BW1, BW4)', () => {
  it('counts CIs by state and scores the healthy share of all CIs', async () => {
    for (const id of ['ci-1', 'ci-2', 'ci-3', 'ci-4', 'ci-5', 'ci-6', 'ci-7', 'ci-8']) addCI(id, ORG_A);
    await incident('ci-1', 1, 'new', ORG_A);
    await incident('ci-2', 2, 'in_progress', ORG_A);
    await incident('ci-2', 4, 'new', ORG_A); // two open incidents still make one critical CI
    await incident('ci-3', 3, 'new', ORG_A);
    await incident('ci-4', 5, 'pending', ORG_A);
    await incident('ci-5', 1, 'resolved', ORG_A);
    await incident('ci-6', 1, 'closed', ORG_A);
    await incident('ci-7', 1, 'cancelled', ORG_A);
    const body = await dashboard();
    expect(body['ci_health']).toEqual({ healthy: 4, degraded: 2, critical: 2, total: 8 });
    expect(body['health_score']).toBe(50);
    expect(body['unavailable']).toEqual([]);
  });

  it('is 100 when no CI has an open incident, and is never a hardcoded 0', async () => {
    addCI('ci-1', ORG_A);
    addCI('ci-2', ORG_A);
    const body = await dashboard();
    expect(body['ci_health']).toEqual({ healthy: 2, degraded: 0, critical: 0, total: 2 });
    expect(body['health_score']).toBe(100);
  });

  it('rounds to one decimal', async () => {
    for (const id of ['ci-1', 'ci-2', 'ci-3']) addCI(id, ORG_A);
    await incident('ci-1', 1, 'new', ORG_A);
    expect((await dashboard())['health_score']).toBe(66.7);
  });

  it('is null and named in unavailable for an organization with no CIs', async () => {
    const body = await dashboard();
    expect(body['health_score']).toBeNull();
    expect(body['ci_health']).toEqual({ healthy: 0, degraded: 0, critical: 0, total: 0 });
    expect(body['unavailable']).toEqual(['health_score']);
  });

  it("never counts another organization's incidents, CIs or rows with no organization", async () => {
    addCI('ci-a', ORG_A);
    addCI('ci-b', ORG_B);
    addCI('ci-legacy', ORG_A);
    await incident('ci-b', 1, 'new', ORG_B); // B's own CI
    await incident('ci-a', 1, 'new', ORG_B); // B names A's CI id
    await incident('ci-b', 1, 'new', ORG_A); // A names B's CI id: not a CI of A
    await incident('ci-legacy', 1, 'new', null); // pre-cutover row with no organization
    const a = await dashboard(ORG_A);
    expect(a['ci_health']).toEqual({ healthy: 2, degraded: 0, critical: 0, total: 2 });
    const b = await dashboard(ORG_B);
    expect(b['ci_health']).toEqual({ healthy: 0, degraded: 0, critical: 1, total: 1 });
    expect(b['health_score']).toBe(0); // a measured 0, distinct from null
    expect(b['unavailable']).toEqual([]);
  });

  it('ignores an incident that names a CI which no longer exists', async () => {
    addCI('ci-1', ORG_A);
    await incident('ci-deleted', 1, 'new', ORG_A);
    expect((await dashboard())['ci_health']).toEqual({ healthy: 1, degraded: 0, critical: 0, total: 1 });
  });

  it('is null (never a partial figure) above the bound, without asking the graph for the incident CIs', async () => {
    addCI('ci-1', ORG_A);
    await sql(`INSERT INTO itil_incidents (incident_number, title, impact, urgency, priority, affected_ci_id, status,
      reported_by, organization_id)
      SELECT 'INC-BULK-' || n, 't', 'high', 'high', 3, 'bulk-' || n, 'new', 'x', $1::uuid
      FROM generate_series(1, $2::int) AS n`, [ORG_A, OPEN_INCIDENT_MAX_CIS + 1]);
    const body = await dashboard();
    expect(body['health_score']).toBeNull();
    expect(body['ci_health']).toBeNull();
    expect(body['unavailable']).toEqual(['health_score']);
    expect(graphRuns.some(cypher => cypher.includes('ci.id IN $ciIds'))).toBe(false);
  });
});

describe('getDashboardStats: health without the ITIL tables (BW1)', () => {
  it('is null and named in unavailable, not 100, and the rest of the payload is unchanged', async () => {
    await sql('ALTER TABLE itil_incidents RENAME TO itil_incidents_off', [], 'exec');
    try {
      addCI('ci-1', ORG_A);
      const body = await dashboard();
      expect(body['health_score']).toBeNull();
      expect(body['ci_health']).toBeNull();
      expect(body['unavailable']).toEqual(['health_score']);
      expect(body['total_cis']).toBe(1);
    } finally {
      await sql('ALTER TABLE itil_incidents_off RENAME TO itil_incidents', [], 'exec');
    }
  });
});
