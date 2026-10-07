// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector API endpoints
 */

import { apiClient } from '../lib/api-client';

interface PublicConfig {
  id: string;
  name: string;
  description?: string;
  connector_type: string;
  enabled: boolean;
  schedule_enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface PublicRun {
  id: string;
  config_id: string;
  connector_type: string;
  config_name: string;
  status: string;
  started_at: string;
  records_loaded: number;
}

interface ConfigInput {
  name?: string;
  connector_type?: string;
  description?: string;
  enabled?: boolean;
  connection?: Record<string, unknown>;
  options?: Record<string, unknown>;
  resource_configs?: Record<string, unknown>;
  enabled_resources?: string[];
}

function displayConfig(row: PublicConfig) {
  return {
    id: row.id, name: row.name, description: row.description,
    type: row.connector_type, status: row.enabled ? 'active' : 'inactive',
    schedule_enabled: row.schedule_enabled, created_at: row.created_at, updated_at: row.updated_at,
  };
}

function displayRun(row: PublicRun) {
  return {
    id: row.id, configId: row.config_id, connectorType: row.connector_type,
    configName: row.config_name, status: row.status, startedAt: row.started_at,
    recordsLoaded: row.records_loaded,
  };
}

/** Surface only the known, fixed server refusal; never display arbitrary response errors. */
export function connectorRunErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = error.response;
    if (response && typeof response === 'object' && 'status' in response &&
        'data' in response && response.status === 409 &&
        response.data && typeof response.data === 'object' &&
        'error' in response.data &&
        response.data.error === 'Connector credential reference unavailable') {
      return 'Connector credential reference unavailable';
    }
  }
  return 'Failed to start connector';
}

export const connectorsApi = {
  // List all connector CONFIGURATIONS (deployed instances)
  list: async () => {
    const response = await apiClient.get<{ success: boolean; data: PublicConfig[] }>('/connector-configs');
    return response.data.map(displayConfig);
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

  // Public responses are projected explicitly; saved connection settings never enter UI state.
  get: async (id: string) => {
    const response = await apiClient.get<{ success: boolean; data: PublicConfig }>(`/connector-configs/${id}`);
    return displayConfig(response.data);
  },

  create: async (data: ConfigInput) => {
    const response = await apiClient.post<{ success: boolean; data: PublicConfig }>('/connector-configs', data);
    return displayConfig(response.data);
  },

  update: async (id: string, data: ConfigInput) => {
    const response = await apiClient.put<{ success: boolean; data: PublicConfig }>(`/connector-configs/${id}`, data);
    return displayConfig(response.data);
  },

  delete: (id: string) => apiClient.delete(`/connector-configs/${id}`),

  run: async (id: string) => {
    const response = await apiClient.post<{ success: boolean; data: PublicRun }>(`/connector-configs/${id}/run`);
    return displayRun(response.data);
  },

  getRuns: async (id: string, limit = 50) => {
    const response = await apiClient.get<{ success: boolean; data: PublicRun[] }>(`/connector-configs/${id}/runs`, {
      params: { limit },
    });
    return response.data.map(displayRun);
  },
  // Test connector connection
  test: (id: string) =>
    apiClient.post<{ success: boolean; message: string }>(`/connector-configs/${id}/test`),
};
