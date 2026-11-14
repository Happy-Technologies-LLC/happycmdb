// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

jest.mock('@cmdb/common', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: jest.fn(), getPostgresClient: jest.fn() }));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { ITILController } from '../itil.controller';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const baselines = [
  { id: 'base-a', organization_id: A, name: 'a', scope: { ci_ids: ['ci-a'] }, baseline_data: { 'ci-a': { name: 'old' }, 'ci-b': { name: 'old' } } },
  { id: 'base-b', organization_id: B, name: 'b', scope: { ci_ids: ['ci-b'] }, baseline_data: { 'ci-b': { name: 'old' } } },
  { id: 'base-legacy', organization_id: null, name: 'legacy', scope: { ci_ids: ['ci-a'] }, baseline_data: { 'ci-a': { name: 'old' } } },
];
const SUMMARY_COLUMNS = ['id', 'name', 'description', 'baseline_type', 'status', 'created_by', 'approved_by', 'approved_at', 'created_at', 'updated_at', 'organization_id'];

/** Column list of a `SELECT <cols> FROM ...` statement; `['*']` for a star select. */
function selectedColumns(sql: string): string[] {
  const match = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(sql);
  return match ? match[1].split(',').map(c => c.trim()) : [];
}

/** Project a fixture row the way Postgres would for the statement's column list. */
function project(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  if (columns.includes('*')) return row;
  return Object.fromEntries(columns.filter(c => c in row).map(c => [c, row[c]]));
}

function response() {
  const res = { statusCode: 200, body: undefined as unknown };
  const mock = {
    status(code: number) { res.statusCode = code; return mock; },
    json(body: unknown) { res.body = body; return mock; },
  };
  return { res, mock: mock as unknown as Response };
}

function caller(org: string | undefined, id?: string, ciId = 'ci-a', role = 'viewer'): Request {
  return {
    user: { _organizationId: org, _role: role },
    params: { id },
    body: { ciId, performedBy: 'user' },
  } as unknown as Request;
}

describe('ITIL baseline tenant boundary', () => {
  let controller: ITILController;

  let sqlLog: string[];

  beforeEach(() => {
    sqlLog = [];
    (getPostgresClient as jest.Mock).mockReturnValue({ pool: {
      query: async (sql: string, params: unknown[] = []) => {
        sqlLog.push(sql);
        const id = sql.includes('WHERE id = $1') ? params[0] : undefined;
        const org = sql.includes('organization_id = $') ? params[id === undefined ? 0 : 1] : undefined;
        const columns = selectedColumns(sql);
        return { rows: baselines.filter(b => (id === undefined || b.id === id) && (org === undefined || b.organization_id === org)).map(b => project(b, columns)) };
      },
    } });
    (getNeo4jClient as jest.Mock).mockReturnValue({
      getCI: async (id: string, org: string) => id === 'ci-a' && org === A ? { id, name: 'current' } : null,
    });
    controller = new ITILController();
  });

  it('lists only the caller organization, excluding NULL even for admin/default role', async () => {
    for (const [org, role, expected] of [[A, 'viewer', 'base-a'], [B, 'viewer', 'base-b'], ['00000000-0000-0000-0000-000000000000', 'admin', undefined]] as const) {
      const { res, mock } = response();
      await controller.getBaselines(caller(org, undefined, undefined, role), mock);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, data: expected ? [project(baselines.find(b => b.id === expected)!, SUMMARY_COLUMNS)] : [], count: expected ? 1 : 0 });
    }
  });

  it('lists summary columns only: no SELECT *, no baseline_data or scope on a row', async () => {
    const { res, mock } = response();
    await controller.getBaselines(caller(A), mock);
    const columns = selectedColumns(sqlLog[0]);
    expect(columns).toEqual(SUMMARY_COLUMNS);
    expect(columns).not.toContain('*');
    const rows = (res.body as { data: Record<string, unknown>[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('baseline_data');
    expect(rows[0]).not.toHaveProperty('scope');
    expect(rows[0]).toMatchObject({ id: 'base-a', organization_id: A });
  });

  it('returns identical 404 for foreign, missing, and legacy baseline detail; own detail succeeds', async () => {
    const results = [];
    for (const id of ['base-a', 'missing', 'base-legacy']) {
      const { res, mock } = response();
      await controller.getBaseline(caller(B, id), mock);
      results.push(res);
    }
    expect(results.map(r => r.statusCode)).toEqual([404, 404, 404]);
    expect(results[0].body).toEqual(results[1].body);
    expect(results[1].body).toEqual(results[2].body);
    const own = response();
    await controller.getBaseline(caller(A, 'base-a'), own.mock);
    expect(own.res.statusCode).toBe(200);
    expect(own.res.body).toEqual({ success: true, data: baselines[0] });
    expect(own.res.body).toMatchObject({ data: { baseline_data: baselines[0].baseline_data, scope: baselines[0].scope } });
  });
});
