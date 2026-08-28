// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * useDiscovery Hook
 * Custom hook for discovery operations and state management
 */

import type { AxiosError } from 'axios';
import { useState, useCallback } from 'react';
import {
  discoveryService,
  DiscoveryProvider,
  DiscoveryStats,
  DiscoverySchedule,
  DiscoveryScheduleUpdate,
  TriggerDiscoveryJobRequest,
  DiscoveryJob,
  DiscoveryJobResult,
} from '../services/discovery.service';
import { useToast } from '../contexts/ToastContext';

export interface UseDiscoveryReturn {
  // State
  stats: DiscoveryStats[];
  schedules: DiscoverySchedule[];
  loading: boolean;
  error: string | null;

  // Actions
  loadStats: () => Promise<void>;
  loadSchedules: () => Promise<void>;
  triggerJob: (request: TriggerDiscoveryJobRequest) => Promise<DiscoveryJob | null>;
  updateSchedule: (
    provider: DiscoveryProvider,
    schedule: DiscoveryScheduleUpdate
  ) => Promise<void>;
  testCredentials: (
    provider: DiscoveryProvider,
    config: Record<string, any>
  ) => Promise<boolean>;
  retryJob: (jobId: string, provider: DiscoveryProvider) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  getJobResult: (jobId: string) => Promise<DiscoveryJobResult | null>;
}

export const useDiscovery = (): UseDiscoveryReturn => {
  const [stats, setStats] = useState<DiscoveryStats[]>([]);
  const [schedules, setSchedules] = useState<DiscoverySchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  /**
   * Load discovery statistics for all providers
   */
  const loadStats = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await discoveryService.getStats();
      setStats(data);
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Failed to load discovery statistics';
      setError(errorMsg);
      showToast(errorMsg, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  /**
   * Load discovery schedules for all providers
   */
  const loadSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await discoveryService.getSchedules();
      setSchedules(data);
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Failed to load discovery schedules';
      setError(errorMsg);
      showToast(errorMsg, 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  /**
   * Trigger a discovery job
   */
  const triggerJob = useCallback(
    async (request: TriggerDiscoveryJobRequest): Promise<DiscoveryJob | null> => {
      setLoading(true);
      setError(null);

      try {
        const job = await discoveryService.triggerJob(request);
        showToast(
          `Discovery job triggered successfully for ${request.provider.toUpperCase()}`,
          'success'
        );
        return job;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to trigger discovery job';
        setError(errorMsg);
        showToast(errorMsg, 'error');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  /**
   * Update a provider's schedule
   */
  const updateSchedule = useCallback(
    async (provider: DiscoveryProvider, schedule: DiscoveryScheduleUpdate) => {
      setLoading(true);
      setError(null);

      try {
        const updatedSchedule = await discoveryService.updateSchedule(provider, schedule);
        setSchedules((prev) =>
          prev.map((s) => (s.provider === provider ? updatedSchedule : s))
        );
        showToast(
          `Schedule updated successfully for ${provider.toUpperCase()}`,
          'success'
        );
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to update schedule';
        setError(errorMsg);
        showToast(errorMsg, 'error');
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  /**
   * Test provider credentials
   */
  const testCredentials = useCallback(
    async (provider: DiscoveryProvider, config: Record<string, any>): Promise<boolean> => {
      setLoading(true);
      setError(null);

      try {
        const result = await discoveryService.testCredentials(provider, config);
        if (result.valid) {
          showToast('Credentials are valid', 'success');
        } else {
          showToast(`Invalid credentials: ${result.message}`, 'error');
        }
        return result.valid;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to test credentials';
        setError(errorMsg);
        showToast(errorMsg, 'error');
        return false;
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  /**
   * Retry a failed job
   */
  const retryJob = useCallback(
    async (jobId: string, provider: DiscoveryProvider) => {
      setLoading(true);
      setError(null);

      try {
        await discoveryService.retryJob(jobId, provider);
        showToast('Job retried successfully', 'success');
      } catch (err) {
        const axiosErr = err as AxiosError<{ message?: string }>;
        const errorMsg = axiosErr.response?.data?.message || 'Failed to retry job';
        setError(errorMsg);
        showToast(errorMsg, 'error');
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  /**
   * Cancel a running job
   */
  const cancelJob = useCallback(
    async (jobId: string) => {
      setLoading(true);
      setError(null);

      try {
        await discoveryService.cancelJob(jobId);
        showToast('Job cancelled successfully', 'success');
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to cancel job';
        setError(errorMsg);
        showToast(errorMsg, 'error');
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  /**
   * Get job results
   */
  const getJobResult = useCallback(
    async (jobId: string): Promise<DiscoveryJobResult | null> => {
      setLoading(true);
      setError(null);

      try {
        const result = await discoveryService.getJobResult(jobId);
        return result;
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to load job results';
        setError(errorMsg);
        showToast(errorMsg, 'error');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [showToast]
  );

  return {
    stats,
    schedules,
    loading,
    error,
    loadStats,
    loadSchedules,
    triggerJob,
    updateSchedule,
    testCredentials,
    retryJob,
    cancelJob,
    getJobResult,
  };
};

export default useDiscovery;
