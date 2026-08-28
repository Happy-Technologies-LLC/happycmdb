// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Analytics API Service
 * Handles all analytics and reporting API calls
 */

import { apiClient } from './api';

export interface DashboardStats {
  total_cis: number;
  by_type: Record<string, number>;
  by_status: Record<string, number>;
  by_environment: Record<string, number>;
  recent_discoveries: DashboardRecentDiscovery[];
  health_score: number;
  critical_relationships: number;
}

export interface DashboardRecentDiscovery {
  id: string;
  name: string;
  type: string;
  status: string;
  environment: string | null;
  last_discovered: string | null;
}

export interface CICountByType {
  ci_type: string;
  count: number;
}

export interface CICountByStatus {
  status: string;
  count: number;
}

export interface CICountByEnvironment {
  environment: string;
  count: number;
}

export interface DiscoveryStats {
  summary: DiscoverySummary;
  by_provider: DiscoveryProviderStat[];
}

export interface DiscoverySummary {
  total_cis: number;
  unique_types: number;
  first_discovery: string | null;
  last_discovery: string | null;
}

export interface DiscoveryProviderStat {
  discovery_provider: string;
  count: number;
}

export interface TopConnectedCI {
  ci_id: string;
  ci_name: string;
  ci_type: string;
  connection_count: number;
}

export interface RelationshipMatrix {
  source_type: string;
  target_type: string;
  relationship_type: string;
  count: number;
}

export interface ChangeTimelinePoint {
  date: string;
  created: number;
  updated: number;
  deleted: number;
}

export interface HealthMetric {
  timestamp: string;
  cpu_usage?: number;
  memory_usage?: number;
  disk_usage?: number;
  network_latency?: number;
  status: string;
}

export interface DateRangeParams {
  startDate?: string;
  endDate?: string;
}

interface AnalyticsApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
}

/** Raw per-row shape from GET /analytics/ci-counts; PG COUNT(*) comes back as a string. */
interface CICountByTypeApiResponse {
  ci_type: string;
  count: number | string;
}

/** Raw per-row shape from GET /analytics/ci-status; PG COUNT(*) comes back as a string. */
interface CICountByStatusApiResponse {
  status: string;
  count: number | string;
}

/** Raw per-row shape from GET /analytics/ci-environments; PG COUNT(*) comes back as a string. */
interface CICountByEnvironmentApiResponse {
  environment: string;
  count: number | string;
}

/** Raw per-row shape from GET /analytics/health-metrics/:ciId; numeric columns may be strings or null. */
interface HealthMetricApiResponse {
  timestamp: string;
  cpu_usage?: number | string | null;
  memory_usage?: number | string | null;
  disk_usage?: number | string | null;
  network_latency?: number | string | null;
  status: string;
}

interface DiscoveryStatsApiResponse {
  summary: {
    total_cis: number | string;
    unique_types: number | string;
    first_discovery?: string | null;
    last_discovery?: string | null;
  };
  by_provider: Array<{
    discovery_provider: string;
    count: number | string;
  }>;
}

interface TopConnectedCIApiResponse {
  ci_id: string;
  ci_name: string;
  ci_type: string;
  relationship_count: number | string;
}

/**
 * Convert a camelCase DateRangeParams into the snake_case query params
 * expected by the analytics REST endpoints.
 */
function toDateRangeQuery(params?: DateRangeParams): Record<string, string> | undefined {
  if (!params) return undefined;
  const query: Record<string, string> = {};
  if (params.startDate) query.start_date = params.startDate;
  if (params.endDate) query.end_date = params.endDate;
  return query;
}

/**
 * Convert a possibly-string, possibly-null/undefined numeric field (as PG
 * may return it) into a real number, preserving absence rather than
 * fabricating 0 for a metric that was never recorded.
 */
function toOptionalNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  return Number(value);
}

class AnalyticsService {
  /**
   * Get dashboard summary statistics
   */
  async getDashboardStats(): Promise<DashboardStats> {
    const response = await apiClient.get<DashboardStats>('/analytics/dashboard');
    return response.data;
  }

  /**
   * Get CI counts grouped by type
   */
  async getCICountsByType(): Promise<CICountByType[]> {
    const response = await apiClient.get<AnalyticsApiResponse<CICountByTypeApiResponse[]>>('/analytics/ci-counts');
    return response.data.data.map((row) => ({
      ci_type: row.ci_type,
      count: Number(row.count),
    }));
  }

  /**
   * Get CI counts grouped by status
   */
  async getCICountsByStatus(): Promise<CICountByStatus[]> {
    const response = await apiClient.get<AnalyticsApiResponse<CICountByStatusApiResponse[]>>('/analytics/ci-status');
    return response.data.data.map((row) => ({
      status: row.status,
      count: Number(row.count),
    }));
  }

  /**
   * Get CI counts grouped by environment
   */
  async getCICountsByEnvironment(): Promise<CICountByEnvironment[]> {
    const response = await apiClient.get<AnalyticsApiResponse<CICountByEnvironmentApiResponse[]>>('/analytics/ci-environments');
    return response.data.data.map((row) => ({
      environment: row.environment,
      count: Number(row.count),
    }));
  }

  /**
   * Get discovery coverage statistics
   */
  async getDiscoveryStats(params?: DateRangeParams): Promise<DiscoveryStats> {
    const response = await apiClient.get<AnalyticsApiResponse<DiscoveryStatsApiResponse>>(
      '/analytics/discovery-stats',
      { params: toDateRangeQuery(params) }
    );
    const { summary, by_provider } = response.data.data;

    return {
      summary: {
        total_cis: Number(summary.total_cis),
        unique_types: Number(summary.unique_types),
        first_discovery: summary.first_discovery ?? null,
        last_discovery: summary.last_discovery ?? null,
      },
      by_provider: by_provider.map((provider) => ({
        discovery_provider: provider.discovery_provider,
        count: Number(provider.count),
      })),
    };
  }

  /**
   * Get top N most connected CIs
   */
  async getTopConnectedCIs(limit: number = 10): Promise<TopConnectedCI[]> {
    const response = await apiClient.get<AnalyticsApiResponse<TopConnectedCIApiResponse[]>>(
      '/analytics/top-connected',
      { params: { limit } }
    );
    return response.data.data.map((ci) => ({
      ci_id: ci.ci_id,
      ci_name: ci.ci_name,
      ci_type: ci.ci_type,
      connection_count: Number(ci.relationship_count),
    }));
  }

  /**
   * Get relationship type matrix
   */
  async getRelationshipMatrix(): Promise<RelationshipMatrix[]> {
    const response = await apiClient.get<AnalyticsApiResponse<RelationshipMatrix[]>>(
      '/analytics/relationship-matrix'
    );
    return response.data.data;
  }

  /**
   * Get change timeline data
   */
  async getChangeTimeline(params?: DateRangeParams): Promise<ChangeTimelinePoint[]> {
    const response = await apiClient.get<AnalyticsApiResponse<ChangeTimelinePoint[]>>(
      '/analytics/change-timeline',
      { params: toDateRangeQuery(params) }
    );
    return response.data.data;
  }

  /**
   * Get health metrics for a specific CI
   */
  async getHealthMetrics(ciId: string, params?: DateRangeParams): Promise<HealthMetric[]> {
    const response = await apiClient.get<AnalyticsApiResponse<HealthMetricApiResponse[]>>(
      `/analytics/health-metrics/${ciId}`,
      { params: toDateRangeQuery(params) }
    );
    return response.data.data.map((row) => ({
      timestamp: row.timestamp,
      cpu_usage: toOptionalNumber(row.cpu_usage),
      memory_usage: toOptionalNumber(row.memory_usage),
      disk_usage: toOptionalNumber(row.disk_usage),
      network_latency: toOptionalNumber(row.network_latency),
      status: row.status,
    }));
  }

  /**
   * Export analytics data to CSV
   */
  async exportToCSV(data: any[], filename: string): Promise<void> {
    const csv = this.convertToCSV(data);
    this.downloadFile(csv, filename, 'text/csv');
  }

  /**
   * Export analytics data to JSON
   */
  async exportToJSON(data: any[], filename: string): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    this.downloadFile(json, filename, 'application/json');
  }

  /**
   * Convert array of objects to CSV format
   */
  private convertToCSV(data: any[]): string {
    if (data.length === 0) return '';

    const headers = Object.keys(data[0]);
    const csvRows = [];

    // Add header row
    csvRows.push(headers.join(','));

    // Add data rows
    for (const row of data) {
      const values = headers.map((header) => {
        const value = row[header];
        // Escape commas and quotes
        const escaped = String(value).replace(/"/g, '""');
        return `"${escaped}"`;
      });
      csvRows.push(values.join(','));
    }

    return csvRows.join('\n');
  }

  /**
   * Trigger file download in browser
   */
  private downloadFile(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }
}

export const analyticsService = new AnalyticsService();
