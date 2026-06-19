// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs API Service
 *
 * Handles all job monitoring, queue management, and scheduling operations
 * for the HappyCMDB platform.
 */

export interface Job {
  id: string;
  name: string;
  queueName: string;
  data: Record<string, any>;
  progress: number;
  attempts: number;
  maxAttempts: number;
  status: 'active' | 'completed' | 'failed' | 'waiting' | 'delayed' | 'paused';
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: any;
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
  data: Record<string, any>;
  enabled: boolean;
  nextRun: number;
  lastRun?: number;
  timezone?: string;
}

export interface JobFilters {
  status?: Job['status'] | Job['status'][];
  queueName?: string | string[];
  dateRange?: {
    start: number;
    end: number;
  };
  jobType?: 'discovery' | 'etl';
  limit?: number;
  offset?: number;
}

export interface JobListResponse {
  jobs: Job[];
  total: number;
  limit: number;
  offset: number;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

class JobsService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = API_BASE_URL;
  }

  /**
   * Get list of jobs with filters
   */
  async getJobs(filters: JobFilters = {}): Promise<JobListResponse> {
    const params = new URLSearchParams();

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      statuses.forEach(status => params.append('status', status));
    }

    if (filters.queueName) {
      const queues = Array.isArray(filters.queueName) ? filters.queueName : [filters.queueName];
      queues.forEach(queue => params.append('queueName', queue));
    }

    if (filters.dateRange) {
      params.set('startDate', filters.dateRange.start.toString());
      params.set('endDate', filters.dateRange.end.toString());
    }

    if (filters.jobType) {
      params.set('jobType', filters.jobType);
    }

    if (filters.limit) {
      params.set('limit', filters.limit.toString());
    }

    if (filters.offset) {
      params.set('offset', filters.offset.toString());
    }

    const response = await fetch(`${this.baseUrl}/jobs?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch jobs: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get job details by ID
   */
  async getJobById(jobId: string): Promise<Job> {
    const response = await fetch(`${this.baseUrl}/jobs/${jobId}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch job: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId: string): Promise<Job> {
    const response = await fetch(`${this.baseUrl}/jobs/${jobId}/retry`, {
      method: 'PUT',
    });

    if (!response.ok) {
      throw new Error(`Failed to retry job: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Cancel a running or waiting job
   */
  async cancelJob(jobId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/jobs/${jobId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`Failed to cancel job: ${response.statusText}`);
    }
  }

  /**
   * Get statistics for all queues
   */
  async getQueueStats(): Promise<QueueStats[]> {
    const response = await fetch(`${this.baseUrl}/queues/stats`);

    if (!response.ok) {
      throw new Error(`Failed to fetch queue stats: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get metrics for a specific queue
   */
  async getQueueMetrics(queueName: string): Promise<QueueMetrics> {
    const response = await fetch(`${this.baseUrl}/queues/${queueName}/metrics`);

    if (!response.ok) {
      throw new Error(`Failed to fetch queue metrics: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get health status for all queues
   */
  async getQueueHealth(): Promise<QueueHealth[]> {
    const response = await fetch(`${this.baseUrl}/queues/health`);

    if (!response.ok) {
      throw new Error(`Failed to fetch queue health: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Pause a queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queues/${queueName}/pause`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`Failed to pause queue: ${response.statusText}`);
    }
  }

  /**
   * Resume a paused queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queues/${queueName}/resume`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`Failed to resume queue: ${response.statusText}`);
    }
  }

  /**
   * Get all job schedules
   * TODO: Backend endpoints not yet implemented (returns 501)
   * Use discovery.service.ts getSchedules() for discovery schedules
   */
  async getSchedules(): Promise<JobSchedule[]> {
    // TODO: This should combine discovery and ETL schedules once backend is implemented
    // For now, return empty array to prevent 500 errors
    return [];

    // const response = await fetch(`${this.baseUrl}/jobs/schedules`);
    // if (!response.ok) {
    //   throw new Error(`Failed to fetch schedules: ${response.statusText}`);
    // }
    // return response.json();
  }

  /**
   * Update a job schedule (enable/disable or modify)
   * TODO: Backend endpoints not yet implemented (returns 501)
   * Use discovery.service.ts updateSchedule() for discovery schedules
   */
  async updateSchedule(id: string, updates: Partial<JobSchedule>): Promise<JobSchedule> {
    // TODO: Backend schedule update not yet implemented
    throw new Error('Schedule updates not yet implemented. Use discovery.service.ts for discovery schedules.');

    // const response = await fetch(`${this.baseUrl}/jobs/schedules/${id}`, {
    //   method: 'PUT',
    //   headers: {
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify(updates),
    // });
    // if (!response.ok) {
    //   throw new Error(`Failed to update schedule: ${response.statusText}`);
    // }
    // return response.json();
  }

  /**
   * Get dead letter queue jobs
   */
  async getDeadLetterJobs(queueName: string): Promise<Job[]> {
    const response = await fetch(`${this.baseUrl}/queues/${queueName}/dead-letter`);

    if (!response.ok) {
      throw new Error(`Failed to fetch dead letter jobs: ${response.statusText}`);
    }

    return response.json();
  }
}

export const jobsService = new JobsService();
