// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/tbm.resolvers.ts

import { GraphQLError } from 'graphql';
import { GraphQLContext } from './index';
import { logger } from '@cmdb/common';
import { checkGraphQLPermission } from '../../middleware/auth.middleware';
import { requireGraphQLOrganization } from '../require-organization';
import { denyPlatformAdminGraphQL } from '../../middleware/platform-admin-unavailable';
import { ownedBusinessServiceIds, ownsBusinessService } from '../../services/business-service-ownership';
import { ciCostTrends } from '../../services/ci-cost-trends';
import { errorLogFields } from '../../utils/log-error';

/**
 * TBM GraphQL Resolvers
 *
 * Provides GraphQL queries and mutations for TBM cost management.
 *
 * Global cost/installation controls refuse every caller until dedicated
 * platform-admin authority exists. Tenant-owned service, capability and trend
 * reads bind the verified organization; trends retain their admin permission.
 */
// All global TBM operations share one interim refusal. No service or graph
// access remains behind these resolvers until a separate platform-admin PR.
function denyGlobalTbmOperation(_parent: unknown, _args: unknown, _context: GraphQLContext): never {
  return denyPlatformAdminGraphQL();
}

const Query = {
  costSummary: denyGlobalTbmOperation,
  costsByTower: denyGlobalTbmOperation,

  costsByCapability: async (_parent: any, args: { id: string }, context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(context);
    // Only the caller organization's services are traversed: owned in Postgres
    // (FD-2) and carrying the organization on the node (FD-16 c).
    const orgServiceIds = [...(await ownedBusinessServiceIds(organizationId))];
    const session = context._neo4jClient.getSession();
    try {
      const result = await session.run(
        `
        MATCH (cap:BusinessCapability {id: $capabilityId})-[:REALIZES]->(service:BusinessService)
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
        MATCH (cap:BusinessCapability {id: $capabilityId})-[:REALIZES]->(service:BusinessService)
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
    requireGraphQLOrganization(context);
    checkGraphQLPermission(context, 'admin');
    try {
      // Only the caller organization's CIs (cmdb.dim_ci.organization_id).
      const trends = await ciCostTrends(requireGraphQLOrganization(context), args.months ?? 6);
      // MonthlyCostData.month is a String: the ISO timestamp REST returns.
      return trends.map((point) => ({ ...point, month: point.month.toISOString() }));
    } catch (error: unknown) {
      // Driver errors name tables/columns: log them, return no driver text.
      logger.error('Error getting cost trends', { error: errorLogFields(error) });
      throw new GraphQLError('Failed to retrieve cost trends', {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    }
  },

  costAllocations: denyGlobalTbmOperation,
  licenses: denyGlobalTbmOperation,
  upcomingRenewals: denyGlobalTbmOperation,
};

const Mutation = {
  allocateCosts: denyGlobalTbmOperation,
  importGLData: denyGlobalTbmOperation,
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


export const tbmResolvers = {
  Query,
  Mutation,
  CI,
};
