// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /analytics/topology-summary failure mapping through the real `executeBoundedAnalysis` admission:
 * resource caps and an unavailable CI list are 503, a Neo4j timeout is 504, anything else a fixed 500.
 * The graph reads and the pending fence itself run against real stores in tests/integration/topology-summary.test.ts.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

const mockReadCIList = jest.fn<(org: string, read: (pending: string[], timeout: number) => Promise<unknown>) => Promise<unknown>>();
jest.mock('../../../read-admission', () => ({
  ...(jest.requireActual('../../../read-admission') as object),
  readCIList: (org: string, read: (pending: string[], timeout: number) => Promise<unknown>) => mockReadCIList(org, read),
}));

const mockReadSummary = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../../../services/topology-summary.service', () => ({
  ...(jest.requireActual('../../../services/topology-summary.service') as object),
  readTopologySummary: (...args: unknown[]) => mockReadSummary(...args),
}));

import { getNeo4jClient } from '@cmdb/database';
import { CIGapError, CIListUnavailableError } from '../../../read-admission';
import { TopologyGroupLimitError } from '../../../services/topology-summary.service';
import { AnalyticsController } from '../analytics.controller';

let seq = 0;
const orgId = (n: number): string => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A fresh organization and principal per call, so admission slots never carry over between cases. */
function call(query: Record<string, string> = {}): { req: Request; res: Response } {
  seq += 1;
  const req = { query, user: { _userId: `topo-user-${seq}`, _role: 'viewer', _organizationId: orgId(seq) } } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('AnalyticsController.getTopologySummary', () => {
  let controller: AnalyticsController;
  beforeEach(() => {
    (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: () => ({ close: async () => undefined }) });
    controller = new AnalyticsController();
    mockReadCIList.mockImplementation((_org, read) => read([], 8000));
  });

  it('answers 200 with the summary read under the readCIList pending fence and budget', async () => {
    mockReadCIList.mockImplementation((_org, read) => read(['pending-ci'], 8000));
    mockReadSummary.mockResolvedValue({ marker: 'summary' });
    const { req, res } = call({ limit: '5' });

    await controller.getTopologySummary(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ marker: 'summary' });
    const [, org, options, pending, budget] = mockReadSummary.mock.calls[0]!;
    expect([org, options, pending, budget]).toEqual([
      (req as unknown as { user: { _organizationId: string } }).user._organizationId,
      expect.objectContaining({ nodeLimit: 5 }), ['pending-ci'], 8000,
    ]);
  });

  const timeoutCode = (code: string) => Object.assign(new Error('t'), { code });
  it.each([
    { name: 'the group cap', error: new TopologyGroupLimitError(), status: 503, message: 'Topology summary resource limit exceeded' },
    { name: 'an unavailable CI list', error: new CIListUnavailableError(), status: 503, message: 'CI list temporarily unavailable' },
    { name: 'a CI gap (never the single-CI 409)', error: new CIGapError(), status: 503, message: 'CI list temporarily unavailable' },
    { name: 'a Neo4j statement timeout', error: timeoutCode('Neo.ClientError.Transaction.TransactionTimedOut'),
      status: 504, message: 'Topology summary timed out' },
    { name: 'a terminated transaction', error: timeoutCode('Neo.TransientError.Transaction.Terminated'),
      status: 504, message: 'Topology summary timed out' },
  ])('maps $name to $status', async ({ error, status, message }) => {
    mockReadSummary.mockRejectedValue(error);
    const { req, res } = call();

    await controller.getTopologySummary(req, res);

    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: message });
  });

  it('answers a fixed 500 without echoing an unexpected error', async () => {
    mockReadSummary.mockRejectedValue(new Error('bolt://secret-host refused'));
    const { req, res } = call();

    await controller.getTopologySummary(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Failed to retrieve topology summary' });
  });

  it('refuses a second concurrent read by the same principal with 429 before touching the graph', async () => {
    let release!: () => void;
    mockReadSummary.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
    const { req, res } = call();
    const first = controller.getTopologySummary(req, res);
    await new Promise(resolve => setImmediate(resolve));

    const second = { req, res: call().res };
    await controller.getTopologySummary(second.req, second.res);
    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(mockReadCIList).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
