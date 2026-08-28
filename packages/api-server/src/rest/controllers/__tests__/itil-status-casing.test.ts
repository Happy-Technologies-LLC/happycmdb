// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * F-141 regression: incidentFiltersSchema (itil.routes.ts) only accepts the
 * uppercase status enum ('NEW', 'ASSIGNED', ...), but createIncident /
 * resolveIncident persist lowercase status literals ('new', 'resolved', ...)
 * to itil_incidents, and the equivalent is true for itil_changes ('draft',
 * 'approved', 'implemented', 'closed' -- see createChange's existing
 * `.toLowerCase()` normalization of changeType). Before this fix, the raw
 * uppercase query-string value was compared case-sensitively against the
 * lowercase stored value, so `GET /incidents?status=NEW` always matched zero
 * rows. These tests assert the controller normalizes status (and, for
 * changes, changeType) to lowercase before it ever reaches SQL, for both the
 * list filters and the PATCH update paths.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { ITILController } from '../itil.controller';

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

describe('ITIL status casing (F-141)', () => {
  let controller: ITILController;
  let poolQuery: jest.Mock<any, any[]>;

  beforeEach(() => {
    poolQuery = jest.fn();
    (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: jest.fn(), getCI: jest.fn() });
    (getPostgresClient as jest.Mock).mockReturnValue({
      query: jest.fn(),
      getClient: jest.fn(),
      pool: { query: poolQuery },
    });
    controller = new ITILController();
  });

  it('lowercases the incident status filter before it reaches SQL', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ total: '1' }] }) // count query
      .mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: 'new' }] }); // select query

    const req = { query: { status: 'NEW' } } as unknown as Request;
    const res = mockRes();

    await controller.getIncidents(req, res);

    expect(poolQuery).toHaveBeenCalledTimes(2);
    const [countSql, countParams] = poolQuery.mock.calls[0] as [string, unknown[]];
    expect(countSql).toContain('status = $1');
    expect(countParams[0]).toBe('new');

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: [{ id: 'inc-1', status: 'new' }],
      })
    );
  });

  it('lowercases the incident status body value on PATCH /incidents/:id', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: 'resolved' }] });

    const req = {
      params: { id: 'inc-1' },
      body: { status: 'RESOLVED' },
    } as unknown as Request;
    const res = mockRes();

    await controller.updateIncident(req, res);

    const [sql, params] = poolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('status = $1');
    expect(params).toContain('resolved');
  });

  it('lowercases the change status/changeType filters before they reach SQL', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'chg-1', status: 'implemented' }] });

    const req = { query: { status: 'IMPLEMENTED', changeType: 'EMERGENCY' } } as unknown as Request;
    const res = mockRes();

    await controller.getChanges(req, res);

    const [, countParams] = poolQuery.mock.calls[0] as [string, unknown[]];
    expect(countParams[0]).toBe('implemented');
    expect(countParams[1]).toBe('emergency');
  });

  it('lowercases the change status body value on PATCH /changes/:id', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: 'chg-1', status: 'closed' }] });

    const req = {
      params: { id: 'chg-1' },
      body: { status: 'CLOSED' },
    } as unknown as Request;
    const res = mockRes();

    await controller.updateChange(req, res);

    const [, params] = poolQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('closed');
  });
});
