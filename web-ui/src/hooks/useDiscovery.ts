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
  TriggerDiscoveryJobRequest,
  DiscoveryJob,
  DiscoveryJobResult,
} from '../services/discovery.service';
import { useToast } from '../contexts/ToastContext';

export interface UseDiscoveryReturn {
  // State
  loading: boolean;
  error: string | null;

  // Actions
  triggerJob: (request: TriggerDiscoveryJobRequest) => Promise<DiscoveryJob | null>;
  retryJob: (jobId: string, provider: DiscoveryProvider) => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
  getJobResult: (jobId: string) => Promise<DiscoveryJobResult | null>;
}

export const useDiscovery = (): UseDiscoveryReturn => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

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
    loading,
    error,
    triggerJob,
    retryJob,
    cancelJob,
    getJobResult,
  };
};

export default useDiscovery;
