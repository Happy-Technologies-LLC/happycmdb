// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request, apiClient } = vi.hoisted(() => {
  const request = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  const apiClient = {
    ...request,
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return { request, apiClient };
});

vi.mock('axios', () => ({
  default: { create: vi.fn(() => apiClient) },
}));

import { jobsService } from './jobs.service';

describe('jobsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists jobs from the queue-scoped route via the shared authenticated apiClient, mapping state/attemptsMade into status/attempts', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          jobs: [
            {
              id: 'job-1',
              name: 'discovery',
              queueName: 'discovery-nmap',
              state: 'active',
              data: {},
              progress: 50,
              attemptsMade: 1,
              maxAttempts: 3,
              timestamp: 1000,
            },
          ],
          count: 1,
        },
        pagination: { total: 37, limit: 25, offset: 0, hasMore: true },
      },
    });

    const result = await jobsService.getJobs('discovery-nmap', { status: 'active', limit: 25, offset: 0 });

    expect(request.get).toHaveBeenCalledWith('/jobs/discovery-nmap', {
      params: { start: '0', end: '24', state: 'active' },
    });
    expect(result.jobs[0]).toMatchObject({
      id: 'job-1',
      queueName: 'discovery-nmap',
      status: 'active',
      attempts: 1,
      maxAttempts: 3,
    });
  });

  it('uses the exact total/limit/offset/hasMore reported by the backend pagination block, never a fabricated offset+limit+1 guess', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: { jobs: [{ id: 'job-1', state: 'waiting' }] },
        pagination: { total: 500, limit: 25, offset: 50, hasMore: true },
      },
    });

    const result = await jobsService.getJobs('discovery-nmap', { limit: 25, offset: 50 });

    expect(result).toMatchObject({ total: 500, limit: 25, offset: 50 });
    expect(result.total).not.toBe(50 + 25 + 1);
  });

  it('fetches a single job detail by queueName and jobId', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          id: 'job-1',
          name: 'discovery',
          queueName: 'discovery-nmap',
          state: 'completed',
          data: {},
          progress: 100,
          attemptsMade: 1,
          maxAttempts: 3,
          timestamp: 1000,
        },
      },
    });

    const job = await jobsService.getJobById('discovery-nmap', 'job-1');

    expect(request.get).toHaveBeenCalledWith('/jobs/discovery-nmap/job-1');
    expect(job.status).toBe('completed');
  });

  it('propagates a rejected request (e.g. 404) rather than silently succeeding', async () => {
    request.get.mockRejectedValue(new Error('Request failed with status code 404'));

    await expect(jobsService.getJobById('discovery-nmap', 'missing')).rejects.toThrow(
      /404/
    );
  });

  it('retries a job against the exact queueName + jobId route, never inferring the queue from the job id', async () => {
    request.post.mockResolvedValue({ data: { success: true, data: {} } });

    await jobsService.retryJob('etl-sync', 'job-42');

    expect(request.post).toHaveBeenCalledWith('/jobs/etl-sync/job-42/retry');
  });

  it('cancels a job against the exact queueName + jobId route', async () => {
    request.delete.mockResolvedValue({ data: { success: true, data: {} } });

    await jobsService.cancelJob('etl-sync', 'job-42');

    expect(request.delete).toHaveBeenCalledWith('/jobs/etl-sync/job-42');
  });

  it('fetches dead letter (failed) jobs via the canonical failed-jobs route with bounded pagination', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          queueName: 'discovery-nmap',
          failedJobs: [
            {
              id: 'job-9',
              name: 'discovery',
              queueName: 'discovery-nmap',
              status: 'failed',
              data: {},
              failedReason: 'boom',
              attemptsMade: 3,
              maxAttempts: 3,
              timestamp: 1000,
            },
          ],
          count: 1,
        },
      },
    });

    const jobs = await jobsService.getDeadLetterJobs('discovery-nmap', { start: 5, end: 24 });

    expect(request.get).toHaveBeenCalledWith('/jobs/discovery-nmap/failed', {
      params: { start: 5, end: 24 },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'job-9', status: 'failed', failedReason: 'boom' });
  });

  it('combines discovery and ETL schedule envelopes for the Jobs schedules tab', async () => {
    request.get
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: [
            {
              provider: 'nmap',
              queueName: 'discovery-nmap',
              cronExpression: '0 * * * *',
              enabled: true,
              config: { targets: [] },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
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
        },
      });

    const schedules = await jobsService.getSchedules();

    expect(request.get).toHaveBeenNthCalledWith(1, '/jobs/schedules/discovery');
    expect(request.get).toHaveBeenNthCalledWith(2, '/jobs/schedules/etl');
    expect(schedules).toEqual([
      expect.objectContaining({
        id: 'discovery:nmap',
        name: 'Discovery: nmap',
        queueName: 'discovery-nmap',
        cron: '0 * * * *',
        enabled: true,
      }),
      expect.objectContaining({
        id: 'etl:sync',
        name: 'ETL: sync',
        queueName: 'etl-sync',
        cron: '*/5 * * * *',
        enabled: false,
      }),
    ]);
  });

  it('updates a namespaced schedule with cron/enabled changes and returns the updated schedule', async () => {
    request.put.mockResolvedValue({
      data: {
        success: true,
        data: {
          provider: 'nmap',
          queueName: 'discovery-nmap',
          cronExpression: '*/15 * * * *',
          enabled: false,
          config: { targets: [] },
        },
      },
    });

    const schedule = await jobsService.updateSchedule('discovery:nmap', {
      cron: '*/15 * * * *',
      enabled: false,
    });

    expect(request.put).toHaveBeenCalledWith('/jobs/schedules/discovery/nmap', {
      cronExpression: '*/15 * * * *',
      enabled: false,
    });
    expect(schedule).toMatchObject({
      id: 'discovery:nmap',
      cron: '*/15 * * * *',
      enabled: false,
    });
  });

  it('unwraps GET /queues/stats into a QueueStats[] array (never the raw {success,data} envelope)', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          queues: [
            {
              queueName: 'discovery-nmap',
              waiting: 2,
              active: 1,
              completed: 10,
              failed: 3,
              delayed: 0,
              paused: 0,
              isPaused: false,
              jobCounts: { waiting: 2, active: 1, completed: 10, failed: 3, delayed: 0, paused: 0 },
            },
          ],
          aggregate: { totalQueues: 1 },
        },
      },
    });

    const stats = await jobsService.getQueueStats();

    expect(request.get).toHaveBeenCalledWith('/queues/stats');
    expect(Array.isArray(stats)).toBe(true);
    expect(stats).toEqual([
      {
        queueName: 'discovery-nmap',
        waiting: 2,
        active: 1,
        completed: 10,
        failed: 3,
        delayed: 0,
        paused: 0,
      },
    ]);
  });

  it('unwraps GET /queues/health into a QueueHealth[] array and derives isPaused/errorRate from real backend fields', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          overallStatus: 'degraded',
          queues: [
            {
              queueName: 'etl-sync',
              status: 'warning',
              issues: ['Queue is paused'],
              jobCounts: { completed: 90, failed: 10, waiting: 0, active: 0, delayed: 0, paused: 0 },
            },
          ],
          summary: { total: 1 },
        },
      },
    });

    const health = await jobsService.getQueueHealth();

    expect(request.get).toHaveBeenCalledWith('/queues/health');
    expect(Array.isArray(health)).toBe(true);
    expect(health).toEqual([
      expect.objectContaining({
        queueName: 'etl-sync',
        status: 'degraded',
        isPaused: true,
        errorRate: 0.1,
        issues: ['Queue is paused'],
      }),
    ]);
  });

  it('unwraps GET /queues/:queueName/metrics into a typed QueueMetrics object', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          queueName: 'etl-sync',
          metrics: {
            latency: { avg: 200, min: 50, max: 400, unit: 'ms' },
            throughput: { value: 1.5, unit: 'jobs/min' },
            completedJobs: 90,
            timeWindow: '1 hour',
          },
        },
      },
    });

    const metrics = await jobsService.getQueueMetrics('etl-sync');

    expect(request.get).toHaveBeenCalledWith('/queues/etl-sync/metrics');
    expect(metrics).toMatchObject({
      queueName: 'etl-sync',
      throughput: { completed: 90, timeWindow: '1 hour' },
      latency: { avg: 200, p50: 200 },
    });
  });

  it('pauses and resumes a queue against the exact queueName route', async () => {
    request.post.mockResolvedValue({ data: { success: true, data: {} } });

    await jobsService.pauseQueue('etl-sync');
    await jobsService.resumeQueue('etl-sync');

    expect(request.post).toHaveBeenNthCalledWith(1, '/queues/etl-sync/pause');
    expect(request.post).toHaveBeenNthCalledWith(2, '/queues/etl-sync/resume');
  });
});
