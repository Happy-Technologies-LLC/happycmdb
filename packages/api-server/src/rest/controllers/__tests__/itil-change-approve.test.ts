// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /itil/changes/:id/approve and PATCH /itil/changes/:id {status: APPROVED} record who approved and when,
 * and only from a pre-approval status (draft, pending_approval); moving back to one clears the stamp.
 *
 * The SQL runs on real PostgreSQL (PGlite, hosted by ../../routes/__tests__/fixtures/pglite-host.cjs) over the
 * itil_changes DDL of 001_complete_schema.sql plus migrations 035 (organization_id) and 040. Timestamps are moved
 * explicitly by SQL; nothing waits on the wall clock. GraphQL `approveChange` and `updateChange` call the same
 * controller methods.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { fork } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Request, Response } from 'express';

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual<object>('@cmdb/common'),
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(), getPostgresClient: jest.fn(),
  isStorableString: (value: string) => !value.includes('\u0000'),
}));
jest.mock('bcrypt', () => ({}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { ITILController } from '../itil.controller';

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
  query: async (text: string, params: unknown[] = []) => ({ rows: await sql(text, params) }),
};

function res() {
  const out = { statusCode: 200, body: undefined as any, status: jest.fn(), json: jest.fn() };
  out.status.mockImplementation((code: unknown) => { out.statusCode = code as number; return out; });
  out.json.mockImplementation((body: unknown) => { out.body = body; return out; });
  return out;
}
async function approve(user: Record<string, unknown>, id: string, body: Record<string, unknown> = {}) {
  (getPostgresClient as jest.Mock).mockReturnValue({ pool });
  const out = res();
  await new ITILController().approveChange(
    { user, params: { id }, body } as unknown as Request, out as unknown as Response);
  return out;
}
async function patch(user: Record<string, unknown>, id: string, body: Record<string, unknown>) {
  (getPostgresClient as jest.Mock).mockReturnValue({ pool });
  const out = res();
  await new ITILController().updateChange(
    { user, params: { id }, body } as unknown as Request, out as unknown as Response);
  return out;
}
const U1 = { _userId: 'u-1', _organizationId: ORG_A };
const U2 = { _userId: 'u-2', _organizationId: ORG_A };
const row = async (id: string) => (await sql('SELECT * FROM itil_changes WHERE id = $1', [id]))[0];
const FIXED_APPROVED = '2026-01-01T00:00:00.000Z';

let counter = 0;
/** A change of `org`, requested by alice, in `status`, with the schema-default approval columns. */
const addChange = async (org: string, status = 'pending_approval') => (await sql(
  `INSERT INTO itil_changes (change_number, title, change_type, requested_by, status, organization_id)
   VALUES ($1, 'Patch the checkout pool', 'normal', 'alice', $2, $3::uuid) RETURNING id`,
  [`CHG-AP-${++counter}`, status, org]))[0]['id'] as string;

beforeAll(async () => {
  const migrationDir = join(__dirname, '../../../../../database/src/postgres/migrations');
  const schema = readFileSync(join(migrationDir, '001_complete_schema.sql'), 'utf8');
  const table = (name: string) => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))![0];
  await sql(['itil_baselines', 'itil_incidents', 'itil_changes'].map(table).join('\n'), [], 'exec');
  for (const file of ['012_itil_baseline_organization_scope.sql', '013_itil_baseline_org_name_unique.sql',
    '035_itil_record_ownership.sql', '040_itil_change_implementation_fields.sql']) {
    const path = join(migrationDir, file);
    if (existsSync(path)) await sql(readFileSync(path, 'utf8'), [], 'exec');
  }
  (getNeo4jClient as jest.Mock).mockReturnValue({});
}, 60_000);
afterAll(() => { host.kill(); });
beforeEach(async () => {
  await sql('DELETE FROM itil_changes', [], 'exec');
});

describe('POST /itil/changes/:id/approve records the approver', () => {
  it('stamps approved_by from the verified user, approval_status and approved_at', async () => {
    const id = await addChange(ORG_A);
    const seeded = await row(id);
    expect(seeded['approval_status']).toBe('pending');
    expect(seeded['approved_by']).toBeNull();
    expect(seeded['approved_at']).toBeNull();

    const before = Date.now();
    const out = await approve(U1, id);
    const after = Date.now();
    expect(out.statusCode).toBe(200);
    const stored = await row(id);
    expect(stored['status']).toBe('approved');
    expect(stored['approval_status']).toBe('approved');
    expect(stored['approved_by']).toBe('u-1');
    expect((stored['approved_at'] as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((stored['approved_at'] as Date).getTime()).toBeLessThanOrEqual(after);
    expect(out.body.success).toBe(true);
    expect(out.body.message).toBe('Change approved successfully');
    expect(out.body.data.status).toBe('approved');
    expect(out.body.data.approval_status).toBe('approved');
    expect(out.body.data.approved_by).toBe('u-1');
    expect(out.body.data.approved_at).toEqual(stored['approved_at']);
  });

  it('a repeat approval is refused 409 and keeps the approver and the time', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    await sql(`UPDATE itil_changes SET approved_at = '${FIXED_APPROVED}' WHERE id = $1`, [id]);
    const before = await row(id);
    const out = await approve(U2, id);
    expect(out.statusCode).toBe(409);
    expect(out.body.code).toBe('CHANGE_NOT_APPROVABLE');
    expect(await row(id)).toEqual(before);
    expect(before['approved_by']).toBe('u-1');
    expect(before['approved_at']).toEqual(new Date(FIXED_APPROVED));
  });

  it('approves from draft as well as pending_approval', async () => {
    const id = await addChange(ORG_A, 'draft');
    expect((await approve(U1, id)).statusCode).toBe(200);
    expect((await row(id))['approved_by']).toBe('u-1');
  });

  it.each(['scheduled', 'in_progress', 'implemented', 'closed', 'cancelled'])(
    'refuses approval of a %s change with 409 and writes nothing', async status => {
      const id = await addChange(ORG_A, status);
      const before = await row(id);
      const out = await approve(U1, id);
      expect(out.statusCode).toBe(409);
      expect(out.body).toEqual({ success: false, error: 'Conflict', code: 'CHANGE_NOT_APPROVABLE',
        message: 'Only a draft or pending_approval change can be approved' });
      expect(await row(id)).toEqual(before);
    });

  it('does not trust a body field for the approver', async () => {
    const id = await addChange(ORG_A);
    const out = await approve(U1, id, { approvedBy: 'attacker', approved_by: 'attacker' });
    expect(out.statusCode).toBe(200);
    expect((await row(id))['approved_by']).toBe('u-1');
  });

  it('falls back to _username when the token carries no _userId', async () => {
    const id = await addChange(ORG_A);
    const out = await approve({ _username: 'alice', _organizationId: ORG_A }, id);
    expect(out.statusCode).toBe(200);
    expect((await row(id))['approved_by']).toBe('alice');
  });

  it('answers 401 without a usable identity and writes nothing', async () => {
    const id = await addChange(ORG_A);
    const before = await row(id);
    const out = await approve({ _organizationId: ORG_A }, id);
    expect(out.statusCode).toBe(401);
    expect(out.body.success).toBe(false);
    expect(out.body.error).toBe('Unauthorized');
    const stored = await row(id);
    expect(stored).toEqual(before);
    expect(stored['status']).toBe('pending_approval');
    expect(stored['approval_status']).toBe('pending');
    expect(stored['approved_by']).toBeNull();
  });
});

describe('tenant boundary and unknown ids', () => {
  it('answers 404 for another organization change and leaves it unmodified', async () => {
    const id = await addChange(ORG_A);
    const before = await row(id);
    const out = await approve({ _userId: 'u-9', _organizationId: ORG_B }, id);
    expect(out.statusCode).toBe(404);
    expect(out.body).toEqual({ success: false, error: 'Not Found', message: 'Change not found' });
    expect(await row(id)).toEqual(before);
  });

  it('answers 404 for an unknown change id', async () => {
    const out = await approve(U1, '33333333-3333-4333-8333-333333333333');
    expect(out.statusCode).toBe(404);
    expect(out.body.message).toBe('Change not found');
  });
});

describe('moving back to a pre-approval status clears the approval stamp', () => {
  it.each(['PENDING_APPROVAL', 'DRAFT'])('PATCH %s clears approved_by and approved_at; a later approve records the new approver',
    async status => {
      const id = await addChange(ORG_A);
      await approve(U1, id);
      await sql(`UPDATE itil_changes SET approved_at = '${FIXED_APPROVED}' WHERE id = $1`, [id]);

      const back = await patch(U2, id, { status });
      expect(back.statusCode).toBe(200);
      const cleared = await row(id);
      expect(cleared['status']).toBe(status.toLowerCase());
      expect(cleared['approved_by']).toBeNull();
      expect(cleared['approved_at']).toBeNull();
      expect(back.body.data.approved_by).toBeNull();

      const before = Date.now();
      const again = await approve(U2, id);
      expect(again.statusCode).toBe(200);
      const stored = await row(id);
      expect(stored['approved_by']).toBe('u-2');
      expect((stored['approved_at'] as Date).getTime()).toBeGreaterThanOrEqual(before);
    });

  it('a later status that is not pre-approval keeps the stamp', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    expect((await patch(U2, id, { status: 'SCHEDULED' })).statusCode).toBe(200);
    const stored = await row(id);
    expect(stored['status']).toBe('scheduled');
    expect(stored['approved_by']).toBe('u-1');
    expect(stored['approved_at']).not.toBeNull();
  });

  it('PATCH to a pre-approval status sets approval_status back to pending in the same write', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    expect((await row(id))['approval_status']).toBe('approved');
    const back = await patch(U2, id, { status: 'DRAFT' });
    expect(back.statusCode).toBe(200);
    const cleared = await row(id);
    expect([cleared['status'], cleared['approval_status'], cleared['approved_by'], cleared['approved_at']])
      .toEqual(['draft', 'pending', null, null]);
    expect(back.body.data.approval_status).toBe('pending');
  });

  it('answers 404 for an unknown or another organization change and writes nothing', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    const before = await row(id);
    const foreign = await patch({ _userId: 'u-9', _organizationId: ORG_B }, id, { status: 'DRAFT' });
    expect([foreign.statusCode, foreign.body.message]).toEqual([404, 'Change not found']);
    const unknown = await patch(U1, '99999999-9999-4999-8999-999999999999', { status: 'DRAFT' });
    expect(unknown.statusCode).toBe(404);
    expect(await row(id)).toEqual(before);
  });
});

/**
 * PATCH to a pre-approval status reads the row, then writes conditionally on what it read. `between` runs after the
 * read and before the write (the window of the race), through the same database.
 */
async function patchBetweenReadAndWrite(user: Record<string, unknown>, id: string, body: Record<string, unknown>,
  between: () => Promise<unknown>) {
  let interleaved = false;
  const racing = {
    query: async (text: string, params: unknown[] = []) => {
      const result = await pool.query(text, params);
      if (!interleaved && /SELECT status, approved_by/.test(text)) {
        interleaved = true;
        await between();
      }
      return result;
    },
  };
  (getPostgresClient as jest.Mock).mockReturnValue({ pool: racing });
  const out = res();
  await new ITILController().updateChange(
    { user, params: { id }, body } as unknown as Request, out as unknown as Response);
  expect(interleaved).toBe(true);
  return out;
}

describe('re-pend racing an approval that commits between its read and its write', () => {
  it('a re-pend that read pending_approval does not undo an approve that committed first: 409, approval intact', async () => {
    const id = await addChange(ORG_A);
    const out = await patchBetweenReadAndWrite(U2, id, { status: 'PENDING_APPROVAL' }, () => approve(U1, id));
    expect(out.statusCode).toBe(409);
    expect(out.body.code).toBe('CHANGE_APPROVAL_CHANGED');
    const stored = await row(id);
    expect([stored['status'], stored['approval_status'], stored['approved_by']]).toEqual(['approved', 'approved', 'u-1']);
    expect(stored['approved_at']).not.toBeNull();
  });

  it('a re-pend of an approved change does not clear a newer approval by the same approver: 409, newer stamp intact', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    await sql(`UPDATE itil_changes SET approved_at = '${FIXED_APPROVED}' WHERE id = $1`, [id]);
    const out = await patchBetweenReadAndWrite(U2, id, { status: 'DRAFT' }, async () => {
      expect((await patch(U2, id, { status: 'PENDING_APPROVAL' })).statusCode).toBe(200);
      expect((await approve(U1, id)).statusCode).toBe(200);
    });
    expect(out.statusCode).toBe(409);
    const stored = await row(id);
    expect([stored['status'], stored['approval_status'], stored['approved_by']]).toEqual(['approved', 'approved', 'u-1']);
    expect((stored['approved_at'] as Date).getTime()).toBeGreaterThan(new Date(FIXED_APPROVED).getTime());
  });

  it('an approve that lands after the re-pend committed finds a consistent pending row and approves it', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    expect((await patch(U2, id, { status: 'PENDING_APPROVAL' })).statusCode).toBe(200);
    expect((await approve(U2, id)).statusCode).toBe(200);
    const stored = await row(id);
    expect([stored['status'], stored['approval_status'], stored['approved_by']]).toEqual(['approved', 'approved', 'u-2']);
  });

  it('a re-pend whose row changed to another status between read and write answers 409 and keeps that status', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    const out = await patchBetweenReadAndWrite(U2, id, { status: 'DRAFT' },
      () => sql(`UPDATE itil_changes SET status = 'scheduled' WHERE id = $1`, [id]));
    expect(out.statusCode).toBe(409);
    const stored = await row(id);
    expect([stored['status'], stored['approved_by']]).toEqual(['scheduled', 'u-1']);
  });
});

describe('clearing an approval stamp leaves one id-only trail event', () => {
  const cleared = () => (logger.info as jest.Mock).mock.calls.filter(([message]) => message === 'Change approval stamp cleared');
  beforeEach(() => { (logger.info as jest.Mock).mockClear(); });

  it('logs change id, org id, previous approver, previous approved_at and actor user id once', async () => {
    const id = await addChange(ORG_A);
    await approve(U1, id);
    await sql(`UPDATE itil_changes SET approved_at = '${FIXED_APPROVED}' WHERE id = $1`, [id]);
    expect((await patch({ _userId: 'u-2', _username: 'Bob Example', _organizationId: ORG_A }, id,
      { status: 'PENDING_APPROVAL' })).statusCode).toBe(200);
    expect(cleared()).toEqual([['Change approval stamp cleared', {
      change_id: id, organization_id: ORG_A, previous_approved_by: 'u-1',
      previous_approved_at: FIXED_APPROVED, actor_user_id: 'u-2',
    }]]);
  });

  it('logs nothing when there was no stamp to clear, or when the write is refused', async () => {
    const unstamped = await addChange(ORG_A);
    expect((await patch(U2, unstamped, { status: 'DRAFT' })).statusCode).toBe(200);
    const stamped = await addChange(ORG_A);
    await approve(U1, stamped);
    const lost = await patchBetweenReadAndWrite(U2, stamped, { status: 'DRAFT' },
      () => sql(`UPDATE itil_changes SET status = 'scheduled' WHERE id = $1`, [stamped]));
    expect(lost.statusCode).toBe(409);
    expect(cleared()).toEqual([]);
  });
});

describe('PATCH /itil/changes/:id with status APPROVED records the approver', () => {
  it('stamps approved_by from the verified user and approved_at, like the approve endpoint', async () => {
    const id = await addChange(ORG_A);
    const before = Date.now();
    const out = await patch(U1, id, { status: 'APPROVED' });
    const after = Date.now();
    expect(out.statusCode).toBe(200);
    const stored = await row(id);
    expect(stored['status']).toBe('approved');
    expect(stored['approval_status']).toBe('approved');
    expect(stored['approved_by']).toBe('u-1');
    expect((stored['approved_at'] as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((stored['approved_at'] as Date).getTime()).toBeLessThanOrEqual(after);
    expect(out.body.data.approved_by).toBe('u-1');
    expect(out.body.message).toBe('Change updated successfully');
  });

  it('ignores a forged approved_by and approved_at in the body', async () => {
    const id = await addChange(ORG_A);
    const out = await patch(U1, id, { status: 'APPROVED', approved_by: 'attacker', approvedBy: 'attacker',
      approved_at: FIXED_APPROVED, approvedAt: FIXED_APPROVED });
    expect(out.statusCode).toBe(200);
    const stored = await row(id);
    expect(stored['approved_by']).toBe('u-1');
    expect((stored['approved_at'] as Date).getTime()).toBeGreaterThan(new Date(FIXED_APPROVED).getTime());
  });

  it('falls back to _username, and carries implementedBy in the same write', async () => {
    const id = await addChange(ORG_A);
    const out = await patch({ _username: 'alice', _organizationId: ORG_A }, id,
      { status: 'APPROVED', implementedBy: 'bob' });
    expect(out.statusCode).toBe(200);
    const stored = await row(id);
    expect([stored['approved_by'], stored['implemented_by']]).toEqual(['alice', 'bob']);
  });

  it('answers 401 without a usable identity and writes nothing', async () => {
    const id = await addChange(ORG_A);
    const before = await row(id);
    const out = await patch({ _organizationId: ORG_A }, id, { status: 'APPROVED' });
    expect(out.statusCode).toBe(401);
    expect(await row(id)).toEqual(before);
  });

  it.each(['approved', 'closed', 'cancelled'])('refuses APPROVED on a %s change with 409 and writes nothing', async status => {
    const id = await addChange(ORG_A, status);
    const before = await row(id);
    const out = await patch(U1, id, { status: 'APPROVED', implementedBy: 'bob' });
    expect(out.statusCode).toBe(409);
    expect(out.body.code).toBe('CHANGE_NOT_APPROVABLE');
    expect(await row(id)).toEqual(before);
  });

  it('answers 404 for another organization change and writes nothing', async () => {
    const id = await addChange(ORG_A);
    const before = await row(id);
    const out = await patch({ _userId: 'u-9', _organizationId: ORG_B }, id, { status: 'APPROVED' });
    expect(out.statusCode).toBe(404);
    expect(out.body).toEqual({ success: false, error: 'Not Found', message: 'Change not found' });
    expect(await row(id)).toEqual(before);
  });
});
