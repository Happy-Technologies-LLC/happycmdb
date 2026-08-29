// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery API Service
 * Handles all discovery-related API calls
 */

import type { AxiosError } from 'axios';
import { apiClient as api } from './api';

/**
 * Discovery Provider - Network-based discovery protocols
 *
 * IMPORTANT: Discovery is for network-based discovery of UNKNOWN infrastructure.
 * For API-based import from KNOWN systems (AWS, Azure, GCP, Kubernetes, VMware, etc.),
 * use the Connector system instead.
 */
export type DiscoveryProvider =
  | 'nmap'              // Network mapping and port scanning
  | 'ssh'               // SSH-based deep discovery
  | 'active-directory'  // Active Directory domain discovery
  | 'snmp';             // SNMP device discovery

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DiscoveryJob {
  id: string;
  provider: DiscoveryProvider;
  status: JobStatus;
  progress: number; // 0-100
  discoveredCIs: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  config: Record<string, any>;
  definitionId?: string;
  definitionName?: string;
}

export interface DiscoveryJobResult {
  jobId: string;
  provider: DiscoveryProvider;
  status: JobStatus;
  discoveredCIs: DiscoveredCIResult[];
  totalCount: number;
  successCount: number;
  failureCount: number;
  duration: number; // milliseconds
}

export interface DiscoveredCIResult {
  id: string;
  name: string;
  type: string;
  source: DiscoveryProvider;
  status: string;
  environment?: string;
  attributes: Record<string, any>;
  confidenceScore: number;
}

/**
 * Raw response shape from the legacy `/discovery/jobs/:id` endpoint, shared
 * by getJob() and getJobResult(). `status` carries the raw BullMQ state
 * (waiting/active/completed/failed/delayed), not our JobStatus type.
 */
interface RawLegacyDiscoveryJob {
  id: string;
  provider: DiscoveryProvider;
  status: string;
  progress?: number;
  result?: { discovered?: number; method?: string; confidence?: number; cost?: number };
  error?: string;
  config?: Record<string, unknown>;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
  definitionId?: string;
  definitionName?: string;
  definition_id?: string;
  definition_name?: string;
}

/** Raw per-provider stat entry returned by GET /jobs/discovery/stats */
interface RawDiscoveryStat {
  provider: DiscoveryProvider;
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
  totalDiscoveredCIs?: number;
  /** Average completed-job duration in ms; null/absent when no sample was available. */
  averageDurationMs?: number | null;
  /** Real schedule-enabled state; absent when the provider has no registered schedule. */
  enabled?: boolean;
}

export interface DiscoverySchedule {
  provider: DiscoveryProvider;
  enabled: boolean;
  cronExpression: string;
  config: Record<string, any>;
  lastRun?: string;
  nextRun?: string;
}

export type DiscoveryScheduleUpdate = Pick<
  Partial<DiscoverySchedule>,
  'cronExpression' | 'enabled'
>;

interface RawDiscoverySchedule {
  provider: DiscoveryProvider;
  enabled: boolean;
  cronExpression?: string;
  cronPattern?: string;
  config?: Record<string, unknown>;
  lastRun?: string;
  nextRun?: string;
}

export interface DiscoveryStats {
  provider: DiscoveryProvider;
  /** Undefined when the provider has no registered schedule; never fabricated. */
  enabled?: boolean;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  successRate: number; // 0-100
  lastRun?: string;
  nextScheduledRun?: string;
  /** Milliseconds; undefined when no completed job in the sample had timing data. */
  averageDuration?: number;
  totalDiscoveredCIs: number;
}

export interface TriggerDiscoveryJobRequest {
  provider: DiscoveryProvider;
  config: AWSConfig | AzureConfig | GCPConfig | SSHConfig | NmapConfig;
}

export interface AWSConfig {
  regions: string[];
  resourceTypes: ('ec2' | 'rds' | 's3' | 'ecs' | 'lambda')[];
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export interface AzureConfig {
  subscriptionId: string;
  resourceGroups?: string[];
  credentials?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
}

export interface GCPConfig {
  projectId: string;
  zones?: string[];
  credentials?: {
    keyFile: string;
  };
}

export interface SSHConfig {
  targets: string[]; // Array of host:port
  credentials: {
    username: string;
    password?: string;
    privateKey?: string;
  };
}

export interface NmapConfig {
  targets: string[]; // Array of IP ranges/subnets
  scanOptions: {
    ports?: string;
    aggressive?: boolean;
    serviceDetection?: boolean;
    osDetection?: boolean;
  };
}

export interface JobFilters {
  provider?: DiscoveryProvider;
  status?: JobStatus;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'completedAt' | 'provider' | 'status';
  sortOrder?: 'asc' | 'desc';
  definitionId?: string;
}

export interface DiscoveryDefinition {
  id: string;
  name: string;
  description?: string;
  provider: DiscoveryProvider;
  method: 'agentless' | 'agent';
  credentialId?: string;
  agentId?: string;
  config: Record<string, any>;
  field_mappings?: Record<string, string>;
  schedule: {
    enabled: boolean;
    cronExpression?: string;
  };
  active: boolean;
  lastRunAt?: string;
  lastRunStatus?: JobStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryDefinitionInput {
  name: string;
  description?: string;
  provider: DiscoveryProvider;
  method: 'agentless' | 'agent';
  credentialId?: string;
  agentId?: string;
  config: Record<string, any>;
  field_mappings?: Record<string, string>;
  schedule?: {
    enabled: boolean;
    cronExpression?: string;
  };
  active?: boolean;
}

export interface DefinitionFilters {
  provider?: DiscoveryProvider;
  active?: boolean;
  page?: number;
  limit?: number;
}

export interface PaginatedJobsResponse {
  jobs: DiscoveryJob[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

class DiscoveryService {
  /**
   * Trigger a discovery job for a specific provider
   */
  async triggerJob(request: TriggerDiscoveryJobRequest): Promise<DiscoveryJob> {
    const { data } = await api.post(`/jobs/discovery/${request.provider}`, {
      config: request.config,
    });
    return data;
  }

  /**
   * Get list of discovery jobs with optional filters
   */
  async getJobs(filters?: JobFilters): Promise<PaginatedJobsResponse> {
    const params = new URLSearchParams();

    if (filters?.provider) params.append('provider', filters.provider);
    if (filters?.status) params.append('status', filters.status);
    if (filters?.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters?.dateTo) params.append('dateTo', filters.dateTo);
    if (filters?.page) params.append('page', filters.page.toString());
    if (filters?.limit) params.append('limit', filters.limit.toString());
    if (filters?.sortBy) params.append('sortBy', filters.sortBy);
    if (filters?.sortOrder) params.append('sortOrder', filters.sortOrder);

    const { data } = await api.get(`/jobs/discovery?${params.toString()}`);

    // Transform API response to match expected format
    const jobs = (data.data || []).map((job: any) => ({
      id: job.data?.jobId || job.id,
      provider: job.data?.provider || job.provider,
      status: this.mapJobStatus(job.status),
      progress: job.progress || 0,
      discoveredCIs: job.returnvalue?.discovered || 0,
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
      completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
      error: job.failedReason,
      config: job.data?.config || {},
      definitionId: job.data?.definition_id,
      definitionName: job.data?.definition_name,
    }));

    return {
      jobs,
      total: data.pagination?.total || 0,
      page: data.pagination?.page || 1,
      limit: data.pagination?.limit || 10,
      totalPages: data.pagination?.totalPages || 0,
    };
  }

  /**
   * Map BullMQ job status to our JobStatus type
   */
  private mapJobStatus(status: string): JobStatus {
    switch (status) {
      case 'waiting':
      case 'delayed':
        return 'pending';
      case 'active':
        return 'running';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * Map the legacy `/discovery/jobs/:id` response into a DiscoveryJob.
   */
  private mapLegacyJob(raw: RawLegacyDiscoveryJob): DiscoveryJob {
    return {
      id: raw.id,
      provider: raw.provider,
      status: this.mapJobStatus(raw.status),
      progress: typeof raw.progress === 'number' ? raw.progress : 0,
      discoveredCIs: raw.result?.discovered ?? 0,
      createdAt: new Date(raw.timestamp ?? Date.now()).toISOString(),
      startedAt: raw.processedOn ? new Date(raw.processedOn).toISOString() : undefined,
      completedAt: raw.finishedOn ? new Date(raw.finishedOn).toISOString() : undefined,
      error: raw.error,
      config: raw.config ?? {},
      definitionId: raw.definitionId ?? raw.definition_id,
      definitionName: raw.definitionName ?? raw.definition_name,
    };
  }

  /**
   * Get a specific job by ID. Uses the dedicated legacy discovery API, which
   * searches across every discovery queue so callers never need a queue name.
   */
  async getJob(jobId: string): Promise<DiscoveryJob> {
    const { data } = await api.get(`/discovery/jobs/${jobId}`);
    return this.mapLegacyJob(data.data);
  }

  /**
   * Get job results. BullMQ only stores an aggregate discovered-CI count on
   * the job's returnvalue (no per-CI records survive on the job itself), so
   * discoveredCIs is intentionally empty - totalCount reflects the real count.
   */
  async getJobResult(jobId: string): Promise<DiscoveryJobResult> {
    const { data } = await api.get(`/discovery/jobs/${jobId}`);
    const raw: RawLegacyDiscoveryJob = data.data;
    const status = this.mapJobStatus(raw.status);
    const discovered = raw.result?.discovered ?? 0;

    return {
      jobId: raw.id,
      provider: raw.provider,
      status,
      discoveredCIs: [],
      totalCount: discovered,
      successCount: status === 'completed' ? discovered : 0,
      failureCount: status === 'failed' ? discovered : 0,
      duration: raw.processedOn && raw.finishedOn ? raw.finishedOn - raw.processedOn : 0,
    };
  }

  /**
   * Retry a failed job via the canonical generic queue route. Discovery jobs
   * live in a per-provider queue (discovery-<provider>); the legacy discovery
   * API has no retry endpoint, so the queue name must be derived from the
   * job's own provider rather than the job ID.
   */
  async retryJob(jobId: string, provider: DiscoveryProvider): Promise<void> {
    await api.post(`/jobs/discovery-${provider}/${jobId}/retry`);
  }

  /**
   * Cancel a running job via the dedicated legacy discovery API, which
   * searches across every discovery queue so callers never need a queue name.
   */
  async cancelJob(jobId: string): Promise<void> {
    await api.delete(`/discovery/jobs/${jobId}`);
  }

  /**
   * Get all discovery schedules
   */
  async getSchedules(): Promise<DiscoverySchedule[]> {
    const { data } = await api.get<{ data?: RawDiscoverySchedule[] }>('/jobs/schedules/discovery');
    return (data.data ?? []).map((schedule) => this.mapDiscoverySchedule(schedule));
  }

  /**
   * Update a provider's schedule
   */
  async updateSchedule(
    provider: DiscoveryProvider,
    schedule: DiscoveryScheduleUpdate
  ): Promise<DiscoverySchedule> {
    const payload: DiscoveryScheduleUpdate = {};
    if (schedule.cronExpression !== undefined) {
      payload.cronExpression = schedule.cronExpression;
    }
    if (schedule.enabled !== undefined) {
      payload.enabled = schedule.enabled;
    }

    const { data } = await api.put<{ data: RawDiscoverySchedule }>(
      `/jobs/schedules/discovery/${provider}`,
      payload
    );
    return this.mapDiscoverySchedule(data.data);
  }

  /**
   * Get discovery statistics for all providers
   */
  async getStats(): Promise<DiscoveryStats[]> {
    const { data } = await api.get('/jobs/discovery/stats');
    return ((data.data ?? []) as RawDiscoveryStat[]).map((stat) => this.mapDiscoveryStat(stat));
  }

  private mapDiscoverySchedule(schedule: RawDiscoverySchedule): DiscoverySchedule {
    const cronExpression = schedule.cronExpression ?? schedule.cronPattern;
    if (!cronExpression) {
      throw new Error(`Invalid discovery schedule response for ${schedule.provider}`);
    }

    return {
      provider: schedule.provider,
      enabled: schedule.enabled,
      cronExpression,
      config: schedule.config ?? {},
      lastRun: schedule.lastRun,
      nextRun: schedule.nextRun,
    };
  }

  private mapDiscoveryStat(stat: RawDiscoveryStat): DiscoveryStats {
    const totalJobs = (stat.waiting || 0) + (stat.active || 0) + (stat.completed || 0) + (stat.failed || 0);
    const successfulJobs = stat.completed || 0;
    const failedJobs = stat.failed || 0;
    const successRate = totalJobs > 0 ? (successfulJobs / totalJobs) * 100 : 0;

    return {
      provider: stat.provider,
      enabled: stat.enabled,
      totalJobs,
      successfulJobs,
      failedJobs,
      successRate,
      averageDuration: stat.averageDurationMs ?? undefined,
      totalDiscoveredCIs: stat.totalDiscoveredCIs || 0,
    };
  }

  /**
   * Get statistics for a specific provider, using server-side provider
   * filtering on the canonical discovery stats endpoint. Throws when the
   * provider has no stats entry rather than fabricating a zeroed/enabled
   * placeholder - callers must handle a missing provider explicitly.
   */
  async getProviderStats(provider: DiscoveryProvider): Promise<DiscoveryStats> {
    const { data } = await api.get(`/jobs/discovery/stats?provider=${provider}`);
    const stat: RawDiscoveryStat | undefined = (data.data ?? [])[0];
    if (!stat) {
      throw new Error(`No discovery stats found for provider: ${provider}`);
    }
    return this.mapDiscoveryStat(stat);
  }

  /**
   * Test provider credentials against the Settings-owned test-connection
   * contract used by DiscoverySettings.tsx.
   */
  async testCredentials(
    provider: DiscoveryProvider,
    config: Record<string, unknown>
  ): Promise<{ valid: boolean; message: string }> {
    try {
      await api.post('/discovery/test-connection', { provider, credentials: config });
      return { valid: true, message: 'Connection successful' };
    } catch (err) {
      const axiosError = err as AxiosError<{ message?: string }>;
      return {
        valid: false,
        message: axiosError.response?.data?.message || 'Connection failed',
      };
    }
  }

  /**
   * Create a new discovery definition
   */
  async createDefinition(input: DiscoveryDefinitionInput): Promise<DiscoveryDefinition> {
    // Transform frontend format to backend format
    const backendInput = {
      name: input.name,
      description: input.description,
      provider: input.provider,
      method: 'agentless',
      credential_id: input.credentialId,
      config: input.config,
      field_mappings: input.field_mappings,
      schedule: input.schedule?.cronExpression,
      is_active: input.active !== undefined ? input.active : input.schedule?.enabled,
    };

    const { data } = await api.post('/discovery/definitions', backendInput);
    const def = data.data;

    // Transform backend format to frontend format
    return {
      ...def,
      active: def.is_active,
      schedule: {
        enabled: def.is_active && !!def.schedule,
        cronExpression: def.schedule,
      },
      lastRunAt: def.last_run_at,
      lastRunStatus: def.last_run_status,
    };
  }

  /**
   * Get a specific discovery definition
   */
  async getDefinition(id: string): Promise<DiscoveryDefinition> {
    const { data } = await api.get(`/discovery/definitions/${id}`);
    const def = data.data;

    // Transform backend format to frontend format
    return {
      ...def,
      credentialId: def.credential_id,
      active: def.is_active,
      schedule: {
        enabled: def.is_active && !!def.schedule,
        cronExpression: def.schedule,
      },
      lastRunAt: def.last_run_at,
      lastRunStatus: def.last_run_status,
    };
  }

  /**
   * List all discovery definitions with optional filters
   */
  async listDefinitions(filters?: DefinitionFilters): Promise<DiscoveryDefinition[]> {
    const params = new URLSearchParams();

    if (filters?.provider) params.append('provider', filters.provider);
    if (filters?.active !== undefined) params.append('is_active', String(filters.active));
    if (filters?.page) params.append('page', String(filters.page));
    if (filters?.limit) params.append('limit', String(filters.limit));

    const { data } = await api.get(`/discovery/definitions?${params.toString()}`);
    const definitions = data.data || [];

    // Transform backend format to frontend format
    return definitions.map((def: any) => ({
      ...def,
      credentialId: def.credential_id,
      active: def.is_active,
      schedule: {
        enabled: def.is_active && !!def.schedule,
        cronExpression: def.schedule,
      },
      lastRunAt: def.last_run_at,
      lastRunStatus: def.last_run_status,
    }));
  }

  /**
   * Update a discovery definition
   */
  async updateDefinition(
    id: string,
    updates: Partial<DiscoveryDefinitionInput>
  ): Promise<DiscoveryDefinition> {
    // Transform frontend format to backend format
    const backendUpdates: any = {};
    if (updates.name !== undefined) backendUpdates.name = updates.name;
    if (updates.description !== undefined) backendUpdates.description = updates.description;
    if (updates.provider !== undefined) backendUpdates.provider = updates.provider;
    if (updates.credentialId !== undefined) backendUpdates.credential_id = updates.credentialId;
    if (updates.config !== undefined) backendUpdates.config = updates.config;
    if (updates.field_mappings !== undefined) backendUpdates.field_mappings = updates.field_mappings;
    if (updates.schedule?.cronExpression !== undefined) backendUpdates.schedule = updates.schedule.cronExpression;
    if (updates.active !== undefined) backendUpdates.is_active = updates.active;

    const { data } = await api.put(`/discovery/definitions/${id}`, backendUpdates);
    const def = data.data;

    // Transform backend format to frontend format
    return {
      ...def,
      active: def.is_active,
      schedule: {
        enabled: def.is_active && !!def.schedule,
        cronExpression: def.schedule,
      },
      lastRunAt: def.last_run_at,
      lastRunStatus: def.last_run_status,
    };
  }

  /**
   * Delete a discovery definition
   */
  async deleteDefinition(id: string): Promise<void> {
    await api.delete(`/discovery/definitions/${id}`);
  }

  /**
   * Run a discovery definition (triggers a job)
   */
  async runDefinition(id: string): Promise<string> {
    const { data } = await api.post(`/discovery/definitions/${id}/run`);
    return data.data?.job_id || data.jobId;
  }

  /**
   * Enable schedule for a discovery definition
   */
  async enableSchedule(id: string): Promise<void> {
    await api.post(`/discovery/definitions/${id}/schedule/enable`);
  }

  /**
   * Disable schedule for a discovery definition
   */
  async disableSchedule(id: string): Promise<void> {
    await api.post(`/discovery/definitions/${id}/schedule/disable`);
  }
}

export const discoveryService = new DiscoveryService();
export default discoveryService;
