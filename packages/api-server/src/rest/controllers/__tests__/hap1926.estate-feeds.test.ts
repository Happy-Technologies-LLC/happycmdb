// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1926 (UX-4b BW8, BW9, BW10): the incident ribbon (+ business_impact on incident create), the tenant-wide recent
 * changes feed and the 24 h service availability.
 *
 * The SQL runs on real PostgreSQL (PGlite, hosted in a forked child by ../../routes/__tests__/fixtures/pglite-host.cjs)
 * over the DDL of 001_complete_schema.sql plus the organization / lifecycle / incarnation columns later migrations add.
 * Neo4j is an in-memory node map that applies the `organization_id = $organizationId` and `id IN $ciIds` predicates a
 * statement actually contains, so a statement that drops its organization predicate sees every organization's CIs.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Request, Response } from 'express';

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual<object>('@cmdb/common'),
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: jest.fn(), getPostgresClient: jest.fn() }));
// The auth middleware imported by the controllers pulls in bcrypt's native binding, unused here.
jest.mock('bcrypt', () => ({}));
// The AP-P' write fence only wraps the callback in a transaction; the INSERT inside it still runs on PGlite.
jest.mock('../../../read-admission', () => ({
  ...jest.requireActual<object>('../../../read-admission'),
  writeReferencedCIs: async (_org: string, _ids: string[], write: (client: unknown) => unknown) =>
    write({ query: (text: string, params: unknown[]) => pgQuery(text, params) }),
}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { ITILController } from '../itil.controller';
import { AnalyticsController } from '../analytics.controller';
import { incidentEndsAfter } from '../../../services/service-availability.service';
import { BusinessServiceController } from '../business-service.controller';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
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
const pgQuery = async (text: string, params: unknown[] = []) => ({ rows: await sql(text, params) });

interface Node { id: string; organization_id: string; incarnation_id: string; name?: string; type?: string }
const graph = new Map<string, Node>();
const addCI = (id: string, org: string, extra: Partial<Node> = {}): Node => {
  const node = { id, organization_id: org, incarnation_id: uuid(Number(id.replace(/\D/g, '')) + 100_000), ...extra };
  graph.set(id, node);
  return node;
};
const rec = (row: Record<string, unknown>) => ({ get: (key: string) => row[key] });
const session = {
  close: async () => undefined,
  run: async (cypher: string, params: Record<string, any> = {}) => {
    let nodes = [...graph.values()];
    if (cypher.includes('ci.organization_id = $organizationId')) nodes = nodes.filter(n => n.organization_id === params['organizationId']);
    if (cypher.includes('ci.id IN $ciIds')) {
      const ids = new Set<string>(params['ciIds']);
      nodes = nodes.filter(n => ids.has(n.id));
    }
    return { records: nodes.map(n => rec({ ciId: n.id, name: n.name ?? null, ciType: n.type ?? null })) };
  },
};

function res() {
  const out = { statusCode: 200, body: undefined as any, status: jest.fn(), json: jest.fn() };
  out.status.mockImplementation((code: unknown) => { out.statusCode = code as number; return out; });
  out.json.mockImplementation((body: unknown) => { out.body = body; return out; });
  return out;
}
function call(org: string | undefined, query: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  return { user: { _organizationId: org, _userId: 'u-1' }, query, body, params: {} } as unknown as Request;
}
/**
 * Every transaction the bounded feeds open, as the connection saw it: BEGIN, each statement (text + params), then
 * COMMIT or ROLLBACK. PGlite does not enforce statement_timeout, so a statement that must "time out" is made to fail
 * with the SQLSTATE the server would raise (`failStatement`), the way `ci-org-scope.test.ts` does.
 */
let trace: Array<{ text: string; params?: unknown[] }> = [];
let failStatement: { when: (text: string) => boolean; error: Error & { code?: string } } | null = null;
const txClient = {
  query: async (text: string, params: unknown[] = []) => {
    trace.push({ text, params });
    if (failStatement?.when(text)) throw failStatement.error;
    return pgQuery(text, params);
  },
};
const transaction = async <T>(callback: (client: typeof txClient) => Promise<T>): Promise<T> => {
  trace.push({ text: 'BEGIN' });
  await pgQuery('BEGIN');
  try {
    const result = await callback(txClient);
    trace.push({ text: 'COMMIT' });
    await pgQuery('COMMIT');
    return result;
  } catch (error) {
    trace.push({ text: 'ROLLBACK' });
    await pgQuery('ROLLBACK');
    throw error;
  }
};
function wire() {
  (getPostgresClient as jest.Mock).mockReturnValue({ query: pgQuery, pool: { query: pgQuery }, transaction });
  (getNeo4jClient as jest.Mock).mockReturnValue({
    getSession: () => session,
    getCI: async (id: string, org: string) => graph.get(id)?.organization_id === org ? { id, type: 'server', environment: 'staging' } : null,
    listCIIncarnations: async (org: string) => [...graph.values()].filter(n => n.organization_id === org)
      .map(n => ({ ciId: n.id, incarnationId: n.incarnation_id, organizationId: n.organization_id, ciType: n.type ?? null })),
  });
}
async function ribbon(org: string | undefined, query: Record<string, unknown> = {}) {
  wire();
  const out = res();
  await new ITILController().getOpenIncidentRibbon(call(org, query), out as unknown as Response);
  return out;
}
async function createIncident(org: string, ci: string) {
  wire();
  const out = res();
  await new ITILController().createIncident(
    call(org, {}, { affectedCIId: ci, description: 'db down', reportedBy: 'op' }), out as unknown as Response);
  return out;
}
async function recentChanges(org: string, query: Record<string, unknown> = {}) {
  wire();
  const out = res();
  await new AnalyticsController().getRecentChanges(call(org, query), out as unknown as Response);
  return out;
}
async function availability(org: string, query: Record<string, unknown> = {}) {
  wire();
  const out = res();
  await new BusinessServiceController().getServiceAvailability(call(org, query), out as unknown as Response);
  return out;
}

let counter = 0;
const nextId = () => uuid(++counter + 500_000);
/** A service of `org` (`live` by default) with its CIs mapped; metadata is the operator-recorded JSON. */
const addService = (org: string, name: string, opts: { criticality?: string; lifecycle?: string; metadata?: unknown; ciIds?: string[] } = {}) => {
  const id = `bs-${nextId()}`;
  return sql(
    `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
       operational_status, organization_id, lifecycle, metadata)
     VALUES ($1, $2, 'application', 'application', $3, 'active', $4::uuid, $5, $6::jsonb)`,
    [id, name, opts.criticality ?? 'medium', org, opts.lifecycle ?? 'live', opts.metadata === undefined ? null : JSON.stringify(opts.metadata)])
    .then(async () => {
      for (const ci of opts.ciIds ?? []) {
        await sql(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES ($1, $2, 'supports')`, [ci, id]);
      }
      return id;
    });
};
/** An incident; `reported` / `resolved` are "N minutes ago" (resolved omitted = still open). */
const addIncident = (org: string, ci: string, opts: { priority?: number; status?: string; reportedMin?: number; resolvedMin?: number;
  updatedMin?: number; title?: string; businessImpact?: unknown } = {}) =>
  sql(
    `INSERT INTO itil_incidents (incident_number, title, impact, urgency, priority, affected_ci_id, status, reported_by,
       reported_at, resolved_at, organization_id, business_impact, updated_at)
     VALUES ($1, $2, 'high', 'high', $3, $4, $5, 'op', now() - ($6::int * interval '1 minute'),
       CASE WHEN $7::int IS NULL THEN NULL ELSE now() - ($7::int * interval '1 minute') END, $8::uuid,
       COALESCE($9::jsonb, '{"estimated_user_impact":0,"estimated_revenue_impact":0,"estimated_cost_of_downtime":0,"affected_services":[]}'::jsonb),
       now() - ($10::int * interval '1 minute'))
     RETURNING id`,
    [`INC-${nextId()}`, opts.title ?? 'incident', opts.priority ?? 3, ci, opts.status ?? 'new', opts.reportedMin ?? 10,
      opts.resolvedMin ?? null, org, opts.businessImpact === undefined ? null : JSON.stringify(opts.businessImpact),
      opts.updatedMin ?? 0]);
const addChange = (org: string | null, ci: Node, ago: { minutes: number }, extra: { type?: string; incarnation?: string } = {}) =>
  sql(
    `INSERT INTO ci_change_history (ci_id, change_type, change_source, changed_fields, changed_at, ci_incarnation_id, organization_id)
     VALUES ($1, $2, 'api', ARRAY['status'], now() - ($3::numeric * interval '1 minute'), $4::uuid, $5::uuid)`,
    [ci.id, extra.type ?? 'updated', String(ago.minutes), extra.incarnation ?? ci.incarnation_id, org]);

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  const table = (name: string) => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))![0];
  await sql([table('itil_incidents'), table('dim_business_services'), table('ci_business_service_mappings'), table('ci_change_history'),
    'ALTER TABLE itil_incidents ADD COLUMN organization_id UUID;',
    'ALTER TABLE dim_business_services ADD COLUMN organization_id UUID, ADD COLUMN lifecycle VARCHAR(20) NOT NULL DEFAULT \'live\';',
    'ALTER TABLE ci_change_history ADD COLUMN ci_incarnation_id UUID, ADD COLUMN organization_id UUID;',
  ].join('\n'), [], 'exec');
}, 60_000);
afterAll(() => { host.kill(); });
beforeEach(async () => {
  graph.clear();
  trace = [];
  failStatement = null;
  await sql('TRUNCATE itil_incidents, ci_business_service_mappings, dim_business_services CASCADE; TRUNCATE ci_change_history', [], 'exec');
});

describe('BW8: open-incident ribbon and business_impact on create', () => {
  it('returns an empty ribbon, not an error, for an organization with no incidents', async () => {
    const out = await ribbon(ORG_A);
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ success: true, data: { incidents: [], open_count: 0 } });
  });

  it('lists only open incidents, P1 first then newest, with the payload keys the ribbon needs', async () => {
    addCI('ci-1', ORG_A);
    await addIncident(ORG_A, 'ci-1', { priority: 2, reportedMin: 5, title: 'p2 newer' });
    await addIncident(ORG_A, 'ci-1', { priority: 2, reportedMin: 50, title: 'p2 older' });
    await addIncident(ORG_A, 'ci-1', { priority: 1, reportedMin: 90, title: 'p1', status: 'in_progress' });
    await addIncident(ORG_A, 'ci-1', { priority: 1, reportedMin: 20, title: 'resolved', status: 'resolved', resolvedMin: 1 });
    await addIncident(ORG_A, 'ci-1', { priority: 1, reportedMin: 20, title: 'cancelled', status: 'cancelled' });
    const out = await ribbon(ORG_A);
    expect(out.body.data.incidents.map((i: any) => i.title)).toEqual(['p1', 'p2 newer', 'p2 older']);
    expect(out.body.data.open_count).toBe(3);
    expect(Object.keys(out.body.data.incidents[0]).sort()).toEqual([
      'affected_ci_id', 'affected_service', 'id', 'incident_number', 'opened_at', 'priority', 'revenue_per_hour', 'status',
      'title', 'unavailable', 'users_affected']);
    expect(out.body.data.incidents[0].opened_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it('counts and returns only the caller organization\'s incidents', async () => {
    await addIncident(ORG_A, 'ci-1', { title: 'mine' });
    await addIncident(ORG_B, 'ci-1', { title: 'theirs', priority: 1 });
    const a = await ribbon(ORG_A);
    expect(a.body.data.incidents.map((i: any) => i.title)).toEqual(['mine']);
    expect(a.body.data.open_count).toBe(1);
    expect((await ribbon(ORG_B)).body.data.incidents.map((i: any) => i.title)).toEqual(['theirs']);
  });

  it('keeps open_count at the true total when the limit trims the page', async () => {
    for (let n = 0; n < 4; n++) await addIncident(ORG_A, 'ci-1', { reportedMin: n + 1 });
    const out = await ribbon(ORG_A, { limit: '2' });
    expect(out.body.data.incidents).toHaveLength(2);
    expect(out.body.data.open_count).toBe(4);
  });

  it('rejects a limit outside 1..50 with 400 instead of clamping it', async () => {
    for (const limit of ['0', '51', 'abc', '2.5']) expect((await ribbon(ORG_A, { limit })).statusCode).toBe(400);
  });

  it('derives users and revenue per hour from the affected CI\'s most critical mapped service, null when no figure is recorded', async () => {
    await addService(ORG_A, 'Checkout', { criticality: 'critical', ciIds: ['ci-1'],
      metadata: { user_count: 18420.4, revenue_impact: { annual_revenue_supported: 8_760_000 } } });
    await addService(ORG_A, 'Wiki', { criticality: 'low', ciIds: ['ci-1'], metadata: { user_count: 999_999 } });
    await addService(ORG_A, 'Bare', { ciIds: ['ci-2'], metadata: { user_count: 0, revenue_impact: 5000 } });
    await addIncident(ORG_A, 'ci-1', { priority: 1, title: 'checkout' });
    await addIncident(ORG_A, 'ci-2', { priority: 2, title: 'bare' });
    await addIncident(ORG_A, 'ci-3', { priority: 3, title: 'unmapped' });
    const [checkout, bare, unmapped] = (await ribbon(ORG_A)).body.data.incidents;
    expect(checkout).toMatchObject({ affected_service: { name: 'Checkout' }, users_affected: 18420, revenue_per_hour: 1000, unavailable: [] });
    // A plain-number revenue_impact has no unit and a zero user_count is no figure: both stay null, never 0.
    expect(bare).toMatchObject({ affected_service: { name: 'Bare' }, users_affected: null, revenue_per_hour: null,
      unavailable: ['users_affected', 'revenue_per_hour'] });
    expect(unmapped).toMatchObject({ affected_service: null, users_affected: null, revenue_per_hour: null });
  });

  it('never uses another organization\'s service for a CI id they also map, nor a retired service', async () => {
    await addService(ORG_B, 'Foreign', { ciIds: ['ci-1'], metadata: { user_count: 777 } });
    await addService(ORG_A, 'Old', { lifecycle: 'retired', ciIds: ['ci-1'], metadata: { user_count: 555 } });
    await addIncident(ORG_A, 'ci-1');
    const [incident] = (await ribbon(ORG_A)).body.data.incidents;
    expect(incident).toMatchObject({ affected_service: null, users_affected: null });
  });

  it('prefers a positive stored figure, and falls back to live service metadata for the column\'s zero default', async () => {
    await addService(ORG_A, 'Checkout', { ciIds: ['ci-1'], metadata: { user_count: 100 } });
    await addIncident(ORG_A, 'ci-1', { title: 'stored', priority: 1, businessImpact: { estimated_user_impact: 4200, revenue_per_hour: 35.5 } });
    await addIncident(ORG_A, 'ci-1', { title: 'legacy zeros', priority: 2 });
    const [stored, legacy] = (await ribbon(ORG_A)).body.data.incidents;
    expect(stored).toMatchObject({ users_affected: 4200, revenue_per_hour: 35.5 });
    expect(legacy).toMatchObject({ users_affected: 100, revenue_per_hour: null, unavailable: ['revenue_per_hour'] });
  });

  it('never reports a stored estimated_revenue_impact total (ITIL priority service, seeds) as revenue per hour', async () => {
    await addService(ORG_A, 'Checkout', { ciIds: ['ci-1'], metadata: { user_count: 100, revenue_impact: { annual_revenue_supported: 87_600 } } });
    await addService(ORG_A, 'Bare', { ciIds: ['ci-2'], metadata: { user_count: 100 } });
    await addIncident(ORG_A, 'ci-1', { title: 'total, documented', priority: 1, businessImpact: { estimated_user_impact: 0, estimated_revenue_impact: 125000 } });
    await addIncident(ORG_A, 'ci-2', { title: 'total, undocumented', priority: 2, businessImpact: { estimated_revenue_impact: 125000 } });
    const [documented, undocumented] = (await ribbon(ORG_A)).body.data.incidents;
    // The documented service's live rate wins; an undocumented one is unavailable, not 125000.
    expect(documented).toMatchObject({ revenue_per_hour: 10 });
    expect(undocumented).toMatchObject({ revenue_per_hour: null, unavailable: ['revenue_per_hour'] });
  });

  it('rounds a stored non-integer estimated_user_impact to a whole user', async () => {
    await addService(ORG_A, 'Checkout', { ciIds: ['ci-1'], metadata: { user_count: 100 } });
    await addIncident(ORG_A, 'ci-1', { title: 'fractional', priority: 1, businessImpact: { estimated_user_impact: 4200.6 } });
    await addIncident(ORG_A, 'ci-1', { title: 'sub-one', priority: 2, businessImpact: { estimated_user_impact: 0.4 } });
    const [fractional, subOne] = (await ribbon(ORG_A)).body.data.incidents;
    expect(fractional.users_affected).toBe(4201);
    expect(subOne.users_affected).toBe(100);
  });

  it('createIncident stores the mapped service\'s figures in business_impact, and null (not zero) when none exist', async () => {
    addCI('ci-1', ORG_A);
    addCI('ci-2', ORG_A);
    await addService(ORG_A, 'Checkout', { ciIds: ['ci-1'], metadata: { user_count: 2000, revenue_impact: { annual_revenue_supported: 87_600 } } });
    await addService(ORG_B, 'Foreign', { criticality: 'critical', ciIds: ['ci-1'], metadata: { user_count: 9 } });
    const mapped = await createIncident(ORG_A, 'ci-1');
    expect(mapped.statusCode).toBe(201);
    expect(mapped.body.data.business_impact).toMatchObject({
      estimated_user_impact: 2000, estimated_revenue_impact: null, revenue_per_hour: 10, estimated_cost_of_downtime: null,
      affected_services: [{ name: 'Checkout' }] });
    const unmapped = await createIncident(ORG_A, 'ci-2');
    expect(unmapped.body.data.business_impact).toEqual({
      estimated_user_impact: null, estimated_revenue_impact: null, revenue_per_hour: null, estimated_cost_of_downtime: null,
      affected_services: [] });
    // The create response keeps its existing keys.
    expect(Object.keys(mapped.body).sort()).toEqual(['data', 'message', 'priorityCalculation', 'success']);
  });
});

describe('BW9: recent changes feed', () => {
  it('is an empty feed, not an error, for an organization with no CIs or no changes', async () => {
    expect((await recentChanges(ORG_A)).body).toEqual({ success: true, data: { window: '1h', total: 0, changes: [] } });
    addCI('ci-1', ORG_A);
    expect((await recentChanges(ORG_A)).body.data).toEqual({ window: '1h', total: 0, changes: [] });
  });

  it('returns newest-first changes in the window with CI name and type, and widens to 24h on request', async () => {
    const web = addCI('ci-1', ORG_A, { name: 'web-01', type: 'server' });
    const unnamed = addCI('ci-2', ORG_A);
    await addChange(ORG_A, web, { minutes: 5 });
    await addChange(ORG_A, unnamed, { minutes: 1 }, { type: 'discovered' });
    await addChange(ORG_A, web, { minutes: 120 });
    const hour = (await recentChanges(ORG_A)).body.data;
    expect(hour.total).toBe(2);
    expect(hour.changes.map((c: any) => [c.ci_id, c.ci_name, c.ci_type, c.change_type])).toEqual([
      ['ci-2', null, null, 'discovered'], ['ci-1', 'web-01', 'server', 'updated']]);
    expect(Object.keys(hour.changes[0]).sort()).toEqual([
      'change_source', 'change_type', 'changed_at', 'changed_by', 'changed_fields', 'ci_id', 'ci_name', 'ci_type', 'id']);
    expect((await recentChanges(ORG_A, { window: '24h' })).body.data.total).toBe(3);
  });

  it('never returns or counts another organization\'s rows, NULL-organization rows, or rows of a replaced incarnation', async () => {
    const mine = addCI('ci-1', ORG_A, { name: 'mine' });
    const theirs = addCI('ci-2', ORG_B, { name: 'theirs' });
    await addChange(ORG_A, mine, { minutes: 3 });
    await addChange(ORG_B, theirs, { minutes: 3 });
    // Stamped for A but naming B's CI, and stamped for B but naming A's CI: graph ownership and the stamp must both agree.
    await addChange(ORG_A, theirs, { minutes: 3 });
    await addChange(ORG_B, mine, { minutes: 3 });
    await addChange(null, mine, { minutes: 3 });
    await addChange(ORG_A, mine, { minutes: 3 }, { incarnation: uuid(999_999) });
    const a = (await recentChanges(ORG_A)).body.data;
    expect(a.total).toBe(1);
    expect(a.changes.map((c: any) => c.ci_name)).toEqual(['mine']);
    expect((await recentChanges(ORG_B)).body.data.changes.map((c: any) => c.ci_name)).toEqual(['theirs']);
  });

  it('keeps total at the true count when the limit trims the page, and excludes rows dated in the future', async () => {
    const web = addCI('ci-1', ORG_A);
    for (let n = 1; n <= 5; n++) await addChange(ORG_A, web, { minutes: n });
    await addChange(ORG_A, web, { minutes: -30 });
    const out = (await recentChanges(ORG_A, { limit: '2' })).body.data;
    expect(out.changes).toHaveLength(2);
    expect(out.total).toBe(5);
  });

  it('rejects an unknown window or an out-of-range limit with 400 instead of clamping', async () => {
    for (const query of [{ window: '7d' }, { window: '' }, { limit: '0' }, { limit: '101' }, { limit: 'x' }]) {
      expect((await recentChanges(ORG_A, query)).statusCode).toBe(400);
    }
  });
});

describe('BW10: 24 h service availability', () => {
  it('is an empty list for an organization with no services', async () => {
    expect((await availability(ORG_A)).body).toEqual({ success: true, data: { window_hours: 24, basis: 'incident_derived', services: [] } });
  });

  it('derives availability from P1/P2 incident downtime, merging overlaps and ignoring P3, cancelled and unmapped CIs', async () => {
    const id = await addService(ORG_A, 'Checkout', { criticality: 'critical', ciIds: ['ci-1', 'ci-2'] });
    // [-180,-120] and [-150,-90] overlap: 90 minutes of union. One incident reaches the service through two CIs.
    await addIncident(ORG_A, 'ci-1', { priority: 1, reportedMin: 180, resolvedMin: 120, status: 'resolved' });
    await addIncident(ORG_A, 'ci-2', { priority: 2, reportedMin: 150, resolvedMin: 90, status: 'resolved' });
    await addIncident(ORG_A, 'ci-1', { priority: 3, reportedMin: 600, resolvedMin: 300, status: 'resolved' });
    await addIncident(ORG_A, 'ci-1', { priority: 1, reportedMin: 600, resolvedMin: 300, status: 'cancelled' });
    await addIncident(ORG_A, 'ci-9', { priority: 1, reportedMin: 600, resolvedMin: 300, status: 'resolved' });
    const [service] = (await availability(ORG_A)).body.data.services;
    expect(service).toEqual({ service_id: id, name: 'Checkout', criticality: 'critical', availability_24h_pct: 93.75,
      downtime_minutes_24h: 90, service_affecting_incidents_24h: 2, unavailable: [] });
  });

  it('clips an incident that began before the window and counts a still-open one up to now', async () => {
    await addService(ORG_A, 'Clipped', { criticality: 'critical', ciIds: ['ci-1'] });
    await addService(ORG_A, 'Ongoing', { criticality: 'high', ciIds: ['ci-2'] });
    // Began 25 h ago, resolved 23 h ago: only the 1 h inside the window counts. Open since 60 minutes ago.
    await addIncident(ORG_A, 'ci-1', { priority: 1, reportedMin: 25 * 60, resolvedMin: 23 * 60, status: 'resolved' });
    await addIncident(ORG_A, 'ci-2', { priority: 2, reportedMin: 60, status: 'in_progress' });
    const [clipped, ongoing] = (await availability(ORG_A)).body.data.services;
    expect(clipped.downtime_minutes_24h).toBeCloseTo(60, 1);
    expect(ongoing.downtime_minutes_24h).toBeCloseTo(60, 1);
    expect(ongoing.availability_24h_pct).toBeCloseTo(95.833, 1);
  });

  it('ends a resolved or closed incident that has no resolved_at/closed_at at updated_at, not at now', async () => {
    await addService(ORG_A, 'Finished', { criticality: 'critical', ciIds: ['ci-1'] });
    await addService(ORG_A, 'Ongoing', { criticality: 'high', ciIds: ['ci-2'] });
    // Reported 3 h ago, last updated 2 h ago, never given a resolution timestamp: 60 minutes of downtime.
    await addIncident(ORG_A, 'ci-1', { priority: 1, reportedMin: 180, updatedMin: 120, status: 'closed' });
    // A still-open incident is unaffected by updated_at: it runs to now.
    await addIncident(ORG_A, 'ci-2', { priority: 1, reportedMin: 180, updatedMin: 120, status: 'in_progress' });
    const [finished, ongoing] = (await availability(ORG_A)).body.data.services;
    expect(finished.downtime_minutes_24h).toBeCloseTo(60, 1);
    expect(ongoing.downtime_minutes_24h).toBeCloseTo(180, 1);
  });

  it('reads 100 for a mapped service with no incident, and null (listed as unavailable) for a service with no mapped CI', async () => {
    await addService(ORG_A, 'Quiet', { criticality: 'critical', ciIds: ['ci-1'] });
    await addService(ORG_A, 'Unmapped', { criticality: 'high' });
    const [quiet, unmapped] = (await availability(ORG_A)).body.data.services;
    expect(quiet).toMatchObject({ availability_24h_pct: 100, downtime_minutes_24h: 0, service_affecting_incidents_24h: 0, unavailable: [] });
    expect(unmapped).toMatchObject({ availability_24h_pct: null, downtime_minutes_24h: null, service_affecting_incidents_24h: null,
      unavailable: ['availability_24h_pct', 'downtime_minutes_24h', 'service_affecting_incidents_24h'] });
  });

  it('never lists another organization\'s service nor counts its incidents against ours', async () => {
    await addService(ORG_A, 'Mine', { ciIds: ['ci-1'] });
    await addService(ORG_B, 'Theirs', { criticality: 'critical', ciIds: ['ci-1'] });
    // B's P1 on a CI id that A's service also maps: not an outage of A's service.
    await addIncident(ORG_B, 'ci-1', { priority: 1, reportedMin: 120, resolvedMin: 60, status: 'resolved' });
    const a = (await availability(ORG_A)).body.data.services;
    expect(a.map((s: any) => [s.name, s.availability_24h_pct])).toEqual([['Mine', 100]]);
    const b = (await availability(ORG_B)).body.data.services;
    expect(b.map((s: any) => [s.name, s.downtime_minutes_24h])).toEqual([['Theirs', 60]]);
  });

  it('lists live and retiring services only, most critical first then by name, up to the limit', async () => {
    await addService(ORG_A, 'b-low', { criticality: 'low', ciIds: ['ci-1'] });
    await addService(ORG_A, 'a-critical', { criticality: 'critical', ciIds: ['ci-1'] });
    await addService(ORG_A, 'c-critical', { criticality: 'critical', lifecycle: 'retiring', ciIds: ['ci-1'] });
    await addService(ORG_A, 'planned', { criticality: 'critical', lifecycle: 'planned', ciIds: ['ci-1'] });
    await addService(ORG_A, 'retired', { criticality: 'critical', lifecycle: 'retired', ciIds: ['ci-1'] });
    expect((await availability(ORG_A)).body.data.services.map((s: any) => s.name)).toEqual(['a-critical', 'c-critical', 'b-low']);
    expect((await availability(ORG_A, { limit: '1' })).body.data.services.map((s: any) => s.name)).toEqual(['a-critical']);
  });

  it('rejects a limit outside 1..50 with 400 instead of clamping it', async () => {
    for (const limit of ['0', '51', 'abc']) expect((await availability(ORG_A, { limit })).statusCode).toBe(400);
  });
});

describe('bounded estate reads: statement timeout, 503 mapping, absent ITIL table, end-time predicate', () => {
  const timeoutError = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  /** Both feeds; each seeds what it needs so that its incident statement actually runs. */
  const feeds: Array<{ name: string; seed: () => Promise<unknown>; run: () => Promise<ReturnType<typeof res>>;
    incidentStatement: (text: string) => boolean }> = [
    { name: 'open-incident ribbon', seed: () => addIncident(ORG_A, 'ci-1', { priority: 1 }), run: () => ribbon(ORG_A),
      incidentStatement: text => text.includes('FROM itil_incidents WHERE') },
    { name: 'service availability', seed: () => addService(ORG_A, 'Checkout', { ciIds: ['ci-1'] }), run: () => availability(ORG_A),
      incidentStatement: text => text.includes('FROM itil_incidents i') },
  ];
  const setConfigs = () => trace.filter(entry => entry.text.startsWith(`SELECT set_config('statement_timeout'`));
  const withEnv = async (value: string | undefined, run: () => Promise<void>) => {
    const before = process.env['ESTATE_FEED_TIMEOUT_MS'];
    if (value === undefined) delete process.env['ESTATE_FEED_TIMEOUT_MS']; else process.env['ESTATE_FEED_TIMEOUT_MS'] = value;
    try { await run(); } finally {
      if (before === undefined) delete process.env['ESTATE_FEED_TIMEOUT_MS']; else process.env['ESTATE_FEED_TIMEOUT_MS'] = before;
    }
  };

  for (const feed of feeds) {
    describe(feed.name, () => {
      it('sets a transaction-local statement_timeout before any incident statement, and commits', async () => {
        await feed.seed();
        trace = [];
        const out = await feed.run();
        expect(out.statusCode).toBe(200);
        expect(trace[0]).toEqual({ text: 'BEGIN' });
        expect(trace.at(-1)).toEqual({ text: 'COMMIT' });
        expect(setConfigs()).toHaveLength(1);
        expect(trace[1]!.text).toBe(`SELECT set_config('statement_timeout', $1, true)`);
        expect(trace[1]!.params).toEqual(['5000']);
        expect(trace.some(entry => feed.incidentStatement(entry.text))).toBe(true);
      });

      it('takes the timeout from ESTATE_FEED_TIMEOUT_MS, and falls back to 5000 for an invalid value', async () => {
        await feed.seed();
        await withEnv('1234', async () => {
          trace = [];
          await feed.run();
          expect(setConfigs().map(entry => entry.params)).toEqual([['1234']]);
        });
        for (const invalid of ['abc', '0', '-5', '2.5', '2147483648', '']) {
          await withEnv(invalid, async () => {
            trace = [];
            await feed.run();
            expect(setConfigs().map(entry => entry.params)).toEqual([['5000']]);
          });
        }
      });

      it('answers 503 Analytics resource limit exceeded when a statement hits the statement timeout (57014), and rolls back', async () => {
        await feed.seed();
        failStatement = { when: feed.incidentStatement, error: timeoutError() };
        const out = await feed.run();
        expect(out.statusCode).toBe(503);
        expect(out.body).toEqual({ success: false, error: 'Analytics resource limit exceeded' });
        expect(trace.at(-1)).toEqual({ text: 'ROLLBACK' });
      });

      it('keeps a 500 for any other failure, SQLSTATE or not', async () => {
        await feed.seed();
        for (const error of [Object.assign(new Error('deadlock detected'), { code: '40P01' }), new Error('boom')]) {
          failStatement = { when: feed.incidentStatement, error };
          const out = await feed.run();
          expect(out.statusCode).toBe(500);
          expect(out.body.success).toBe(false);
          expect(out.body.error).not.toBe('Analytics resource limit exceeded');
        }
      });
    });
  }

  describe('service availability without the ITIL incident table', () => {
    const NONE = ['availability_24h_pct', 'downtime_minutes_24h', 'service_affecting_incidents_24h'];
    for (const [what, hide, restore] of [
      ['no itil_incidents table', 'ALTER TABLE itil_incidents RENAME TO itil_incidents_x', 'ALTER TABLE itil_incidents_x RENAME TO itil_incidents'],
      ['no itil_incidents.organization_id', 'ALTER TABLE itil_incidents RENAME COLUMN organization_id TO organization_id_x',
        'ALTER TABLE itil_incidents RENAME COLUMN organization_id_x TO organization_id'],
    ] as const) {
      it(`lists every service with three null figures and all three names unavailable, HTTP 200, for ${what}`, async () => {
        await addService(ORG_A, 'Mapped', { criticality: 'critical', ciIds: ['ci-1'] });
        await addService(ORG_A, 'Unmapped', { criticality: 'high' });
        await sql(hide, [], 'exec');
        try {
          const out = await availability(ORG_A);
          expect(out.statusCode).toBe(200);
          expect(out.body.data.services.map((s: any) => [s.name, s.availability_24h_pct, s.downtime_minutes_24h,
            s.service_affecting_incidents_24h, s.unavailable])).toEqual([
            ['Mapped', null, null, null, NONE], ['Unmapped', null, null, null, NONE]]);
          expect(trace.some(entry => entry.text.includes('FROM itil_incidents i'))).toBe(false);
        } finally {
          await sql(restore, [], 'exec');
        }
      });
    }
  });

  describe('availability end-time predicate', () => {
    // The pre-rewrite condition, kept here as the oracle.
    const OLD_END = `COALESCE(i.resolved_at, i.closed_at, CASE WHEN i.status IN ('resolved', 'closed') THEN i.updated_at ELSE now() END)`;
    const CUT = `now() - interval '24 hours'`;

    it('selects exactly the rows the COALESCE condition selects, for every NULL / status / cutoff combination', async () => {
      // Each timestamp column: NULL, before the cutoff, after the cutoff. updated_at too (it is the finished-status arm).
      const rows = await sql(
        `WITH ts(v) AS (VALUES (NULL::timestamptz), (now() - interval '48 hours'), (now() - interval '1 hour')),
              combo AS (SELECT r.v AS resolved_at, c.v AS closed_at, u.v AS updated_at, s.status
                        FROM ts r, ts c, ts u, (VALUES ('resolved'), ('closed'), ('in_progress')) AS s(status))
         SELECT i.resolved_at IS NULL AS r_null, i.closed_at IS NULL AS c_null, i.status,
                (${OLD_END} > ${CUT}) IS TRUE AS old_selects,
                (${incidentEndsAfter(CUT)}) IS TRUE AS new_selects
         FROM combo i`);
      expect(rows).toHaveLength(81);
      expect(rows.filter(row => row['old_selects'] !== row['new_selects'])).toEqual([]);
      // Not vacuous: the combinations are split between selected and not.
      const selected = rows.filter(row => row['old_selects']).length;
      expect(selected).toBeGreaterThan(0);
      expect(selected).toBeLessThan(81);
    });
  });
});
