// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Data Hooks
 * React Query hooks for Business Insights dashboards (REST API)
 */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import dashboardService, {
  ExecutiveSummaryData,
  CIOMetricsData,
  ITSMDashboardData,
  FinOpsDashboardData,
  BusinessServiceDashboardData,
} from '../services/dashboard.service';

export interface TimeRange {
  start: string;
  end: string;
  label?: string;
}

/**
 * Convert time range string to days
 */
function timeRangeToDays(range: string): number {
  const mapping: Record<string, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '1y': 365,
  };
  return mapping[range] || 30;
}

// Executive Dashboard Hook
export const useExecutiveDashboard = (timeRange: TimeRange) => {
  const days = timeRangeToDays(timeRange.start);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['executive-dashboard', days],
    queryFn: () => dashboardService.getExecutiveDashboard(days),
    staleTime: 30000, // 30 seconds
    refetchInterval: 30000, // Auto-refresh every 30 seconds
  });

  return {
    data,
    loading: isLoading,
    error,
    refetch,
  };
};

// CIO Dashboard Hook
export const useCIODashboard = (timeRange: TimeRange) => {
  const days = timeRangeToDays(timeRange.start);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cio-dashboard', days],
    queryFn: () => dashboardService.getCIODashboard(days),
    staleTime: 30000,
    refetchInterval: 30000,
  });

  return {
    data,
    loading: isLoading,
    error,
    refetch,
  };
};

// ITSM Dashboard Hook
export const useITSMDashboard = (_filters?: any) => {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['itsm-dashboard'],
    queryFn: () => dashboardService.getITSMDashboard(),
    staleTime: 10000, // 10 seconds
    refetchInterval: 10000, // More frequent for incidents
  });

  return {
    incidents: {
      data: data?.openIncidents || [],
      loading: isLoading,
      error,
      refetch,
    },
    changes: {
      data: data?.changesInProgress || [],
      loading: isLoading,
      error,
      refetch,
    },
    ciStatus: {
      data: data?.ciStatus || [],
      loading: isLoading,
      error,
      refetch,
    },
    topFailing: {
      data: data?.topFailingCIs || [],
      loading: isLoading,
      error,
      refetch,
    },
    slaCompliance: {
      data: data?.slaCompliance || [],
      loading: isLoading,
      error,
      refetch,
    },
    baselineCompliance: {
      data: data?.baselineCompliance || [],
      loading: isLoading,
      error,
      refetch,
    },
    realTimeUpdates: {
      incidents: null,
      changes: null,
    },
  };
};

// FinOps Dashboard Hook
export const useFinOpsDashboard = (timeRange: TimeRange) => {
  const days = timeRangeToDays(timeRange.start);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['finops-dashboard', days],
    queryFn: () => dashboardService.getFinOpsDashboard(days),
    staleTime: 60000, // 1 minute
    refetchInterval: 60000,
  });

  return {
    cloudCosts: {
      data: data?.cloudCosts || [],
      loading: isLoading,
      error,
      refetch,
    },
    onPremVsCloud: {
      data: data?.onPremVsCloud,
      loading: isLoading,
      error,
      refetch,
    },
    costByTower: {
      data: data?.costByTower || [],
      loading: isLoading,
      error,
      refetch,
    },
    budgetVariance: {
      data: data?.budgetVariance || [],
      loading: isLoading,
      error,
      refetch,
    },
    unitEconomics: {
      data: data?.unitEconomics || [],
      loading: isLoading,
      error,
      refetch,
    },
    costOptimization: {
      data: data?.costOptimization,
      loading: isLoading,
      error,
      refetch,
    },
  };
};

// Business Service Dashboard Hook
export const useBusinessServiceDashboard = (serviceId?: string, _businessUnit?: string) => {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['business-service-dashboard', serviceId],
    queryFn: () => dashboardService.getBusinessServiceDashboard(serviceId),
    staleTime: 30000,
    refetchInterval: 30000,
    enabled: !!serviceId, // Only fetch if serviceId is provided
  });

  return {
    serviceHealth: {
      data: data?.serviceHealth,
      loading: isLoading,
      error,
      refetch,
    },
    revenueAtRisk: {
      data: data?.revenueAtRisk,
      loading: isLoading,
      error,
      refetch,
    },
    customerImpact: {
      data: data?.customerImpact,
      loading: isLoading,
      error,
      refetch,
    },
    complianceStatus: {
      data: data?.complianceStatus,
      loading: isLoading,
      error,
      refetch,
    },
    valueStreamHealth: {
      data: data?.valueStreamHealth,
      loading: isLoading,
      error,
      refetch,
    },
    serviceDependencies: {
      data: data?.serviceDependencies,
      loading: isLoading,
      error,
      refetch,
    },
  };
};

// Export Dashboard Hook - serializes the provided data to JSON and triggers a
// dependency-free client-side download (mirrors analyticsService.downloadFile).
export const useExportDashboard = () => {
  const exportData = (dashboardType: string, data?: unknown) => {
    const json = JSON.stringify(data ?? {}, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${dashboardType}-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const exportToPDF = async (dashboardType: string, filters?: any) => {
    exportData(dashboardType, filters);
  };

  const exportToExcel = async (dashboardType: string, filters?: any) => {
    exportData(dashboardType, filters);
  };

  return {
    exportData,
    exportToPDF,
    exportToExcel,
    loading: false,
    error: null,
  };
};

// Time Range Helper Hook
export const useTimeRange = (defaultRange: string = '30d') => {
  const [timeRange, setTimeRange] = useState<TimeRange>({
    start: defaultRange,
    end: 'now',
    label: getLabel(defaultRange),
  });

  const updateTimeRange = (range: string) => {
    setTimeRange({
      start: range,
      end: 'now',
      label: getLabel(range),
    });
  };

  return {
    timeRange,
    updateTimeRange,
  };
};

function getLabel(range: string): string {
  const labels: Record<string, string> = {
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    '1y': 'Last year',
  };
  return labels[range] || 'Last 30 days';
}
