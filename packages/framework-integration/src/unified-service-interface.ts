// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified Service Interface
 * Main orchestrator combining ITIL + TBM + BSM frameworks
 */

import { ITILServiceManager } from './services/itil-service-manager';
import { TBMServiceManager } from './services/tbm-service-manager';
import { BSMServiceManager } from './services/bsm-service-manager';
import { BusinessServiceRepository } from '@cmdb/itil-service-manager';
import { getPostgresClient, getRedisClient } from '@cmdb/database';
import {
  IncidentInput,
  ChangeRequest
} from '@cmdb/itil-service-manager';
import {
  BusinessCriticality,
  OperationalStatus
} from '@cmdb/unified-model';
import {
  CompleteServiceView,
  EnrichedIncident,
  UnifiedChangeRisk,
  ServiceDashboardData,
  UnifiedQueryFilters,
  ApprovalRequirements
} from './types/unified-types';
import {
  UnifiedKPIs,
  ServiceHealthDetails,
  RiskScoreDetails,
  ValueScoreDetails
} from './types/kpi-types';

/**
 * Unified Service Interface
 * Orchestrates all three frameworks to provide complete service views
 */
export class UnifiedServiceInterface {
  private itilManager: ITILServiceManager;
  private tbmManager: TBMServiceManager;
  private bsmManager: BSMServiceManager;
  private businessServiceRepo: BusinessServiceRepository;
  private redis: any;

  constructor() {
    this.itilManager = new ITILServiceManager();
    this.tbmManager = new TBMServiceManager();
    this.bsmManager = new BSMServiceManager();
    this.businessServiceRepo = new BusinessServiceRepository(getPostgresClient());
    this.redis = getRedisClient();
  }

  /**
   * Get complete service view combining all three frameworks
   *
   * @param serviceId - Business service ID
   * @param options - Query options
   * @returns Complete service view with ITIL, TBM, BSM, and unified KPIs
   *
   * @example
   * ```typescript
   * const view = await unifiedService.getCompleteServiceView('bs-001', { useCache: true });
   * console.log(`Service: ${view.serviceName}`);
   * console.log(`Health Score: ${view.kpis.serviceHealth}/100`);
   * console.log(`Monthly Cost: $${view.tbm.monthlyCost}`);
   * console.log(`Annual Revenue: $${view.bsm.annualRevenue}`);
   * ```
   */
  async getCompleteServiceView(
    serviceId: string,
    options: { useCache?: boolean } = { useCache: true }
  ): Promise<CompleteServiceView> {
    try {
      // Check cache first
      const cacheKey = `unified:service:${serviceId}`;
      if (options.useCache) {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      }

      // Fetch data from all three frameworks in parallel
      const [businessService, itilMetrics, tbmCosts, bsmImpact] = await Promise.all([
        this.businessServiceRepo.getBusinessServiceById(serviceId),
        this.itilManager.getServiceMetrics(serviceId),
        this.tbmManager.getServiceCosts(serviceId),
        this.bsmManager.getServiceImpact(serviceId)
      ]);

      if (!businessService) {
        throw new Error(`Business service not found: ${serviceId}`);
      }

      // Calculate unified KPIs
      const kpis = this.calculateUnifiedKPIs(itilMetrics, tbmCosts, bsmImpact);

      const view: CompleteServiceView = {
        serviceId,
        serviceName: businessService.name,
        serviceDescription: businessService.description,
        itil: itilMetrics,
        tbm: tbmCosts,
        bsm: bsmImpact,
        kpis,
        businessService,
        generatedAt: new Date(),
        cacheTTL: 300 // 5 minutes
      };

      // Cache the result
      await this.redis.setex(cacheKey, view.cacheTTL, JSON.stringify(view));

      return view;
    } catch (error) {
      throw new Error(`Failed to get complete service view: ${error.message}`);
    }
  }

  /**
   * Create enriched incident with ITIL + TBM + BSM data
   *
   * @param incident - Incident input data
   * @returns Enriched incident with priority, impact, cost, and response team
   *
   * @example
   * ```typescript
   * const enrichedIncident = await unifiedService.createEnrichedIncident({
   *   affectedCIId: 'ci-prod-db-001',
   *   title: 'Database connection pool exhausted',
   *   description: 'Production database rejecting connections',
   *   reportedBy: 'monitoring@company.com',
   *   symptoms: ['Connection timeouts', 'Error rate spike']
   * });
   * console.log(`Priority: ${enrichedIncident.itilPriority.priority}`);
   * console.log(`Downtime Cost: $${enrichedIncident.downtimeCostPerHour}/hour`);
   * console.log(`Customers Impacted: ${enrichedIncident.estimatedCustomerImpact}`);
   * ```
   */
  async createEnrichedIncident(incident: IncidentInput): Promise<EnrichedIncident> {
    try {
      // 1. Calculate ITIL priority (from Phase 2)
      const itilPriority = await this.itilManager.calculatePriority(incident);

      // 2. Calculate business impact (from Phase 4)
      const businessImpact = await this.bsmManager.calculateImpact(incident.affectedCIId);

      // 3. Calculate blast radius
      const blastRadius = await this.bsmManager.calculateBlastRadius(incident.affectedCIId);

      // 4. Calculate downtime cost (from Phase 3 + 4)
      const downtimeCostPerHour = await this.tbmManager.calculateDowntimeCost(
        incident.affectedCIId,
        1 // per hour
      );

      // 5. Estimate total cost based on typical incident duration
      const estimatedDurationHours = this.estimateIncidentDuration(itilPriority.priority);
      const totalEstimatedCost = downtimeCostPerHour * estimatedDurationHours;

      // 6. Determine response team based on criticality
      const responseTeam = this.determineResponseTeam(businessImpact.criticality);

      // 7. Determine escalation requirements
      const escalationRequired = itilPriority.priority <= 2;
      const executiveNotificationRequired = businessImpact.criticality === 'tier_0';

      // 8. Get SLA targets
      const slaTargets = await this.itilManager.getSLATargets(businessImpact.serviceId);

      // 9. Generate recommended actions
      const recommendedActions = this.generateIncidentActions(
        itilPriority,
        businessImpact,
        blastRadius
      );

      return {
        id: '', // Will be set when persisted
        title: incident.title,
        description: incident.description,
        affectedCIId: incident.affectedCIId,
        affectedCIName: '', // Would need to query CI name
        reportedBy: incident.reportedBy,
        category: incident.category,
        subcategory: incident.subcategory,
        symptoms: incident.symptoms,
        itilPriority,
        businessImpact,
        blastRadius,
        estimatedRevenueImpact: businessImpact.revenueAtRiskPerHour * estimatedDurationHours,
        estimatedCustomerImpact: blastRadius.totalCustomersImpacted,
        downtimeCostPerHour,
        totalEstimatedCost,
        responseTeam,
        escalationRequired,
        executiveNotificationRequired,
        recommendedActions,
        targetResponseTime: slaTargets?.responseTime || this.getDefaultResponseTime(itilPriority.priority),
        targetResolutionTime: slaTargets?.resolutionTime || this.getDefaultResolutionTime(itilPriority.priority),
        enrichedAt: new Date()
      };
    } catch (error) {
      throw new Error(`Failed to create enriched incident: ${error.message}`);
    }
  }

  /**
   * Assess unified change risk across all frameworks
   *
   * @param change - Change request data
   * @returns Unified risk assessment with approvals and recommendations
   *
   * @example
   * ```typescript
   * const riskAssessment = await unifiedService.assessChangeRisk({
   *   affectedCIIds: ['ci-prod-app-001'],
   *   title: 'Deploy new authentication service',
   *   changeType: 'normal',
   *   // ... other fields
   * });
   * console.log(`Overall Risk: ${riskAssessment.overallRiskLevel}`);
   * console.log(`Requires CAB: ${riskAssessment.requiresCABApproval}`);
   * console.log(`Estimated Cost: $${riskAssessment.costEstimate.totalCost}`);
   * ```
   */
  async assessChangeRisk(change: ChangeRequest): Promise<UnifiedChangeRisk> {
    try {
      // 1. ITIL risk assessment (5 factors from Phase 2)
      const itilRisk = await this.itilManager.assessChangeRisk(change);

      // 2. Business impact analysis (from Phase 4)
      const businessImpact = await this.bsmManager.calculateImpact(change.affectedCIIds[0]);

      // 3. Cost estimation (from Phase 3)
      const costEstimate = await this.tbmManager.estimateChangeCost(change);

      // 4. Determine overall risk level
      const overallRiskLevel = this.calculateOverallRiskLevel(itilRisk.riskLevel, businessImpact.criticality);

      // 5. Determine approval requirements
      const approvalRequirements = this.determineApprovalRequirements(
        itilRisk,
        businessImpact,
        costEstimate
      );

      // 6. Generate recommendations
      const recommendations = this.generateChangeRecommendations(
        itilRisk,
        businessImpact,
        costEstimate
      );

      // 7. Determine optimal change window
      const optimalChangeWindow = this.determineOptimalChangeWindow(change, businessImpact);

      return {
        changeId: change.changeId || '',
        changeTitle: change.title,
        changeType: change.changeType,
        itilRisk,
        businessImpact,
        costEstimate,
        approvalRequirements,
        requiresCABApproval: itilRisk.requiresCABApproval,
        requiresExecutiveApproval: businessImpact.criticality === 'tier_0',
        requiresFinancialApproval: costEstimate.totalCost > 50000,
        overallRiskLevel,
        recommendations,
        optimalChangeWindow,
        assessedAt: new Date()
      };
    } catch (error) {
      throw new Error(`Failed to assess unified change risk: ${error.message}`);
    }
  }

  /**
   * Get service dashboard data
   *
   * @param serviceId - Business service ID
   * @returns Complete dashboard data including trends and alerts
   */
  async getServiceDashboard(serviceId: string): Promise<ServiceDashboardData> {
    try {
      // Get complete service view
      const service = await this.getCompleteServiceView(serviceId);

      // Get recent incidents
      const recentIncidents = await this.itilManager.getRecentIncidents(serviceId, 30);

      // Get recent changes
      const recentChanges = await this.itilManager.getRecentChanges(serviceId, 30);

      // Cost trends from TBM data
      const costTrends = service.tbm.costByTower;
      const costTrendsArray = Array.from(costTrends.entries()).map(([tower, cost]) => ({
        month: new Date().toISOString().substring(0, 7),
        cost,
        change: 0 // Would calculate from historical data
      }));

      // Health trends (mock data - would calculate from historical metrics)
      const healthTrends = this.generateHealthTrends(service.kpis.serviceHealth, service.kpis.availability);

      // Generate alerts
      const alerts = this.generateAlerts(service);

      return {
        service,
        recentIncidents,
        recentChanges,
        costTrends: costTrendsArray,
        healthTrends,
        alerts,
        generatedAt: new Date()
      };
    } catch (error) {
      throw new Error(`Failed to get service dashboard: ${error.message}`);
    }
  }

  /**
   * Calculate unified KPIs from framework metrics
   * @private
   */
  private calculateUnifiedKPIs(itil: any, tbm: any, bsm: any): UnifiedKPIs {
    // Service health (0-100)
    const serviceHealth = this.calculateServiceHealth(itil, bsm);

    // Cost efficiency
    const costEfficiency = {
      costPerTransaction: tbm.monthlyCost / (bsm.transactionVolume * 30),
      costPerUser: tbm.monthlyCost / bsm.userCount,
      costPerRevenue: (tbm.monthlyCost * 12) / bsm.annualRevenue,
      trend: tbm.costTrend,
      budgetVariance: tbm.budgetVariance
    };

    // Risk score (0-100)
    const riskScore = this.calculateRiskScore(itil, bsm);

    // Value score (revenue / cost ratio)
    const valueScore = (bsm.annualRevenue / 12) / tbm.monthlyCost;

    // Compliance score (0-100)
    const complianceScore = itil.auditStatus === 'compliant' ? 100 :
                            itil.auditStatus === 'non_compliant' ? 0 : 50;

    // ROI
    const roi = ((bsm.annualRevenue / 12) - tbm.monthlyCost) / tbm.monthlyCost;

    return {
      serviceHealth,
      costEfficiency,
      riskScore,
      valueScore,
      complianceScore,
      availability: itil.availability * 100,
      roi,
      mttr: itil.averageMTTR,
      mtbf: this.calculateMTBF(itil),
      changeSuccessRate: itil.changeSuccessRate * 100
    };
  }

  /**
   * Calculate service health score
   * @private
   */
  private calculateServiceHealth(itil: any, bsm: any): number {
    const availabilityScore = itil.availability * 100;
    const incidentScore = Math.max(0, 100 - (itil.openIncidents * 10));
    const changeScore = itil.changeSuccessRate * 100;
    const complianceScore = itil.baselineCompliance;

    return (availabilityScore * 0.4 + incidentScore * 0.3 + changeScore * 0.2 + complianceScore * 0.1);
  }

  /**
   * Calculate risk score
   * @private
   */
  private calculateRiskScore(itil: any, bsm: any): number {
    const criticalityRisk = this.getCriticalityRisk(bsm.criticality);
    const incidentRisk = Math.min(100, itil.criticalIncidents * 20);
    const driftRisk = itil.driftedCIs > 0 ? (itil.driftedCIs / itil.baselinedCIs) * 100 : 0;
    const complianceRisk = itil.auditStatus === 'non_compliant' ? 100 : 0;

    return (criticalityRisk * 0.3 + incidentRisk * 0.3 + driftRisk * 0.2 + complianceRisk * 0.2);
  }

  /**
   * Get risk score from criticality tier
   * @private
   */
  private getCriticalityRisk(criticality: BusinessCriticality): number {
    switch (criticality) {
      case 'tier_0': return 100;
      case 'tier_1': return 75;
      case 'tier_2': return 50;
      case 'tier_3': return 25;
      case 'tier_4': return 10;
      default: return 50;
    }
  }

  /**
   * Calculate MTBF (Mean Time Between Failures)
   * @private
   */
  private calculateMTBF(itil: any): number {
    if (itil.criticalIncidents === 0) return 720; // 30 days in hours
    return (30 * 24) / itil.criticalIncidents;
  }

  /**
   * Determine response team based on criticality
   * @private
   */
  private determineResponseTeam(criticality: BusinessCriticality): string[] {
    switch (criticality) {
      case 'tier_0':
        return ['Executive On-Call', 'Senior SRE Team', 'Product Management', 'Customer Success'];
      case 'tier_1':
        return ['Senior SRE Team', 'Platform Engineering', 'Product On-Call'];
      case 'tier_2':
        return ['Platform Engineering', 'Application Support'];
      case 'tier_3':
        return ['Application Support'];
      case 'tier_4':
        return ['Service Desk'];
      default:
        return ['Application Support'];
    }
  }

  /**
   * Estimate incident duration based on priority
   * @private
   */
  private estimateIncidentDuration(priority: number): number {
    switch (priority) {
      case 1: return 2;   // 2 hours
      case 2: return 4;   // 4 hours
      case 3: return 8;   // 8 hours
      case 4: return 24;  // 24 hours
      case 5: return 48;  // 48 hours
      default: return 8;
    }
  }

  /**
   * Get default response time for priority
   * @private
   */
  private getDefaultResponseTime(priority: number): number {
    switch (priority) {
      case 1: return 15;   // 15 minutes
      case 2: return 30;   // 30 minutes
      case 3: return 60;   // 1 hour
      case 4: return 240;  // 4 hours
      case 5: return 480;  // 8 hours
      default: return 60;
    }
  }

  /**
   * Get default resolution time for priority
   * @private
   */
  private getDefaultResolutionTime(priority: number): number {
    switch (priority) {
      case 1: return 60;    // 1 hour
      case 2: return 240;   // 4 hours
      case 3: return 480;   // 8 hours
      case 4: return 1440;  // 24 hours
      case 5: return 2880;  // 48 hours
      default: return 480;
    }
  }

  /**
   * Generate incident recommended actions
   * @private
   */
  private generateIncidentActions(itilPriority: any, businessImpact: any, blastRadius: any): string[] {
    const actions = [];

    if (itilPriority.priority === 1) {
      actions.push('Initiate emergency response protocol');
      actions.push('Notify executive leadership immediately');
    }

    if (businessImpact.customerFacing) {
      actions.push('Update status page');
      actions.push('Prepare customer communication');
    }

    if (blastRadius.totalServicesImpacted > 5) {
      actions.push('Assemble war room with all affected service owners');
    }

    if (businessImpact.complianceImpact !== 'none') {
      actions.push('Notify compliance team');
      actions.push('Begin audit trail documentation');
    }

    actions.push('Enable detailed logging and monitoring');
    actions.push('Prepare rollback plan if change-related');

    return actions;
  }

  /**
   * Calculate overall risk level
   * @private
   */
  private calculateOverallRiskLevel(
    itilRisk: string,
    criticality: BusinessCriticality
  ): 'very_high' | 'high' | 'medium' | 'low' {
    if (itilRisk === 'very_high' || criticality === 'tier_0') return 'very_high';
    if (itilRisk === 'high' || criticality === 'tier_1') return 'high';
    if (itilRisk === 'medium' || criticality === 'tier_2') return 'medium';
    return 'low';
  }

  /**
   * Determine approval requirements
   * @private
   */
  private determineApprovalRequirements(itilRisk: any, businessImpact: any, costEstimate: any): ApprovalRequirements {
    return {
      cabApproval: itilRisk.requiresCABApproval,
      businessOwnerApproval: businessImpact.criticality <= 'tier_2',
      technicalOwnerApproval: true,
      executiveApproval: businessImpact.criticality === 'tier_0',
      financeApproval: costEstimate.totalCost > 50000,
      securityApproval: businessImpact.complianceImpact !== 'none',
      complianceApproval: businessImpact.complianceFrameworks.length > 0,
      approvers: [],
      approvalDeadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      estimatedApprovalDuration: this.estimateApprovalDuration(businessImpact.criticality),
      approvalReasons: this.getApprovalReasons(itilRisk, businessImpact, costEstimate)
    };
  }

  /**
   * Estimate approval duration in hours
   * @private
   */
  private estimateApprovalDuration(criticality: BusinessCriticality): number {
    switch (criticality) {
      case 'tier_0': return 4;
      case 'tier_1': return 24;
      case 'tier_2': return 48;
      default: return 72;
    }
  }

  /**
   * Get approval reasons
   * @private
   */
  private getApprovalReasons(itilRisk: any, businessImpact: any, costEstimate: any): string[] {
    const reasons = [];

    if (itilRisk.requiresCABApproval) {
      reasons.push(`High ITIL risk score: ${itilRisk.overallRiskScore}`);
    }

    if (businessImpact.criticality === 'tier_0') {
      reasons.push('Affects business-stopping service');
    }

    if (costEstimate.totalCost > 50000) {
      reasons.push(`High cost: $${costEstimate.totalCost.toLocaleString()}`);
    }

    if (businessImpact.complianceFrameworks.length > 0) {
      reasons.push(`Compliance scope: ${businessImpact.complianceFrameworks.join(', ')}`);
    }

    return reasons;
  }

  /**
   * Generate change recommendations
   * @private
   */
  private generateChangeRecommendations(itilRisk: any, businessImpact: any, costEstimate: any): string[] {
    const recommendations = [...itilRisk.recommendations];

    if (businessImpact.criticality === 'tier_0') {
      recommendations.push('Consider maintenance window during lowest traffic period');
      recommendations.push('Ensure executive leadership is aware and available');
    }

    if (costEstimate.confidence === 'low') {
      recommendations.push('Conduct detailed cost analysis before approval');
    }

    if (businessImpact.customerFacing) {
      recommendations.push('Prepare customer communication plan');
      recommendations.push('Schedule status page updates');
    }

    return recommendations;
  }

  /**
   * Determine optimal change window
   * @private
   */
  private determineOptimalChangeWindow(change: ChangeRequest, businessImpact: any): {
    start: Date;
    end: Date;
    reason: string;
  } | undefined {
    // For customer-facing services, recommend off-peak hours
    if (businessImpact.customerFacing) {
      const start = new Date(change.plannedStart);
      start.setHours(2, 0, 0, 0); // 2 AM

      const end = new Date(start);
      end.setHours(6, 0, 0, 0); // 6 AM

      return {
        start,
        end,
        reason: 'Low traffic period (2 AM - 6 AM) minimizes customer impact'
      };
    }

    return undefined;
  }

  /**
   * Generate health trends
   * @private
   */
  private generateHealthTrends(currentHealth: number, currentAvailability: number): Array<{
    date: string;
    healthScore: number;
    availability: number;
  }> {
    const trends = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);

      trends.push({
        date: date.toISOString().substring(0, 10),
        healthScore: currentHealth + (Math.random() - 0.5) * 10,
        availability: currentAvailability + (Math.random() - 0.5) * 2
      });
    }
    return trends;
  }

  /**
   * Generate alerts based on service metrics
   * @private
   */
  private generateAlerts(service: CompleteServiceView): Array<{
    severity: 'critical' | 'warning' | 'info';
    message: string;
    timestamp: Date;
  }> {
    const alerts = [];

    if (service.kpis.serviceHealth < 70) {
      alerts.push({
        severity: 'critical',
        message: `Service health is low: ${service.kpis.serviceHealth.toFixed(1)}/100`,
        timestamp: new Date()
      });
    }

    if (service.itil.openIncidents > 5) {
      alerts.push({
        severity: 'warning',
        message: `High number of open incidents: ${service.itil.openIncidents}`,
        timestamp: new Date()
      });
    }

    if (service.tbm.budgetVariance < 0) {
      alerts.push({
        severity: 'warning',
        message: `Over budget by $${Math.abs(service.tbm.budgetVariance).toLocaleString()}`,
        timestamp: new Date()
      });
    }

    if (service.kpis.availability < 99.9) {
      alerts.push({
        severity: 'warning',
        message: `Availability below SLA: ${service.kpis.availability.toFixed(2)}%`,
        timestamp: new Date()
      });
    }

    return alerts;
  }
}
