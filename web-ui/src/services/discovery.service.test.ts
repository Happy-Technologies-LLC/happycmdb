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
          result: { discovered: 5 },
          timestamp: 1000,
          processedOn: 1100,
          finishedOn: 1500,
          config: {},
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

  it('derives job results from the same legacy endpoint, backed by the stored returnvalue', async () => {
    request.get.mockResolvedValue({
      data: {
        data: {
          id: 'job-1',
          provider: 'nmap',
          status: 'completed',
          progress: 100,
          result: { discovered: 7 },
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

  it('fetches provider stats using server-side provider filtering on the canonical stats endpoint', async () => {
    request.get.mockResolvedValue({
      data: {
        data: [
          { provider: 'nmap', waiting: 1, active: 0, completed: 4, failed: 1, totalDiscoveredCIs: 12 },
        ],
      },
    });

    const stats = await discoveryService.getProviderStats('nmap');

    expect(request.get).toHaveBeenCalledWith('/jobs/discovery/stats?provider=nmap');
    expect(stats).toMatchObject({ provider: 'nmap', totalJobs: 6, totalDiscoveredCIs: 12 });
  });

  it('maps the real averageDurationMs and enabled fields from the stats endpoint, never fabricating them', async () => {
    request.get.mockResolvedValue({
      data: {
        data: [
          {
            provider: 'nmap',
            waiting: 1,
            active: 0,
            completed: 4,
            failed: 1,
            totalDiscoveredCIs: 12,
            averageDurationMs: 4500,
            enabled: false,
          },
        ],
      },
    });

    const stats = await discoveryService.getProviderStats('nmap');

    expect(stats.averageDuration).toBe(4500);
    expect(stats.enabled).toBe(false);
  });

  it('leaves averageDuration and enabled undefined when the backend omits them, rather than defaulting to 0/true', async () => {
    request.get.mockResolvedValue({
      data: {
        data: [
          { provider: 'nmap', waiting: 0, active: 0, completed: 0, failed: 0, totalDiscoveredCIs: 0 },
        ],
      },
    });

    const stats = await discoveryService.getProviderStats('nmap');

    expect(stats.averageDuration).toBeUndefined();
    expect(stats.enabled).toBeUndefined();
  });

  it('throws for a provider absent from the stats response instead of returning a fabricated placeholder', async () => {
    request.get.mockResolvedValue({ data: { data: [] } });

    await expect(discoveryService.getProviderStats('nmap')).rejects.toThrow(
      'No discovery stats found for provider: nmap'
    );
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

  it('maps the schedule envelope to the frontend contract and sends the canonical cronExpression field', async () => {
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

    const schedule = await discoveryService.updateSchedule('nmap', {
      cronExpression: '*/15 * * * *',
      enabled: false,
    });

    expect(request.put).toHaveBeenCalledWith('/jobs/schedules/discovery/nmap', {
      cronExpression: '*/15 * * * *',
      enabled: false,
    });
    expect(schedule).toEqual({
      provider: 'nmap',
      cronExpression: '*/15 * * * *',
      enabled: false,
      config: { targets: [] },
    });
  });
});
