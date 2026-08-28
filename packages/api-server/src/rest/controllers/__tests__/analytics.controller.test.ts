// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the analytics endpoints added to close the reachable
 * frontend/backend contract gaps:
 *  - GET /analytics/relationship-matrix
 *  - GET /analytics/change-timeline
 *  - GET /analytics/health-metrics/:ciId
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
import { AnalyticsController } from '../analytics.controller';

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

describe('AnalyticsController - relationship matrix / change timeline / health metrics', () => {
  let controller: AnalyticsController;
  let query: jest.Mock<any, any[]>;

  beforeEach(() => {
    query = jest.fn();
    (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: jest.fn() });
    (getPostgresClient as jest.Mock).mockReturnValue({ query });
    controller = new AnalyticsController();
  });

  describe('getRelationshipMatrix', () => {
    it('returns the real source/target/relationship-type matrix from fact_ci_relationships joined to dim_ci', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { source_type: 'server', target_type: 'application', relationship_type: 'HOSTS', count: 5 },
        ],
      });

      const req = {} as Request;
      const res = mockRes();

      await controller.getRelationshipMatrix(req, res);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql] = query.mock.calls[0] as [string];
      expect(sql).toContain('cmdb.fact_ci_relationships');
      expect(sql).toContain('cmdb.dim_ci sc');
      expect(sql).toContain('cmdb.dim_ci tc');
      expect(sql).toContain('GROUP BY sc.ci_type, tc.ci_type, r.relationship_type');

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: [
          { source_type: 'server', target_type: 'application', relationship_type: 'HOSTS', count: 5 },
        ],
      });
    });

    it('returns 500 with an error envelope when the query fails', async () => {
      query.mockRejectedValueOnce(new Error('db down'));
      const req = {} as Request;
      const res = mockRes();

      await controller.getRelationshipMatrix(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: 'db down' })
      );
    });
  });

  describe('getChangeTimeline', () => {
    it('defaults to a bounded 30-day window when no date range is supplied', async () => {
      query.mockResolvedValueOnce({
        rows: [{ date: '2026-01-01', created: 3, updated: 1, deleted: 0 }],
      });

      const req = { query: {} } as unknown as Request;
      const res = mockRes();

      await controller.getChangeTimeline(req, res);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, string[]];
      expect(sql).toContain('FROM ci_change_history');
      expect(sql).toContain("change_type = 'discovered'");
      expect(sql).toContain("change_type = 'updated'");
      expect(sql).toContain("change_type = 'deleted'");

      const [startIso, endIso] = params;
      const spanMs = new Date(endIso).getTime() - new Date(startIso).getTime();
      expect(spanMs).toBeCloseTo(30 * 24 * 60 * 60 * 1000, -3);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: [{ date: '2026-01-01', created: 3, updated: 1, deleted: 0 }],
        })
      );
    });

    it('honors an explicit start_date/end_date range', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const req = {
        query: { start_date: '2026-01-01T00:00:00.000Z', end_date: '2026-01-08T00:00:00.000Z' },
      } as unknown as Request;
      const res = mockRes();

      await controller.getChangeTimeline(req, res);

      const [, params] = query.mock.calls[0] as [string, string[]];
      expect(params[0]).toBe('2026-01-01T00:00:00.000Z');
      expect(params[1]).toBe('2026-01-08T00:00:00.000Z');
    });

    it('rejects a date range wider than 90 days with 400', async () => {
      const req = {
        query: { start_date: '2026-01-01T00:00:00.000Z', end_date: '2026-06-01T00:00:00.000Z' },
      } as unknown as Request;
      const res = mockRes();

      await controller.getChangeTimeline(req, res);

      expect(query).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: expect.stringContaining('90 days') })
      );
    });

    it('rejects start_date after end_date with 400', async () => {
      const req = {
        query: { start_date: '2026-02-01T00:00:00.000Z', end_date: '2026-01-01T00:00:00.000Z' },
      } as unknown as Request;
      const res = mockRes();

      await controller.getChangeTimeline(req, res);

      expect(query).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('getHealthMetrics', () => {
    it('queries anomalies scoped to the CI id and default 7-day window', async () => {
      query.mockResolvedValueOnce({
        rows: [
          {
            timestamp: '2026-01-05T00:00:00.000Z',
            status: 'detected',
            cpu_usage: null,
            memory_usage: null,
            disk_usage: null,
            network_latency: null,
          },
        ],
      });

      const req = { params: { ciId: 'server-001' }, query: {} } as unknown as Request;
      const res = mockRes();

      await controller.getHealthMetrics(req, res);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, string[]];
      expect(sql).toContain('FROM anomalies');
      expect(sql).toContain("metrics->>'cpu_usage'");
      expect(params[0]).toBe('server-001');

      const spanMs = new Date(params[2]).getTime() - new Date(params[1]).getTime();
      expect(spanMs).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          ci_id: 'server-001',
          data: [
            {
              timestamp: '2026-01-05T00:00:00.000Z',
              status: 'detected',
              cpu_usage: null,
              memory_usage: null,
              disk_usage: null,
              network_latency: null,
            },
          ],
        })
      );
    });

    it('rejects a date range wider than 90 days with 400', async () => {
      const req = {
        params: { ciId: 'server-001' },
        query: { start_date: '2026-01-01T00:00:00.000Z', end_date: '2026-06-01T00:00:00.000Z' },
      } as unknown as Request;
      const res = mockRes();

      await controller.getHealthMetrics(req, res);

      expect(query).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
