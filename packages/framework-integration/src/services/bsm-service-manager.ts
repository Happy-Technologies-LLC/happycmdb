// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * BSM Service Manager Wrapper
 * Wraps Phase 4 BSM functionality for unified interface
 *
 * NOTE: This is a placeholder implementation. Agent 11 is building the actual
 * BSM impact engine (@cmdb/bsm-impact-engine). Once that package is complete,
 * this wrapper should import and use those services.
 *
 * TODO: Replace placeholder implementation with actual BSM services:
 * - import { ImpactScoringService } from '@cmdb/bsm-impact-engine';
 * - import { CriticalityCalculator } from '@cmdb/bsm-impact-engine';
 * - import { BlastRadiusService } from '@cmdb/bsm-impact-engine';
 */

import { BusinessServiceRepository } from '@cmdb/itil-service-manager';
import { getPostgresClient, getNeo4jClient } from '@cmdb/database';
import { BusinessCriticality, RiskRating } from '@cmdb/unified-model';
import { BSMImpact } from '../types/kpi-types';
import { ImpactAnalysis, BlastRadiusAnalysis } from '../types/unified-types';

/**
 * BSM Service Manager
 * Provides BSM impact metrics and operations for unified interface
 *
 * PLACEHOLDER: This implementation uses mock data and simplified logic.
 * Replace with actual BSM services once @cmdb/bsm-impact-engine is complete.
 */
export class BSMServiceManager {
  private businessServiceRepo: BusinessServiceRepository;

  constructor() {
    const pgClient = getPostgresClient();
    this.businessServiceRepo = new BusinessServiceRepository(pgClient);
  }

  /**
   * Get comprehensive BSM impact metrics for a service
   *
   * @param serviceId - Business service ID
   * @returns BSM impact metrics including criticality, revenue, compliance
   */
  async getServiceImpact(serviceId: string): Promise<BSMImpact> {
    try {
      // Fetch business service
      const businessService = await this.businessServiceRepo.getBusinessServiceById(serviceId);
      if (!businessService) {
        throw new Error(`Business service not found: ${serviceId}`);
      }

      const bsmAttrs = businessService.bsm_attributes;

      // Calculate revenue at risk per hour
      const revenueAtRiskPerHour = bsmAttrs.annual_revenue_supported / 8760; // hours per year

      // Estimate customers impacted by outage (assuming full outage)
      const customersImpactedByOutage = bsmAttrs.customer_count;

      // Get compliance scope
      const complianceScope = bsmAttrs.compliance_requirements.map(req => req.framework);

      return {
        criticality: bsmAttrs.business_criticality,
        impactScore: bsmAttrs.business_impact_score,
        annualRevenue: bsmAttrs.annual_revenue_supported,
        customerCount: bsmAttrs.customer_count,
        userCount: this.estimateUserCount(bsmAttrs.customer_count),
        transactionVolume: bsmAttrs.transaction_volume_daily,
        complianceScope,
        riskLevel: bsmAttrs.risk_rating,
        customerFacing: this.isCustomerFacing(bsmAttrs.business_criticality),
        revenueAtRiskPerHour,
        customersImpactedByOutage,
        rto: bsmAttrs.recovery_time_objective,
        rpo: bsmAttrs.recovery_point_objective
      };
    } catch (error) {
      throw new Error(`Failed to get BSM impact for service ${serviceId}: ${error.message}`);
    }
  }

  /**
   * Calculate business impact for a CI
   *
   * PLACEHOLDER: Replace with actual ImpactScoringService once available
   *
   * @param ciId - Configuration item ID
   * @returns Impact analysis with revenue, customers, compliance
   */
  async calculateImpact(ciId: string): Promise<ImpactAnalysis> {
    try {
      // Get business services supported by this CI
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();

      try {
        const result = await session.run(
          `
          MATCH (ci:CI {_id: $ciId})
          MATCH (ci)-[:SUPPORTS|HOSTS*1..3]->(bs:BusinessService)
          RETURN DISTINCT bs._id as serviceId
          ORDER BY bs.business_criticality
          LIMIT 1
          `,
          { ciId }
        );

        if (result.records.length === 0) {
          // No business service found, return minimal impact
          return this.createMinimalImpact(ciId);
        }

        // Get the most critical business service
        const serviceId = result.records[0].get('serviceId');
        const businessService = await this.businessServiceRepo.getBusinessServiceById(serviceId);

        if (!businessService) {
          return this.createMinimalImpact(ciId);
        }

        const bsmAttrs = businessService.bsm_attributes;

        // Get dependent services
        const dependentResult = await session.run(
          `
          MATCH (bs:BusinessService {_id: $serviceId})
          MATCH (bs)-[:DEPENDS_ON]->(dep:BusinessService)
          RETURN dep._id as depServiceId, dep.name as depServiceName,
                 dep.business_criticality as depCriticality
          LIMIT 10
          `,
          { serviceId }
        );

        const dependentServices = dependentResult.records.map(record => ({
          serviceId: record.get('depServiceId'),
          serviceName: record.get('depServiceName'),
          criticality: record.get('depCriticality') as BusinessCriticality
        }));

        // Calculate compliance impact
        const complianceImpact = this.calculateComplianceImpact(
          bsmAttrs.compliance_requirements.map(r => r.framework)
        );

        return {
          serviceId: businessService.id,
          serviceName: businessService.name,
          criticality: bsmAttrs.business_criticality,
          impactScore: bsmAttrs.business_impact_score,
          annualRevenueAtRisk: bsmAttrs.annual_revenue_supported,
          revenueAtRiskPerHour: bsmAttrs.annual_revenue_supported / 8760,
          customersImpacted: bsmAttrs.customer_count,
          usersImpacted: this.estimateUserCount(bsmAttrs.customer_count),
          transactionsImpacted: bsmAttrs.transaction_volume_daily,
          customerFacing: this.isCustomerFacing(bsmAttrs.business_criticality),
          complianceFrameworks: bsmAttrs.compliance_requirements.map(r => r.framework),
          complianceImpact,
          riskRating: bsmAttrs.risk_rating,
          dependentServices
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      throw new Error(`Failed to calculate impact for CI ${ciId}: ${error.message}`);
    }
  }

  /**
   * Calculate blast radius for a CI or service
   *
   * PLACEHOLDER: Replace with actual BlastRadiusService once available
   *
   * @param ciId - CI or service ID
   * @returns Blast radius analysis with impacted services and CIs
   */
  async calculateBlastRadius(ciId: string): Promise<BlastRadiusAnalysis> {
    try {
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();

      try {
        // Find all downstream dependencies
        const result = await session.run(
          `
          MATCH (source {_id: $ciId})
          MATCH path = (source)-[*1..5]->(dependent)
          WHERE dependent:CI OR dependent:BusinessService
          RETURN DISTINCT
            dependent._id as id,
            dependent.name as name,
            labels(dependent)[0] as type,
            length(path) as depth
          ORDER BY depth
          LIMIT 100
          `,
          { ciId }
        );

        const impactedNodes = result.records.map(record => ({
          id: record.get('id'),
          name: record.get('name'),
          type: record.get('type'),
          depth: record.get('depth').toNumber()
        }));

        // Separate services from CIs
        const impactedServiceNodes = impactedNodes.filter(n => n.type === 'BusinessService');
        const impactedCINodes = impactedNodes.filter(n => n.type === 'CI');

        // Get service details
        const impactedServices = [];
        let totalCustomers = 0;
        let totalUsers = 0;
        let totalRevenue = 0;

        for (const node of impactedServiceNodes) {
          const service = await this.businessServiceRepo.getBusinessServiceById(node.id);
          if (service) {
            const customers = service.bsm_attributes.customer_count;
            const revenue = service.bsm_attributes.annual_revenue_supported;
            const users = this.estimateUserCount(customers);

            impactedServices.push({
              serviceId: service.id,
              serviceName: service.name,
              criticality: service.bsm_attributes.business_criticality,
              customers,
              users,
              revenue
            });

            totalCustomers += customers;
            totalUsers += users;
            totalRevenue += revenue;
          }
        }

        // Build impacted CIs list
        const impactedCIs = impactedCINodes.map(node => ({
          ciId: node.id,
          ciName: node.name,
          ciType: 'unknown', // Would need to query CI details
          dependencyDepth: node.depth
        }));

        // Get source details
        const sourceResult = await session.run(
          `
          MATCH (source {_id: $ciId})
          RETURN source._id as id, source.name as name
          `,
          { ciId }
        );

        const sourceId = sourceResult.records[0].get('id');
        const sourceName = sourceResult.records[0].get('name');

        // Build visualization data
        const nodes = [
          { id: sourceId, name: sourceName, type: 'ci' as const, criticality: 'tier_2' as BusinessCriticality }
        ];
        const edges = [];

        for (const service of impactedServices) {
          nodes.push({
            id: service.serviceId,
            name: service.serviceName,
            type: 'service' as const,
            criticality: service.criticality
          });
          edges.push({
            from: sourceId,
            to: service.serviceId,
            relationship: 'SUPPORTS'
          });
        }

        const maxDepth = Math.max(...impactedNodes.map(n => n.depth), 0);

        return {
          sourceId,
          sourceName,
          totalCIsImpacted: impactedCIs.length,
          totalServicesImpacted: impactedServices.length,
          totalCustomersImpacted: totalCustomers,
          totalUsersImpacted: totalUsers,
          totalRevenueAtRisk: totalRevenue,
          impactedServices,
          impactedCIs,
          visualizationData: { nodes, edges },
          maxDependencyDepth: maxDepth,
          analyzedAt: new Date()
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      throw new Error(`Failed to calculate blast radius: ${error.message}`);
    }
  }

  /**
   * Create minimal impact for CIs with no business service
   * @private
   */
  private createMinimalImpact(ciId: string): ImpactAnalysis {
    return {
      serviceId: '',
      serviceName: 'No Business Service',
      criticality: 'tier_4',
      impactScore: 10,
      annualRevenueAtRisk: 0,
      revenueAtRiskPerHour: 0,
      customersImpacted: 0,
      usersImpacted: 0,
      transactionsImpacted: 0,
      customerFacing: false,
      complianceFrameworks: [],
      complianceImpact: 'none',
      riskRating: 'low',
      dependentServices: []
    };
  }

  /**
   * Estimate user count from customer count
   * @private
   */
  private estimateUserCount(customerCount: number): number {
    // Average 3 users per customer (for B2B services)
    return customerCount * 3;
  }

  /**
   * Determine if service is customer-facing based on criticality
   * @private
   */
  private isCustomerFacing(criticality: BusinessCriticality): boolean {
    return criticality === 'tier_0' || criticality === 'tier_1';
  }

  /**
   * Calculate compliance impact level
   * @private
   */
  private calculateComplianceImpact(frameworks: string[]): 'critical' | 'high' | 'medium' | 'low' | 'none' {
    if (frameworks.length === 0) return 'none';
    if (frameworks.includes('SOX') || frameworks.includes('PCI_DSS')) return 'critical';
    if (frameworks.includes('HIPAA') || frameworks.includes('GDPR')) return 'high';
    if (frameworks.includes('SOC2') || frameworks.includes('ISO27001')) return 'medium';
    return 'low';
  }
}
