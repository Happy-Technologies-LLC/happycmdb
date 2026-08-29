// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * useQueueStats Hook
 *
 * Custom hook for fetching and polling queue statistics and health metrics.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  jobsService,
  QueueStats,
  QueueMetrics,
  QueueHealth,
  JobSchedule,
} from '../services/jobs.service';

interface UseQueueStatsOptions {
  autoRefresh?: boolean;
  refreshInterval?: number; // milliseconds
}

interface UseQueueStatsReturn {
  stats: QueueStats[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useQueueStats(options: UseQueueStatsOptions = {}): UseQueueStatsReturn {
  const { autoRefresh = true, refreshInterval = 30000 } = options;

  const [stats, setStats] = useState<QueueStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const statsData = await jobsService.getQueueStats();
      setStats(statsData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch queue stats'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(() => {
      fetchStats();
    }, refreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefresh, refreshInterval, fetchStats]);

  return {
    stats,
    loading,
    error,
    refetch: fetchStats,
  };
}

interface UseQueueMetricsOptions {
  queueName: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseQueueMetricsReturn {
  metrics: QueueMetrics | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useQueueMetrics(options: UseQueueMetricsOptions): UseQueueMetricsReturn {
  const { queueName, autoRefresh = true, refreshInterval = 30000 } = options;

  const [metrics, setMetrics] = useState<QueueMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const metricsData = await jobsService.getQueueMetrics(queueName);
      setMetrics(metricsData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch queue metrics'));
    } finally {
      setLoading(false);
    }
  }, [queueName]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(() => {
      fetchMetrics();
    }, refreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefresh, refreshInterval, fetchMetrics]);

  return {
    metrics,
    loading,
    error,
    refetch: fetchMetrics,
  };
}

interface UseQueueHealthOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseQueueHealthReturn {
  health: QueueHealth[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  pauseQueue: (queueName: string) => Promise<void>;
  resumeQueue: (queueName: string) => Promise<void>;
}

export function useQueueHealth(options: UseQueueHealthOptions = {}): UseQueueHealthReturn {
  const { autoRefresh = true, refreshInterval = 30000 } = options;

  const [health, setHealth] = useState<QueueHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const healthData = await jobsService.getQueueHealth();
      setHealth(healthData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch queue health'));
    } finally {
      setLoading(false);
    }
  }, []);

  const pauseQueue = useCallback(async (queueName: string) => {
    try {
      await jobsService.pauseQueue(queueName);
      await fetchHealth();
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to pause queue');
    }
  }, [fetchHealth]);

  const resumeQueue = useCallback(async (queueName: string) => {
    try {
      await jobsService.resumeQueue(queueName);
      await fetchHealth();
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to resume queue');
    }
  }, [fetchHealth]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(() => {
      fetchHealth();
    }, refreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefresh, refreshInterval, fetchHealth]);

  return {
    health,
    loading,
    error,
    refetch: fetchHealth,
    pauseQueue,
    resumeQueue,
  };
}

interface UseSchedulesOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseSchedulesReturn {
  schedules: JobSchedule[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  updateSchedule: (id: string, updates: Partial<JobSchedule>) => Promise<JobSchedule>;
  toggleSchedule: (id: string, enabled: boolean) => Promise<JobSchedule>;
}

export function useSchedules(options: UseSchedulesOptions = {}): UseSchedulesReturn {
  const { autoRefresh = true, refreshInterval = 60000 } = options;

  const [schedules, setSchedules] = useState<JobSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSchedules = useCallback(async (): Promise<JobSchedule[]> => {
    try {
      setLoading(true);
      setError(null);
      const schedulesData = await jobsService.getSchedules();
      setSchedules(schedulesData);
      return schedulesData;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to fetch schedules'));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const updateSchedule = useCallback(async (id: string, updates: Partial<JobSchedule>): Promise<JobSchedule> => {
    try {
      const updated = await jobsService.updateSchedule(id, updates);
      const schedulesData = await fetchSchedules();
      return schedulesData.find((schedule) => schedule.id === id) ?? updated;
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to update schedule');
    }
  }, [fetchSchedules]);

  const toggleSchedule = useCallback(
    (id: string, enabled: boolean): Promise<JobSchedule> => updateSchedule(id, { enabled }),
    [updateSchedule]
  );

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  useEffect(() => {
    if (!autoRefresh) return;

    const intervalId = setInterval(() => {
      fetchSchedules();
    }, refreshInterval);

    return () => clearInterval(intervalId);
  }, [autoRefresh, refreshInterval, fetchSchedules]);

  return {
    schedules,
    loading,
    error,
    refetch: async () => {
      await fetchSchedules();
    },
    updateSchedule,
    toggleSchedule,
  };
}
