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

  it('never passes raw worker result, progress, failures or job data to a consumer even if a response contains them', async () => {
    const secret = 'synthetic-nested-secret';
    request.get.mockResolvedValue({ data: { success: true, data: {
      id: 'owned-job', name: 'scan', state: 'failed', timestamp: 1,
      data: { config: { credentials: { password: secret } } },
      returnvalue: { nested: { password: secret } },
      progress: { nested: secret }, failedReason: secret, stacktrace: [secret],
    } } });
    const job = await jobsService.getJobById('discovery-nmap', 'owned-job');
    expect(job.status).toBe('failed');
    expect(job.failedReason).toBe('Job failed');
    expect(JSON.stringify(job)).not.toContain(secret);
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

  it('fetches dead letter (failed) jobs via the canonical failed-jobs route with bounded pagination and no raw failure payload', async () => {
    const secret = 'synthetic-failure-secret';
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
              state: 'failed',
              data: { config: { credentials: { password: secret } } },
              failedReason: secret,
              stacktrace: [secret],
              returnvalue: { nested: secret },
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
    expect(jobs[0]).toMatchObject({ id: 'job-9', status: 'failed', failedReason: 'Job failed', attempts: 3 });
    expect(JSON.stringify(jobs)).not.toContain(secret);
  });
});
