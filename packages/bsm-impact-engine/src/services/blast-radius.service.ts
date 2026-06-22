// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Blast Radius Service
 * Analyzes impact radius when a CI fails or changes
 */

import { getNeo4jClient } from '@cmdb/database';
import { BlastRadiusAnalysis, BlastRadiusOptions } from '../types/impact-types';
import { getGraphTraversal } from '../utils/graph-traversal';
import { getRevenueImpactCalculator } from '../calculators/revenue-impact-calculator';
import { getUserImpactCalculator } from '../calculators/user-impact-calculator';
import { BusinessService } from '@cmdb/unified-model';

/**
 * Blast Radius Service
 * Performs comprehensive impact analysis to determine what would be affected
 * if a specific CI fails or is taken offline
 *
 * Performance Target: <5 minutes for 100K+ CI graphs
 */
export class BlastRadiusService {
  private graphTraversal = getGraphTraversal();
  private revenueCalculator = getRevenueImpactCalculator();
  private userCalculator = getUserImpactCalculator();

  /**
   * Analyze blast radius for a CI
   * Returns all impacted CIs and business services
   *
   * @param ciId - Source CI identifier
   * @param options - Analysis options
   * @returns Complete blast radius analysis
   */
  async analyzeBlastRadius(
    ciId: string,
    options?: BlastRadiusOptions
  ): Promise<BlastRadiusAnalysis> {
    const startTime = Date.now();

    try {
      // Fetch source CI details
      const sourceCI = await this.getSourceCI(ciId);

      if (!sourceCI) {
        throw new Error(`CI not found: ${ciId}`);
      }

      // Find all impacted CIs (downstream dependencies that rely on this CI)
      console.log(`Finding blast radius for CI ${ciId}...`);
      const impactedCIs = await this.graphTraversal.findBlastRadius(ciId, options);

      console.log(`Found ${impactedCIs.length} impacted CIs`);

      // Find all impacted business services
      console.log(`Finding impacted business services...`);
      const impactedServices = await this.graphTraversal.findUpstreamBusinessServices(ciId);

      console.log(`Found ${impactedServices.length} impacted business services`);

      // Calculate aggregate metrics
      const totalRevenueAtRisk = impactedServices.reduce(
        (sum, service) => sum + service.annualRevenue,
        0
      );

      const totalCustomersImpacted = impactedServices.reduce(
        (sum, service) => sum + service.customerCount,
        0
      );

      // Calculate estimated downtime cost per hour
      const estimatedDowntimeCostPerHour = await this.calculateDowntimeCostPerHour(
        impactedServices
      );

      // Calculate maximum hops traversed
      const maxHopsInCIs = impactedCIs.length > 0 ? Math.max(...impactedCIs.map((ci) => ci.hops)) : 0;
      const maxHopsInServices = impactedServices.length > 0 ? Math.max(...impactedServices.map((s) => s.hops)) : 0;
      const maxHopsTraversed = Math.max(maxHopsInCIs, maxHopsInServices);

      const analysisTime = Date.now() - startTime;

      const analysis: BlastRadiusAnalysis = {
        sourceCI: ciId,
        sourceCIName: sourceCI.name,
        sourceCIType: sourceCI.type,
        impactedCIs,
        impactedBusinessServices: impactedServices,
        totalCIsImpacted: impactedCIs.length,
        totalServicesImpacted: impactedServices.length,
        totalRevenueAtRisk,
        totalCustomersImpacted,
        estimatedDowntimeCostPerHour,
        maxHopsTraversed,
        analysisTime,
        analysisDate: new Date(),
      };

      console.log(
        `Blast radius analysis completed in ${analysisTime}ms: ${impactedCIs.length} CIs, ${impactedServices.length} services impacted`
      );

      return analysis;
    } catch (error) {
      const analysisTime = Date.now() - startTime;
      console.error(`Blast radius analysis failed after ${analysisTime}ms:`, error);
      throw new Error(`Failed to analyze blast radius for ${ciId}: ${error}`);
    }
  }

  /**
   * Get source CI details from Neo4j
   *
   * @param ciId - CI identifier
   * @returns CI details or null
   */
  private async getSourceCI(
    ciId: string
  ): Promise<{ id: string; name: string; type: string } | null> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      const query = `
        MATCH (ci:CI {id: $ciId})
        RETURN ci.id as id, ci.name as name, ci.type as type
        LIMIT 1
      `;

      const result = await session.run(query, { ciId });

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      return {
        id: record.get('id'),
        name: record.get('name'),
        type: record.get('type'),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate estimated downtime cost per hour across all impacted services
   *
   * @param impactedServices - Array of impacted business services
   * @returns Total downtime cost per hour in USD
   */
  private async calculateDowntimeCostPerHour(
    impactedServices: Array<{
      serviceId: string;
      serviceName: string;
      annualRevenue: number;
      customerCount: number;
      criticality: string;
    }>
  ): Promise<number> {
    let totalCostPerHour = 0;

    // Fetch full business service objects to calculate downtime costs
    for (const impactedService of impactedServices) {
      try {
        const businessService = await this.getBusinessService(impactedService.serviceId);

        if (businessService) {
          const hourlyCost = this.revenueCalculator.calculateHourlyCost(businessService);
          totalCostPerHour += hourlyCost;
        }
      } catch (error) {
        console.error(
          `Error calculating downtime cost for service ${impactedService.serviceId}:`,
          error
        );
        // Continue with other services
      }
    }

    return Math.round(totalCostPerHour * 100) / 100;
  }

  /**
   * Get full business service object from Neo4j
   *
   * @param serviceId - Business service identifier
   * @returns Business service or null
   */
  private async getBusinessService(serviceId: string): Promise<BusinessService | null> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      const query = `
        MATCH (bs:BusinessService {id: $serviceId})
        RETURN bs
        LIMIT 1
      `;

      const result = await session.run(query, { serviceId });

      if (result.records.length === 0) {
        return null;
      }

      const record = result.records[0];
      const bsNode = record.get('bs').properties;

      // Convert Neo4j node to BusinessService object
      // This is a simplified conversion - in production, use proper mapping
      return bsNode as any;
    } finally {
      await session.close();
    }
  }

  /**
   * Analyze blast radius for multiple CIs
   * Useful for scenario planning (e.g., "what if these 3 servers fail?")
   *
   * @param ciIds - Array of CI identifiers
   * @param options - Analysis options
   * @returns Aggregated blast radius analysis
   */
  async analyzeMultipleCIBlastRadius(
    ciIds: string[],
    options?: BlastRadiusOptions
  ): Promise<BlastRadiusAnalysis> {
    const startTime = Date.now();

    // Analyze each CI individually
    const individualAnalyses = await Promise.all(
      ciIds.map((ciId) => this.analyzeBlastRadius(ciId, options))
    );

    // Aggregate results
    const allImpactedCIs = new Map();
    const allImpactedServices = new Map();

    for (const analysis of individualAnalyses) {
      // Merge impacted CIs (deduplicate)
      for (const ci of analysis.impactedCIs) {
        if (!allImpactedCIs.has(ci.ciId)) {
          allImpactedCIs.set(ci.ciId, ci);
        }
      }

      // Merge impacted services (deduplicate)
      for (const service of analysis.impactedBusinessServices) {
        if (!allImpactedServices.has(service.serviceId)) {
          allImpactedServices.set(service.serviceId, service);
        }
      }
    }

    // Calculate aggregate metrics
    const impactedServices = Array.from(allImpactedServices.values());
    const totalRevenueAtRisk = impactedServices.reduce(
      (sum, service) => sum + service.annualRevenue,
      0
    );
    const totalCustomersImpacted = impactedServices.reduce(
      (sum, service) => sum + service.customerCount,
      0
    );

    const estimatedDowntimeCostPerHour = await this.calculateDowntimeCostPerHour(impactedServices);

    const maxHopsTraversed = individualAnalyses.reduce(
      (max, analysis) => Math.max(max, analysis.maxHopsTraversed),
      0
    );

    const analysisTime = Date.now() - startTime;

    const aggregateAnalysis: BlastRadiusAnalysis = {
      sourceCI: ciIds.join(', '),
      sourceCIName: `Multiple CIs (${ciIds.length})`,
      sourceCIType: 'multiple',
      impactedCIs: Array.from(allImpactedCIs.values()),
      impactedBusinessServices: impactedServices,
      totalCIsImpacted: allImpactedCIs.size,
      totalServicesImpacted: impactedServices.length,
      totalRevenueAtRisk,
      totalCustomersImpacted,
      estimatedDowntimeCostPerHour,
      maxHopsTraversed,
      analysisTime,
      analysisDate: new Date(),
    };

    return aggregateAnalysis;
  }

  /**
   * Generate blast radius report
   * Human-readable summary of the impact analysis
   *
   * @param analysis - Blast radius analysis
   * @returns Report text
   */
  generateBlastRadiusReport(analysis: BlastRadiusAnalysis): string {
    const lines: string[] = [];

    lines.push('=== BLAST RADIUS ANALYSIS REPORT ===');
    lines.push('');
    lines.push(`Source CI: ${analysis.sourceCIName} (${analysis.sourceCIType})`);
    lines.push(`Analysis Date: ${analysis.analysisDate.toISOString()}`);
    lines.push(`Analysis Time: ${analysis.analysisTime}ms`);
    lines.push('');

    lines.push('--- IMPACT SUMMARY ---');
    lines.push(`Total CIs Impacted: ${analysis.totalCIsImpacted}`);
    lines.push(`Total Business Services Impacted: ${analysis.totalServicesImpacted}`);
    lines.push(`Maximum Graph Depth: ${analysis.maxHopsTraversed} hops`);
    lines.push('');

    lines.push('--- FINANCIAL IMPACT ---');
    lines.push(
      `Total Revenue at Risk: $${(analysis.totalRevenueAtRisk / 1_000_000).toFixed(2)}M annually`
    );
    lines.push(
      `Estimated Downtime Cost: $${analysis.estimatedDowntimeCostPerHour.toLocaleString()}/hour`
    );
    lines.push(`Total Customers Impacted: ${analysis.totalCustomersImpacted.toLocaleString()}`);
    lines.push('');

    if (analysis.impactedBusinessServices.length > 0) {
      lines.push('--- TOP IMPACTED BUSINESS SERVICES ---');

      // Sort by annual revenue (descending)
      const topServices = [...analysis.impactedBusinessServices]
        .sort((a, b) => b.annualRevenue - a.annualRevenue)
        .slice(0, 10);

      for (const service of topServices) {
        lines.push(
          `  - ${service.serviceName} (${service.criticality}): $${(service.annualRevenue / 1_000_000).toFixed(1)}M, ${service.customerCount.toLocaleString()} customers`
        );
      }
      lines.push('');
    }

    if (analysis.impactedCIs.length > 0) {
      lines.push('--- CRITICAL IMPACTED CIs ---');

      // Show CIs with criticality tier_0 or tier_1
      const criticalCIs = analysis.impactedCIs
        .filter((ci) => ci.criticality === 'tier_0' || ci.criticality === 'tier_1')
        .slice(0, 10);

      if (criticalCIs.length > 0) {
        for (const ci of criticalCIs) {
          lines.push(`  - ${ci.ciName} (${ci.ciType}) - ${ci.criticality} - ${ci.hops} hops`);
        }
      } else {
        lines.push('  No critical CIs in blast radius');
      }
      lines.push('');
    }

    lines.push('--- RECOMMENDATIONS ---');

    if (analysis.totalServicesImpacted > 10) {
      lines.push('  ! HIGH IMPACT: This CI affects many business services');
      lines.push('  - Consider implementing redundancy and failover mechanisms');
      lines.push('  - Ensure comprehensive monitoring and alerting');
    }

    if (analysis.estimatedDowntimeCostPerHour > 100000) {
      lines.push(
        `  ! HIGH COST: Downtime cost exceeds $${(analysis.estimatedDowntimeCostPerHour / 1000).toFixed(0)}K/hour`
      );
      lines.push('  - Implement disaster recovery plan');
      lines.push('  - Consider active-active configuration');
    }

    if (analysis.totalCustomersImpacted > 100000) {
      lines.push('  ! HIGH USER IMPACT: Over 100K customers affected');
      lines.push('  - Prepare customer communication plan');
      lines.push('  - Ensure support team is staffed appropriately');
    }

    lines.push('');
    lines.push('=== END OF REPORT ===');

    return lines.join('\n');
  }

  /**
   * Find single points of failure
   * Identifies CIs that have no redundancy (if they fail, services go down)
   *
   * @param businessServiceId - Business service to analyze
   * @returns Array of single point of failure CIs
   */
  async findSinglePointsOfFailure(businessServiceId: string): Promise<
    Array<{
      ciId: string;
      ciName: string;
      ciType: string;
      criticalityReason: string;
    }>
  > {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      // Find CIs where there's only one path to the business service
      // These are single points of failure
      const query = `
        MATCH path = (bs:BusinessService {id: $businessServiceId})-[*1..10]->(ci:CI)
        WHERE bs.id = $businessServiceId
        WITH ci, count(DISTINCT path) as pathCount
        WHERE pathCount = 1
        RETURN ci.id as ciId,
               ci.name as ciName,
               ci.type as ciType,
               'Only one dependency path to business service' as reason
        LIMIT 100
      `;

      const result = await session.run(query, { businessServiceId });

      return result.records.map((record) => ({
        ciId: record.get('ciId'),
        ciName: record.get('ciName'),
        ciType: record.get('ciType'),
        criticalityReason: record.get('reason'),
      }));
    } finally {
      await session.close();
    }
  }
}

/**
 * Singleton instance
 */
let blastRadiusInstance: BlastRadiusService | null = null;

/**
 * Get Blast Radius Service instance (singleton)
 */
export function getBlastRadiusService(): BlastRadiusService {
  if (!blastRadiusInstance) {
    blastRadiusInstance = new BlastRadiusService();
  }
  return blastRadiusInstance;
}
