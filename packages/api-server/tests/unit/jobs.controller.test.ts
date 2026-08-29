// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getQueueManager } from '@cmdb/common';
import { getDiscoveryScheduler, getDiscoveryJobScheduler } from '@cmdb/discovery-engine';
import { getNeo4jClient } from '@cmdb/database';
import { getETLScheduler } from '@cmdb/etl-processor';
import { JobsController } from '../../src/rest/controllers/jobs.controller';

jest.mock('@cmdb/common', () => ({
  getQueueManager: jest.fn(),
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@cmdb/discovery-engine', () => ({
  getDiscoveryScheduler: jest.fn(),
  getDiscoveryJobScheduler: jest.fn(),
}));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
}));

jest.mock('@cmdb/etl-processor', () => ({
  getETLScheduler: jest.fn(),
}));

interface MockBullJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  progress: number;
  attemptsMade: number;
  opts: { attempts: number };
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  stacktrace: string[];
  returnvalue: unknown;
  getState: jest.Mock;
  remove: jest.Mock;
  retry: jest.Mock;
}

interface MockQueueManager {
  getJob: jest.Mock;
  getQueue: jest.Mock;
  removeJob: jest.Mock;
  retryJob: jest.Mock;
  getQueueStats: jest.Mock;
  getFailedJobs: jest.Mock;
  cleanQueue: jest.Mock;
}

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockBullJob(overrides: Partial<MockBullJob> = {}): MockBullJob {
  return {
    id: 'job-1',
    name: 'discovery',
    data: { provider: 'nmap' },
    progress: 42,
    attemptsMade: 1,
    opts: { attempts: 3 },
    timestamp: 1000,
    processedOn: 1100,
    finishedOn: undefined,
    failedReason: undefined,
    stacktrace: [],
    returnvalue: undefined,
    getState: jest.fn().mockResolvedValue('active'),
    remove: jest.fn().mockResolvedValue(undefined),
    retry: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('JobsController', () => {
  let controller: JobsController;
  let mockQueueManager: MockQueueManager;
  let mockNeo4jSession: { run: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockQueueManager = {
      getJob: jest.fn(),
      getQueue: jest.fn(),
      removeJob: jest.fn().mockResolvedValue(undefined),
      retryJob: jest.fn().mockResolvedValue(undefined),
      getQueueStats: jest.fn().mockResolvedValue({
        queueName: 'discovery-nmap',
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
      }),
      getFailedJobs: jest.fn().mockResolvedValue([]),
      cleanQueue: jest.fn().mockResolvedValue(undefined),
    };
    (getQueueManager as jest.Mock).mockReturnValue(mockQueueManager);

    (getDiscoveryScheduler as jest.Mock).mockReturnValue({
      triggerDiscovery: jest.fn().mockResolvedValue('job-1'),
    });
    (getDiscoveryJobScheduler as jest.Mock).mockReturnValue({
      getSchedules: jest.fn(),
      getSchedule: jest.fn(),
      getSchedulesView: jest.fn(),
      getScheduleView: jest.fn(),
      updateSchedule: jest.fn(),
      enableSchedule: jest.fn(),
      disableSchedule: jest.fn(),
    });

    mockNeo4jSession = {
      run: jest.fn().mockResolvedValue({
        records: [{ get: () => ({ toNumber: () => 0 }) }],
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (getNeo4jClient as jest.Mock).mockReturnValue({
      getSession: jest.fn().mockReturnValue(mockNeo4jSession),
    });

    (getETLScheduler as jest.Mock).mockReturnValue({
      getSchedules: jest.fn(),
      getSchedule: jest.fn(),
      getSchedulesView: jest.fn(),
      getScheduleView: jest.fn(),
      updateSchedule: jest.fn(),
      enableSchedule: jest.fn(),
      disableSchedule: jest.fn(),
    });

    controller = new JobsController();
  });

  describe('getJobStatus', () => {
    it('returns 404 when the job does not exist in the requested queue', async () => {
      mockQueueManager.getJob.mockResolvedValue(undefined);
      const req = { params: { queueName: 'discovery-nmap', jobId: 'missing' } } as unknown as Request;
      const res = mockResponse();

      await controller.getJobStatus(req, res);

      expect(mockQueueManager.getJob).toHaveBeenCalledWith('discovery-nmap', 'missing');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
    });

    it('includes queueName and maxAttempts (from job.opts.attempts) on success', async () => {
      mockQueueManager.getJob.mockResolvedValue(mockBullJob());
      const req = { params: { queueName: 'discovery-nmap', jobId: 'job-1' } } as unknown as Request;
      const res = mockResponse();

      await controller.getJobStatus(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            queueName: 'discovery-nmap',
            maxAttempts: 3,
            attemptsMade: 1,
          }),
        })
      );
    });

    it('returns 400 when queueName or jobId is missing', async () => {
      const req = { params: { queueName: 'discovery-nmap' } } as unknown as Request;
      const res = mockResponse();

      await controller.getJobStatus(req, res);

      expect(mockQueueManager.getJob).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('listJobs', () => {
    it('propagates the requested queueName and maxAttempts onto every job', async () => {
      const queue = { getWaiting: jest.fn().mockResolvedValue([mockBullJob({ id: 'a' }), mockBullJob({ id: 'b' })]) };
      mockQueueManager.getQueue.mockReturnValue(queue);
      const req = {
        params: { queueName: 'discovery-nmap' },
        query: {},
      } as unknown as Request;
      const res = mockResponse();

      await controller.listJobs(req, res);

      expect(mockQueueManager.getQueue).toHaveBeenCalledWith('discovery-nmap');
      const payload = (res.json as jest.Mock).mock.calls[0][0] as { data: { jobs: Array<{ queueName: string; maxAttempts: number }> } };
      expect(payload.data.jobs).toHaveLength(2);
      for (const job of payload.data.jobs) {
        expect(job.queueName).toBe('discovery-nmap');
        expect(job.maxAttempts).toBe(3);
      }
    });

    it('returns a real total/hasMore from queueManager.getQueueStats for the requested state, never an inferred offset+limit+1 guess', async () => {
      const queue = {
        getFailed: jest.fn().mockResolvedValue([mockBullJob({ id: 'a' }), mockBullJob({ id: 'b' })]),
      };
      mockQueueManager.getQueue.mockReturnValue(queue);
      mockQueueManager.getQueueStats.mockResolvedValue({
        queueName: 'discovery-nmap',
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 500,
        delayed: 0,
        paused: 0,
      });
      const req = {
        params: { queueName: 'discovery-nmap' },
        query: { state: 'failed', start: '0', end: '1' },
      } as unknown as Request;
      const res = mockResponse();

      await controller.listJobs(req, res);

      expect(mockQueueManager.getQueueStats).toHaveBeenCalledWith('discovery-nmap');
      const payload = (res.json as jest.Mock).mock.calls[0][0] as {
        pagination: { total: number; limit: number; offset: number; hasMore: boolean };
      };
      expect(payload.pagination).toEqual({ total: 500, limit: 2, offset: 0, hasMore: true });
      expect(payload.pagination.total).not.toBe(0 + 2 + 1);
    });

    it('reports hasMore=false once the returned slice reaches the real total for the state', async () => {
      const queue = {
        getWaiting: jest.fn().mockResolvedValue([mockBullJob({ id: 'a' })]),
      };
      mockQueueManager.getQueue.mockReturnValue(queue);
      mockQueueManager.getQueueStats.mockResolvedValue({
        queueName: 'discovery-nmap',
        waiting: 1,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      });
      const req = {
        params: { queueName: 'discovery-nmap' },
        query: {},
      } as unknown as Request;
      const res = mockResponse();

      await controller.listJobs(req, res);

      const payload = (res.json as jest.Mock).mock.calls[0][0] as {
        pagination: { total: number; hasMore: boolean };
      };
      expect(payload.pagination).toEqual({ total: 1, limit: 100, offset: 0, hasMore: false });
    });
  });

  describe('cancelJob / retryJob (queueName propagation, never inferred from job id)', () => {
    it('cancelJob calls queueManager.removeJob with the exact queueName + jobId from the route', async () => {
      const req = { params: { queueName: 'etl-sync', jobId: 'job-42' } } as unknown as Request;
      const res = mockResponse();

      await controller.cancelJob(req, res);

      expect(mockQueueManager.removeJob).toHaveBeenCalledWith('etl-sync', 'job-42');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: expect.objectContaining({ queueName: 'etl-sync', jobId: 'job-42' }) })
      );
    });

    it('retryJob calls queueManager.retryJob with the exact queueName + jobId from the route', async () => {
      const req = { params: { queueName: 'etl-sync', jobId: 'job-42' } } as unknown as Request;
      const res = mockResponse();

      await controller.retryJob(req, res);

      expect(mockQueueManager.retryJob).toHaveBeenCalledWith('etl-sync', 'job-42');
    });
  });

  describe('getFailedJobs (bounded pagination)', () => {
    it('defaults to start=0 end=99 and includes queueName + maxAttempts per job', async () => {
      mockQueueManager.getFailedJobs.mockResolvedValue([mockBullJob({ failedReason: 'boom' })]);
      const req = { params: { queueName: 'discovery-nmap' }, query: {} } as unknown as Request;
      const res = mockResponse();

      await controller.getFailedJobs(req, res);

      expect(mockQueueManager.getFailedJobs).toHaveBeenCalledWith('discovery-nmap', 0, 99);
      const payload = (res.json as jest.Mock).mock.calls[0][0] as { data: { failedJobs: unknown[] } };
      expect(payload.data.failedJobs[0]).toMatchObject({
        queueName: 'discovery-nmap',
        status: 'failed',
        maxAttempts: 3,
        failedReason: 'boom',
      });
    });

    it('honors explicit start/end query params for bounded pagination', async () => {
      mockQueueManager.getFailedJobs.mockResolvedValue([]);
      const req = {
        params: { queueName: 'discovery-nmap' },
        query: { start: '10', end: '19' },
      } as unknown as Request;
      const res = mockResponse();

      await controller.getFailedJobs(req, res);

      expect(mockQueueManager.getFailedJobs).toHaveBeenCalledWith('discovery-nmap', 10, 19);
    });
  });

  describe('getDiscoveryStats (provider filtering)', () => {
    it('queries every discovery queue when no provider filter is given', async () => {
      const req = { query: {} } as unknown as Request;
      const res = mockResponse();

      await controller.getDiscoveryStats(req, res);

      expect(mockQueueManager.getQueueStats).toHaveBeenCalledTimes(4);
    });

    it('queries only the requested provider queue when provider filter is given', async () => {
      const req = { query: { provider: 'nmap' } } as unknown as Request;
      const res = mockResponse();

      await controller.getDiscoveryStats(req, res);

      expect(mockQueueManager.getQueueStats).toHaveBeenCalledTimes(1);
      expect(mockQueueManager.getQueueStats).toHaveBeenCalledWith('discovery-nmap');
    });
  });
  describe('schedule management', () => {
    it('returns configured discovery and ETL schedules using the public schedule shape', async () => {
      const discoverySchedules = [
        {
          _provider: 'nmap',
          _queueName: 'discovery-nmap',
          _cronPattern: '0 * * * *',
          _enabled: true,
          _config: { targets: ['10.0.0.0/24'] },
        },
      ];
      const etlSchedules = [
        {
          _type: 'sync',
          _queueName: 'etl-sync',
          _cronPattern: '*/5 * * * *',
          _enabled: false,
          _config: { source: 'neo4j' },
        },
      ];
      const discoveryJobScheduler = (getDiscoveryJobScheduler as jest.Mock).mock.results[0]?.value;
      const etlScheduler = (getETLScheduler as jest.Mock).mock.results[0]?.value;
      discoveryJobScheduler.getSchedulesView.mockResolvedValue(discoverySchedules);
      etlScheduler.getSchedulesView.mockResolvedValue(etlSchedules);

      const discoveryResponse = mockResponse();
      const etlResponse = mockResponse();
      await controller.getDiscoverySchedules({} as Request, discoveryResponse);
      await controller.getETLSchedules({} as Request, etlResponse);

      expect(discoveryResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [
          {
            provider: 'nmap',
            queueName: 'discovery-nmap',
            cronExpression: '0 * * * *',
            enabled: true,
            config: { targets: ['10.0.0.0/24'] },
          },
        ],
      });
      expect(etlResponse.json).toHaveBeenCalledWith({
        success: true,
        data: [
          {
            type: 'sync',
            queueName: 'etl-sync',
            cronExpression: '*/5 * * * *',
            enabled: false,
            config: { source: 'neo4j' },
          },
        ],
      });
    });

    it('round-trips a discovery cronExpression and enabled state', async () => {
      const schedule = {
        _provider: 'nmap',
        _queueName: 'discovery-nmap',
        _cronPattern: '0 * * * *',
        _enabled: true,
        _config: { targets: [] },
      };
      const discoveryJobScheduler = (getDiscoveryJobScheduler as jest.Mock).mock.results[0]?.value;
      discoveryJobScheduler.getScheduleView.mockImplementation(async () => schedule);
      discoveryJobScheduler.updateSchedule.mockImplementation(
        async (_provider: string, cronExpression: string) => {
          schedule._cronPattern = cronExpression;
        }
      );
      discoveryJobScheduler.disableSchedule.mockImplementation(async () => {
        schedule._enabled = false;
      });
      const req = {
        params: { provider: 'nmap' },
        body: { cronExpression: '*/15 * * * *', enabled: false },
      } as unknown as Request;
      const res = mockResponse();

      await controller.updateDiscoverySchedule(req, res);

      expect(discoveryJobScheduler.updateSchedule).toHaveBeenCalledWith('nmap', '*/15 * * * *');
      expect(discoveryJobScheduler.disableSchedule).toHaveBeenCalledWith('nmap');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: {
            provider: 'nmap',
            queueName: 'discovery-nmap',
            cronExpression: '*/15 * * * *',
            enabled: false,
            config: { targets: [] },
          },
        })
      );
    });

    it('rejects legacy cronPattern rather than ignoring it', async () => {
      const req = {
        params: { provider: 'nmap' },
        body: { cronPattern: '*/15 * * * *' },
      } as unknown as Request;
      const res = mockResponse();

      await controller.updateDiscoverySchedule(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((getDiscoveryJobScheduler as jest.Mock).mock.results[0]?.value.getScheduleView).not.toHaveBeenCalled();
    });

    it('round-trips an ETL cronExpression and enables the schedule', async () => {
      const schedule = {
        _type: 'sync',
        _queueName: 'etl-sync',
        _cronPattern: '*/5 * * * *',
        _enabled: false,
        _config: { source: 'neo4j' },
      };
      const etlScheduler = (getETLScheduler as jest.Mock).mock.results[0]?.value;
      etlScheduler.getScheduleView.mockImplementation(async () => schedule);
      etlScheduler.updateSchedule.mockImplementation(async (_type: string, cronExpression: string) => {
        schedule._cronPattern = cronExpression;
      });
      etlScheduler.enableSchedule.mockImplementation(async () => {
        schedule._enabled = true;
      });
      const req = {
        params: { type: 'sync' },
        body: { cronExpression: '0 * * * *', enabled: true },
      } as unknown as Request;
      const res = mockResponse();

      await controller.updateETLSchedule(req, res);

      expect(etlScheduler.updateSchedule).toHaveBeenCalledWith('sync', '0 * * * *');
      expect(etlScheduler.enableSchedule).toHaveBeenCalledWith('sync');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            type: 'sync',
            cronExpression: '0 * * * *',
            enabled: true,
          }),
        })
      );
    });
  });
});
