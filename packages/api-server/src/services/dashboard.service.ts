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
import { criticalTiersParam } from './critical-ci';
import { DASHBOARD_QUERY_TIMEOUT_MS, MAX_DASHBOARD_GROUPS } from './dashboard-query';
import { itilRecordTablesAvailable } from './itil-record-schema';

const MAX_ITSM_ROWS = 25;
const MAX_TOP_FAILING_CIS = 5;
const TOP_FAILING_WINDOW_DAYS = 90;

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
  /** Incidents not yet resolved, closed or cancelled; most urgent first, at most MAX_ITSM_ROWS. */
  openIncidents: Array<{
    id: string;
    title: string;
    priority: string;
    status: string;
    affectedCI: string | null;
    assignedTeam: string | null;
    createdAt: string;
    updatedAt: string;
    /** Whole hours since the incident was reported. */
    age: number;
  }>;
  /** Total open incidents (not capped by the list); null when the ITIL records are unavailable. */
  openIncidentCount: number | null;
  /** Scheduled or in-progress changes; at most MAX_ITSM_ROWS. */
  changesInProgress: Array<{
    id: string;
    title: string;
    status: string;
    type: string;
    riskLevel: string | null;
    scheduledDate: string | null;
    affectedCIs: string[];
    assignedTo: string | null;
    createdAt: string;
  }>;
  /** Total scheduled or in-progress changes; null when the ITIL records are unavailable. */
  changesInProgressCount: number | null;
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
  /** CIs with the most incidents reported in the last TOP_FAILING_WINDOW_DAYS days. */
  topFailingCIs: Array<{
    ci_id: string;
    /** Null when the incident's CI id is not a CI of this organization's graph. */
    name: string | null;
    type: string | null;
    incidentCount: number;
    /** Mean of the recorded time_to_resolve_minutes; null when no incident of the CI is resolved. */
    mttrMinutes: number | null;
    lastFailure: string;
  }>;
  /** No SLA targets are stored, so compliance cannot be computed: always empty. */
  slaCompliance: Array<{
    priority: string;
    withinSLA: number;
    total: number;
    compliancePercentage: number;
    target: number;
  }>;
  /** No drift evaluation is stored: always empty. */
  baselineCompliance: Array<{
    ci_id: string;
    name: string;
    type: string;
    driftSeverity: string;
    driftDetails: string;
    remediationStatus: string;
    lastChecked: string;
  }>;
  /** Fields with no backing data; null or empty in this payload. */
  unavailable: string[];
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
            AND ci.bsm_business_criticality IN $criticalTiers
          WITH ci ORDER BY ci.id LIMIT 10
          RETURN ci.id AS id, ci.name AS name, ci.type AS type,
            ci.bsm_business_criticality AS criticality
        `, { organizationId, ...criticalTiersParam() }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
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
   * Get ITSM Dashboard data.
   *
   * Incidents and changes come from the organization's itil_* rows; CI status
   * and CI names from its graph. Nothing is invented: SLA compliance (no stored
   * targets) and baseline drift (no stored evaluation) are empty and named in
   * `unavailable`, and every ITIL-derived field is too when the ITIL tables are
   * absent from the deployed schema.
   */
  async getITSMDashboard(organizationId: string): Promise<ITSMDashboardData> {
    logger.info('Fetching ITSM dashboard data');

    try {
      const itil = await this.queryITILRecords(organizationId);

      const session = this.neo4j.getSession();
      let ciStatus: ITSMDashboardData['ciStatus'];
      let ciIdentity = new Map<string, { name: string | null; type: string | null }>();
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

        if (itil.topFailing.length > 0) {
          // An incident's CI id is free text; only this organization's CIs name it.
          const identities = await session.run(
            `MATCH (ci:CI) WHERE ci.organization_id = $organizationId AND ci.id IN $ids
             RETURN ci.id AS id, ci.name AS name, ci.type AS type`,
            { organizationId, ids: itil.topFailing.map(row => row.ciId) },
            { timeout: DASHBOARD_QUERY_TIMEOUT_MS }
          );
          ciIdentity = new Map(identities.records.map(record => [
            record.get('id') as string,
            { name: (record.get('name') as string | null) ?? null, type: (record.get('type') as string | null) ?? null },
          ]));
        }
      } finally {
        await session.close();
      }

      return {
        openIncidents: itil.openIncidents,
        openIncidentCount: itil.openIncidentCount,
        changesInProgress: itil.changesInProgress,
        changesInProgressCount: itil.changesInProgressCount,
        ciStatus,
        topFailingCIs: itil.topFailing.map(row => ({
          ci_id: row.ciId,
          name: ciIdentity.get(row.ciId)?.name ?? null,
          type: ciIdentity.get(row.ciId)?.type ?? null,
          incidentCount: row.incidentCount,
          mttrMinutes: row.mttrMinutes,
          lastFailure: row.lastFailure,
        })),
        slaCompliance: [],
        baselineCompliance: [],
        unavailable: [
          ...(itil.available ? [] : [
            'openIncidents', 'openIncidentCount', 'changesInProgress', 'changesInProgressCount', 'topFailingCIs',
          ]),
          'slaCompliance', 'baselineCompliance',
        ],
      };
    } catch (error) {
      logger.error('Error fetching ITSM dashboard data', { error });
      throw error;
    }
  }

  /**
   * The organization's open incidents, in-flight changes and most incident-prone
   * CIs. Every statement is bound to `organization_id = $1`; rows with a NULL
   * owner (pre-ownership records) never match. A deployment without the ITIL
   * tables (catalog check) answers `available: false`; any query failure propagates.
   */
  private async queryITILRecords(organizationId: string): Promise<{
    available: boolean;
    openIncidents: ITSMDashboardData['openIncidents'];
    openIncidentCount: number | null;
    changesInProgress: ITSMDashboardData['changesInProgress'];
    changesInProgressCount: number | null;
    topFailing: Array<{
      ciId: string; incidentCount: number; mttrMinutes: number | null; lastFailure: string;
    }>;
  }> {
    if (!await itilRecordTablesAvailable((sql, params) => this.postgres.query(sql, params), 'itil_incidents', 'itil_changes')) {
      return {
        available: false, openIncidents: [], openIncidentCount: null,
        changesInProgress: [], changesInProgressCount: null, topFailing: [],
      };
    }
    const incidents = await this.postgres.query(
      `SELECT incident_number, title, priority, status, affected_ci_id, assigned_group,
              reported_at, updated_at, count(*) OVER () AS total
         FROM itil_incidents
        WHERE organization_id = $1 AND status NOT IN ('resolved', 'closed', 'cancelled')
        ORDER BY priority ASC, reported_at ASC, id
        LIMIT ${MAX_ITSM_ROWS}`,
      [organizationId]
    );
    const changes = await this.postgres.query(
      `SELECT change_number, title, status, change_type, risk_assessment->>'risk_level' AS risk_level,
              scheduled_start, affected_ci_ids, assigned_to, created_at, count(*) OVER () AS total
         FROM itil_changes
        WHERE organization_id = $1 AND status IN ('scheduled', 'in_progress')
        ORDER BY scheduled_start ASC NULLS LAST, created_at DESC, id
        LIMIT ${MAX_ITSM_ROWS}`,
      [organizationId]
    );
    // Cancelled incidents (opened in error) are not failures.
    const failing = await this.postgres.query(
      `SELECT affected_ci_id, count(*) AS incident_count,
              avg(time_to_resolve_minutes) AS mttr_minutes, max(reported_at) AS last_failure
         FROM itil_incidents
        WHERE organization_id = $1 AND affected_ci_id IS NOT NULL AND affected_ci_id <> ''
          AND status <> 'cancelled'
          AND reported_at >= now() - make_interval(days => $2::int)
        GROUP BY affected_ci_id
        ORDER BY incident_count DESC, last_failure DESC, affected_ci_id
        LIMIT ${MAX_TOP_FAILING_CIS}`,
      [organizationId, TOP_FAILING_WINDOW_DAYS]
    );

    const now = Date.now();
    return {
      available: true,
      // A page with no rows has no window total: nothing matched.
      openIncidentCount: incidents.rows.length === 0 ? 0 : Number(incidents.rows[0].total),
      openIncidents: incidents.rows.map(row => ({
        id: row.incident_number,
        title: row.title,
        priority: `P${row.priority}`,
        status: row.status,
        affectedCI: row.affected_ci_id ?? null,
        assignedTeam: row.assigned_group ?? null,
        createdAt: new Date(row.reported_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        age: Math.max(0, Math.floor((now - new Date(row.reported_at).getTime()) / 3600000)),
      })),
      changesInProgressCount: changes.rows.length === 0 ? 0 : Number(changes.rows[0].total),
      changesInProgress: changes.rows.map(row => ({
        id: row.change_number,
        title: row.title,
        status: row.status,
        type: row.change_type,
        riskLevel: row.risk_level ?? null,
        scheduledDate: row.scheduled_start ? new Date(row.scheduled_start).toISOString() : null,
        affectedCIs: row.affected_ci_ids ?? [],
        assignedTo: row.assigned_to ?? null,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      topFailing: failing.rows.map(row => ({
        ciId: row.affected_ci_id,
        incidentCount: Number(row.incident_count),
        mttrMinutes: row.mttr_minutes == null ? null : Math.round(Number(row.mttr_minutes)),
        lastFailure: new Date(row.last_failure).toISOString(),
      })),
    };
  }

  /**
   * Get FinOps Dashboard data
   */
  async getFinOpsDashboard(organizationId: string, timeRange: TimeRange): Promise<FinOpsDashboardData> {
    logger.info('Fetching FinOps dashboard data', { timeRange });

    try {
      const session = this.neo4j.getSession();
      let totalCost: number | null;
      let cloudCost: number | null;
      let onPremCost: number | null;
      let capabilities: ExecutiveSummaryData['costByCapability'];
      try {
        const costs = await session.run(`
          MATCH (ci:CI)
          WHERE ci.status = 'active' AND ci.organization_id = $organizationId
          RETURN sum(ci.tbm_monthly_cost) AS totalCost, count(ci.tbm_monthly_cost) AS costedCIs,
            sum(CASE WHEN ci.discovery_provider IN ['aws', 'azure', 'gcp'] THEN ci.tbm_monthly_cost END) AS cloudCost,
            count(CASE WHEN ci.discovery_provider IN ['aws', 'azure', 'gcp'] THEN ci.tbm_monthly_cost END) AS cloudCostedCIs
        `, { organizationId }, { timeout: DASHBOARD_QUERY_TIMEOUT_MS });
        const row = costs.records[0];
        const costedCIs = graphNumber(row?.get('costedCIs'));
        const cloudCostedCIs = graphNumber(row?.get('cloudCostedCIs'));
        totalCost = costedCIs > 0 ? graphNumber(row?.get('totalCost')) : null;
        // Each segment is known only if a CI in that segment carries a cost.
        cloudCost = cloudCostedCIs > 0 ? graphNumber(row?.get('cloudCost')) : null;
        onPremCost = totalCost !== null && costedCIs - cloudCostedCIs > 0
          ? totalCost - graphNumber(row?.get('cloudCost')) : null;
        capabilities = await this.aggregateCostByCapability(session, organizationId);
      } finally {
        await session.close();
      }

      const onPremVsCloud = this.calculateOnPremVsCloud(totalCost, cloudCost, onPremCost);
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
          ...(totalCost === null ? ['onPremVsCloud.totalCost'] : []),
          ...(onPremCost === null ? ['onPremVsCloud.onPremCost'] : []),
          ...(cloudCost === null ? ['onPremVsCloud.cloudCost'] : []),
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
    totalCost: number | null, cloudCost: number | null, onPremCost: number | null
  ): FinOpsDashboardData['onPremVsCloud'] {
    // The per-category TCO split has no backing data.
    return { onPremCost, cloudCost, totalCost, tcoComparison: [] };
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
