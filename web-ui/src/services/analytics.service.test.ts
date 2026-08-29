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

import { analyticsService } from './analytics.service';

describe('analyticsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches CI counts by type from the registered /analytics/ci-counts endpoint and unwraps the envelope', async () => {
    request.get.mockResolvedValue({
      data: { success: true, data: [{ ci_type: 'server', count: 3 }] },
    });

    const result = await analyticsService.getCICountsByType();

    expect(request.get).toHaveBeenCalledWith('/analytics/ci-counts');
    expect(result).toEqual([{ ci_type: 'server', count: 3 }]);
  });

  it('fetches CI counts by status from the registered /analytics/ci-status endpoint', async () => {
    request.get.mockResolvedValue({
      data: { success: true, data: [{ status: 'active', count: 10 }] },
    });

    const result = await analyticsService.getCICountsByStatus();

    expect(request.get).toHaveBeenCalledWith('/analytics/ci-status');
    expect(result).toEqual([{ status: 'active', count: 10 }]);
  });

  it('fetches CI counts by environment from the registered /analytics/ci-environments endpoint', async () => {
    request.get.mockResolvedValue({
      data: { success: true, data: [{ environment: 'production', count: 7 }] },
    });

    const result = await analyticsService.getCICountsByEnvironment();

    expect(request.get).toHaveBeenCalledWith('/analytics/ci-environments');
    expect(result).toEqual([{ environment: 'production', count: 7 }]);
  });

  it('converts PG COUNT(*) string values to numbers for all three CI count endpoints', async () => {
    request.get.mockResolvedValueOnce({
      data: { success: true, data: [{ ci_type: 'server', count: '42' }] },
    });
    const byType = await analyticsService.getCICountsByType();
    expect(byType).toEqual([{ ci_type: 'server', count: 42 }]);
    expect(typeof byType[0].count).toBe('number');

    request.get.mockResolvedValueOnce({
      data: { success: true, data: [{ status: 'active', count: '17' }] },
    });
    const byStatus = await analyticsService.getCICountsByStatus();
    expect(byStatus).toEqual([{ status: 'active', count: 17 }]);
    expect(typeof byStatus[0].count).toBe('number');

    request.get.mockResolvedValueOnce({
      data: { success: true, data: [{ environment: 'production', count: '5' }] },
    });
    const byEnvironment = await analyticsService.getCICountsByEnvironment();
    expect(byEnvironment).toEqual([{ environment: 'production', count: 5 }]);
    expect(typeof byEnvironment[0].count).toBe('number');
  });

  it('fetches the real relationship matrix shape from /analytics/relationship-matrix', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: [
          { source_type: 'server', target_type: 'application', relationship_type: 'HOSTS', count: 2 },
        ],
      },
    });

    const result = await analyticsService.getRelationshipMatrix();

    expect(request.get).toHaveBeenCalledWith('/analytics/relationship-matrix');
    expect(result).toEqual([
      { source_type: 'server', target_type: 'application', relationship_type: 'HOSTS', count: 2 },
    ]);
  });

  it('sends the change timeline date range using the backend snake_case query params', async () => {
    request.get.mockResolvedValue({
      data: { success: true, data: [{ date: '2026-01-01', created: 1, updated: 0, deleted: 0 }] },
    });

    const result = await analyticsService.getChangeTimeline({
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-08T00:00:00.000Z',
    });

    expect(request.get).toHaveBeenCalledWith('/analytics/change-timeline', {
      params: {
        start_date: '2026-01-01T00:00:00.000Z',
        end_date: '2026-01-08T00:00:00.000Z',
      },
    });
    expect(result).toEqual([{ date: '2026-01-01', created: 1, updated: 0, deleted: 0 }]);
  });

  it('omits date params when no date range is provided for the change timeline', async () => {
    request.get.mockResolvedValue({ data: { success: true, data: [] } });

    await analyticsService.getChangeTimeline();

    expect(request.get).toHaveBeenCalledWith('/analytics/change-timeline', { params: undefined });
  });

  it('requests health metrics for the given CI id with converted date range params', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: [{ timestamp: '2026-01-05T00:00:00.000Z', status: 'detected' }],
      },
    });

    const result = await analyticsService.getHealthMetrics('server-001', {
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-08T00:00:00.000Z',
    });

    expect(request.get).toHaveBeenCalledWith('/analytics/health-metrics/server-001', {
      params: {
        start_date: '2026-01-01T00:00:00.000Z',
        end_date: '2026-01-08T00:00:00.000Z',
      },
    });
    expect(result).toEqual([{ timestamp: '2026-01-05T00:00:00.000Z', status: 'detected' }]);
  });

  it('converts present health metric numeric fields (even as PG strings) and leaves null/absent fields undefined, never 0', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            timestamp: '2026-01-05T00:00:00.000Z',
            cpu_usage: '87.5',
            memory_usage: null,
            disk_usage: 42,
            status: 'detected',
          },
        ],
      },
    });

    const result = await analyticsService.getHealthMetrics('server-001');

    expect(result).toEqual([
      {
        timestamp: '2026-01-05T00:00:00.000Z',
        cpu_usage: 87.5,
        memory_usage: undefined,
        disk_usage: 42,
        network_latency: undefined,
        status: 'detected',
      },
    ]);
    expect(typeof result[0].cpu_usage).toBe('number');
  });

  it('returns the dashboard payload using its controller snake_case contract', async () => {
    request.get.mockResolvedValue({
      data: {
        total_cis: 12,
        by_type: { server: 8, application: 4 },
        by_status: { active: 10, retired: 2 },
        by_environment: { production: 9, development: 3 },
        recent_discoveries: [],
        health_score: 0,
        critical_relationships: 16,
      },
    });

    const result = await analyticsService.getDashboardStats();

    expect(request.get).toHaveBeenCalledWith('/analytics/dashboard');
    expect(result).toEqual({
      total_cis: 12,
      by_type: { server: 8, application: 4 },
      by_status: { active: 10, retired: 2 },
      by_environment: { production: 9, development: 3 },
      recent_discoveries: [],
      health_score: 0,
      critical_relationships: 16,
    });
  });

  it('converts and unwraps discovery statistics into the controller contract', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          summary: {
            total_cis: '12',
            unique_types: '3',
            first_discovery: '2026-01-01T00:00:00.000Z',
            last_discovery: '2026-01-08T00:00:00.000Z',
          },
          by_provider: [
            { discovery_provider: 'aws', count: '9' },
            { discovery_provider: 'servicenow', count: '3' },
          ],
        },
      },
    });

    const result = await analyticsService.getDiscoveryStats({
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-08T00:00:00.000Z',
    });

    expect(request.get).toHaveBeenCalledWith('/analytics/discovery-stats', {
      params: {
        start_date: '2026-01-01T00:00:00.000Z',
        end_date: '2026-01-08T00:00:00.000Z',
      },
    });
    expect(result).toEqual({
      summary: {
        total_cis: 12,
        unique_types: 3,
        first_discovery: '2026-01-01T00:00:00.000Z',
        last_discovery: '2026-01-08T00:00:00.000Z',
      },
      by_provider: [
        { discovery_provider: 'aws', count: 9 },
        { discovery_provider: 'servicenow', count: 3 },
      ],
    });
  });

  it('unwraps top connected CIs and maps relationship_count for the chart', async () => {
    request.get.mockResolvedValue({
      data: {
        success: true,
        data: [
          {
            ci_id: 'ci-001',
            ci_name: 'Production API',
            ci_type: 'application',
            relationship_count: '14',
          },
        ],
      },
    });

    const result = await analyticsService.getTopConnectedCIs(5);

    expect(request.get).toHaveBeenCalledWith('/analytics/top-connected', { params: { limit: 5 } });
    expect(result).toEqual([
      {
        ci_id: 'ci-001',
        ci_name: 'Production API',
        ci_type: 'application',
        connection_count: 14,
      },
    ]);
  });
});
