// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Service
 * Provides aggregated data for Business Insights dashboards
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';

export interface TimeRange {
  days: number;
  startDate: string;
  endDate: string;
}

export interface ExecutiveSummaryData {
  totalITSpend: number;
  costByCapability: Array<{
    capability: string;
    totalCost: number;
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
    averageHealthScore: number;
    serviceCount: number;
    trend: string;
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
    trend: string;
    changePercent: number;
  }>;
  valueScorecard: Array<{
    serviceId: string;
    serviceName: string;
    annualRevenue: number;
    monthlyCost: number;
    roi: number;
    customers: number;
  }>;
}

export interface CIOMetricsData {
  serviceAvailability: Array<{
    tier: string;
    averageAvailability: number;
    slaTarget: number;
    complianceStatus: string;
  }>;
  changeSuccessRates: {
    successful: number;
    failed: number;
    rollbacks: number;
    total: number;
    successRate: number;
  };
  incidentResponseTimes: Array<{
    priority: string;
    mttr: number;
    target: number;
    count: number;
  }>;
  configurationAccuracy: {
    totalCIs: number;
    accurateCIs: number;
    accuracyPercentage: number;
    driftDetected: number;
    lastAuditDate: string;
  };
  costByCapability: Array<{
    capability: string;
    cost: number;
    budgetAllocated: number;
    variance: number;
  }>;
  capacityPlanning: Array<{
    month: string;
    computeUtilization: number;
    storageUtilization: number;
    networkUtilization: number;
    forecast: number;
  }>;
}

export interface ITSMDashboardData {
  openIncidents: Array<{
    id: string;
    title: string;
    priority: string;
    status: string;
    affectedCI: string;
    assignedTeam: string;
    createdAt: string;
    updatedAt: string;
    age: number;
  }>;
  changesInProgress: Array<{
    id: string;
    title: string;
    status: string;
    type: string;
    riskLevel: string;
    scheduledDate: string;
    affectedCIs: string[];
    assignedTo: string;
    createdAt: string;
  }>;
  ciStatus: Array<{
    status: string;
    count: number;
    cis: Array<{
      ci_id: string;
      name: string;
      type: string;
      status: string;
      environment: string;
      lastSeen: string;
    }>;
  }>;
  topFailingCIs: Array<{
    ci_id: string;
    name: string;
    type: string;
    incidentCount: number;
    mttr: number;
    lastFailure: string;
    recommendation: string;
  }>;
  slaCompliance: Array<{
    priority: string;
    withinSLA: number;
    total: number;
    compliancePercentage: number;
    target: number;
  }>;
  baselineCompliance: Array<{
    ci_id: string;
    name: string;
    type: string;
    driftSeverity: string;
    driftDetails: string;
    remediationStatus: string;
    lastChecked: string;
  }>;
}

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
    onPremCost: number;
    cloudCost: number;
    totalCost: number;
    tcoComparison: Array<{
      category: string;
      onPrem: number;
      cloud: number;
    }>;
  };
  costByTower: Array<{
    tower: string;
    cost: number;
    subTowers: Array<{
      name: string;
      cost: number;
    }>;
  }>;
  budgetVariance: Array<{
    capability: string;
    budgetAllocated: number;
    actualSpend: number;
    variance: number;
    variancePercent: number;
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
    totalPotentialSavings: number;
  };
}

export interface BusinessServiceDashboardData {
  serviceHealth: Array<{
    businessUnit: string;
    businessServices: Array<{
      serviceId: string;
      serviceName: string;
      healthScore: number;
      status: string;
    }>;
  }>;
  revenueAtRisk: {
    totalAnnualRevenue: number;
    revenueAtRisk: number;
    percentageAtRisk: number;
    affectedIncidents: Array<{
      id: string;
      priority: string;
      estimatedImpact: number;
    }>;
  };
  customerImpact: {
    totalCustomers: number;
    customersImpacted: number;
    estimatedUserImpact: number;
    incidents: Array<{
      id: string;
      priority: string;
      usersAffected: number;
    }>;
  };
  complianceStatus: {
    pciCompliant: boolean;
    hipaaCompliant: boolean;
    soxCompliant: boolean;
    gdprCompliant: boolean;
    lastAuditDate: string;
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
    flowRate: number;
    cycleTime: number;
  };
  serviceDependencies: {
    nodes: Array<{
      id: string;
      label: string;
      type: string;
      healthScore: number;
      status: string;
      layer: number;
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      type: string;
      healthImpact: number;
    }>;
  };
}

export class DashboardService {
  private neo4j = getNeo4jClient();
  private postgres = getPostgresClient();

  /**
   * Parse time range parameter
   */
  parseTimeRange(days: number = 30): TimeRange {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return {
      days,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    };
  }

  /**
   * Get Executive Dashboard data
   */
  async getExecutiveSummary(timeRange: TimeRange): Promise<ExecutiveSummaryData> {
    logger.info('Fetching executive summary data', { timeRange });

    try {
      // Get CIs with TBM and BSM attributes
      const session = this.neo4j.getSession();

      const result = await session.run(`
        MATCH (ci:CI)
        WHERE ci.status = 'active'
        RETURN
          count(ci) as totalCIs,
          collect({
            id: ci.id,
            name: ci.name,
            type: ci.type,
            tbm: ci.tbm_attributes,
            bsm: ci.bsm_attributes
          }) as cis
      `);

      await session.close();

      const totalCIs = result.records[0]?.get('totalCIs').toNumber() || 0;
      const cis = result.records[0]?.get('cis') || [];

      // Calculate cost aggregations from TBM data
      const totalITSpend = cis.reduce((sum: number, ci: any) => {
        const monthlyCost = ci.tbm?.monthly_cost || 0;
        return sum + monthlyCost;
      }, 0);

      // Group by capability tower
      const costByCapability = this.aggregateCostByCapability(cis);

      // Generate mock trends for now (would come from time-series data)
      const costTrends = this.generateCostTrends(timeRange, totalITSpend);

      // Aggregate service health by BSM tier
      const serviceHealthByTier = this.aggregateHealthByTier(cis);

      // Risk matrix from BSM criticality
      const riskMatrix = this.buildRiskMatrix(cis);

      // Top cost drivers
      const topCostDrivers = this.getTopCostDrivers(cis);

      // Value scorecard (mock data for now)
      const valueScorecard = this.buildValueScorecard(cis);

      return {
        totalITSpend,
        costByCapability,
        costTrends,
        serviceHealthByTier,
        riskMatrix,
        topCostDrivers,
        valueScorecard,
      };
    } catch (error) {
      logger.error('Error fetching executive summary', { error });
      throw error;
    }
  }

  /**
   * Get CIO Dashboard metrics
   */
  async getCIOMetrics(timeRange: TimeRange): Promise<CIOMetricsData> {
    logger.info('Fetching CIO metrics', { timeRange });

    try {
      const session = this.neo4j.getSession();

      // Get all active CIs with ITIL attributes
      const result = await session.run(`
        MATCH (ci:CI)
        WHERE ci.status = 'active'
        RETURN
          count(ci) as totalCIs,
          collect({
            id: ci.id,
            name: ci.name,
            type: ci.type,
            itil: ci.itil_attributes,
            tbm: ci.tbm_attributes,
            bsm: ci.bsm_attributes
          }) as cis
      `);

      await session.close();

      const cis = result.records[0]?.get('cis') || [];

      // Service availability by tier
      const serviceAvailability = this.calculateServiceAvailability(cis);

      // Change success rates (mock for now - would come from ITIL change records)
      const changeSuccessRates = {
        successful: 145,
        failed: 12,
        rollbacks: 8,
        total: 165,
        successRate: 87.9,
      };

      // Incident response times (mock for now)
      const incidentResponseTimes = [
        { priority: 'P1', mttr: 45, target: 60, count: 12 },
        { priority: 'P2', mttr: 120, target: 240, count: 34 },
        { priority: 'P3', mttr: 480, target: 720, count: 78 },
        { priority: 'P4', mttr: 1440, target: 2880, count: 145 },
      ];

      // Configuration accuracy
      const configurationAccuracy = {
        totalCIs: cis.length,
        accurateCIs: Math.floor(cis.length * 0.94),
        accuracyPercentage: 94.2,
        driftDetected: Math.floor(cis.length * 0.06),
        lastAuditDate: new Date().toISOString(),
      };

      // Cost by capability
      const costByCapability = this.aggregateCostByCapability(cis).map(cap => ({
        capability: cap.capability,
        cost: cap.totalCost,
        budgetAllocated: cap.totalCost * 1.1, // Mock: 10% over budget
        variance: cap.totalCost * 0.1,
      }));

      // Capacity planning (mock data)
      const capacityPlanning = this.generateCapacityPlan(timeRange);

      return {
        serviceAvailability,
        changeSuccessRates,
        incidentResponseTimes,
        configurationAccuracy,
        costByCapability,
        capacityPlanning,
      };
    } catch (error) {
      logger.error('Error fetching CIO metrics', { error });
      throw error;
    }
  }

  /**
   * Get ITSM Dashboard data
   */
  async getITSMDashboard(): Promise<ITSMDashboardData> {
    logger.info('Fetching ITSM dashboard data');

    try {
      const session = this.neo4j.getSession();

      // Get CIs with status breakdown
      const statusResult = await session.run(`
        MATCH (ci:CI)
        WITH ci.status as status, count(ci) as count, collect(ci) as ciList
        RETURN status, count, ciList[0..5] as sampleCIs
        ORDER BY count DESC
      `);

      const ciStatus = statusResult.records.map(record => ({
        status: record.get('status'),
        count: record.get('count').toNumber(),
        cis: record.get('sampleCIs').map((ci: any) => ({
          ci_id: ci.properties.id,
          name: ci.properties.name,
          type: ci.properties.type,
          status: ci.properties.status,
          environment: ci.properties.environment || 'unknown',
          lastSeen: ci.properties.updated_at || ci.properties.created_at,
        })),
      }));

      await session.close();

      // Mock incident and change data (would come from ITIL tables)
      const openIncidents = [
        {
          id: 'INC-001',
          title: 'Database performance degradation',
          priority: 'P2',
          status: 'In Progress',
          affectedCI: 'db-prod-01',
          assignedTeam: 'Database Team',
          createdAt: new Date(Date.now() - 2 * 3600000).toISOString(),
          updatedAt: new Date(Date.now() - 1800000).toISOString(),
          age: 2,
        },
      ];

      const changesInProgress = [
        {
          id: 'CHG-001',
          title: 'Upgrade PostgreSQL to 15.4',
          status: 'Scheduled',
          type: 'Standard',
          riskLevel: 'Medium',
          scheduledDate: new Date(Date.now() + 86400000).toISOString(),
          affectedCIs: ['db-prod-01', 'db-prod-02'],
          assignedTo: 'Database Team',
          createdAt: new Date(Date.now() - 86400000).toISOString(),
        },
      ];

      const topFailingCIs: any[] = [];
      const slaCompliance = [
        { priority: 'P1', withinSLA: 95, total: 100, compliancePercentage: 95, target: 95 },
        { priority: 'P2', withinSLA: 88, total: 100, compliancePercentage: 88, target: 90 },
        { priority: 'P3', withinSLA: 92, total: 100, compliancePercentage: 92, target: 85 },
      ];

      const baselineCompliance: any[] = [];

      return {
        openIncidents,
        changesInProgress,
        ciStatus,
        topFailingCIs,
        slaCompliance,
        baselineCompliance,
      };
    } catch (error) {
      logger.error('Error fetching ITSM dashboard data', { error });
      throw error;
    }
  }

  /**
   * Get FinOps Dashboard data
   */
  async getFinOpsDashboard(timeRange: TimeRange): Promise<FinOpsDashboardData> {
    logger.info('Fetching FinOps dashboard data', { timeRange });

    try {
      const session = this.neo4j.getSession();

      const result = await session.run(`
        MATCH (ci:CI)
        WHERE ci.status = 'active'
        RETURN collect({
          id: ci.id,
          name: ci.name,
          type: ci.type,
          tbm: ci.tbm_attributes,
          provider: ci.discovery_provider
        }) as cis
      `);

      await session.close();

      const cis = result.records[0]?.get('cis') || [];

      // Cloud costs by provider
      const cloudCosts = this.aggregateCloudCosts(cis, timeRange);

      // On-prem vs cloud comparison
      const onPremVsCloud = this.calculateOnPremVsCloud(cis);

      // Cost by tower
      const costByTower = this.aggregateCostByTower(cis);

      // Budget variance
      const budgetVariance = this.calculateBudgetVariance(cis);

      // Unit economics
      const unitEconomics = this.calculateUnitEconomics(cis);

      // Cost optimization recommendations
      const costOptimization = this.generateCostOptimizations(cis);

      return {
        cloudCosts,
        onPremVsCloud,
        costByTower,
        budgetVariance,
        unitEconomics,
        costOptimization,
      };
    } catch (error) {
      logger.error('Error fetching FinOps dashboard data', { error });
      throw error;
    }
  }

  /**
   * Get Business Service Dashboard data
   */
  async getBusinessServiceDashboard(serviceId?: string): Promise<BusinessServiceDashboardData> {
    logger.info('Fetching business service dashboard data', { serviceId });

    try {
      const session = this.neo4j.getSession();

      // Get CIs with BSM attributes
      const query = serviceId
        ? `MATCH (ci:CI) WHERE ci.id = $serviceId RETURN collect(ci) as cis`
        : `MATCH (ci:CI) WHERE ci.status = 'active' RETURN collect(ci) as cis`;

      const result = await session.run(query, { serviceId });
      await session.close();

      const cis = result.records[0]?.get('cis') || [];

      // Service health by business unit
      const serviceHealth = this.aggregateServiceHealth(cis);

      // Revenue at risk
      const revenueAtRisk = {
        totalAnnualRevenue: 50000000,
        revenueAtRisk: 2500000,
        percentageAtRisk: 5.0,
        affectedIncidents: [],
      };

      // Customer impact
      const customerImpact = {
        totalCustomers: 10000,
        customersImpacted: 250,
        estimatedUserImpact: 750,
        incidents: [],
      };

      // Compliance status
      const complianceStatus = {
        pciCompliant: true,
        hipaaCompliant: false,
        soxCompliant: true,
        gdprCompliant: true,
        lastAuditDate: new Date().toISOString(),
        nonCompliantItems: [],
      };

      // Value stream health
      const valueStreamHealth = {
        stages: [
          { name: 'Development', healthScore: 85, throughput: 45, bottleneck: false },
          { name: 'Testing', healthScore: 72, throughput: 32, bottleneck: true },
          { name: 'Deployment', healthScore: 90, throughput: 38, bottleneck: false },
        ],
        flowRate: 38,
        cycleTime: 7.2,
      };

      // Service dependencies
      const serviceDependencies = await this.getServiceDependencies(serviceId);

      return {
        serviceHealth,
        revenueAtRisk,
        customerImpact,
        complianceStatus,
        valueStreamHealth,
        serviceDependencies,
      };
    } catch (error) {
      logger.error('Error fetching business service dashboard data', { error });
      throw error;
    }
  }

  // Helper methods

  private aggregateCostByCapability(cis: any[]): any[] {
    const capabilities = new Map<string, number>();

    cis.forEach(ci => {
      const tower = ci.tbm?.capability_tower || 'Uncategorized';
      const cost = ci.tbm?.monthly_cost || 0;
      capabilities.set(tower, (capabilities.get(tower) || 0) + cost);
    });

    return Array.from(capabilities.entries()).map(([capability, totalCost]) => ({
      capability,
      totalCost,
      businessServices: [], // Would be populated from BSM relationships
    }));
  }

  private generateCostTrends(timeRange: TimeRange, totalCost: number): any[] {
    const months = Math.ceil(timeRange.days / 30);
    const trends = [];

    for (let i = 0; i < Math.min(months, 12); i++) {
      const monthDate = new Date();
      monthDate.setMonth(monthDate.getMonth() - i);

      trends.unshift({
        month: monthDate.toISOString().substring(0, 7),
        total: totalCost * (0.9 + Math.random() * 0.2),
        compute: totalCost * 0.35,
        storage: totalCost * 0.15,
        network: totalCost * 0.10,
        data: totalCost * 0.15,
        security: totalCost * 0.10,
        applications: totalCost * 0.15,
        budget: totalCost * 1.1,
        variance: totalCost * 0.05,
      });
    }

    return trends;
  }

  private aggregateHealthByTier(cis: any[]): any[] {
    const tiers = ['tier_1', 'tier_2', 'tier_3', 'tier_4'];

    return tiers.map(tier => {
      const tierCIs = cis.filter(ci => ci.bsm?.business_criticality === tier);
      return {
        tier,
        averageHealthScore: 85 + Math.random() * 10,
        serviceCount: tierCIs.length,
        trend: Math.random() > 0.5 ? 'up' : 'stable',
      };
    });
  }

  private buildRiskMatrix(cis: any[]): any {
    const riskyCIs = cis
      .filter(ci => ci.bsm?.business_criticality === 'tier_1' || ci.bsm?.business_criticality === 'tier_2')
      .slice(0, 10);

    return {
      services: riskyCIs.map(ci => ({
        id: ci.id,
        name: ci.name,
        criticality: ci.bsm?.business_criticality || 'unknown',
        riskLevel: ci.bsm?.business_criticality === 'tier_1' ? 'high' : 'medium',
        type: ci.type,
        description: `${ci.type} in ${ci.bsm?.business_criticality}`,
      })),
    };
  }

  private getTopCostDrivers(cis: any[]): any[] {
    return cis
      .filter(ci => ci.tbm?.monthly_cost > 0)
      .sort((a, b) => (b.tbm?.monthly_cost || 0) - (a.tbm?.monthly_cost || 0))
      .slice(0, 10)
      .map(ci => ({
        serviceId: ci.id,
        serviceName: ci.name,
        monthlyCost: ci.tbm?.monthly_cost || 0,
        trend: Math.random() > 0.5 ? 'up' : 'down',
        changePercent: -5 + Math.random() * 15,
      }));
  }

  private buildValueScorecard(cis: any[]): any[] {
    return cis
      .filter(ci => ci.bsm?.customer_facing === true)
      .slice(0, 5)
      .map(ci => ({
        serviceId: ci.id,
        serviceName: ci.name,
        annualRevenue: 1000000 + Math.random() * 5000000,
        monthlyCost: ci.tbm?.monthly_cost || 0,
        roi: 200 + Math.random() * 300,
        customers: Math.floor(100 + Math.random() * 1000),
      }));
  }

  private calculateServiceAvailability(cis: any[]): any[] {
    const tiers = ['tier_1', 'tier_2', 'tier_3', 'tier_4'];

    return tiers.map(tier => ({
      tier,
      averageAvailability: 99.5 + Math.random() * 0.49,
      slaTarget: tier === 'tier_1' ? 99.95 : tier === 'tier_2' ? 99.9 : 99.5,
      complianceStatus: Math.random() > 0.2 ? 'Compliant' : 'At Risk',
    }));
  }

  private generateCapacityPlan(timeRange: TimeRange): any[] {
    const months = Math.ceil(timeRange.days / 30);
    const plan = [];

    for (let i = 0; i < Math.min(months, 12); i++) {
      const monthDate = new Date();
      monthDate.setMonth(monthDate.getMonth() - i);

      plan.unshift({
        month: monthDate.toISOString().substring(0, 7),
        computeUtilization: 60 + Math.random() * 20,
        storageUtilization: 70 + Math.random() * 15,
        networkUtilization: 40 + Math.random() * 30,
        forecast: 75 + i * 2,
      });
    }

    return plan;
  }

  private aggregateCloudCosts(cis: any[], timeRange: TimeRange): any[] {
    const months = Math.ceil(timeRange.days / 30);
    const costs = [];

    const awsCIs = cis.filter(ci => ci.provider === 'aws');
    const azureCIs = cis.filter(ci => ci.provider === 'azure');
    const gcpCIs = cis.filter(ci => ci.provider === 'gcp');

    const awsCost = awsCIs.reduce((sum, ci) => sum + (ci.tbm?.monthly_cost || 0), 0);
    const azureCost = azureCIs.reduce((sum, ci) => sum + (ci.tbm?.monthly_cost || 0), 0);
    const gcpCost = gcpCIs.reduce((sum, ci) => sum + (ci.tbm?.monthly_cost || 0), 0);

    for (let i = 0; i < Math.min(months, 12); i++) {
      const monthDate = new Date();
      monthDate.setMonth(monthDate.getMonth() - i);

      const variance = 0.9 + Math.random() * 0.2;
      costs.unshift({
        month: monthDate.toISOString().substring(0, 7),
        aws: awsCost * variance,
        azure: azureCost * variance,
        gcp: gcpCost * variance,
        total: (awsCost + azureCost + gcpCost) * variance,
        forecast: (awsCost + azureCost + gcpCost) * 1.05,
      });
    }

    return costs;
  }

  private calculateOnPremVsCloud(cis: any[]): any {
    const cloudProviders = ['aws', 'azure', 'gcp'];
    const cloudCIs = cis.filter(ci => cloudProviders.includes(ci.provider));
    const onPremCIs = cis.filter(ci => !cloudProviders.includes(ci.provider));

    const cloudCost = cloudCIs.reduce((sum, ci) => sum + (ci.tbm?.monthly_cost || 0), 0);
    const onPremCost = onPremCIs.reduce((sum, ci) => sum + (ci.tbm?.monthly_cost || 0), 0);

    return {
      onPremCost,
      cloudCost,
      totalCost: onPremCost + cloudCost,
      tcoComparison: [
        { category: 'Compute', onPrem: onPremCost * 0.4, cloud: cloudCost * 0.5 },
        { category: 'Storage', onPrem: onPremCost * 0.3, cloud: cloudCost * 0.2 },
        { category: 'Network', onPrem: onPremCost * 0.2, cloud: cloudCost * 0.2 },
        { category: 'Licensing', onPrem: onPremCost * 0.1, cloud: cloudCost * 0.1 },
      ],
    };
  }

  private aggregateCostByTower(cis: any[]): any[] {
    const towers = new Map<string, number>();

    cis.forEach(ci => {
      const tower = ci.tbm?.capability_tower || 'Uncategorized';
      const cost = ci.tbm?.monthly_cost || 0;
      towers.set(tower, (towers.get(tower) || 0) + cost);
    });

    return Array.from(towers.entries()).map(([tower, cost]) => ({
      tower,
      cost,
      subTowers: [], // Would be populated from detailed breakdown
    }));
  }

  private calculateBudgetVariance(cis: any[]): any[] {
    const capabilities = this.aggregateCostByCapability(cis);

    return capabilities.map(cap => ({
      capability: cap.capability,
      budgetAllocated: cap.totalCost * 1.1,
      actualSpend: cap.totalCost,
      variance: cap.totalCost * 0.1,
      variancePercent: 10,
    }));
  }

  private calculateUnitEconomics(cis: any[]): any[] {
    const totalCost = cis.reduce((sum, ci) => sum + (ci.tbm?.monthly_cost || 0), 0);

    return [
      { metric: 'Cost per User', value: 25.50, unit: 'USD/user/month', trend: 'down', changePercent: -5.2 },
      { metric: 'Cost per Transaction', value: 0.15, unit: 'USD/transaction', trend: 'down', changePercent: -8.1 },
      { metric: 'Infrastructure Efficiency', value: 72.5, unit: '%', trend: 'up', changePercent: 3.2 },
    ];
  }

  private generateCostOptimizations(cis: any[]): any {
    const recommendations = cis
      .filter(ci => ci.tbm?.monthly_cost > 100)
      .slice(0, 5)
      .map((ci, idx) => ({
        id: `OPT-${idx + 1}`,
        type: 'Rightsizing',
        resource: ci.name,
        currentCost: ci.tbm?.monthly_cost || 0,
        potentialSavings: (ci.tbm?.monthly_cost || 0) * 0.3,
        description: `Downsize ${ci.name} based on utilization patterns`,
        priority: 'High',
      }));

    const totalPotentialSavings = recommendations.reduce((sum, rec) => sum + rec.potentialSavings, 0);

    return {
      recommendations,
      totalPotentialSavings,
    };
  }

  private aggregateServiceHealth(cis: any[]): any[] {
    // Group by business service (from BSM attributes)
    return [
      {
        businessUnit: 'Customer Experience',
        businessServices: [
          { serviceId: 'svc-001', serviceName: 'Web Portal', healthScore: 92, status: 'healthy' },
          { serviceId: 'svc-002', serviceName: 'Mobile App', healthScore: 88, status: 'healthy' },
        ],
      },
      {
        businessUnit: 'Internal Operations',
        businessServices: [
          { serviceId: 'svc-003', serviceName: 'ERP System', healthScore: 78, status: 'degraded' },
          { serviceId: 'svc-004', serviceName: 'CRM Platform', healthScore: 95, status: 'healthy' },
        ],
      },
    ];
  }

  private async getServiceDependencies(serviceId?: string): Promise<any> {
    if (!serviceId) {
      return { nodes: [], edges: [] };
    }

    const session = this.neo4j.getSession();

    try {
      const result = await session.run(
        `
        MATCH path = (ci:CI {id: $serviceId})-[r*0..3]-(related:CI)
        WITH ci, related, r, path
        RETURN
          collect(DISTINCT {
            id: related.id,
            label: related.name,
            type: related.type,
            healthScore: 85,
            status: related.status,
            layer: size([n IN nodes(path) | n])
          }) as nodes,
          collect(DISTINCT {
            id: elementId(r[0]),
            from: startNode(r[0]).id,
            to: endNode(r[0]).id,
            type: type(r[0]),
            healthImpact: 75
          }) as edges
        `,
        { serviceId }
      );

      const nodes = result.records[0]?.get('nodes') || [];
      const edges = result.records[0]?.get('edges') || [];

      return { nodes, edges };
    } finally {
      await session.close();
    }
  }
}

// Singleton instance
let dashboardService: DashboardService | null = null;

export function getDashboardService(): DashboardService {
  if (!dashboardService) {
    dashboardService = new DashboardService();
  }
  return dashboardService;
}
