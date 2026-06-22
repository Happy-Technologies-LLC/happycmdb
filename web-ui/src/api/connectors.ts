// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector API endpoints
 */

import { apiClient } from '../lib/api-client';
import { Connector, ConnectorRun } from '../types';

export const connectorsApi = {
  // List all connector CONFIGURATIONS (deployed instances)
  list: async () => {
    const response = await apiClient.get<{ success: boolean; data: Connector[] }>('/connector-configs');
    return response.data ?? [];
  },

  // List installed connectors (available templates from registry)
  listInstalled: async () => {
    const response = await apiClient.get<{ data: any[] }>('/connectors/installed');
    return response.data;
  },

  // Browse connector registry (all available connectors)
  listRegistry: async (params?: { category?: string; search?: string; verified_only?: boolean }) => {
    const response = await apiClient.get<{ data: any[]; pagination: any }>('/connectors/registry', { params });
    return response.data;
  },

  // Get connector by ID
  get: (id: string) => apiClient.get<Connector>(`/connector-configs/${id}`),

  // Create connector
  create: (data: Partial<Connector>) => apiClient.post<Connector>('/connector-configs', data),

  // Update connector
  update: (id: string, data: Partial<Connector>) =>
    apiClient.put<Connector>(`/connector-configs/${id}`, data),

  // Delete connector
  delete: (id: string) => apiClient.delete(`/connector-configs/${id}`),

  // Run connector manually
  run: (connectorName: string) =>
    apiClient.post<ConnectorRun>(`/connector-configs/${connectorName}/run`),

  // Get connector runs
  getRuns: (connectorName: string, limit = 50) =>
    apiClient.get<ConnectorRun[]>(`/connector-configs/${connectorName}/runs`, {
      params: { limit },
    }),

  // Test connector connection
  test: (id: string) =>
    apiClient.post<{ success: boolean; message: string }>(`/connector-configs/${id}/test`),
};
