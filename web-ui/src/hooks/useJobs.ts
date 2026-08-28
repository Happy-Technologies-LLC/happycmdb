// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * useJobs Hook
 *
 * Custom hook for job operations including fetching, retrying, and canceling jobs.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  jobsService,
  Job,
  JobFilters,
  JobListResponse,
} from '../services/jobs.service';

interface UseJobsOptions {
  queueName: string;
  filters?: JobFilters;
  autoRefresh?: boolean;
  refreshInterval?: number; // milliseconds
}

interface UseJobsReturn {
  jobs: Job[];
  total: number;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  retryJob: (jobId: string) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  hasMore: boolean;
}

export function useJobs(options: UseJobsOptions): UseJobsReturn {
  const {
    queueName,
    filters = {},
    autoRefresh = false,
    refreshInterval = 5000,
  } = options;
  const { status: filterStatus, limit: filterLimit, offset: filterOffset } = filters;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Depend on the individual filter scalars, not the `filters` object
  // itself: callers (Jobs.tsx, JobMonitor.tsx) construct a fresh filters
  // object literal on every render, so depending on its identity would
  // recreate fetchJobs - and re-trigger the effect below - every render,
  // even when status/limit/offset never actually changed.
  const fetchJobs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response: JobListResponse = await jobsService.getJobs(queueName, {
        status: filterStatus,
        limit: filterLimit,
        offset: filterOffset,
      });
      setJobs(response.jobs);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch jobs'));
    } finally {
      setLoading(false);
    }
  }, [queueName, filterStatus, filterLimit, filterOffset]);

  const retryJob = useCallback(async (jobId: string) => {
    try {
      await jobsService.retryJob(queueName, jobId);
      await fetchJobs(); // Refresh the list
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to retry job');
    }
  }, [queueName, fetchJobs]);

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await jobsService.cancelJob(queueName, jobId);
      await fetchJobs(); // Refresh the list
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to cancel job');
    }
  }, [queueName, fetchJobs]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(() => {
      fetchJobs();
    }, refreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefresh, refreshInterval, fetchJobs]);

  const hasMore = jobs.length < total;

  return {
    jobs,
    total,
    loading,
    error,
    refetch: fetchJobs,
    retryJob,
    cancelJob,
    hasMore,
  };
}

interface UseJobDetailOptions {
  queueName: string;
  jobId: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseJobDetailReturn {
  job: Job | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useJobDetail(options: UseJobDetailOptions): UseJobDetailReturn {
  const { queueName, jobId, autoRefresh = false, refreshInterval = 5000 } = options;

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchJob = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const jobData = await jobsService.getJobById(queueName, jobId);
      setJob(jobData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch job'));
    } finally {
      setLoading(false);
    }
  }, [queueName, jobId]);

  useEffect(() => {
    fetchJob();
  }, [fetchJob]);

  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(() => {
      fetchJob();
    }, refreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefresh, refreshInterval, fetchJob]);

  return {
    job,
    loading,
    error,
    refetch: fetchJob,
  };
}
