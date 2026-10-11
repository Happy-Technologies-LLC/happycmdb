// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request, apiClient } = vi.hoisted(() => {
  const request = {
    post: vi.fn(),
    get: vi.fn(),
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

import { discoveryService } from './discovery.service';

describe('discoveryService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists discovery jobs via the canonical /jobs/discovery endpoint', async () => {
    request.get.mockResolvedValue({
      data: { data: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } },
    });

    await discoveryService.getJobs({ provider: 'nmap' });

    expect(request.get).toHaveBeenCalledWith('/jobs/discovery?provider=nmap');
  });

  it('gets a job by id via the dedicated legacy discovery API, needing no queue name', async () => {
    request.get.mockResolvedValue({
      data: {
        data: {
          id: 'job-1',
          provider: 'nmap',
          status: 'completed',
          progress: 100,
          summary: { discoveredCIs: 5 },
          timestamp: 1000,
          processedOn: 1100,
          finishedOn: 1500,
        },
      },
    });

    const job = await discoveryService.getJob('job-1');

    expect(request.get).toHaveBeenCalledWith('/discovery/jobs/job-1');
    expect(job).toMatchObject({
      id: 'job-1',
      provider: 'nmap',
      status: 'completed',
      discoveredCIs: 5,
    });
  });

  it('derives numeric result counts only from the allowlisted summary, never worker returnvalue', async () => {
    request.get.mockResolvedValue({
      data: {
        data: {
          id: 'job-1',
          provider: 'nmap',
          status: 'completed',
          progress: 100,
          summary: { discoveredCIs: 7 },
          timestamp: 1000,
          processedOn: 1100,
          finishedOn: 1500,
        },
      },
    });

    const result = await discoveryService.getJobResult('job-1');

    expect(request.get).toHaveBeenCalledWith('/discovery/jobs/job-1');
    expect(result).toEqual({
      jobId: 'job-1',
      provider: 'nmap',
      status: 'completed',
      discoveredCIs: [],
      totalCount: 7,
      successCount: 7,
      failureCount: 0,
      duration: 400,
    });
  });

  it('shows only fixed failure metadata and refuses to invent an unavailable result count', async () => {
    request.get.mockResolvedValue({ data: { data: {
      id: 'failed-job', provider: 'nmap', status: 'failed',
      failureCode: 'DISCOVERY_JOB_FAILED', timestamp: 1000,
    } } });
    const job = await discoveryService.getJob('failed-job');
    expect(job.error).toBe('DISCOVERY_JOB_FAILED');
    await expect(discoveryService.getJobResult('failed-job'))
      .rejects.toThrow('Discovery job result summary unavailable');
  });

  it('retries a job on the canonical per-provider queue route, never a route derived from the job id alone', async () => {
    request.post.mockResolvedValue({ data: {} });

    await discoveryService.retryJob('job-1', 'ssh');

    expect(request.post).toHaveBeenCalledWith('/jobs/discovery-ssh/job-1/retry');
  });

  it('cancels a job via the dedicated legacy discovery API, needing no queue name', async () => {
    request.delete.mockResolvedValue({ data: {} });

    await discoveryService.cancelJob('job-1');

    expect(request.delete).toHaveBeenCalledWith('/discovery/jobs/job-1');
  });


  it('tests credentials against the Settings-owned /discovery/test-connection contract', async () => {
    request.post.mockResolvedValue({ data: {} });

    const result = await discoveryService.testCredentials('ssh', { username: 'x' });

    expect(request.post).toHaveBeenCalledWith('/discovery/test-connection', {
      provider: 'ssh',
      credentials: { username: 'x' },
    });
    expect(result.valid).toBe(true);
  });

  it('reports invalid credentials when the test-connection call fails', async () => {
    request.post.mockRejectedValue({ response: { data: { message: 'bad creds' } } });

    const result = await discoveryService.testCredentials('ssh', { username: 'x' });

    expect(result).toEqual({ valid: false, message: 'bad creds' });
  });

});
