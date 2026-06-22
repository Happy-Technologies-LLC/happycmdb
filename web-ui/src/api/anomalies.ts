// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Anomaly Detection API endpoints
 */

import { apiClient } from '../lib/api-client';
import { Anomaly } from '../types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  _error?: string;
  _message?: string;
}

export const anomaliesApi = {
  // Get recent anomalies
  getRecent: async (hours = 24, limit = 100): Promise<Anomaly[]> => {
    const response = await apiClient.get<ApiResponse<Anomaly[]>>('/anomalies/recent', {
      params: { hours, limit },
    });
    return response.data;
  },

  // Get anomalies for a specific CI
  getForCI: async (ciId: string, limit = 50): Promise<Anomaly[]> => {
    const response = await apiClient.get<ApiResponse<Anomaly[]>>(`/anomalies/ci/${ciId}`, {
      params: { limit },
    });
    return response.data;
  },

  // Update anomaly status
  updateStatus: async (
    id: string,
    status: 'investigating' | 'resolved' | 'false_positive',
    resolvedBy?: string
  ): Promise<Anomaly> => {
    const response = await apiClient.patch<ApiResponse<Anomaly>>(`/anomalies/${id}/status`, {
      status,
      resolved_by: resolvedBy,
    });
    return response.data;
  },

  // Get anomaly statistics
  getStats: async (): Promise<{
    total: number;
    by_severity: Record<string, number>;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
  }> => {
    const response = await apiClient.get<ApiResponse<{
      total: number;
      by_severity: Record<string, number>;
      by_type: Record<string, number>;
      by_status: Record<string, number>;
    }>>('/anomalies/stats');
    return response.data;
  },
};
