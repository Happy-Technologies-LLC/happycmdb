// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Drift API endpoints
 */

import { apiClient } from '../lib/api-client';
import { DriftDetectionResult, BaselineSnapshot } from '../types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
}

type SnapshotType = 'configuration' | 'performance' | 'relationships';

export const driftApi = {
  // Detect drift for a CI against its approved baseline
  detect: async (ciId: string): Promise<DriftDetectionResult> => {
    const response = await apiClient.post<ApiResponse<DriftDetectionResult>>(
      `/drift/detect/${ciId}`
    );
    return response.data;
  },

  // Get drift history
  getHistory: async (ciId: string, limit = 50): Promise<DriftDetectionResult[]> => {
    const response = await apiClient.get<ApiResponse<DriftDetectionResult[]>>(
      `/drift/history/${ciId}`,
      { params: { limit } }
    );
    return response.data;
  },

  // Create baseline (created_by is derived server-side from the authenticated user)
  createBaseline: async (
    ciId: string,
    snapshotType: SnapshotType
  ): Promise<BaselineSnapshot> => {
    const response = await apiClient.post<ApiResponse<BaselineSnapshot>>('/drift/baseline', {
      ci_id: ciId,
      snapshot_type: snapshotType,
    });
    return response.data;
  },

  // Approve baseline (approved_by is derived server-side from the authenticated user)
  approveBaseline: async (baselineId: string): Promise<BaselineSnapshot> => {
    const response = await apiClient.post<ApiResponse<BaselineSnapshot>>(
      `/drift/baseline/${baselineId}/approve`
    );
    return response.data;
  },

  // Get approved baseline
  getApprovedBaseline: async (
    ciId: string,
    snapshotType: SnapshotType
  ): Promise<BaselineSnapshot | null> => {
    const response = await apiClient.get<ApiResponse<BaselineSnapshot | null>>(
      `/drift/baseline/${ciId}`,
      { params: { snapshot_type: snapshotType } }
    );
    return response.data;
  },
};
