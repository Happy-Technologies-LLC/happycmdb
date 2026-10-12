// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Service
 * Provides aggregated data for Business Insights dashboards
 */

import neo4j, { type Integer, type Node, type Session } from 'neo4j-driver';
import {
  getNeo4jClient, getPostgresClient, CITraversalLimitError,
  MAX_CI_TRAVERSAL_NODES, MAX_CI_TRAVERSAL_WORK,
} from '@cmdb/database';
import { logger } from '@cmdb/common';
import { ownsBusinessService } from './business-service-ownership';

const DASHBOARD_QUERY_TIMEOUT_MS = 5000;
const MAX_DASHBOARD_GROUPS = 100;

export class DashboardAggregateLimitError extends Error {
  constructor() {
    super('Dashboard aggregate resource limit exceeded');
  }
}

const graphNumber = (value: number | Integer | null | undefined): number =>
  value == null ? 0 : neo4j.isInt(value) ? value.toNumber() : value;

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
   * Get Executive Dashboard data. Every dashboard method takes the caller's
   * organization id (from the token, never from request input) and only
   * matches :CI nodes whose organization_id equals it.
   */
  async getExecutiveSummary(organizationId: string, timeRange: TimeRange): Promise<ExecutiveSummaryData> {
    logger.info('Fetching executive summary data', { timeRange });

    try {
      const session = this.neo4j.getSession();
      let costByCapability: ExecutiveSummaryData['costByCapability'];
      let serviceHealthByTier: ExecutiveSummaryData['serviceHealthByTier'];
      let riskMatrix: ExecutiveSummaryData['riskMatrix'];
      let topCostDrivers: ExecutiveSummaryData['topCostDrivers'];
      let valueScorecard: ExecutiveSummaryData['valueScorecard'];
      try {
        costByCapability = await this.aggregateCostByCapability(session, organizationId);
        const tierResult = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
          RETURN
            count(CASE WHEN ci.bsm_business_criticality = 'tier_1' THEN 1 END) AS tier_1,
            count(CASE WHEN ci.bsm_business_criticality = 'tier_2' THEN 1 END) AS tier_2,
            count(CASE WHEN ci.bsm_business_criticality = 'tier_3' THEN 1 END) AS tier_3,
            count(CASE WHEN ci.bsm_business_criticality = 'tier_4' THEN 1 END) AS tier_4
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        serviceHealthByTier = this.aggregateHealthByTier(tierResult.records[0]);

        const riskResult = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
            AND ci.bsm_business_criticality IN ['tier_1', 'tier_2']
          WITH ci ORDER BY ci.id LIMIT 10
          RETURN ci.id AS id, ci.name AS name, ci.type AS type,
            ci.bsm_business_criticality AS criticality
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        riskMatrix = { services: riskResult.records.map(row => {
          const criticality = row.get('criticality') as string;
          const type = row.get('type') as string;
          return {
            id: row.get('id'), name: row.get('name'), type, criticality,
            riskLevel: criticality === 'tier_1' ? 'high' : 'medium',
            description: `${type} in ${criticality}`,
          };
        }) };

        const driversResult = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
            AND ci.tbm_monthly_cost > 0
          WITH ci ORDER BY ci.tbm_monthly_cost DESC, ci.id LIMIT 10
          RETURN ci.id AS id, ci.name AS name, ci.tbm_monthly_cost AS monthlyCost
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        topCostDrivers = driversResult.records.map(row => ({
          serviceId: row.get('id'),
          serviceName: row.get('name'),
          monthlyCost: graphNumber(row.get('monthlyCost')),
          trend: Math.random() > 0.5 ? 'up' : 'down',
          changePercent: -5 + Math.random() * 15,
        }));

        const valueResult = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
            AND ci.bsm_customer_facing = true
          WITH ci ORDER BY ci.id LIMIT 5
          RETURN ci.id AS id, ci.name AS name, ci.tbm_monthly_cost AS monthlyCost
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        valueScorecard = valueResult.records.map(row => ({
          serviceId: row.get('id'),
          serviceName: row.get('name'),
          annualRevenue: 1000000 + Math.random() * 5000000,
          monthlyCost: graphNumber(row.get('monthlyCost')),
          roi: 200 + Math.random() * 300,
          customers: Math.floor(100 + Math.random() * 1000),
        }));
      } finally {
        await session.close();
      }

      const totalITSpend = costByCapability.reduce((sum, cap) => sum + cap.totalCost, 0);
      // Time-series data has not yet been integrated.
      const costTrends = this.generateCostTrends(timeRange, totalITSpend);

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
  async getCIOMetrics(organizationId: string, timeRange: TimeRange): Promise<CIOMetricsData> {
    logger.info('Fetching CIO metrics', { timeRange });

    try {
      const session = this.neo4j.getSession();
      let totalCIs: number;
      let capabilities: ExecutiveSummaryData['costByCapability'];
      try {
        const result = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
          RETURN count(ci) AS totalCIs
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        totalCIs = result.records[0]?.get('totalCIs').toNumber() ?? 0;
        capabilities = await this.aggregateCostByCapability(session, organizationId);
      } finally {
        await session.close();
      }

      // Service availability remains a mock until ITIL records are integrated.
      const serviceAvailability = this.calculateServiceAvailability();

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
        totalCIs,
        accurateCIs: Math.floor(totalCIs * 0.94),
        accuracyPercentage: 94.2,
        driftDetected: Math.floor(totalCIs * 0.06),
        lastAuditDate: new Date().toISOString(),
      };

      // Cost by capability
      const costByCapability = capabilities.map(cap => ({
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
  async getITSMDashboard(organizationId: string): Promise<ITSMDashboardData> {
    logger.info('Fetching ITSM dashboard data');

    try {
      const session = this.neo4j.getSession();
      let ciStatus: ITSMDashboardData['ciStatus'];
      try {
        const statusResult = await session.run(`
          MATCH (ci:CI)
          WHERE ci.organization_id = $organizationId
          WITH ci.status AS status, count(ci) AS count
          ORDER BY count DESC, status LIMIT ${MAX_DASHBOARD_GROUPS + 1}
          CALL {
            WITH status
            MATCH (sample:CI)
            WHERE sample.organization_id = $organizationId
              AND (sample.status = status OR (sample.status IS NULL AND status IS NULL))
            WITH sample ORDER BY sample.id LIMIT 5
            RETURN collect(sample) AS sampleCIs
          }
          RETURN status, count, sampleCIs
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        if (statusResult.records.length > MAX_DASHBOARD_GROUPS) throw new DashboardAggregateLimitError();
        ciStatus = statusResult.records.map(record => ({
          status: record.get('status'),
          count: record.get('count').toNumber(),
          cis: (record.get('sampleCIs') as Node[]).map(ci => ({
            ci_id: ci.properties['id'],
            name: ci.properties['name'],
            type: ci.properties['type'],
            status: ci.properties['status'],
            environment: ci.properties['environment'] || 'unknown',
            lastSeen: ci.properties['updated_at'] || ci.properties['created_at'],
          })),
        }));
      } finally {
        await session.close();
      }

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
  async getFinOpsDashboard(organizationId: string, timeRange: TimeRange): Promise<FinOpsDashboardData> {
    logger.info('Fetching FinOps dashboard data', { timeRange });

    try {
      const session = this.neo4j.getSession();
      let providerCosts: { awsCost: number; azureCost: number; gcpCost: number; totalCost: number };
      let capabilities: ExecutiveSummaryData['costByCapability'];
      let optimizations: FinOpsDashboardData['costOptimization'];
      try {
        const costs = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
          RETURN sum(coalesce(ci.tbm_monthly_cost, 0)) AS totalCost,
            sum(CASE WHEN ci.discovery_provider = 'aws' THEN coalesce(ci.tbm_monthly_cost, 0) ELSE 0 END) AS awsCost,
            sum(CASE WHEN ci.discovery_provider = 'azure' THEN coalesce(ci.tbm_monthly_cost, 0) ELSE 0 END) AS azureCost,
            sum(CASE WHEN ci.discovery_provider = 'gcp' THEN coalesce(ci.tbm_monthly_cost, 0) ELSE 0 END) AS gcpCost
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        const row = costs.records[0];
        providerCosts = {
          totalCost: graphNumber(row?.get('totalCost')), awsCost: graphNumber(row?.get('awsCost')),
          azureCost: graphNumber(row?.get('azureCost')), gcpCost: graphNumber(row?.get('gcpCost')),
        };
        capabilities = await this.aggregateCostByCapability(session, organizationId);
        const sample = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
            AND ci.tbm_monthly_cost > 100
          WITH ci ORDER BY ci.id LIMIT 5
          RETURN ci.name AS name, ci.tbm_monthly_cost AS monthlyCost
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        const recommendations = sample.records.map((item, idx) => {
          const resource = item.get('name') as string;
          const currentCost = graphNumber(item.get('monthlyCost'));
          return {
            id: `OPT-${idx + 1}`, type: 'Rightsizing', resource, currentCost,
            potentialSavings: currentCost * 0.3,
            description: `Downsize ${resource} based on utilization patterns`, priority: 'High',
          };
        });
        optimizations = {
          recommendations,
          totalPotentialSavings: recommendations.reduce((sum, recommendation) => sum + recommendation.potentialSavings, 0),
        };
      } finally {
        await session.close();
      }

      const cloudCosts = this.aggregateCloudCosts(providerCosts, timeRange);
      const cloudCost = providerCosts.awsCost + providerCosts.azureCost + providerCosts.gcpCost;
      const onPremVsCloud = this.calculateOnPremVsCloud(providerCosts.totalCost - cloudCost, cloudCost);
      const costByTower = capabilities.map(cap => ({
        tower: cap.capability, cost: cap.totalCost, subTowers: [],
      }));
      const budgetVariance = this.calculateBudgetVariance(capabilities);
      const unitEconomics = this.calculateUnitEconomics();
      const costOptimization = optimizations;

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
   * Get Business Service Dashboard data. With a serviceId, returns null (and
   * runs no Cypher) unless the organization owns the service in Postgres, and
   * returns null when a :BusinessService node with that id exists but does not
   * carry the organization (another organization's, or none; FD-16 c), so such
   * a node is indistinguishable from a missing service. An owned service with
   * no :BusinessService node keeps its CI-only dashboard.
   */
  async getBusinessServiceDashboard(
    organizationId: string,
    serviceId?: string
  ): Promise<BusinessServiceDashboardData | null> {
    logger.info('Fetching business service dashboard data', { serviceId });

    try {
      if (serviceId && !(await ownsBusinessService(organizationId, serviceId))) {
        return null;
      }

      if (serviceId) {
        const session = this.neo4j.getSession();
        try {
          const gate = await session.run(
            `OPTIONAL MATCH (bs:BusinessService {id: $serviceId})
             WITH collect(bs) AS nodes
             RETURN all(b IN nodes WHERE b.organization_id = $organizationId) AS allowed`,
            { serviceId, organizationId },
            { timeout: 5000 }
          );
          // No node: all() over [] is true. A node without organization_id gives null,
          // refused like false (another organization's node).
          if (gate.records[0]?.get('allowed') !== true) return null;
        } finally {
          await session.close();
        }
      }

      // Health is currently static for both modes; the default route needs no graph read.
      const serviceHealth = this.aggregateServiceHealth();

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
      const serviceDependencies = await this.getServiceDependencies(organizationId, serviceId);

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

  private async aggregateCostByCapability(
    session: Session, organizationId: string
  ): Promise<ExecutiveSummaryData['costByCapability']> {
    // Group server-side, then admit at most 100 distinct towers. Never transfer a tenant's CI list.
    const result = await session.run(`
      MATCH (ci:CI)
      WHERE ci.status = 'active' AND ci.organization_id = $organizationId
      WITH CASE
        WHEN ci.tbm_capability_tower IS NOT NULL AND ci.tbm_capability_tower <> '' THEN ci.tbm_capability_tower
        WHEN ci.tbm_resource_tower IS NOT NULL AND ci.tbm_resource_tower <> '' THEN ci.tbm_resource_tower
        ELSE 'Uncategorized'
      END AS capability, coalesce(ci.tbm_monthly_cost, 0) AS monthlyCost
      RETURN capability, sum(monthlyCost) AS totalCost
      ORDER BY capability LIMIT ${MAX_DASHBOARD_GROUPS + 1}
    `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
    if (result.records.length > MAX_DASHBOARD_GROUPS) throw new DashboardAggregateLimitError();
    return result.records.map(row => ({
      capability: row.get('capability'),
      totalCost: graphNumber(row.get('totalCost')),
      businessServices: [],
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

  private aggregateHealthByTier(record: { get(key: string): Integer } | undefined): any[] {
    const tiers = ['tier_1', 'tier_2', 'tier_3', 'tier_4'];
    return tiers.map(tier => ({
      tier,
      averageHealthScore: 85 + Math.random() * 10,
      serviceCount: record?.get(tier).toNumber() ?? 0,
      trend: Math.random() > 0.5 ? 'up' : 'stable',
    }));
  }

  private calculateServiceAvailability(): any[] {
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

  private aggregateCloudCosts(
    { awsCost, azureCost, gcpCost }: { awsCost: number; azureCost: number; gcpCost: number },
    timeRange: TimeRange
  ): any[] {
    const months = Math.ceil(timeRange.days / 30);
    const costs = [];

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

  private calculateOnPremVsCloud(onPremCost: number, cloudCost: number): any {

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


  private calculateBudgetVariance(capabilities: ExecutiveSummaryData['costByCapability']): any[] {
    return capabilities.map(cap => ({
      capability: cap.capability,
      budgetAllocated: cap.totalCost * 1.1,
      actualSpend: cap.totalCost,
      variance: cap.totalCost * 0.1,
      variancePercent: 10,
    }));
  }

  private calculateUnitEconomics(): any[] {
    return [
      { metric: 'Cost per User', value: 25.50, unit: 'USD/user/month', trend: 'down', changePercent: -5.2 },
      { metric: 'Cost per Transaction', value: 0.15, unit: 'USD/transaction', trend: 'down', changePercent: -8.1 },
      { metric: 'Infrastructure Efficiency', value: 72.5, unit: '%', trend: 'up', changePercent: 3.2 },
    ];
  }

  private aggregateServiceHealth(): any[] {
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

  private async getServiceDependencies(organizationId: string, serviceId?: string): Promise<any> {
    if (!serviceId) {
      return { nodes: [], edges: [] };
    }

    const session = this.neo4j.getSession();
    const nodes: BusinessServiceDashboardData['serviceDependencies']['nodes'] = [];
    const edges: BusinessServiceDashboardData['serviceDependencies']['edges'] = [];
    const discovered = new Set<string>();
    const seenEdges = new Set<string>();
    let remaining = MAX_CI_TRAVERSAL_WORK;

    try {
      const root = await session.run(
        `MATCH (ci:CI {id: $serviceId})
         WHERE ci.organization_id = $organizationId
         RETURN ci LIMIT 1`,
        { serviceId, organizationId },
        { timeout: 5000 }
      );
      const start = root.records[0]?.get('ci') as Node | undefined;
      if (!start) return { nodes, edges };
      discovered.add(serviceId);
      nodes.push({
        id: serviceId, label: start.properties['name'], type: start.properties['type'],
        healthScore: 85, status: start.properties['status'], layer: 1,
      });

      let frontier = [serviceId];
      for (let layer = 2; layer <= 4 && frontier.length > 0; layer++) {
        if (remaining === 0) throw new CITraversalLimitError();
        const result = await session.run(
          `UNWIND $frontier AS sourceId
           MATCH (source:CI {id: sourceId})
           WHERE source.organization_id = $organizationId
           MATCH (source)-[relationship]-(related:CI)
           WHERE related.organization_id = $organizationId
           RETURN related, elementId(relationship) AS relationshipId,
                  startNode(relationship).id AS fromId, endNode(relationship).id AS toId,
                  type(relationship) AS relationshipType
           LIMIT $rowLimit`,
          { frontier, organizationId, rowLimit: neo4j.int(remaining + 1) },
          { timeout: 5000 }
        );
        if (result.records.length > remaining) throw new CITraversalLimitError();
        remaining -= result.records.length;
        const next: string[] = [];
        for (const record of result.records) {
          const related = record.get('related') as Node;
          const id = related.properties['id'] as string;
          const relationshipId = record.get('relationshipId') as string;
          if (!seenEdges.has(relationshipId)) {
            seenEdges.add(relationshipId);
            edges.push({
              id: relationshipId, from: record.get('fromId'), to: record.get('toId'),
              type: record.get('relationshipType'), healthImpact: 75,
            });
          }
          if (discovered.has(id)) continue;
          discovered.add(id);
          if (discovered.size > MAX_CI_TRAVERSAL_NODES) throw new CITraversalLimitError();
          nodes.push({
            id, label: related.properties['name'], type: related.properties['type'],
            healthScore: 85, status: related.properties['status'], layer,
          });
          next.push(id);
        }
        frontier = next;
      }
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
