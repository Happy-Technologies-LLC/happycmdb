// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

const query = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
const getSession = jest.fn();
jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession }),
  getPostgresClient: () => ({ pool: { query } }),
}));
jest.mock('@cmdb/common', () => ({ logger: { error: jest.fn() } }));
import { ITILController } from '../itil.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
function response(): Response & { code: number; body: unknown } {
  const res = { code: 200, body: null } as Response & { code: number; body: unknown };
  res.status = ((code: number) => { res.code = code; return res; }) as Response['status'];
  res.json = ((body: unknown) => { res.body = body; return res; }) as Response['json'];
  return res;
}

const req = { params: { id: 'base-1' }, user: { _organizationId: ORG },
  body: { ciId: 'ci-1', performedBy: 'alice' } } as unknown as Request;

describe('baseline restore until S4 journal admission', () => {
  beforeEach(() => { query.mockReset(); getSession.mockReset(); });
  it('returns the same 404 for absent and foreign baselines without reading snapshot data', async () => {
    query.mockResolvedValue({ rows: [] });
    const controller = new ITILController();
    const foreign = response();
    await controller.restoreFromBaseline(req, foreign);
    const missing = response();
    await controller.restoreFromBaseline({ ...req, params: { id: 'missing' } }, missing);
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(missing.body));
    expect(foreign.code).toBe(404);
    expect(getSession).not.toHaveBeenCalled();
    expect(query.mock.calls.every(call => String(call[0]).includes('organization_id = $2'))).toBe(true);
  });
  it('blocks owned restore without a direct graph write until S4', async () => {
    query.mockResolvedValue({ rows: [{ id: 'base-1' }] });
    const res = response();
    await new ITILController().restoreFromBaseline(req, res);
    expect(res.code).toBe(503);
    expect(getSession).not.toHaveBeenCalled();
  });
});
