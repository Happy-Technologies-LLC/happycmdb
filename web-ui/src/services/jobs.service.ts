// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs API Service
 *
 * Handles all job monitoring, queue management, and scheduling operations
 * for the HappyCMDB platform.
 */

import { apiClient } from './api';

export interface Job {
  id: string;
  name: string;
  queueName: string;
  data: Record<string, unknown>;
  progress: number;
  attempts: number;
  maxAttempts: number;
  status: 'active' | 'completed' | 'failed' | 'waiting' | 'delayed' | 'paused';
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: unknown;
  delay?: number;
}

export interface QueueStats {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface QueueMetrics {
  queueName: string;
  throughput: {
    completed: number;
    failed: number;
    timeWindow: string;
  };
  latency: {
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
  workers: {
    active: number;
    total: number;
    concurrency: number;
  };
}

export interface QueueHealth {
  queueName: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  isPaused: boolean;
  workers: number;
  errorRate: number;
  avgProcessingTime: number;
  issues: string[];
}

export interface JobSchedule {
  id: string;
  name: string;
  queueName: string;
  cron: string;
  data: Record<string, unknown>;
  enabled: boolean;
  nextRun?: number;
  lastRun?: number;
  timezone?: string;
}

export interface JobFilters {
  status?: Job['status'];
  limit?: number;
  offset?: number;
}

export interface JobListResponse {
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Standard `{success, data}` response envelope used by the api-server REST
 * routes. List endpoints that support pagination also carry a sibling
 * `pagination` block.
 */
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  pagination?: RawPagination;
  error?: string;
  message?: string;
}

interface RawPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Raw job payload shape returned by the backend's listJobs/getJobStatus/
 * getFailedJobs endpoints. `state` (listJobs/getJobStatus) and `status`
 * (getFailedJobs) both carry the BullMQ job state under different keys.
 */
interface RawJobPayload {
  id: string;
  name?: string;
  queueName?: string;
  data?: Record<string, unknown>;
  progress?: number;
  attemptsMade?: number;
  maxAttempts?: number;
  state?: string;
  status?: string;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: unknown;
}

interface RawSchedulePayload {
  provider?: string;
  type?: string;
  queueName?: string;
  cronExpression?: string;
  cronPattern?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  nextRun?: number;
  lastRun?: number;
  timezone?: string;
}

/** Raw per-queue shape from GET /queues/stats (queue-manager.getQueueStats, spread). */
interface RawQueueStatsPayload {
  queueName: string;
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
  delayed?: number;
  paused?: number;
}

/** Raw per-queue shape from GET /queues/health. */
interface RawQueueHealthPayload {
  queueName: string;
  status?: string;
  issues?: string[];
  jobCounts?: Record<string, number>;
}

/** Raw shape from GET /queues/:queueName/metrics. */
interface RawQueueMetricsPayload {
  queueName: string;
  metrics?: {
    latency?: { avg?: number; min?: number; max?: number; unit?: string };
    throughput?: { value?: number; unit?: string };
    completedJobs?: number;
    timeWindow?: string;
  };
}

type ScheduleKind = 'discovery' | 'etl';

class JobsService {
  /**
   * Map a raw job payload (from listJobs/getJobStatus/getFailedJobs) into a Job.
   * `state` (listJobs/getJobStatus) and `status` (getFailedJobs) both carry the
   * BullMQ job state; `queueName` is echoed back by the backend, with the
   * requested queue as a fallback for older responses.
   */
  private mapJob(raw: RawJobPayload, fallbackQueueName: string): Job {
    return {
      id: raw.id,
      name: raw.name ?? raw.id,
      queueName: raw.queueName ?? fallbackQueueName,
      data: raw.data ?? {},
      progress: typeof raw.progress === 'number' ? raw.progress : 0,
      attempts: raw.attemptsMade ?? 0,
      maxAttempts: raw.maxAttempts ?? 1,
      status: (raw.state ?? raw.status) as Job['status'],
      timestamp: raw.timestamp ?? 0,
      processedOn: raw.processedOn,
      finishedOn: raw.finishedOn,
      failedReason: raw.failedReason,
      stacktrace: raw.stacktrace,
      returnvalue: raw.returnvalue,
    };
  }

  /**
   * Get list of jobs in a specific queue.
   * The backend lists jobs by BullMQ state (waiting/active/completed/failed/delayed)
   * within a single queue; there is no cross-queue "all jobs" endpoint.
   */
  async getJobs(queueName: string, filters: JobFilters = {}): Promise<JobListResponse> {
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const params: Record<string, string> = {
      start: String(offset),
      end: String(offset + limit - 1),
    };
    if (filters.status) {
      params.state = filters.status;
    }

    const response = await apiClient.get<ApiEnvelope<{ jobs?: RawJobPayload[] }>>(
      `/jobs/${encodeURIComponent(queueName)}`,
      { params }
    );

    const rawJobs = response.data.data?.jobs ?? [];
    const jobs = rawJobs.map((raw) => this.mapJob(raw, queueName));
    const pagination = response.data.pagination;

    return {
      jobs,
      // The backend now reports a real total (BullMQ job counts for the
      // requested state); only fall back to the observed slice length if an
      // older/unpatched backend omits the pagination block.
      total: pagination?.total ?? offset + jobs.length,
      limit: pagination?.limit ?? limit,
      offset: pagination?.offset ?? offset,
    };
  }

  /**
   * Get job details by queue name and job ID
   */
  async getJobById(queueName: string, jobId: string): Promise<Job> {
    const response = await apiClient.get<ApiEnvelope<RawJobPayload>>(
      `/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`
    );

    return this.mapJob(response.data.data, queueName);
  }

  /**
   * Retry a failed job
   */
  async retryJob(queueName: string, jobId: string): Promise<void> {
    await apiClient.post(
      `/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/retry`
    );
  }

  /**
   * Cancel a running or waiting job
   */
  async cancelJob(queueName: string, jobId: string): Promise<void> {
    await apiClient.delete(
      `/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`
    );
  }

  /**
   * Get statistics for all queues
   */
  async getQueueStats(): Promise<QueueStats[]> {
    const response = await apiClient.get<ApiEnvelope<{ queues: RawQueueStatsPayload[] }>>(
      '/queues/stats'
    );

    return (response.data.data?.queues ?? []).map((raw) => this.mapQueueStats(raw));
  }

  /**
   * Get metrics for a specific queue
   */
  async getQueueMetrics(queueName: string): Promise<QueueMetrics> {
    const response = await apiClient.get<ApiEnvelope<RawQueueMetricsPayload>>(
      `/queues/${encodeURIComponent(queueName)}/metrics`
    );

    return this.mapQueueMetrics(response.data.data);
  }

  /**
   * Get health status for all queues
   */
  async getQueueHealth(): Promise<QueueHealth[]> {
    const response = await apiClient.get<ApiEnvelope<{ queues: RawQueueHealthPayload[] }>>(
      '/queues/health'
    );

    return (response.data.data?.queues ?? []).map((raw) => this.mapQueueHealth(raw));
  }

  /**
   * Pause a queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    await apiClient.post(`/queues/${encodeURIComponent(queueName)}/pause`);
  }

  /**
   * Resume a paused queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    await apiClient.post(`/queues/${encodeURIComponent(queueName)}/resume`);
  }

  /**
   * Get all discovery and ETL schedules for the Jobs schedules tab.
   */
  async getSchedules(): Promise<JobSchedule[]> {
    const [discoveryResponse, etlResponse] = await Promise.all([
      apiClient.get<ApiEnvelope<RawSchedulePayload[]>>('/jobs/schedules/discovery'),
      apiClient.get<ApiEnvelope<RawSchedulePayload[]>>('/jobs/schedules/etl'),
    ]);

    return [
      ...(discoveryResponse.data.data ?? []).map((schedule) => this.mapSchedule('discovery', schedule)),
      ...(etlResponse.data.data ?? []).map((schedule) => this.mapSchedule('etl', schedule)),
    ];
  }

  /**
   * Update a discovery or ETL schedule using its namespaced schedule ID.
   */
  async updateSchedule(id: string, updates: Partial<JobSchedule>): Promise<JobSchedule> {
    const [kind, scheduleId] = id.split(':', 2);
    if ((kind !== 'discovery' && kind !== 'etl') || !scheduleId) {
      throw new Error(`Invalid schedule id: ${id}`);
    }

    if (
      Object.keys(updates).some((field) => field !== 'cron' && field !== 'enabled') ||
      (updates.cron === undefined && updates.enabled === undefined)
    ) {
      throw new Error('Only cron and enabled schedule updates are supported');
    }

    const payload: { cronExpression?: string; enabled?: boolean } = {};
    if (updates.cron !== undefined) {
      payload.cronExpression = updates.cron;
    }
    if (updates.enabled !== undefined) {
      payload.enabled = updates.enabled;
    }

    const response = await apiClient.put<ApiEnvelope<RawSchedulePayload>>(
      `/jobs/schedules/${kind}/${encodeURIComponent(scheduleId)}`,
      payload
    );

    return this.mapSchedule(kind, response.data.data);
  }

  /**
   * Get dead letter queue jobs (failed jobs that exhausted all retry attempts).
   * Backed by the canonical failed-jobs endpoint - there is no separate
   * dead-letter route, BullMQ's "failed" state already is the dead letter queue.
   */
  async getDeadLetterJobs(
    queueName: string,
    options: { start?: number; end?: number } = {}
  ): Promise<Job[]> {
    const response = await apiClient.get<ApiEnvelope<{ failedJobs?: RawJobPayload[] }>>(
      `/jobs/${encodeURIComponent(queueName)}/failed`,
      {
        params: {
          start: options.start ?? 0,
          end: options.end ?? 99,
        },
      }
    );

    const rawJobs = response.data.data?.failedJobs ?? [];
    return rawJobs.map((raw) => this.mapJob(raw, queueName));
  }

  private mapSchedule(kind: ScheduleKind, schedule: RawSchedulePayload): JobSchedule {
    const scheduleId = kind === 'discovery' ? schedule.provider : schedule.type;
    const cron = schedule.cronExpression ?? schedule.cronPattern;
    if (!scheduleId || !cron) {
      throw new Error(`Invalid ${kind} schedule response`);
    }

    return {
      id: `${kind}:${scheduleId}`,
      name: `${kind === 'discovery' ? 'Discovery' : 'ETL'}: ${scheduleId}`,
      queueName: schedule.queueName ?? `${kind}-${scheduleId}`,
      cron,
      data: schedule.config ?? {},
      enabled: schedule.enabled ?? false,
      nextRun: schedule.nextRun,
      lastRun: schedule.lastRun,
      timezone: schedule.timezone,
    };
  }

  /**
   * Map a raw per-queue GET /queues/stats entry (all fields real - the
   * backend's getQueueStats() already returns exactly this shape via
   * BullMQ getJobCounts()) into the declared QueueStats type.
   */
  private mapQueueStats(raw: RawQueueStatsPayload): QueueStats {
    return {
      queueName: raw.queueName,
      waiting: raw.waiting ?? 0,
      active: raw.active ?? 0,
      completed: raw.completed ?? 0,
      failed: raw.failed ?? 0,
      delayed: raw.delayed ?? 0,
      paused: raw.paused ?? 0,
    };
  }

  /**
   * Map a raw per-queue GET /queues/health entry into the declared
   * QueueHealth type. The backend's health check does not report a worker
   * count or an average processing time for this endpoint, so those fields
   * fall back to 0 rather than being fabricated from unrelated data;
   * `isPaused` and `errorRate` are derived from real fields the backend
   * does return (the "Queue is paused" issue string and the completed/
   * failed job counts).
   */
  private mapQueueHealth(raw: RawQueueHealthPayload): QueueHealth {
    const issues = raw.issues ?? [];
    const jobCounts = raw.jobCounts ?? {};
    const completed = jobCounts['completed'] ?? 0;
    const failed = jobCounts['failed'] ?? 0;
    const total = completed + failed;
    const status: QueueHealth['status'] =
      raw.status === 'healthy' || raw.status === 'unhealthy' ? raw.status : 'degraded';

    return {
      queueName: raw.queueName,
      status,
      isPaused: issues.some((issue) => issue.toLowerCase().includes('paused')),
      workers: 0,
      errorRate: total > 0 ? failed / total : 0,
      avgProcessingTime: 0,
      issues,
    };
  }

  /**
   * Map the raw GET /queues/:queueName/metrics payload into the declared
   * QueueMetrics type. The backend reports a single average latency (no
   * percentile breakdown) and no worker/failed-throughput data for this
   * endpoint; p50/p95/p99 are approximated from the average the same way
   * the Jobs page already does when synthesizing metrics from health data,
   * and the unavailable failed-throughput/worker fields fall back to 0
   * instead of being invented.
   */
  private mapQueueMetrics(raw: RawQueueMetricsPayload): QueueMetrics {
    const avg = raw.metrics?.latency?.avg ?? 0;

    return {
      queueName: raw.queueName,
      throughput: {
        completed: raw.metrics?.completedJobs ?? 0,
        failed: 0,
        timeWindow: raw.metrics?.timeWindow ?? '1 hour',
      },
      latency: {
        avg,
        p50: avg,
        p95: avg * 1.5,
        p99: avg * 2,
      },
      workers: {
        active: 0,
        total: 0,
        concurrency: 0,
      },
    };
  }
}

export const jobsService = new JobsService();
