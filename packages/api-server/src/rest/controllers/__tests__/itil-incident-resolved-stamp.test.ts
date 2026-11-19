// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * PATCH /itil/incidents/:id stamps resolved_at / closed_at once, on the transition (follow-up to HAP-1926, HAP-2150).
 *
 * The service-availability downtime interval ends at COALESCE(resolved_at, closed_at, updated_at for a finished
 * incident), so a resolved incident without a stamp has its downtime extended by every later write that bumps
 * updated_at. The SQL runs on real PostgreSQL (PGlite, hosted by ../../routes/__tests__/fixtures/pglite-host.cjs) over
 * the itil_incidents DDL of 001_complete_schema.sql plus organization_id.
 * Timestamps are moved explicitly by SQL (setStamps); nothing waits on the wall clock.
 * Reopen (HAP-2150 fix round 1): a move back to new / assigned / in_progress clears resolved_at and closed_at.
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

const pool = {
  query: async (text: string, params: unknown[] = []) => {
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
const row = async (id: string) => (await sql('SELECT * FROM itil_incidents WHERE id = $1', [id]))[0];
/** Moves a stamp or timestamp explicitly, so no test depends on wall-clock spacing between statements. */
const setStamps = (id: string, set: string) => sql(`UPDATE itil_incidents SET ${set} WHERE id = $1`, [id]);
const FIXED_RESOLVED = '2026-01-01T00:00:00.000Z';
const FIXED_CLOSED = '2026-01-02T00:00:00.000Z';

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
  await sql('TRUNCATE itil_incidents, ci_business_service_mappings, dim_business_services CASCADE', [], 'exec');
});

describe('stamp semantics on PostgreSQL', () => {
  it('stamps resolved_at on RESOLVED, and a later priority or assignee PATCH does not move it', async () => {
    const id = await addIncident(ORG_A);
    const before = Date.now();
    const out = await patch(ORG_A, id, { status: 'RESOLVED' });
    const after = Date.now();
    expect(out.statusCode).toBe(200);
    const stamped = (await row(id))['resolved_at'] as Date;
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThanOrEqual(after);
    expect(out.body.data.resolved_at).toEqual(stamped);
    expect((await row(id))['closed_at']).toBeNull();

    await setStamps(id, `resolved_at = '${FIXED_RESOLVED}'`);
    await patch(ORG_A, id, { priority: 2 });
    await patch(ORG_A, id, { assignedTo: 'alice' });
    const later = await row(id);
    expect(later['resolved_at']).toEqual(new Date(FIXED_RESOLVED));
    expect(later['updated_at'].getTime()).toBeGreaterThan(new Date(FIXED_RESOLVED).getTime());
  });

  it('a repeat RESOLVED PATCH does not move resolved_at', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    await setStamps(id, `resolved_at = '${FIXED_RESOLVED}'`);
    await patch(ORG_A, id, { status: 'resolved' });
    expect((await row(id))['resolved_at']).toEqual(new Date(FIXED_RESOLVED));
  });

  it('CLOSED after RESOLVED stamps closed_at and keeps resolved_at; a repeat CLOSED keeps closed_at', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    await setStamps(id, `resolved_at = '${FIXED_RESOLVED}'`);
    const before = Date.now();
    await patch(ORG_A, id, { status: 'CLOSED' });
    const after = Date.now();
    const closedRow = await row(id);
    expect(closedRow['resolved_at']).toEqual(new Date(FIXED_RESOLVED));
    expect(closedRow['closed_at'].getTime()).toBeGreaterThanOrEqual(before);
    expect(closedRow['closed_at'].getTime()).toBeLessThanOrEqual(after);

    await setStamps(id, `closed_at = '${FIXED_CLOSED}'`);
    await patch(ORG_A, id, { status: 'CLOSED' });
    expect((await row(id))['closed_at']).toEqual(new Date(FIXED_CLOSED));
  });

  it('a move between open statuses leaves both stamps NULL', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'ASSIGNED' });
    const after = await row(id);
    expect(after['status']).toBe('assigned');
    expect(after['resolved_at']).toBeNull();
    expect(after['closed_at']).toBeNull();
  });
});

describe('reopen: a move from a finished status back to an open one clears the stamps', () => {
  it.each(['NEW', 'ASSIGNED', 'IN_PROGRESS'])('%s clears resolved_at and closed_at', async (status) => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    await patch(ORG_A, id, { status: 'CLOSED' });
    expect((await row(id))['closed_at']).not.toBeNull();
    const out = await patch(ORG_A, id, { status });
    expect(out.statusCode).toBe(200);
    const after = await row(id);
    expect(after['status']).toBe(status.toLowerCase());
    expect(after['resolved_at']).toBeNull();
    expect(after['closed_at']).toBeNull();
    expect(out.body.data.resolved_at).toBeNull();
    expect(out.body.data.closed_at).toBeNull();
  });

  it('a re-resolve stamps a fresh resolved_at instead of keeping the first one', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    await setStamps(id, `resolved_at = '${FIXED_RESOLVED}'`);
    await patch(ORG_A, id, { status: 'IN_PROGRESS' });
    const before = Date.now();
    await patch(ORG_A, id, { status: 'RESOLVED' });
    expect(((await row(id))['resolved_at'] as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a priority or assignee PATCH on a resolved incident is not a reopen', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    await setStamps(id, `resolved_at = '${FIXED_RESOLVED}'`);
    await patch(ORG_A, id, { priority: 3, assignedTo: 'bob' });
    expect((await row(id))['resolved_at']).toEqual(new Date(FIXED_RESOLVED));
  });

  it('answers 404 for another organization reopen and leaves the stamps in place', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    const before = await row(id);
    const out = await patch(ORG_B, id, { status: 'IN_PROGRESS' });
    expect(out.statusCode).toBe(404);
    expect(await row(id)).toEqual(before);
  });
});

describe('tenant boundary', () => {
  it('answers 404 for another organization incident and leaves it unmodified', async () => {
    const id = await addIncident(ORG_A);
    const before = await row(id);
    const out = await patch(ORG_B, id, { status: 'RESOLVED' });
    expect(out.statusCode).toBe(404);
    expect(await row(id)).toEqual(before);
  });
});

describe('downstream: service availability downtime end', () => {
  const serviceId = 'bs-resolved-stamp';
  const downtime = async () => (await readServiceAvailability(pool, ORG_A, 5)).services[0]!.downtime_minutes_24h;
  const minutesBetween = (from: Date, to: Date) => Math.round(((to.getTime() - from.getTime()) / 60_000) * 100) / 100;
  beforeEach(async () => {
    await sql(
      `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality,
         operational_status, organization_id, lifecycle)
       VALUES ($1, 'Checkout', 'application', 'application', 'critical', 'active', $2::uuid, 'live')`, [serviceId, ORG_A]);
    await sql(`INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type) VALUES ('ci-1', $1, 'supports')`, [serviceId]);
  });

  it('ends at resolved_at, not at the updated_at of a later PATCH', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    const resolved = await row(id);
    const atResolve = await downtime();
    expect(atResolve).toBe(minutesBetween(resolved['reported_at'], resolved['resolved_at']));

    // Advance updated_at by an explicit hour: the downtime must not follow it.
    await setStamps(id, `updated_at = updated_at + interval '60 minutes'`);
    await patch(ORG_A, id, { priority: 2 });
    expect(await downtime()).toBe(atResolve);
  });

  it('resolve, reopen, the outage keeps growing, re-resolve ends at the new stamp', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    // First resolution 30 minutes ago: 30 of the 60 minutes since the report.
    await setStamps(id, `resolved_at = now() - interval '30 minutes'`);
    const firstResolution = await downtime();
    expect(firstResolution).toBeGreaterThan(29.9);
    expect(firstResolution).toBeLessThan(30.1);

    // Reopened: the outage is live again and counts to now, not to the first resolution.
    await patch(ORG_A, id, { status: 'IN_PROGRESS' });
    const reopened = await downtime();
    expect(reopened).toBeGreaterThan(59.9);
    // The outage started 10 minutes earlier: the live downtime grows by exactly those 10 minutes.
    await setStamps(id, `reported_at = reported_at - interval '10 minutes'`);
    expect(await downtime()).toBeGreaterThanOrEqual(reopened + 10 - 0.02);

    // Re-resolve: ends at the new stamp, not at the first resolution and not at a later updated_at.
    await patch(ORG_A, id, { status: 'RESOLVED' });
    const final = await row(id);
    expect((final['resolved_at'] as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const atReResolve = await downtime();
    expect(atReResolve).toBe(minutesBetween(final['reported_at'], final['resolved_at']));
    expect(atReResolve).toBeGreaterThan(69.9);
    await setStamps(id, `updated_at = updated_at + interval '60 minutes'`);
    expect(await downtime()).toBe(atReResolve);
  });
});

describe('MTTR of a reopened incident', () => {
  const mttr = async () => {
    (getPostgresClient as jest.Mock).mockReturnValue({ pool });
    const out = res();
    await new ITILController().getMeanTimeToResolve(
      { user: { _organizationId: ORG_A } } as unknown as Request, out as unknown as Response);
    return out.body.data.mttr as string;
  };

  it('measures to the latest resolution, not the first', async () => {
    const id = await addIncident(ORG_A);
    await patch(ORG_A, id, { status: 'RESOLVED' });
    // First resolution 45 minutes ago: reported 60 minutes ago, so 0.25 h.
    await setStamps(id, `resolved_at = now() - interval '45 minutes'`);
    expect(await mttr()).toBe('0.25');

    await patch(ORG_A, id, { status: 'IN_PROGRESS' });
    await patch(ORG_A, id, { status: 'RESOLVED' });
    // Re-resolved now: reported 60 minutes ago, so 1.00 h.
    expect(await mttr()).toBe('1.00');
  });
});
