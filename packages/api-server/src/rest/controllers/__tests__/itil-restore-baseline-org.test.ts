// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * FD-4: a :CI's organization_id is written only from the token organization
 * (or the backfill). POST /api/v1/itil/baselines/:id/restore applies a stored
 * snapshot with `SET ci += $restoreProps`, so a snapshot (or an explicit
 * restoreAttributes list) naming organization_id must not move the CI. Nor
 * may it rewrite created_at: the ETL (migration 011) must not be able to take
 * a recreated CI for an older one.
 *
 * Neo4j is a one-node in-memory store: the statement's `SET ci += $restoreProps`
 * and every `SET ci.<prop> = coalesce(datetime($param), …)` are applied to the
 * stored node, which is what the assertions read back.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { ITILController } from '../itil.controller';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

describe('ITIL restoreFromBaseline and organization_id', () => {
  let node: Record<string, unknown>;
  let controller: ITILController;

  beforeEach(() => {
    node = { id: 'ci-1', name: 'current-name', status: 'active', organization_id: ORG_A, created_at: '2026-06-01T00:00:00Z' };
    const session = {
      // Plain functions (not jest.fn): the unit config resets mock implementations.
      run: async (cypher: string, params: { ciId: string; restoreProps: Record<string, unknown> } & Record<string, unknown>) => {
        if (!cypher.includes('SET ci += $restoreProps') || params.ciId !== node['id']) return { records: [] };
        Object.assign(node, params.restoreProps);
        for (const [, prop, param] of cypher.matchAll(/SET ci\.(\w+) = coalesce\(datetime\(\$(\w+)\)/g)) {
          if (params[param!] !== null && params[param!] !== undefined) node[prop!] = params[param!];
        }
        return { records: [{ get: () => ({ properties: { ...node } }) }] };
      },
      close: async () => undefined,
    };
    // The snapshot was captured while the CI belonged to (or was crafted to name) another organization.
    const baseline = {
      id: 'base-1',
      baseline_data: { 'ci-1': {
        name: 'baseline-name', status: 'maintenance', organization_id: ORG_B, _organization_id: ORG_B,
        // Older than the recreated node's own created_at.
        created_at: '2025-01-01T00:00:00Z', _created_at: '2025-01-01T00:00:00Z',
      } },
    };
    (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: () => session });
    (getPostgresClient as jest.Mock).mockReturnValue({
      pool: { query: async () => ({ rows: [baseline] }) },
    });
    controller = new ITILController();
  });

  it('restoreFromBaseline does not change organization_id', async () => {
    for (const restoreAttributes of [undefined, ['organization_id', '_organization_id', 'name']]) {
      node['name'] = 'current-name';
      const req = {
        params: { id: 'base-1' },
        user: { _organizationId: ORG_A },
        body: { ciId: 'ci-1', restoreAttributes, performedBy: 'alice' },
      } as unknown as Request;
      const res = mockRes();

      await controller.restoreFromBaseline(req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(node['organization_id']).toBe(ORG_A);
      expect(node['name']).toBe('baseline-name');
    }
  });

  it('baseline restore does not change created_at', async () => {
    for (const restoreAttributes of [undefined, ['created_at', '_created_at', 'name']]) {
      node['name'] = 'current-name';
      const req = {
        params: { id: 'base-1' },
        user: { _organizationId: ORG_A },
        body: { ciId: 'ci-1', restoreAttributes, performedBy: 'alice' },
      } as unknown as Request;
      const res = mockRes();

      await controller.restoreFromBaseline(req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(node['created_at']).toBe('2026-06-01T00:00:00Z');
      expect(node['name']).toBe('baseline-name');
    }
  });
});
