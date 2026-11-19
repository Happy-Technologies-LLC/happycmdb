// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * PATCH /itil/incidents/:id stamps resolved_at / closed_at once, on the transition (follow-up to HAP-1926, HAP-2150).
 *
 * The service-availability downtime interval ends at COALESCE(resolved_at, closed_at, updated_at for a finished
 * incident), so a resolved incident without a stamp has its downtime extended by every later write that bumps
 * updated_at. The SQL runs on real PostgreSQL (PGlite, hosted by ../../routes/__tests__/fixtures/pglite-host.cjs) over
 * the itil_incidents DDL of 001_complete_schema.sql plus organization_id; the pool wrapper records each statement sent.
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
jest.mock('bcrypt', () => ({}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { ITILController } from '../itil.controller';
import { readServiceAvailability } from '../../../services/service-availability.service';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

const host = fork(join(__dirname, '../../routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let serial = 0;
const pending = new Map<number, PromiseWithResolvers<Record<string, any>[]>>();
host.on('message', ({ id, rows, error }: { id: number; rows: Record<string, any>[]; error?: string }) => {
  const entry = pending.get(id)!;
  pending.delete(id);
  if (error) entry.reject(new Error(error));
  else entry.resolve(rows);
});
function sql(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const entry = Promise.withResolvers<Record<string, any>[]>();
  pending.set(id, entry);
  host.send({ id, op, sql: text, params });
  return entry.promise;
}

/** Statements the controller sent, in order. */
let sent: Array<{ text: string; params: unknown[] }> = [];
const pool = {
  query: async (text: string, params: unknown[] = []) => {
    sent.push({ text, params });
    return { rows: await sql(text, params) };
  },
};

function res() {
  const out = { statusCode: 200, body: undefined as any, status: jest.fn(), json: jest.fn() };
  out.status.mockImplementation((code: unknown) => { out.statusCode = code as number; return out; });
  out.json.mockImplementation((body: unknown) => { out.body = body; return out; });
  return out;
}
async function patch(org: string, id: string, body: Record<string, unknown>) {
  (getPostgresClient as jest.Mock).mockReturnValue({ pool });
  const out = res();
  await new ITILController().updateIncident(
    { user: { _organizationId: org }, params: { id }, body } as unknown as Request, out as unknown as Response);
  return out;
}
const lastUpdate = () => sent.filter(s => s.text.includes('UPDATE itil_incidents')).at(-1)!;
const row = async (id: string) => (await sql('SELECT * FROM itil_incidents WHERE id = $1', [id]))[0];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let counter = 0;
/** An open P1 incident of `org` on `ci`, reported an hour ago. */
const addIncident = async (org: string, ci = 'ci-1', status = 'in_progress') => (await sql(
  `INSERT INTO itil_incidents (incident_number, title, impact, urgency, priority, affected_ci_id, status, reported_by,
     reported_at, organization_id)
   VALUES ($1, 't', 'high', 'high', 1, $2, $3, 'op', now() - interval '60 minutes', $4::uuid) RETURNING id`,
  [`INC-RS-${++counter}`, ci, status, org]))[0]['id'] as string;

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  const table = (name: string) => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))![0];
  await sql([table('itil_incidents'), table('dim_business_services'), table('ci_business_service_mappings'),
    'ALTER TABLE itil_incidents ADD COLUMN organization_id UUID;',
    'ALTER TABLE dim_business_services ADD COLUMN organization_id UUID, ADD COLUMN lifecycle VARCHAR(20) NOT NULL DEFAULT \'live\';',
  ].join('\n'), [], 'exec');
  (getNeo4jClient as jest.Mock).mockReturnValue({});
}, 60_000);
afterAll(() => { host.kill(); });
beforeEach(async () => {
  sent = [];
  await sql('TRUNCATE itil_incidents, ci_business_service_mappings, dim_business_services CASCADE', [], 'exec');
});

describe('statement sent by PATCH /itil/incidents/:id', () => {
  it.each([
    ['RESOLVED', 'resolved_at = COALESCE(resolved_at, NOW())', 'closed_at'],
    ['resolved', 'resolved_at = COALESCE(resolved_at, NOW())', 'closed_at'],
    ['CLOSED', 'closed_at = COALESCE(closed_at, NOW())', 'resolved_at'],
  ])('status %s stamps its own column through COALESCE and not the other', async (status, stamp, other) => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status });
    const set = lastUpdate().text.split('WHERE')[0]!;
    expect(set).toContain(stamp);
    expect(set).not.toContain(other);
  });

  it.each([
    ['IN_PROGRESS status', { status: 'IN_PROGRESS' }],
    ['ASSIGNED status', { status: 'ASSIGNED' }],
    ['assignedTo only', { assignedTo: 'alice' }],
    ['priority only', { priority: 2 }],
  ])('%s touches neither resolved_at nor closed_at', async (_name, body) => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, body);
    const set = lastUpdate().text.split('WHERE')[0]!;
    expect(set).not.toContain('resolved_at');
    expect(set).not.toContain('closed_at');
    const after = await row(id);
    expect(after['resolved_at']).toBeNull();
    expect(after['closed_at']).toBeNull();
  });

  it('keeps the caller organization bound to the organization_id predicate', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    const { text, params } = lastUpdate();
    const placeholder = text.match(/organization_id = \$(\d+)/);
    expect(placeholder).not.toBeNull();
    expect(params[Number(placeholder![1]) - 1]).toBe(ORG_A);
  });

  it('answers 404 for another organization incident and leaves it unmodified', async () => {
    const id = await addIncident(ORG_A);
    const before = await row(id);
    const out = await patch(ORG_B, id, { status: 'RESOLVED' });
    expect(out.statusCode).toBe(404);
    expect(await row(id)).toEqual(before);
  });
});

describe('stamp semantics on PostgreSQL', () => {
  it('stamps resolved_at on RESOLVED and a later priority PATCH does not move it', async () => {
    const id = await addIncident(ORG_A);
    const out = await patch(ORG_A, id, { status: 'RESOLVED' });
    expect(out.statusCode).toBe(200);
    const first = (await row(id))['resolved_at'] as Date;
    expect(Number.isNaN(first.getTime())).toBe(false);
    expect(out.body.data.resolved_at).toEqual(first);
    await pause(50);
    await patch(ORG_A, id, { priority: 2 });
    const after = await row(id);
    expect(after['resolved_at']).toEqual(first);
    expect(after['updated_at'].getTime()).toBeGreaterThan(first.getTime());
  });

  it('a second RESOLVED PATCH does not move resolved_at', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    const first = (await row(id))['resolved_at'] as Date;
    await pause(50);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    expect((await row(id))['resolved_at']).toEqual(first);
  });

  it('CLOSED after RESOLVED stamps closed_at and keeps resolved_at; a repeat CLOSED keeps closed_at', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    const resolved = (await row(id))['resolved_at'] as Date;
    await pause(50);
    await patch(ORG_A, id, { status: 'CLOSED' });
    const closedRow = await row(id);
    expect(closedRow['resolved_at']).toEqual(resolved);
    const closed = closedRow['closed_at'] as Date;
    expect(closed.getTime()).toBeGreaterThan(resolved.getTime());
    await pause(50);
    await patch(ORG_A, id, { status: 'CLOSED' });
    expect((await row(id))['closed_at']).toEqual(closed);
  });

  it('does not stamp when the status moves to a state other than resolved or closed', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'ASSIGNED' });
    const after = await row(id);
    expect(after['status']).toBe('assigned');
    expect(after['resolved_at']).toBeNull();
    expect(after['closed_at']).toBeNull();
  });
});

describe('downstream: service availability downtime end', () => {
  it('ends at resolved_at, not at the updated_at of a later PATCH', async () => {
    const serviceId = 'bs-resolved-stamp';
    await sql(
      `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
         operational_status, organization_id, lifecycle)
       VALUES ($1, 'Checkout', 'application', 'application', 'critical', 'active', $2::uuid, 'live')`, [serviceId, ORG_A]);
    await sql(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES ('ci-1', $1, 'supports')`, [serviceId]);
    const id = await addIncident(ORG_A);
    const downtime = async () => (await readServiceAvailability(pool, ORG_A, 5)).services[0]!.downtime_minutes_24h;

    await patch(ORG_A, id, { status: 'RESOLVED' });
    const resolvedAt = (await row(id))['resolved_at'] as Date;
    const reportedAt = (await row(id))['reported_at'] as Date;
    const atResolve = await downtime();
    expect(atResolve).toBe(Math.round(((resolvedAt.getTime() - reportedAt.getTime()) / 60_000) * 100) / 100);

    await pause(2000);
    await patch(ORG_A, id, { priority: 2 });
    expect(await downtime()).toBe(atResolve);
  }, 30_000);
});
