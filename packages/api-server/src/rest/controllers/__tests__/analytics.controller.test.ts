// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Bound the legacy change timeline's date range; tenant isolation is
 * covered by mounted authenticated analytics tests. */

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

describe('AnalyticsController change timeline date bounds', () => {
  let controller: AnalyticsController;
  let query: jest.Mock;

  beforeEach(() => {
    query = jest.fn();
    (getNeo4jClient as jest.Mock).mockReturnValue({ getSession: jest.fn() });
    (getPostgresClient as jest.Mock).mockReturnValue({ query });
    controller = new AnalyticsController();
  });

  describe('getChangeTimeline', () => {
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
});
