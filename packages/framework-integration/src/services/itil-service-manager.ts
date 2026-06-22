// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ITIL Service Manager Wrapper
 * Wraps Phase 2 ITIL v4 functionality for unified interface
 */

import {
  IncidentPriorityService,
  ChangeRiskService,
  ConfigurationManagementService,
  BaselineService,
  IncidentRepository,
  ChangeRepository,
  BusinessServiceRepository,
  IncidentInput,
  IncidentPriority,
  ChangeRequest,
  ChangeRiskAssessment
} from '@cmdb/itil-service-manager';
import { getPostgresClient } from '@cmdb/database';
import { ITILMetrics } from '../types/kpi-types';

/**
 * ITIL Service Manager
 * Provides ITIL metrics and operations for unified interface
 */
export class ITILServiceManager {
  private priorityService: IncidentPriorityService;
  private changeRiskService: ChangeRiskService;
  private configMgmtService: ConfigurationManagementService;
  private baselineService: BaselineService;
  private incidentRepo: IncidentRepository;
  private changeRepo: ChangeRepository;
  private businessServiceRepo: BusinessServiceRepository;

  constructor() {
    const pgClient = getPostgresClient();

    this.priorityService = new IncidentPriorityService();
    this.changeRiskService = new ChangeRiskService();
    this.configMgmtService = new ConfigurationManagementService();
    this.baselineService = new BaselineService();
    this.incidentRepo = new IncidentRepository(pgClient);
    this.changeRepo = new ChangeRepository(pgClient);
    this.businessServiceRepo = new BusinessServiceRepository(pgClient);
  }

  /**
   * Get comprehensive ITIL metrics for a service
   *
   * @param serviceId - Business service ID
   * @returns ITIL metrics including incidents, changes, configuration, baselines
   */
  async getServiceMetrics(serviceId: string): Promise<ITILMetrics> {
    try {
      // Fetch business service
      const businessService = await this.businessServiceRepo.getBusinessServiceById(serviceId);
      if (!businessService) {
        throw new Error(`Business service not found: ${serviceId}`);
      }

      // Get incident metrics
      const incidents = await this.incidentRepo.getIncidentsByBusinessServiceId(serviceId);
      const openIncidents = incidents.filter(i =>
        ['new', 'assigned', 'in_progress', 'pending'].includes(i.status)
      ).length;

      const resolvedIncidents = incidents.filter(i => i.resolvedAt);
      const criticalIncidents = incidents.filter(i =>
        i.priority === 1 &&
        i.reportedAt >= new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      ).length;

      // Calculate average MTTR
      let totalResolutionTime = 0;
      let resolvedCount = 0;
      for (const incident of resolvedIncidents) {
        if (incident.timeToResolveMinutes) {
          totalResolutionTime += incident.timeToResolveMinutes;
          resolvedCount++;
        }
      }
      const averageMTTR = resolvedCount > 0 ? totalResolutionTime / resolvedCount : 0;

      // Get change metrics (last 30 days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const changes = await this.changeRepo.findByBusinessService(serviceId);
      const recentChanges = changes.filter(c => c.createdAt >= thirtyDaysAgo);
      const changesLast30Days = recentChanges.length;

      // Calculate change success rate
      const completedChanges = recentChanges.filter(c =>
        c.status === 'closed' && c.outcome
      );
      const successfulChanges = completedChanges.filter(c =>
        c.outcome === 'successful'
      ).length;
      const changeSuccessRate = completedChanges.length > 0
        ? successfulChanges / completedChanges.length
        : 1.0;

      // Get configuration accuracy
      const accuracyMetrics = await this.configMgmtService.getAccuracyMetrics();
      const configurationAccuracy = accuracyMetrics.accuracyPercentage / 100;

      // Get baseline metrics
      const baselineComparisons = await this.baselineService.getRecentComparisons(serviceId);
      const latestBaseline = baselineComparisons.length > 0
        ? baselineComparisons[0]
        : null;

      const baselinedCIs = latestBaseline ? latestBaseline.totalDriftCount : 0;
      const driftedCIs = latestBaseline ? latestBaseline.driftedCIs.length : 0;
      const baselineCompliance = latestBaseline ? latestBaseline.complianceScore : 100;

      // Get service availability (from ITIL attributes)
      const availability = businessService.itil_attributes.availability_30d / 100;

      // Get audit status
      const lastAuditDate = businessService.itil_attributes.last_audit_date || null;
      const auditStatus = businessService.itil_attributes.audit_status || 'unknown';

      return {
        serviceName: businessService.name,
        openIncidents,
        averageMTTR,
        changesLast30Days,
        changeSuccessRate,
        configurationAccuracy,
        availability,
        lastAuditDate,
        auditStatus: auditStatus as 'compliant' | 'non_compliant' | 'unknown',
        criticalIncidents,
        baselinedCIs,
        driftedCIs,
        baselineCompliance
      };
    } catch (error) {
      throw new Error(`Failed to get ITIL metrics for service ${serviceId}: ${error.message}`);
    }
  }

  /**
   * Calculate incident priority using ITIL framework
   *
   * @param incident - Incident input data
   * @returns Calculated incident priority with impact/urgency
   */
  async calculatePriority(incident: IncidentInput): Promise<IncidentPriority> {
    try {
      return await this.priorityService.calculatePriority(incident);
    } catch (error) {
      throw new Error(`Failed to calculate incident priority: ${error.message}`);
    }
  }

  /**
   * Assess change risk using ITIL framework
   *
   * @param change - Change request data
   * @returns Risk assessment with score, level, and recommendations
   */
  async assessChangeRisk(change: ChangeRequest): Promise<ChangeRiskAssessment> {
    try {
      return await this.changeRiskService.assessRisk(change);
    } catch (error) {
      throw new Error(`Failed to assess change risk: ${error.message}`);
    }
  }

  /**
   * Get service owner information
   *
   * @param serviceId - Business service ID
   * @returns Service owner details
   */
  async getServiceOwner(serviceId: string): Promise<{
    name: string;
    email: string;
    team: string;
  } | null> {
    try {
      const businessService = await this.businessServiceRepo.getBusinessServiceById(serviceId);
      if (!businessService) {
        return null;
      }

      return {
        name: businessService.itil_attributes.service_owner,
        email: businessService.itil_attributes.service_owner, // Assuming email format
        team: businessService.platform_team
      };
    } catch (error) {
      throw new Error(`Failed to get service owner: ${error.message}`);
    }
  }

  /**
   * Get SLA targets for a service
   *
   * @param serviceId - Business service ID
   * @returns SLA target definitions
   */
  async getSLATargets(serviceId: string): Promise<{
    availability: number;
    responseTime: number;
    resolutionTime: number;
  } | null> {
    try {
      const businessService = await this.businessServiceRepo.getBusinessServiceById(serviceId);
      if (!businessService) {
        return null;
      }

      const slaTargets = businessService.itil_attributes.sla_targets;

      return {
        availability: slaTargets.availability_percentage,
        responseTime: slaTargets.response_time_ms,
        resolutionTime: this.calculateTargetResolutionTime(businessService.bsm_attributes.business_criticality)
      };
    } catch (error) {
      throw new Error(`Failed to get SLA targets: ${error.message}`);
    }
  }

  /**
   * Calculate target resolution time based on criticality
   *
   * @param criticality - Business criticality tier
   * @returns Target resolution time in minutes
   * @private
   */
  private calculateTargetResolutionTime(criticality: string): number {
    switch (criticality) {
      case 'tier_0': return 60;    // 1 hour
      case 'tier_1': return 240;   // 4 hours
      case 'tier_2': return 480;   // 8 hours
      case 'tier_3': return 1440;  // 24 hours
      case 'tier_4': return 2880;  // 48 hours
      default: return 480;
    }
  }

  /**
   * Get recent incident history
   *
   * @param serviceId - Business service ID
   * @param days - Number of days to look back
   * @returns Recent incidents
   */
  async getRecentIncidents(serviceId: string, days: number = 30): Promise<Array<{
    id: string;
    title: string;
    priority: number;
    status: string;
    createdAt: Date;
    resolvedAt?: Date;
  }>> {
    try {
      const incidents = await this.incidentRepo.getIncidentsByBusinessServiceId(serviceId);
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      return incidents
        .filter(i => i.reportedAt >= cutoffDate)
        .map(i => ({
          id: i.id,
          title: i.title,
          priority: i.priority,
          status: i.status,
          createdAt: i.reportedAt,
          resolvedAt: i.resolvedAt
        }))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch (error) {
      throw new Error(`Failed to get recent incidents: ${error.message}`);
    }
  }

  /**
   * Get recent change history
   *
   * @param serviceId - Business service ID
   * @param days - Number of days to look back
   * @returns Recent changes
   */
  async getRecentChanges(serviceId: string, days: number = 30): Promise<Array<{
    id: string;
    title: string;
    changeType: string;
    status: string;
    scheduledStart: Date;
    outcome?: string;
  }>> {
    try {
      const changes = await this.changeRepo.findByBusinessService(serviceId);
      const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      return changes
        .filter(c => c.createdAt >= cutoffDate)
        .map(c => ({
          id: c.id,
          title: c.title,
          changeType: c.changeType,
          status: c.status,
          scheduledStart: c.scheduledStart || c.createdAt,
          outcome: c.outcome
        }))
        .sort((a, b) => b.scheduledStart.getTime() - a.scheduledStart.getTime());
    } catch (error) {
      throw new Error(`Failed to get recent changes: ${error.message}`);
    }
  }
}
