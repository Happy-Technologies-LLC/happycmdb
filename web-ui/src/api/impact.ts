// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Prediction API endpoints
 */

import { apiClient } from '../lib/api-client';
import { ImpactAnalysis, DependencyGraph } from '../types';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
}

interface CriticalityScore {
  ci_id: string;
  ci_name: string;
  criticality_score: number;
  factors: Record<string, any>;
  calculated_at: string;
}

export const impactApi = {
  // Predict change impact
  predict: async (ciId: string, changeType: string): Promise<ImpactAnalysis> => {
    const response = await apiClient.post<ApiResponse<ImpactAnalysis>>('/impact/predict', {
      ci_id: ciId,
      change_type: changeType,
    });
    return response.data;
  },

  // Get dependency graph
  getGraph: async (rootCiId: string, maxDepth = 3): Promise<DependencyGraph> => {
    const response = await apiClient.get<ApiResponse<DependencyGraph>>(
      `/impact/graph/${rootCiId}`,
      { params: { max_depth: maxDepth } }
    );
    return response.data;
  },

  // Get CI criticality score
  getCriticalityScore: async (ciId: string): Promise<CriticalityScore> => {
    const response = await apiClient.get<ApiResponse<CriticalityScore>>(
      `/impact/criticality/${ciId}`
    );
    return response.data;
  },

  // Get impact analysis history
  getHistory: async (ciId: string, limit = 20): Promise<ImpactAnalysis[]> => {
    const response = await apiClient.get<ApiResponse<ImpactAnalysis[]>>(
      `/impact/history/${ciId}`,
      { params: { limit } }
    );
    return response.data;
  },
};
