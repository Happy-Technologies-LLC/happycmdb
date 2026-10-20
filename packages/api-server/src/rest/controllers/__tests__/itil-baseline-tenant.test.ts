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
  { id: 'base-a', organization_id: A, baseline_data: { 'ci-a': { name: 'old' }, 'ci-b': { name: 'old' } } },
  { id: 'base-b', organization_id: B, baseline_data: { 'ci-b': { name: 'old' } } },
  { id: 'base-legacy', organization_id: null, baseline_data: { 'ci-a': { name: 'old' } } },
];

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

  beforeEach(() => {
    (getPostgresClient as jest.Mock).mockReturnValue({ pool: {
      query: async (sql: string, params: unknown[] = []) => {
        const id = sql.includes('WHERE id = $1') ? params[0] : undefined;
        const org = sql.includes('organization_id = $') ? params[id === undefined ? 0 : 1] : undefined;
        return { rows: baselines.filter(b => (id === undefined || b.id === id) && (org === undefined || b.organization_id === org)) };
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
      expect(res.body).toEqual({ success: true, data: expected ? baselines.filter(b => b.id === expected) : [], count: expected ? 1 : 0 });
    }
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
  });
});
