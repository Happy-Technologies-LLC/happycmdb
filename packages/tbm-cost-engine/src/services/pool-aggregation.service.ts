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

/**
 * The caller's tenancy for business-service reads. `ownedServiceIds` are the
 * business service ids the organization owns in Postgres
 * (dim_business_services.organization_id, FD-2); `organizationId` is the
 * caller's token organization, which each :BusinessService node must also
 * carry as `organization_id` (FD-16 c). A node with another organization's id,
 * or with none, contributes nothing even when its id is owned in Postgres.
 */
export interface BusinessServiceScope {
  readonly organizationId: string;
  readonly ownedServiceIds: ReadonlySet<string>;
}

/** Default scope: no owned ids, so every business service is refused and no capability path counts. */
const NO_SCOPE: BusinessServiceScope = { organizationId: '', ownedServiceIds: new Set() };

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
   * The id must be in the caller's owned set (refused before any Cypher runs)
   * and the :BusinessService node must carry the caller's organization_id; a
   * node with another organization's id, or none, is treated as missing.
   *
   * @param businessServiceId - Business Service ID
   * @param scope - The caller's organization and the business service ids it owns
   * @returns Cost aggregation result
   * @throws Error('Business service not found') when the id is not owned or the
   *   node is missing or not in the caller's organization
   */
  public async aggregateBusinessServiceCosts(
    businessServiceId: string,
    scope: BusinessServiceScope
  ): Promise<CostAggregationResult> {
    if (!scope.ownedServiceIds.has(businessServiceId)) {
      throw new Error('Business service not found');
    }

    const session = this.neo4jClient.getSession();
    const params = { serviceId: businessServiceId, organizationId: scope.organizationId };

    try {
      // The node must be in the caller's organization before any cost is read.
      const nameQuery = `
        MATCH (bs:BusinessService {id: $serviceId})
        WHERE bs.organization_id = $organizationId
        RETURN bs.name AS name
      `;
      const nameResult = await session.run(nameQuery, params);
      if (nameResult.records.length === 0) {
        throw new Error('Business service not found');
      }
      const serviceName = nameResult.records[0].get('name') || businessServiceId;

      // Query to find all CIs and Application Services that support this business service
      const query = `
        MATCH (bs:BusinessService {id: $serviceId})
        WHERE bs.organization_id = $organizationId
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

      const result = await session.run(query, params);

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
   * Only CI paths that pass through at least one :BusinessService are counted,
   * and every :BusinessService on the path must be both in the caller's owned
   * set (Postgres, FD-2) and carry the caller's organization_id (FD-16 c). A
   * path through a foreign or org-less service, or through no service, is not.
   *
   * @param businessCapabilityId - Business Capability ID
   * @param scope - The caller's organization and the business service ids it owns
   * @returns Cost aggregation result
   */
  public async aggregateBusinessCapabilityCosts(
    businessCapabilityId: string,
    scope: BusinessServiceScope
  ): Promise<CostAggregationResult> {
    const session = this.neo4jClient.getSession();

    try {
      // Query to find all CIs that roll up to this business capability through owned services
      const query = `
        MATCH (bc:BusinessCapability {id: $capabilityId})
        MATCH path = (ci:CI)-[:SUPPORTS|ENABLES*1..3]->(bc)
        WHERE any(n IN nodes(path) WHERE n:BusinessService)
          AND all(n IN nodes(path) WHERE NOT n:BusinessService OR n.id IN $ownedServiceIds)
          AND all(n IN nodes(path) WHERE NOT n:BusinessService OR n.organization_id = $organizationId)
        RETURN DISTINCT
          ci.id AS ciId,
          ci.name AS ciName,
          ci.type AS ciType,
          ci.tbm_resource_tower AS tower,
          ci.tbm_cost_pool AS costPool,
          ci.tbm_monthly_cost AS monthlyCost
      `;

      const result = await session.run(query, {
        capabilityId: businessCapabilityId,
        ownedServiceIds: [...scope.ownedServiceIds],
        organizationId: scope.organizationId
      });

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
   * @param scope - For 'business_service' and 'business_capability': the caller's organization and owned ids (default none)
   * @returns Cost breakdown by tower
   */
  public async getCostBreakdownByTower(
    entityId: string,
    entityType: 'application_service' | 'business_service' | 'business_capability',
    scope: BusinessServiceScope = NO_SCOPE
  ): Promise<Record<TBMResourceTower, number>> {
    let result: CostAggregationResult;

    switch (entityType) {
      case 'application_service':
        result = await this.aggregateApplicationServiceCosts(entityId);
        break;
      case 'business_service':
        result = await this.aggregateBusinessServiceCosts(entityId, scope);
        break;
      case 'business_capability':
        result = await this.aggregateBusinessCapabilityCosts(entityId, scope);
        break;
    }

    return result.costByTower;
  }

  /**
   * Get cost breakdown by pool for an entity
   *
   * @param entityId - Entity ID
   * @param entityType - Entity type
   * @param scope - For 'business_service' and 'business_capability': the caller's organization and owned ids (default none)
   * @returns Cost breakdown by pool
   */
  public async getCostBreakdownByPool(
    entityId: string,
    entityType: 'application_service' | 'business_service' | 'business_capability',
    scope: BusinessServiceScope = NO_SCOPE
  ): Promise<Record<TBMCostPool, number>> {
    let result: CostAggregationResult;

    switch (entityType) {
      case 'application_service':
        result = await this.aggregateApplicationServiceCosts(entityId);
        break;
      case 'business_service':
        result = await this.aggregateBusinessServiceCosts(entityId, scope);
        break;
      case 'business_capability':
        result = await this.aggregateBusinessCapabilityCosts(entityId, scope);
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
   * @param scope - For 'business_service' and 'business_capability': the caller's organization and owned ids (default none)
   * @returns Top cost contributors
   */
  public async getTopCostContributors(
    entityId: string,
    entityType: 'application_service' | 'business_service' | 'business_capability',
    limit: number = 10,
    scope: BusinessServiceScope = NO_SCOPE
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
        result = await this.aggregateBusinessServiceCosts(entityId, scope);
        break;
      case 'business_capability':
        result = await this.aggregateBusinessCapabilityCosts(entityId, scope);
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
