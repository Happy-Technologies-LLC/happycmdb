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

const nullableGraphNumber = (value: number | Integer | null | undefined): number | null =>
  value == null ? null : graphNumber(value);

/** Sum of the known values; null when none is known (no data is not a zero). */
const sumKnown = (values: Array<number | null>): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
};

/**
 * Dashboard payloads never carry an invented number: a field with no backing
 * data in the caller's organization is null (or an empty list) and is named in
 * the payload's `unavailable` list as `<section>.<field>` (or `<section>`).
 */

export interface TimeRange {
  days: number;
  startDate: string;
  endDate: string;
}

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
          // The graph keeps no previous-period cost (only tbm_monthly_cost), so no change is computable.
          trend: null,
          changePercent: null,
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
          // No CI property carries revenue, ROI or customer counts.
          annualRevenue: null,
          monthlyCost: nullableGraphNumber(row.get('monthlyCost')),
          roi: null,
          customers: null,
        }));
      } finally {
        await session.close();
      }

      const totalITSpend = sumKnown(costByCapability.map(cap => cap.totalCost));
      const unavailable = [
        'costTrends',
        'serviceHealthByTier.averageHealthScore', 'serviceHealthByTier.trend',
        'topCostDrivers.trend', 'topCostDrivers.changePercent',
        'valueScorecard.annualRevenue', 'valueScorecard.roi', 'valueScorecard.customers',
        ...(totalITSpend === null ? ['totalITSpend'] : []),
        ...(costByCapability.some(cap => cap.totalCost === null) ? ['costByCapability.totalCost'] : []),
        ...(valueScorecard.some(row => row.monthlyCost === null) ? ['valueScorecard.monthlyCost'] : []),
      ];

      return {
        totalITSpend,
        costByCapability,
        // No cost time series is stored; the graph holds only the current tbm_monthly_cost.
        costTrends: [],
        serviceHealthByTier,
        riskMatrix,
        topCostDrivers,
        valueScorecard,
        unavailable,
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

      // No availability, change, incident, drift, budget or utilization record feeds this service.
      const serviceAvailability = this.calculateServiceAvailability();
      const changeSuccessRates = {
        successful: null, failed: null, rollbacks: null, total: null, successRate: null,
      };
      const configurationAccuracy = {
        totalCIs, accurateCIs: null, accuracyPercentage: null, driftDetected: null, lastAuditDate: null,
      };
      const costByCapability = capabilities.map(cap => ({
        capability: cap.capability, cost: cap.totalCost, budgetAllocated: null, variance: null,
      }));

      return {
        serviceAvailability,
        changeSuccessRates,
        incidentResponseTimes: [],
        configurationAccuracy,
        costByCapability,
        capacityPlanning: [],
        unavailable: [
          'serviceAvailability', 'changeSuccessRates', 'incidentResponseTimes',
          'configurationAccuracy.accurateCIs', 'configurationAccuracy.accuracyPercentage',
          'configurationAccuracy.driftDetected', 'configurationAccuracy.lastAuditDate',
          'costByCapability.budgetAllocated', 'costByCapability.variance', 'capacityPlanning',
          ...(costByCapability.some(cap => cap.cost === null) ? ['costByCapability.cost'] : []),
        ],
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
      let totalCost: number | null;
      let cloudCost: number;
      let capabilities: ExecutiveSummaryData['costByCapability'];
      try {
        const costs = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
          RETURN sum(ci.tbm_monthly_cost) AS totalCost, count(ci.tbm_monthly_cost) AS costedCIs,
            sum(CASE WHEN ci.discovery_provider IN ['aws', 'azure', 'gcp'] THEN ci.tbm_monthly_cost END) AS cloudCost
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        const row = costs.records[0];
        totalCost = graphNumber(row?.get('costedCIs')) > 0 ? graphNumber(row?.get('totalCost')) : null;
        cloudCost = graphNumber(row?.get('cloudCost'));
        capabilities = await this.aggregateCostByCapability(session, organizationId);
      } finally {
        await session.close();
      }

      const onPremVsCloud = this.calculateOnPremVsCloud(totalCost, cloudCost);
      const costByTower = capabilities.map(cap => ({
        tower: cap.capability, cost: cap.totalCost, subTowers: [],
      }));
      const budgetVariance = this.calculateBudgetVariance(capabilities);

      return {
        // No cost time series, budget, unit-economics or utilization data is stored.
        cloudCosts: [],
        onPremVsCloud,
        costByTower,
        budgetVariance,
        unitEconomics: [],
        costOptimization: { recommendations: [], totalPotentialSavings: null },
        unavailable: [
          'cloudCosts', 'onPremVsCloud.tcoComparison',
          'budgetVariance.budgetAllocated', 'budgetVariance.variance', 'budgetVariance.variancePercent',
          'unitEconomics', 'costOptimization',
          ...(totalCost === null
            ? ['onPremVsCloud.onPremCost', 'onPremVsCloud.cloudCost', 'onPremVsCloud.totalCost'] : []),
          ...(capabilities.some(cap => cap.totalCost === null) ? ['costByTower.cost', 'budgetVariance.actualSpend'] : []),
        ],
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

      // No CI health state exists yet (BW1), no incident source feeds revenue or customer
      // impact, and no compliance, audit or value-stream record is stored.
      const serviceDependencies = await this.getServiceDependencies(organizationId, serviceId);

      return {
        serviceHealth: [],
        revenueAtRisk: {
          totalAnnualRevenue: null, revenueAtRisk: null, percentageAtRisk: null, affectedIncidents: [],
        },
        customerImpact: {
          totalCustomers: null, customersImpacted: null, estimatedUserImpact: null, incidents: [],
        },
        complianceStatus: {
          pciCompliant: null, hipaaCompliant: null, soxCompliant: null, gdprCompliant: null,
          lastAuditDate: null, nonCompliantItems: [],
        },
        valueStreamHealth: { stages: [], flowRate: null, cycleTime: null },
        serviceDependencies,
        unavailable: [
          'serviceHealth', 'revenueAtRisk', 'customerImpact', 'complianceStatus', 'valueStreamHealth',
          'serviceDependencies.healthScore', 'serviceDependencies.healthImpact',
        ],
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
    // A tower whose CIs carry no tbm_monthly_cost has an unknown cost, not a zero one.
    const result = await session.run(`
      MATCH (ci:CI)
      WHERE ci.status = 'active' AND ci.organization_id = $organizationId
      WITH CASE
        WHEN ci.tbm_capability_tower IS NOT NULL AND ci.tbm_capability_tower <> '' THEN ci.tbm_capability_tower
        WHEN ci.tbm_resource_tower IS NOT NULL AND ci.tbm_resource_tower <> '' THEN ci.tbm_resource_tower
        ELSE 'Uncategorized'
      END AS capability, ci.tbm_monthly_cost AS monthlyCost
      RETURN capability, sum(monthlyCost) AS totalCost, count(monthlyCost) AS costedCIs
      ORDER BY capability LIMIT ${MAX_DASHBOARD_GROUPS + 1}
    `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
    if (result.records.length > MAX_DASHBOARD_GROUPS) throw new DashboardAggregateLimitError();
    return result.records.map(row => ({
      capability: row.get('capability'),
      totalCost: graphNumber(row.get('costedCIs')) > 0 ? graphNumber(row.get('totalCost')) : null,
      businessServices: [],
    }));
  }

  private aggregateHealthByTier(
    record: { get(key: string): Integer } | undefined
  ): ExecutiveSummaryData['serviceHealthByTier'] {
    const tiers = ['tier_1', 'tier_2', 'tier_3', 'tier_4'];
    return tiers.map(tier => ({
      tier,
      averageHealthScore: null,
      serviceCount: record?.get(tier).toNumber() ?? 0,
      trend: null,
    }));
  }

  private calculateServiceAvailability(): CIOMetricsData['serviceAvailability'] {
    const tiers = ['tier_1', 'tier_2', 'tier_3', 'tier_4'];
    return tiers.map(tier => ({
      tier, averageAvailability: null, slaTarget: null, complianceStatus: null,
    }));
  }

  private calculateOnPremVsCloud(
    totalCost: number | null, cloudCost: number
  ): FinOpsDashboardData['onPremVsCloud'] {
    // The per-category TCO split has no backing data.
    return totalCost === null
      ? { onPremCost: null, cloudCost: null, totalCost: null, tcoComparison: [] }
      : { onPremCost: totalCost - cloudCost, cloudCost, totalCost, tcoComparison: [] };
  }

  private calculateBudgetVariance(
    capabilities: ExecutiveSummaryData['costByCapability']
  ): FinOpsDashboardData['budgetVariance'] {
    // The graph holds no budget, so spend has nothing to vary against.
    return capabilities.map(cap => ({
      capability: cap.capability,
      budgetAllocated: null,
      actualSpend: cap.totalCost,
      variance: null,
      variancePercent: null,
    }));
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
        healthScore: null, status: start.properties['status'], layer: 1,
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
              type: record.get('relationshipType'), healthImpact: null,
            });
          }
          if (discovered.has(id)) continue;
          discovered.add(id);
          if (discovered.size > MAX_CI_TRAVERSAL_NODES) throw new CITraversalLimitError();
          nodes.push({
            id, label: related.properties['name'], type: related.properties['type'],
            healthScore: null, status: related.properties['status'], layer,
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
