// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery API Service
 * Handles all discovery-related API calls
 */

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

export interface DiscoverySchedule {
  provider: DiscoveryProvider;
  enabled: boolean;
  cronExpression: string;
  config: Record<string, any>;
  lastRun?: string;
  nextRun?: string;
}

export interface DiscoveryStats {
  provider: DiscoveryProvider;
  enabled: boolean;
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  successRate: number; // 0-100
  lastRun?: string;
  nextScheduledRun?: string;
  averageDuration: number; // milliseconds
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
   * Get a specific job by ID
   */
  async getJob(jobId: string): Promise<DiscoveryJob> {
    const { data } = await api.get(`/jobs/${jobId}`);
    return data;
  }

  /**
   * Get job results with discovered CIs
   */
  async getJobResult(jobId: string): Promise<DiscoveryJobResult> {
    const { data } = await api.get(`/jobs/${jobId}/result`);
    return data;
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<DiscoveryJob> {
    const { data } = await api.put(`/jobs/${jobId}/retry`);
    return data;
  }

  /**
   * Cancel a running job
   */
  async cancelJob(jobId: string): Promise<void> {
    await api.delete(`/jobs/${jobId}`);
  }

  /**
   * Get all discovery schedules
   */
  async getSchedules(): Promise<DiscoverySchedule[]> {
    const { data } = await api.get('/jobs/schedules/discovery');
    return data.data || [];
  }

  /**
   * Update a provider's schedule
   */
  async updateSchedule(
    provider: DiscoveryProvider,
    schedule: Partial<DiscoverySchedule>
  ): Promise<DiscoverySchedule> {
    const { data } = await api.put(`/jobs/schedules/discovery/${provider}`, schedule);
    return data;
  }

  /**
   * Get discovery statistics for all providers
   */
  async getStats(): Promise<DiscoveryStats[]> {
    const { data } = await api.get('/jobs/discovery/stats');

    // Transform queue stats to DiscoveryStats format
    return (data.data || []).map((stat: any) => {
      const totalJobs = (stat.waiting || 0) + (stat.active || 0) + (stat.completed || 0) + (stat.failed || 0);
      const successfulJobs = stat.completed || 0;
      const failedJobs = stat.failed || 0;
      const successRate = totalJobs > 0 ? (successfulJobs / totalJobs) * 100 : 0;

      return {
        provider: stat.provider,
        enabled: true,
        totalJobs,
        successfulJobs,
        failedJobs,
        successRate,
        averageDuration: 0, // Not available from queue stats
        totalDiscoveredCIs: stat.totalDiscoveredCIs || 0, // Now using value from API
      };
    });
  }

  /**
   * Get statistics for a specific provider
   */
  async getProviderStats(provider: DiscoveryProvider): Promise<DiscoveryStats> {
    const { data } = await api.get(`/jobs/discovery/stats/${provider}`);
    return data;
  }

  /**
   * Test provider credentials without running full discovery
   */
  async testCredentials(
    provider: DiscoveryProvider,
    config: Record<string, any>
  ): Promise<{ valid: boolean; message: string }> {
    const { data } = await api.post(`/jobs/discovery/${provider}/test`, { config });
    return data;
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
