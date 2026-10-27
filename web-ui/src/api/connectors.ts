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
  started_at: string | null;
  records_loaded: number | null;
  resource_id?: string | null;
  completed_at?: string | null;
  records_extracted?: number | null;
  records_transformed?: number | null;
  records_failed?: number | null;
  duration_ms?: number | null;
  triggered_by?: string | null;
}

interface ConfigInput {
  name?: string;
  connector_type?: string;
  description?: string;
  enabled?: boolean;
  schedule?: string;
  schedule_enabled?: boolean;
  connection?: Record<string, unknown>;
  options?: Record<string, unknown>;
  resource_configs?: Record<string, unknown>;
  enabled_resources?: string[];
}

/** Only fields returned by the public connector-config projection. Run timestamps
 * belong to the separate /runs response, not to configuration records. */
export interface ConnectorConfigSummary {
  id: string;
  name: string;
  description?: string;
  type: string;
  status: string;
  schedule_enabled: boolean;
  created_at: string;
  updated_at: string;
}

function displayConfig(row: PublicConfig): ConnectorConfigSummary {
  return {
    id: row.id, name: row.name, description: row.description,
    type: row.connector_type, status: row.enabled ? 'active' : 'inactive',
    schedule_enabled: row.schedule_enabled, created_at: row.created_at, updated_at: row.updated_at,
  };
}

/** Public run telemetry as returned by the API; absent values stay null, never defaulted. */
export interface ConnectorRun {
  id: string;
  configId: string;
  connectorType: string;
  configName: string;
  status: string;
  startedAt: string | null;
  recordsLoaded: number | null;
  resourceId: string | null;
  completedAt: string | null;
  recordsExtracted: number | null;
  recordsTransformed: number | null;
  recordsFailed: number | null;
  durationMs: number | null;
  triggeredBy: string | null;
}

function displayRun(row: PublicRun): ConnectorRun {
  return {
    id: row.id, configId: row.config_id, connectorType: row.connector_type,
    configName: row.config_name, status: row.status, startedAt: row.started_at,
    recordsLoaded: row.records_loaded,
    resourceId: row.resource_id ?? null, completedAt: row.completed_at ?? null,
    recordsExtracted: row.records_extracted ?? null, recordsTransformed: row.records_transformed ?? null,
    recordsFailed: row.records_failed ?? null, durationMs: row.duration_ms ?? null,
    triggeredBy: row.triggered_by ?? null,
  };
}

/** Epoch ms of a supplied, valid timestamp; null when absent or unparseable. */
function startedAtMs(run: ConnectorRun): number | null {
  const ms = run.startedAt ? Date.parse(run.startedAt) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

/** Newest started_at first; runs without a valid started_at go last. Non-mutating and stable. */
export function sortRunsNewestFirst(runs: ConnectorRun[]): ConnectorRun[] {
  return [...runs].sort((a, b) => {
    const am = startedAtMs(a);
    const bm = startedAtMs(b);
    if (am === null || bm === null) return am === bm ? 0 : am === null ? 1 : -1;
    return bm - am;
  });
}

export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;

const RUN_STATUS_DISPLAY: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  queued: { variant: 'outline', label: 'Queued' },
  running: { variant: 'default', label: 'Running' },
  completed: { variant: 'secondary', label: 'Completed' },
  failed: { variant: 'destructive', label: 'Failed' },
  cancelled: { variant: 'outline', label: 'Cancelled' },
};

/** Known statuses get a label; anything else is shown verbatim with neutral styling. */
export function runStatusDisplay(status: string) {
  return Object.prototype.hasOwnProperty.call(RUN_STATUS_DISPLAY, status)
    ? RUN_STATUS_DISPLAY[status]
    : { variant: 'outline' as const, label: status };
}

export const UNKNOWN_VALUE = '—';

/** Locale date-time for a supplied, valid timestamp; otherwise "—". Never substitutes "now". */
export function formatRunTimestamp(value: string | null | undefined): string {
  if (!value || Number.isNaN(Date.parse(value))) return UNKNOWN_VALUE;
  return new Date(value).toLocaleString();
}

/** Actual counts only (0 stays "0"); absent or non-numeric stays "—". */
export function formatRunCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : UNKNOWN_VALUE;
}

/** Format a reported duration_ms; absent or invalid stays "—". */
export function formatRunDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return UNKNOWN_VALUE;
  if (ms < 1000) return `${ms} ms`;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h && `${h}h`, (h || m) && `${m}m`, `${s}s`].filter(Boolean).join(' ');
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

  // Tenant-scoped run history across all configurations. The server orders and scopes it;
  // ordering is repeated here so unsorted responses still render deterministically.
  getAllRuns: async () => {
    const response = await apiClient.get<{ success: boolean; data: PublicRun[] }>('/connector-configs/runs/all', {
      params: { sort_by: 'started_at', sort_order: 'desc' },
    });
    return sortRunsNewestFirst(response.data.map(displayRun));
  },

  // Test connector connection
  test: (id: string) =>
    apiClient.post<{ success: boolean; message: string }>(`/connector-configs/${id}/test`),
};
