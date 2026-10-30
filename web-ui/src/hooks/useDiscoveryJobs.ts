// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * useDiscoveryJobs Hook
 * Custom hook for job listing with polling and real-time updates
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  discoveryService,
  DiscoveryJob,
  JobFilters,
  PaginatedJobsResponse,
} from '../services/discovery.service';
import { useToast } from '../contexts/ToastContext';
import { logClientError } from '../utils/logger';

const POLL_INTERVAL = 5000; // 5 seconds

export interface UseDiscoveryJobsReturn {
  jobs: DiscoveryJob[];
  total: number;
  page: number;
  totalPages: number;
  loading: boolean;
  error: string | null;
  filters: JobFilters;
  hasRunningJobs: boolean;

  // Actions
  loadJobs: () => Promise<void>;
  setFilters: (filters: JobFilters) => void;
  setPage: (page: number) => void;
  refreshJobs: () => Promise<void>;
  getJob: (jobId: string) => Promise<DiscoveryJob | null>;
}

export const useDiscoveryJobs = (
  initialFilters: JobFilters = {},
  autoRefresh: boolean = true
): UseDiscoveryJobsReturn => {
  const [jobs, setJobs] = useState<DiscoveryJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPageState] = useState(initialFilters.page || 1);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<JobFilters>({
    limit: 10,
    sortBy: 'createdAt',
    sortOrder: 'desc',
    ...initialFilters,
  });

  const { showToast } = useToast();
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Check if there are any running or pending jobs
  const hasRunningJobs = jobs?.some(
    (job) => job.status === 'running' || job.status === 'pending'
  ) ?? false;

  /**
   * Load jobs with current filters
   */
  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response: PaginatedJobsResponse = await discoveryService.getJobs({
        ...filters,
        page,
      });

      if (mountedRef.current) {
        setJobs(response.jobs);
        setTotal(response.total);
        setTotalPages(response.totalPages);
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Failed to load discovery jobs';
      if (mountedRef.current) {
        setError(errorMsg);
        showToast(errorMsg, 'error');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [filters, page, showToast]);

  /**
   * Refresh jobs (silent reload without loading state)
   */
  const refreshJobs = useCallback(async () => {
    try {
      const response: PaginatedJobsResponse = await discoveryService.getJobs({
        ...filters,
        page,
      });

      if (mountedRef.current) {
        setJobs(response.jobs);
        setTotal(response.total);
        setTotalPages(response.totalPages);
      }
    } catch (err: any) {
      // Silent failure for background refresh
      logClientError('Failed to refresh jobs:', err);
    }
  }, [filters, page]);

  /**
   * Get a specific job by ID
   */
  const getJob = useCallback(
    async (jobId: string): Promise<DiscoveryJob | null> => {
      try {
        const job = await discoveryService.getJob(jobId);
        return job;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to load job';
        showToast(errorMsg, 'error');
        return null;
      }
    },
    [showToast]
  );

  /**
   * Update filters
   */
  const setFilters = useCallback((newFilters: JobFilters) => {
    setFiltersState((prev) => ({ ...prev, ...newFilters }));
    setPageState(1); // Reset to first page when filters change
  }, []);

  /**
   * Update page
   */
  const setPage = useCallback((newPage: number) => {
    setPageState(newPage);
  }, []);

  /**
   * Setup polling for running jobs
   */
  useEffect(() => {
    if (!autoRefresh) return;

    // Clear existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    // Only poll if there are running/pending jobs
    if (hasRunningJobs) {
      pollIntervalRef.current = setInterval(() => {
        refreshJobs();
      }, POLL_INTERVAL);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [hasRunningJobs, autoRefresh, refreshJobs]);

  /**
   * Load jobs when filters or page changes
   */
  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  return {
    jobs,
    total,
    page,
    totalPages,
    loading,
    error,
    filters,
    hasRunningJobs,
    loadJobs,
    setFilters,
    setPage,
    refreshJobs,
    getJob,
  };
};

export default useDiscoveryJobs;
