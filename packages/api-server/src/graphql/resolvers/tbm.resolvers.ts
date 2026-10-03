// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/tbm.resolvers.ts

import { GraphQLError } from 'graphql';
import { getPostgresClient } from '@cmdb/database';
import { GraphQLContext } from './index';
import { logger } from '@cmdb/common';
import { checkGraphQLPermission } from '../../middleware/auth.middleware';
import { requireGraphQLOrganization } from '../require-organization';
import { ownedBusinessServiceIds, ownsBusinessService } from '../../services/business-service-ownership';

/**
 * TBM GraphQL Resolvers
 *
 * Provides GraphQL queries and mutations for TBM cost management.
 *
 * Tenancy mirrors /api/v1/tbm: every resolver requires an organization claim
 * before any data access; business-service and capability costs only reach
 * :BusinessService ids the caller's organization owns in Postgres (FD-2)
 * whose node also carries that organization_id (FD-16 c); aggregates over
 * every CI are admin-only until CI tenancy lands (FD-3 b).
 */

/** FD-3 b gate for the global (all-CI) aggregates. */
function requireGlobalAggregateAccess(context: GraphQLContext): void {
  requireGraphQLOrganization(context);
  checkGraphQLPermission(context, 'admin');
}

const Query = {
  // Cost Summary
  costSummary: async (_parent: any, _args: any, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    const session = context._neo4jClient.getSession();
    try {
      // Get total monthly cost across all CIs
      const costResult = await session.run(`
        MATCH (ci:CI)
        WHERE ci.tbm_monthly_cost IS NOT NULL
        RETURN
          sum(ci.tbm_monthly_cost) as totalMonthlyCost,
          count(ci) as totalCIs
      `);

      const totalMonthlyCost = costResult.records[0]?.get('totalMonthlyCost') || 0;
      const totalCIs = costResult.records[0]?.get('totalCIs')?.toNumber() || 0;

      // Get cost by tower
      const towerResult = await session.run(`
        MATCH (ci:CI)
        WHERE ci.tbm_resource_tower IS NOT NULL
          AND ci.tbm_monthly_cost IS NOT NULL
        RETURN
          ci.tbm_resource_tower as tower,
          sum(ci.tbm_monthly_cost) as cost,
          count(ci) as ciCount
        ORDER BY cost DESC
      `);

      const costByTower = towerResult.records.map((r: any) => ({
        tower: r.get('tower'),
        totalCost: r.get('cost'),
        ciCount: r.get('ciCount').toNumber(),
      }));

      return {
        totalMonthlyCost,
        totalCIs,
        costByTower,
        currency: 'USD',
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      logger.error('Error getting cost summary', error);
      throw new GraphQLError('Failed to retrieve cost summary', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  costsByTower: async (_parent: any, args: { tower?: string }, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    const session = context._neo4jClient.getSession();
    try {
      let query = `
        MATCH (ci:CI)
        WHERE ci.tbm_resource_tower IS NOT NULL
          AND ci.tbm_monthly_cost IS NOT NULL
      `;

      const params: any = {};

      if (args.tower) {
        query += ' AND ci.tbm_resource_tower = $tower';
        params.tower = args.tower;
      }

      query += `
        RETURN
          ci.tbm_resource_tower as tower,
          ci.tbm_sub_tower as subTower,
          ci.tbm_cost_pool as costPool,
          sum(ci.tbm_monthly_cost) as totalCost,
          count(ci) as ciCount,
          collect({id: ci.id, name: ci.name, cost: ci.tbm_monthly_cost})[..10] as topCIs
        ORDER BY totalCost DESC
      `;

      const result = await session.run(query, params);

      return result.records.map((r: any) => ({
        tower: r.get('tower'),
        subTower: r.get('subTower'),
        costPool: r.get('costPool'),
        totalCost: r.get('totalCost'),
        ciCount: r.get('ciCount').toNumber(),
        topCIs: r.get('topCIs'),
      }));
    } catch (error: any) {
      logger.error('Error getting costs by tower', error);
      throw new GraphQLError('Failed to retrieve costs by tower', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  costsByCapability: async (_parent: any, args: { id: string }, context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(context);
    // Only the caller organization's services are traversed: owned in Postgres
    // (FD-2) and carrying the organization on the node (FD-16 c).
    const orgServiceIds = [...(await ownedBusinessServiceIds(organizationId))];
    const session = context._neo4jClient.getSession();
    try {
      const result = await session.run(
        `
        MATCH (cap:BusinessCapability {id: $capabilityId})
        OPTIONAL MATCH (cap)-[:REALIZES]->(service:BusinessService)
        WHERE service.id IN $orgServiceIds AND service.organization_id = $organizationId
        OPTIONAL MATCH (service)-[:SUPPORTED_BY]->(app:ApplicationService)
        OPTIONAL MATCH (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
        WHERE ci.tbm_monthly_cost IS NOT NULL
        RETURN
          cap.id as capabilityId,
          cap.name as capabilityName,
          collect(DISTINCT service.id) as serviceIds,
          sum(DISTINCT ci.tbm_monthly_cost) as totalCost,
          count(DISTINCT ci) as ciCount,
          collect(DISTINCT ci.tbm_resource_tower) as towers
        `,
        { capabilityId: args.id, orgServiceIds, organizationId }
      );

      if (result.records.length === 0) {
        throw new GraphQLError('Business capability not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const record = result.records[0]!;

      // Get cost by tower for this capability
      const towerResult = await session.run(
        `
        MATCH (cap:BusinessCapability {id: $capabilityId})
        OPTIONAL MATCH (cap)-[:REALIZES]->(service:BusinessService)
        WHERE service.id IN $orgServiceIds AND service.organization_id = $organizationId
        OPTIONAL MATCH (service)-[:SUPPORTED_BY]->(app:ApplicationService)
        OPTIONAL MATCH (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
        WHERE ci.tbm_monthly_cost IS NOT NULL
          AND ci.tbm_resource_tower IS NOT NULL
        RETURN
          ci.tbm_resource_tower as tower,
          sum(ci.tbm_monthly_cost) as totalCost,
          count(ci) as ciCount
        ORDER BY totalCost DESC
        `,
        { capabilityId: args.id, orgServiceIds, organizationId }
      );

      const costByTower = towerResult.records.map((r: any) => ({
        tower: r.get('tower'),
        totalCost: r.get('totalCost'),
        ciCount: r.get('ciCount').toNumber(),
      }));

      return {
        capabilityId: record.get('capabilityId'),
        capabilityName: record.get('capabilityName'),
        totalMonthlyCost: record.get('totalCost') || 0,
        ciCount: record.get('ciCount').toNumber(),
        supportingServices: record.get('serviceIds').length,
        costByTower,
      };
    } catch (error: any) {
      logger.error('Error getting costs by capability', error);
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to retrieve costs by capability', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  costsByBusinessService: async (_parent: any, args: { id: string }, context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(context);
    // Ownership is decided in Postgres before any Cypher runs (FD-2); a
    // foreign, missing or Neo4j-only service gets the same NOT_FOUND.
    if (!(await ownsBusinessService(organizationId, args.id))) {
      throw new GraphQLError('Business service not found', {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    const session = context._neo4jClient.getSession();
    try {
      // The node must also carry the caller's organization (FD-16 c): a node
      // with another organization's id, or none, matches nothing (NOT_FOUND).
      const result = await session.run(
        `
        MATCH (service:BusinessService {id: $serviceId})
        WHERE service.organization_id = $organizationId
        OPTIONAL MATCH (service)-[:SUPPORTED_BY]->(app:ApplicationService)
        OPTIONAL MATCH (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
        WHERE ci.tbm_monthly_cost IS NOT NULL
        RETURN
          service.id as serviceId,
          service.name as serviceName,
          service.user_count as userCount,
          sum(ci.tbm_monthly_cost) as totalCost,
          count(DISTINCT ci) as ciCount,
          collect(DISTINCT ci.tbm_resource_tower) as towers
        `,
        { serviceId: args.id, organizationId }
      );

      if (result.records.length === 0) {
        throw new GraphQLError('Business service not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const record = result.records[0]!;
      const totalCost = record.get('totalCost') || 0;
      const userCount = record.get('userCount') || 0;

      return {
        serviceId: record.get('serviceId'),
        serviceName: record.get('serviceName'),
        totalMonthlyCost: totalCost,
        ciCount: record.get('ciCount').toNumber(),
        towers: record.get('towers'),
        costPerUser: userCount > 0 ? totalCost / userCount : null,
        costPerTransaction: null, // Would require transaction count
      };
    } catch (error: any) {
      logger.error('Error getting costs by business service', error);
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to retrieve costs by business service', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  costTrends: async (_parent: any, args: { months?: number }, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    const pool = getPostgresClient().pool;
    try {
      const months = args.months || 6;

      const result = await pool.query(
        `
        SELECT
          date_trunc('month', snapshot_date) as month,
          sum(tbm_monthly_cost) as total_cost,
          count(*) as ci_count
        FROM ci_snapshot
        WHERE snapshot_date >= NOW() - INTERVAL '${months} months'
          AND tbm_monthly_cost IS NOT NULL
        GROUP BY date_trunc('month', snapshot_date)
        ORDER BY month DESC
        `
      );

      return result.rows.map((row) => ({
        month: row.month,
        totalCost: parseFloat(row.total_cost),
        ciCount: parseInt(row.ci_count),
      }));
    } catch (error: any) {
      logger.error('Error getting cost trends', error);
      throw new GraphQLError('Failed to retrieve cost trends', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    }
  },

  // Cost Allocations
  costAllocations: async (_parent: any, args: { ciId: string }, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    // TODO: Query cost allocations from database
    // For now, return placeholder
    return {
      ciId: args.ciId,
      totalAllocatedCost: 0,
      allocations: [],
    };
  },

  // Licenses
  licenses: async (_parent: any, args: { vendor?: string; status?: string }, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    const session = context._neo4jClient.getSession();
    try {
      let query = `MATCH (ci:CI {type: 'software'}) WHERE 1=1`;
      const params: any = {};

      if (args.vendor) {
        query += ' AND ci.vendor = $vendor';
        params.vendor = args.vendor;
      }

      if (args.status) {
        query += ' AND ci.license_status = $status';
        params.status = args.status;
      }

      query += ' RETURN ci ORDER BY ci.license_expiry_date ASC LIMIT 100';

      const result = await session.run(query, params);
      return result.records.map((r: any) => r.get('ci').properties);
    } catch (error: any) {
      logger.error('Error getting licenses', error);
      throw new GraphQLError('Failed to retrieve licenses', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  upcomingRenewals: async (_parent: any, args: { days?: number }, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    const session = context._neo4jClient.getSession();
    try {
      const days = args.days || 90;

      const result = await session.run(
        `
        MATCH (ci:CI {type: 'software'})
        WHERE ci.license_expiry_date IS NOT NULL
          AND ci.license_expiry_date <= date() + duration({days: $days})
          AND ci.license_expiry_date >= date()
        RETURN ci
        ORDER BY ci.license_expiry_date ASC
        `,
        { days }
      );

      return result.records.map((r: any) => r.get('ci').properties);
    } catch (error: any) {
      logger.error('Error getting upcoming renewals', error);
      throw new GraphQLError('Failed to retrieve upcoming renewals', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },
};

const Mutation = {
  allocateCosts: async (_parent: any, args: { input: any }, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    const { sourceId, targetType, targetIds, allocationMethod, allocationRules } = args.input;

    // Validate input
    if (!sourceId || !targetType || !targetIds || !Array.isArray(targetIds)) {
      throw new GraphQLError('Invalid input: sourceId, targetType, and targetIds are required', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const session = context._neo4jClient.getSession();
    try {
      // Get source CI cost
      const sourceResult = await session.run(
        'MATCH (ci:CI {id: $id}) RETURN ci.tbm_monthly_cost as cost',
        { id: sourceId }
      );

      if (sourceResult.records.length === 0) {
        throw new GraphQLError('CI not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const totalCost = sourceResult.records[0]?.get('cost') || 0;

      // Allocate costs based on method
      let allocations: any[] = [];

      switch (allocationMethod || 'USAGE_BASED') {
        case 'EQUAL':
          allocations = allocateEqual(totalCost, targetIds);
          break;
        case 'USAGE_BASED':
          allocations = allocateUsageBased(totalCost, targetIds, allocationRules);
          break;
        case 'DIRECT':
          allocations = [{ targetId: targetIds[0], allocatedCost: totalCost, allocationPercentage: 100 }];
          break;
        default:
          allocations = allocateEqual(totalCost, targetIds);
      }

      return {
        sourceId,
        totalCost,
        allocationMethod: allocationMethod || 'USAGE_BASED',
        allocations,
      };
    } catch (error: any) {
      logger.error('Error allocating costs', error);
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Failed to allocate costs', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
      });
    } finally {
      await session.close();
    }
  },

  importGLData: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
    requireGlobalAggregateAccess(context);
    // TODO: Implement GL data import
    return {
      success: false,
      recordsImported: 0,
      errorMessage: 'GL import feature coming soon',
    };
  },
};

// Field resolvers
const CI = {
  tbmAttributes: async (parent: any) => {
    // Extract TBM attributes from CI properties
    if (!parent.tbm_resource_tower) {
      return null;
    }

    return {
      resourceTower: parent.tbm_resource_tower,
      subTower: parent.tbm_sub_tower,
      costPool: parent.tbm_cost_pool,
      monthlyCost: parent.tbm_monthly_cost || 0,
      costAllocationMethod: parent.tbm_cost_allocation_method || 'USAGE_BASED',
      depreciationSchedule: parent.tbm_depreciation_schedule
        ? JSON.parse(parent.tbm_depreciation_schedule)
        : null,
    };
  },
};

// Helper functions
function allocateEqual(totalCost: number, targetIds: string[]): any[] {
  const costPerTarget = totalCost / targetIds.length;
  return targetIds.map((targetId) => ({
    targetId,
    allocatedCost: costPerTarget,
    allocationPercentage: (1 / targetIds.length) * 100,
  }));
}

function allocateUsageBased(
  totalCost: number,
  targetIds: string[],
  rules?: Record<string, number>
): any[] {
  if (!rules) {
    return allocateEqual(totalCost, targetIds);
  }

  const totalWeight = Object.values(rules).reduce((sum, weight) => sum + weight, 0);

  return targetIds.map((targetId) => {
    const weight = rules[targetId] || 0;
    const allocatedCost = (weight / totalWeight) * totalCost;
    return {
      targetId,
      allocatedCost,
      allocationPercentage: (weight / totalWeight) * 100,
      weight,
    };
  });
}

export const tbmResolvers = {
  Query,
  Mutation,
  CI,
};
