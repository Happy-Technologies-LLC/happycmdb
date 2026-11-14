// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Service
 * API client for Business Insights dashboards
 */

import { apiClient } from './api';

export interface TimeRange {
  days: number;
  startDate: string;
  endDate: string;
}

export interface DashboardResponse<T> {
  success: boolean;
  data: T;
  timeRange?: TimeRange;
  serviceId?: string;
  error?: string;
  message?: string;
}

// Executive Dashboard Types
export interface ExecutiveSummaryData {
  totalITSpend: number | null;
  costByCapability: Array<{
    capability: string;
    totalCost: number | null;
    businessServices: Array<{
      serviceId: string;
      serviceName: string;
      monthlyCost: number;
      applicationServices: Array<{
        serviceId: string;
        serviceName: string;
        monthlyCost: number;
      }>;
    }>;
  }>;
  costTrends: Array<{
    month: string;
    total: number;
    compute: number;
    storage: number;
    network: number;
    data: number;
    security: number;
    applications: number;
    budget: number;
    variance: number;
  }>;
  serviceHealthByTier: Array<{
    tier: string;
    averageHealthScore: number | null;
    serviceCount: number;
    trend: string | null;
  }>;
  riskMatrix: {
    services: Array<{
      id: string;
      name: string;
      criticality: string;
      riskLevel: string;
      type: string;
      description: string;
    }>;
  };
  topCostDrivers: Array<{
    serviceId: string;
    serviceName: string;
    monthlyCost: number;
    trend: string | null;
    changePercent: number | null;
  }>;
  valueScorecard: Array<{
    serviceId: string;
    serviceName: string;
    annualRevenue: number | null;
    monthlyCost: number | null;
    roi: number | null;
    customers: number | null;
  }>;
  /** Fields with no backing data; null or empty in this payload. */
  unavailable: string[];
}

// CIO Dashboard Types
export interface CIOMetricsData {
  serviceAvailability: Array<{
    tier: string;
    averageAvailability: number | null;
    slaTarget: number | null;
    complianceStatus: string | null;
  }>;
  changeSuccessRates: {
    successful: number | null;
    failed: number | null;
    rollbacks: number | null;
    total: number | null;
    successRate: number | null;
  };
  incidentResponseTimes: Array<{
    priority: string;
    mttr: number;
    target: number;
    count: number;
  }>;
  configurationAccuracy: {
    totalCIs: number;
    accurateCIs: number | null;
    accuracyPercentage: number | null;
    driftDetected: number | null;
    lastAuditDate: string | null;
  };
  costByCapability: Array<{
    capability: string;
    cost: number | null;
    budgetAllocated: number | null;
    variance: number | null;
  }>;
  capacityPlanning: Array<{
    month: string;
    computeUtilization: number;
    storageUtilization: number;
    networkUtilization: number;
    forecast: number;
  }>;
  /** Fields with no backing data; null or empty in this payload. */
  unavailable: string[];
}

// FinOps Dashboard Types
export interface FinOpsDashboardData {
  cloudCosts: Array<{
    month: string;
    aws: number;
    azure: number;
    gcp: number;
    total: number;
    forecast: number;
  }>;
  onPremVsCloud: {
    onPremCost: number | null;
    cloudCost: number | null;
    totalCost: number | null;
    tcoComparison: Array<{
      category: string;
      onPrem: number;
      cloud: number;
    }>;
  };
  costByTower: Array<{
    tower: string;
    cost: number | null;
    subTowers: Array<{
      name: string;
      cost: number;
    }>;
  }>;
  budgetVariance: Array<{
    capability: string;
    budgetAllocated: number | null;
    actualSpend: number | null;
    variance: number | null;
    variancePercent: number | null;
  }>;
  unitEconomics: Array<{
    metric: string;
    value: number;
    unit: string;
    trend: string;
    changePercent: number;
  }>;
  costOptimization: {
    recommendations: Array<{
      id: string;
      type: string;
      resource: string;
      currentCost: number;
      potentialSavings: number;
      description: string;
      priority: string;
    }>;
    totalPotentialSavings: number | null;
  };
  /** Fields with no backing data; null or empty in this payload. */
  unavailable: string[];
}

// Business Service Dashboard Types
export interface BusinessServiceDashboardData {
  serviceHealth: Array<{
    businessUnit: string;
    businessServices: Array<{
      serviceId: string;
      serviceName: string;
      healthScore: number | null;
      status: string;
    }>;
  }>;
  revenueAtRisk: {
    totalAnnualRevenue: number | null;
    revenueAtRisk: number | null;
    percentageAtRisk: number | null;
    affectedIncidents: Array<{
      id: string;
      priority: string;
      estimatedImpact: number;
    }>;
  };
  customerImpact: {
    totalCustomers: number | null;
    customersImpacted: number | null;
    estimatedUserImpact: number | null;
    incidents: Array<{
      id: string;
      priority: string;
      usersAffected: number;
    }>;
  };
  complianceStatus: {
    pciCompliant: boolean | null;
    hipaaCompliant: boolean | null;
    soxCompliant: boolean | null;
    gdprCompliant: boolean | null;
    lastAuditDate: string | null;
    nonCompliantItems: Array<{
      requirement: string;
      status: string;
      remediation: string;
    }>;
  };
  valueStreamHealth: {
    stages: Array<{
      name: string;
      healthScore: number;
      throughput: number;
      bottleneck: boolean;
    }>;
    flowRate: number | null;
    cycleTime: number | null;
  };
  serviceDependencies: {
    nodes: Array<{
      id: string;
      label: string;
      type: string;
      healthScore: number | null;
      status: string;
      layer: number;
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      type: string;
      healthImpact: number | null;
    }>;
  };
  /** Fields with no backing data; null or empty in this payload. */
  unavailable: string[];
}

class DashboardService {
  /**
   * Get Executive Dashboard summary data
   */
  async getExecutiveDashboard(days: number = 30): Promise<ExecutiveSummaryData> {
    const response = await apiClient.get<DashboardResponse<ExecutiveSummaryData>>(
      `/dashboards/executive?days=${days}`
    );
    return response.data.data;
  }

  /**
   * Get CIO Dashboard metrics
   */
  async getCIODashboard(days: number = 30): Promise<CIOMetricsData> {
    const response = await apiClient.get<DashboardResponse<CIOMetricsData>>(
      `/dashboards/cio?days=${days}`
    );
    return response.data.data;
  }

  /**
   * Get FinOps Dashboard data
   */
  async getFinOpsDashboard(days: number = 30): Promise<FinOpsDashboardData> {
    const response = await apiClient.get<DashboardResponse<FinOpsDashboardData>>(
      `/dashboards/finops?days=${days}`
    );
    return response.data.data;
  }

  /**
   * Get Business Service Dashboard data
   */
  async getBusinessServiceDashboard(serviceId?: string): Promise<BusinessServiceDashboardData> {
    const url = serviceId
      ? `/dashboards/business-service/${serviceId}`
      : `/dashboards/business-service`;

    const response = await apiClient.get<DashboardResponse<BusinessServiceDashboardData>>(url);
    return response.data.data;
  }
}

export default new DashboardService();
