// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused unit tests for JobsController.getDiscoveryStats: the real
 * average-completed-job-duration and real schedule-enabled state wired in
 * to close the wave-1 "no fabricated discovery stats" finding. Every other
 * JobsController dependency (queue manager, Neo4j, ETL scheduler) is
 * mocked so this stays scoped to getDiscoveryStats/getAverageJobDuration.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';

// Mock typing follows this suite's established convention (see
// settings.controller.test.ts / drift-impact.controller.test.ts's
// `jest.Mock<(...args: any[]) => any>`): jest's default Mock generics
// otherwise infer `never` for the resolved-value parameter.
type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockGetQueueStats: AnyMock = jest.fn();
const mockGetQueue: AnyMock = jest.fn();
const mockGetSchedule: AnyMock = jest.fn();
const mockSessionRun: AnyMock = jest.fn();
const mockSessionClose: AnyMock = jest.fn();

jest.mock('@cmdb/common', () => ({
  getQueueManager: () => ({
    getQueueStats: mockGetQueueStats,
    getQueue: mockGetQueue,
  }),
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@cmdb/discovery-engine', () => ({
  getDiscoveryScheduler: () => ({ triggerDiscovery: jest.fn() }),
  getDiscoveryJobScheduler: () => ({
    getSchedule: mockGetSchedule,
    getSchedules: jest.fn(() => []),
  }),
}));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({
    getSession: () => ({
      run: mockSessionRun,
      close: mockSessionClose,
    }),
  }),
}));

jest.mock('@cmdb/etl-processor', () => ({
  getETLScheduler: () => ({ getSchedules: jest.fn(() => []) }),
}));

import { JobsController } from '../jobs.controller';

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

function mockReq(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

describe('JobsController.getDiscoveryStats', () => {
  let controller: JobsController;

  beforeEach(() => {
    controller = new JobsController();

    mockGetQueueStats.mockResolvedValue({
      queueName: 'discovery-nmap',
      waiting: 0,
      active: 0,
      completed: 5,
      failed: 1,
      delayed: 0,
      paused: 0,
    });

    mockSessionRun.mockResolvedValue({
      records: [{ get: () => ({ toNumber: () => 3 }) }],
    });
  });

  it('computes the real average duration from completed jobs, never a fabricated 0ms', async () => {
    mockGetQueue.mockReturnValue({
      getCompleted: jest.fn().mockResolvedValue([
        { processedOn: 1000, finishedOn: 3000 }, // 2000ms
        { processedOn: 2000, finishedOn: 5000 }, // 3000ms
      ]),
    });
    mockGetSchedule.mockReturnValue({
      _provider: 'nmap',
      _queueName: 'discovery-nmap',
      _cronPattern: '0 * * * *',
      _enabled: true,
      _config: {},
    });

    const req = mockReq({ provider: 'nmap' });
    const res = mockRes();

    await controller.getDiscoveryStats(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        expect.objectContaining({
          provider: 'nmap',
          averageDurationMs: 2500,
          enabled: true,
          totalDiscoveredCIs: 3,
        }),
      ],
    });
  });

  it('reports averageDurationMs as null (not 0) when no completed job carries both timestamps', async () => {
    mockGetQueue.mockReturnValue({
      getCompleted: jest.fn().mockResolvedValue([
        { processedOn: undefined, finishedOn: 4000 },
        { processedOn: 1000, finishedOn: undefined },
      ]),
    });
    mockGetSchedule.mockReturnValue({
      _provider: 'nmap',
      _queueName: 'discovery-nmap',
      _cronPattern: '0 * * * *',
      _enabled: false,
      _config: {},
    });

    const req = mockReq({ provider: 'nmap' });
    const res = mockRes();

    await controller.getDiscoveryStats(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        expect.objectContaining({
          provider: 'nmap',
          averageDurationMs: null,
          enabled: false,
        }),
      ],
    });
  });

  it('leaves enabled undefined (never fabricated true) when the provider has no registered schedule', async () => {
    mockGetQueue.mockReturnValue({
      getCompleted: jest.fn().mockResolvedValue([]),
    });
    mockGetSchedule.mockReturnValue(undefined);

    const req = mockReq({ provider: 'nmap' });
    const res = mockRes();

    await controller.getDiscoveryStats(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        expect.objectContaining({
          provider: 'nmap',
          enabled: undefined,
          averageDurationMs: null,
        }),
      ],
    });
  });
});
