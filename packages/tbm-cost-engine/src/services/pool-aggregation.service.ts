// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pool Aggregation Service
 * Aggregates costs from CIs up through the hierarchy to Business Capabilities
 */

import { Neo4jClient, getNeo4jClient } from '@cmdb/database';
import {
  CostAggregationResult,
  TBMResourceTower,
  TBMCostPool
} from '../types/tbm-types';

/** Default owned set: a business service is refused unless the caller passes its organization's ids. */
const NO_OWNED_SERVICES: ReadonlySet<string> = new Set();

/**
 * Pool Aggregation Service
 * Singleton service for aggregating costs through the graph hierarchy
 */
export class PoolAggregationService {
  private static instance: PoolAggregationService;
  private neo4jClient: Neo4jClient;

  private constructor() {
    this.neo4jClient = getNeo4jClient();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): PoolAggregationService {
    if (!PoolAggregationService.instance) {
      PoolAggregationService.instance = new PoolAggregationService();
    }
    return PoolAggregationService.instance;
  }

  /**
   * Aggregate costs for an Application Service
   *
   * @param applicationServiceId - Application Service ID
   * @returns Cost aggregation result
   *
   * @example
   * ```typescript
   * const service = PoolAggregationService.getInstance();
   * const result = await service.aggregateApplicationServiceCosts('app-svc-001');
   * console.log(result.totalMonthlyCost);
   * console.log(result.costByTower);
   * ```
   */
  public async aggregateApplicationServiceCosts(
    applicationServiceId: string
  ): Promise<CostAggregationResult> {
    const session = this.neo4jClient.getSession();

    try {
      // Query to find all CIs that support this application service
      const query = `
        MATCH (svc:ApplicationService {id: $serviceId})
        MATCH (ci:CI)-[:SUPPORTS]->(svc)
        RETURN
          ci.id AS ciId,
          ci.name AS ciName,
          ci.type AS ciType,
          ci.tbm_resource_tower AS tower,
          ci.tbm_cost_pool AS costPool,
          ci.tbm_monthly_cost AS monthlyCost
      `;

      const result = await session.run(query, { serviceId: applicationServiceId });

      // Aggregate costs
      const costByTower: Record<TBMResourceTower, number> = {} as Record<TBMResourceTower, number>;
      const costByPool: Record<TBMCostPool, number> = {} as Record<TBMCostPool, number>;
      const contributingCIs: Array<{
        ciId: string;
        ciName: string;
        cost: number;
        percentage: number;
      }> = [];

      let totalMonthlyCost = 0;

      for (const record of result.records) {
        const ciId = record.get('ciId');
        const ciName = record.get('ciName');
        const tower = record.get('tower') as TBMResourceTower;
        const costPool = record.get('costPool') as TBMCostPool;
        const monthlyCost = parseFloat(record.get('monthlyCost') || 0);

        totalMonthlyCost += monthlyCost;

        // Aggregate by tower
        if (!costByTower[tower]) {
          costByTower[tower] = 0;
        }
        costByTower[tower] += monthlyCost;

        // Aggregate by pool
        if (!costByPool[costPool]) {
          costByPool[costPool] = 0;
        }
        costByPool[costPool] += monthlyCost;

        contributingCIs.push({
          ciId,
          ciName,
          cost: monthlyCost,
          percentage: 0 // Will calculate after we have total
        });
      }

      // Calculate percentages
      for (const ci of contributingCIs) {
        ci.percentage = totalMonthlyCost > 0 ? (ci.cost / totalMonthlyCost) * 100 : 0;
        ci.percentage = this.roundToDecimal(ci.percentage, 2);
      }

      // Sort by cost descending
      contributingCIs.sort((a, b) => b.cost - a.cost);

      // Get application service name
      const nameQuery = `
        MATCH (svc:ApplicationService {id: $serviceId})
        RETURN svc.name AS name
      `;
      const nameResult = await session.run(nameQuery, { serviceId: applicationServiceId });
      const serviceName = nameResult.records[0]?.get('name') || applicationServiceId;

      return {
        entityId: applicationServiceId,
        entityType: 'application_service',
        entityName: serviceName,
        totalMonthlyCost: this.roundToCents(totalMonthlyCost),
        costByTower,
        costByPool,
        contributingCIs,
        timestamp: new Date()
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Aggregate costs for a Business Service
   *
   * Neo4j :BusinessService nodes carry no organization; Postgres
   * dim_business_services.organization_id is the tenant authority (FD-2).
   * The caller passes the ids its organization owns there, and an id outside
   * that set is refused before any Cypher runs.
   *
   * @param businessServiceId - Business Service ID
   * @param ownedServiceIds - Business service ids the caller's organization owns
   * @returns Cost aggregation result
   * @throws Error('Business service not found') when the id is not owned
   */
  public async aggregateBusinessServiceCosts(
    businessServiceId: string,
    ownedServiceIds: ReadonlySet<string>
  ): Promise<CostAggregationResult> {
    if (!ownedServiceIds.has(businessServiceId)) {
      throw new Error('Business service not found');
    }

    const session = this.neo4jClient.getSession();

    try {
      // Query to find all CIs and Application Services that support this business service
      const query = `
        MATCH (bs:BusinessService {id: $serviceId})
        OPTIONAL MATCH (ci:CI)-[:SUPPORTS*1..2]->(bs)
        OPTIONAL MATCH (appSvc:ApplicationService)-[:SUPPORTS]->(bs)
        WITH bs, ci, appSvc
        MATCH (allCis:CI) WHERE allCis.id = ci.id OR allCis.id IN [(appSvc)<-[:SUPPORTS]-(c:CI) | c.id]
        RETURN DISTINCT
          allCis.id AS ciId,
          allCis.name AS ciName,
          allCis.type AS ciType,
          allCis.tbm_resource_tower AS tower,
          allCis.tbm_cost_pool AS costPool,
          allCis.tbm_monthly_cost AS monthlyCost
      `;

      const result = await session.run(query, { serviceId: businessServiceId });

      const costByTower: Record<TBMResourceTower, number> = {} as Record<TBMResourceTower, number>;
      const costByPool: Record<TBMCostPool, number> = {} as Record<TBMCostPool, number>;
      const contributingCIs: Array<{
        ciId: string;
        ciName: string;
        cost: number;
        percentage: number;
      }> = [];

      let totalMonthlyCost = 0;

      for (const record of result.records) {
        const ciId = record.get('ciId');
        const ciName = record.get('ciName');
        const tower = record.get('tower') as TBMResourceTower;
        const costPool = record.get('costPool') as TBMCostPool;
        const monthlyCost = parseFloat(record.get('monthlyCost') || 0);

        totalMonthlyCost += monthlyCost;

        if (!costByTower[tower]) {
          costByTower[tower] = 0;
        }
        costByTower[tower] += monthlyCost;

        if (!costByPool[costPool]) {
          costByPool[costPool] = 0;
        }
        costByPool[costPool] += monthlyCost;

        contributingCIs.push({
          ciId,
          ciName,
          cost: monthlyCost,
          percentage: 0
        });
      }

      // Calculate percentages
      for (const ci of contributingCIs) {
        ci.percentage = totalMonthlyCost > 0 ? (ci.cost / totalMonthlyCost) * 100 : 0;
        ci.percentage = this.roundToDecimal(ci.percentage, 2);
      }

      contributingCIs.sort((a, b) => b.cost - a.cost);

      // Get business service name
      const nameQuery = `
        MATCH (bs:BusinessService {id: $serviceId})
        RETURN bs.name AS name
      `;
      const nameResult = await session.run(nameQuery, { serviceId: businessServiceId });
      const serviceName = nameResult.records[0]?.get('name') || businessServiceId;

      return {
        entityId: businessServiceId,
        entityType: 'business_service',
        entityName: serviceName,
        totalMonthlyCost: this.roundToCents(totalMonthlyCost),
        costByTower,
        costByPool,
        contributingCIs,
        timestamp: new Date()
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Aggregate costs for a Business Capability
   *
   * @param businessCapabilityId - Business Capability ID
   * @returns Cost aggregation result
   */
  public async aggregateBusinessCapabilityCosts(
    businessCapabilityId: string
  ): Promise<CostAggregationResult> {
    const session = this.neo4jClient.getSession();

    try {
      // Query to find all CIs that roll up to this business capability
      const query = `
        MATCH (bc:BusinessCapability {id: $capabilityId})
        MATCH (ci:CI)-[:SUPPORTS|ENABLES*1..3]->(bc)
        RETURN DISTINCT
          ci.id AS ciId,
          ci.name AS ciName,
          ci.type AS ciType,
          ci.tbm_resource_tower AS tower,
          ci.tbm_cost_pool AS costPool,
          ci.tbm_monthly_cost AS monthlyCost
      `;

      const result = await session.run(query, { capabilityId: businessCapabilityId });

      const costByTower: Record<TBMResourceTower, number> = {} as Record<TBMResourceTower, number>;
      const costByPool: Record<TBMCostPool, number> = {} as Record<TBMCostPool, number>;
      const contributingCIs: Array<{
        ciId: string;
        ciName: string;
        cost: number;
        percentage: number;
      }> = [];

      let totalMonthlyCost = 0;

      for (const record of result.records) {
        const ciId = record.get('ciId');
        const ciName = record.get('ciName');
        const tower = record.get('tower') as TBMResourceTower;
        const costPool = record.get('costPool') as TBMCostPool;
        const monthlyCost = parseFloat(record.get('monthlyCost') || 0);

        totalMonthlyCost += monthlyCost;

        if (!costByTower[tower]) {
          costByTower[tower] = 0;
        }
        costByTower[tower] += monthlyCost;

        if (!costByPool[costPool]) {
          costByPool[costPool] = 0;
        }
        costByPool[costPool] += monthlyCost;

        contributingCIs.push({
          ciId,
          ciName,
          cost: monthlyCost,
          percentage: 0
        });
      }

      // Calculate percentages
      for (const ci of contributingCIs) {
        ci.percentage = totalMonthlyCost > 0 ? (ci.cost / totalMonthlyCost) * 100 : 0;
        ci.percentage = this.roundToDecimal(ci.percentage, 2);
      }

      contributingCIs.sort((a, b) => b.cost - a.cost);

      // Get business capability name
      const nameQuery = `
        MATCH (bc:BusinessCapability {id: $capabilityId})
        RETURN bc.name AS name
      `;
      const nameResult = await session.run(nameQuery, { capabilityId: businessCapabilityId });
      const capabilityName = nameResult.records[0]?.get('name') || businessCapabilityId;

      return {
        entityId: businessCapabilityId,
        entityType: 'business_capability',
        entityName: capabilityName,
        totalMonthlyCost: this.roundToCents(totalMonthlyCost),
        costByTower,
        costByPool,
        contributingCIs,
        timestamp: new Date()
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get cost breakdown by tower for an entity
   *
   * @param entityId - Entity ID
   * @param entityType - Entity type
   * @param ownedServiceIds - For 'business_service': ids the caller's organization owns (default none: refused)
   * @returns Cost breakdown by tower
   */
  public async getCostBreakdownByTower(
    entityId: string,
    entityType: 'application_service' | 'business_service' | 'business_capability',
    ownedServiceIds: ReadonlySet<string> = NO_OWNED_SERVICES
  ): Promise<Record<TBMResourceTower, number>> {
    let result: CostAggregationResult;

    switch (entityType) {
      case 'application_service':
        result = await this.aggregateApplicationServiceCosts(entityId);
        break;
      case 'business_service':
        result = await this.aggregateBusinessServiceCosts(entityId, ownedServiceIds);
        break;
      case 'business_capability':
        result = await this.aggregateBusinessCapabilityCosts(entityId);
        break;
    }

    return result.costByTower;
  }

  /**
   * Get cost breakdown by pool for an entity
   *
   * @param entityId - Entity ID
   * @param entityType - Entity type
   * @param ownedServiceIds - For 'business_service': ids the caller's organization owns (default none: refused)
   * @returns Cost breakdown by pool
   */
  public async getCostBreakdownByPool(
    entityId: string,
    entityType: 'application_service' | 'business_service' | 'business_capability',
    ownedServiceIds: ReadonlySet<string> = NO_OWNED_SERVICES
  ): Promise<Record<TBMCostPool, number>> {
    let result: CostAggregationResult;

    switch (entityType) {
      case 'application_service':
        result = await this.aggregateApplicationServiceCosts(entityId);
        break;
      case 'business_service':
        result = await this.aggregateBusinessServiceCosts(entityId, ownedServiceIds);
        break;
      case 'business_capability':
        result = await this.aggregateBusinessCapabilityCosts(entityId);
        break;
    }

    return result.costByPool;
  }

  /**
   * Get top cost contributors for an entity
   *
   * @param entityId - Entity ID
   * @param entityType - Entity type
   * @param limit - Number of top contributors to return
   * @param ownedServiceIds - For 'business_service': ids the caller's organization owns (default none: refused)
   * @returns Top cost contributors
   */
  public async getTopCostContributors(
    entityId: string,
    entityType: 'application_service' | 'business_service' | 'business_capability',
    limit: number = 10,
    ownedServiceIds: ReadonlySet<string> = NO_OWNED_SERVICES
  ): Promise<
    Array<{
      ciId: string;
      ciName: string;
      cost: number;
      percentage: number;
    }>
  > {
    let result: CostAggregationResult;

    switch (entityType) {
      case 'application_service':
        result = await this.aggregateApplicationServiceCosts(entityId);
        break;
      case 'business_service':
        result = await this.aggregateBusinessServiceCosts(entityId, ownedServiceIds);
        break;
      case 'business_capability':
        result = await this.aggregateBusinessCapabilityCosts(entityId);
        break;
    }

    return result.contributingCIs.slice(0, limit);
  }

  /**
   * Calculate cost allocation percentage for a CI
   *
   * @param ciId - CI ID
   * @param totalBudget - Total budget
   * @returns Allocation percentage
   */
  public async calculateAllocationPercentage(ciId: string, totalBudget: number): Promise<number> {
    const session = this.neo4jClient.getSession();

    try {
      const query = `
        MATCH (ci:CI {id: $ciId})
        RETURN ci.tbm_monthly_cost AS monthlyCost
      `;

      const result = await session.run(query, { ciId });

      if (result.records.length === 0) {
        return 0;
      }

      const monthlyCost = parseFloat(result.records[0].get('monthlyCost') || 0);
      return totalBudget > 0 ? (monthlyCost / totalBudget) * 100 : 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Helper: Round to cents
   */
  private roundToCents(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * Helper: Round to decimal places
   */
  private roundToDecimal(value: number, decimals: number): number {
    const multiplier = Math.pow(10, decimals);
    return Math.round(value * multiplier) / multiplier;
  }
}

/**
 * Get singleton instance
 */
export function getPoolAggregationService(): PoolAggregationService {
  return PoolAggregationService.getInstance();
}
