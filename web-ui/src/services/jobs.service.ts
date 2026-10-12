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
  progress: number;
  attempts: number;
  maxAttempts: number;
  status: 'active' | 'completed' | 'failed' | 'waiting' | 'delayed' | 'paused';
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  delay?: number;
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
  attemptsMade?: number;
  maxAttempts?: number;
  state?: string;
  status?: string;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
}


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
      progress: 0,
      attempts: raw.attemptsMade ?? 0,
      maxAttempts: raw.maxAttempts ?? 1,
      status: (raw.state ?? raw.status) as Job['status'],
      timestamp: raw.timestamp ?? 0,
      processedOn: raw.processedOn,
      finishedOn: raw.finishedOn,
      failedReason: (raw.state ?? raw.status) === 'failed' ? 'Job failed' : undefined,
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

}

export const jobsService = new JobsService();
