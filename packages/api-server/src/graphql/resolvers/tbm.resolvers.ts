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
import { getAuthService } from '../../auth/auth-bootstrap';
import { isPlatformAdmin } from '../../auth/platform-admin';
import { readGlobalCIPage, readCIList, CIListUnavailableError } from '../../read-admission';

/**
 * TBM GraphQL Resolvers
 *
 * Provides GraphQL queries and mutations for TBM cost management.
 *
 * Platform-wide license lists require a freshly verified platform administrator;
 * tenant-owned service, capability and trend reads bind the verified organization.
 */
function denyGlobalTbmOperation(_parent: unknown, _args: unknown, _context: GraphQLContext): never {
  return denyPlatformAdminGraphQL();
}

async function requirePlatformAdmin(context: GraphQLContext): Promise<void> {
  if (context.credentialType !== 'jwt' || !context.user) return denyPlatformAdminGraphQL();
  try {
    const user = await getAuthService().findEnabledUser(context.user._userId);
    if (user && isPlatformAdmin(user)) return;
  } catch {
    // Unavailable identity storage cannot grant platform access.
  }
  return denyPlatformAdminGraphQL();
}

async function licenseList(
  context: GraphQLContext,
  where: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  await requirePlatformAdmin(context);
  const session = context._neo4jClient.getSession();
  try {
    const rows = await readGlobalCIPage(async (offset, timeout) => {
      const result = await session.run(
        `MATCH (ci:CI {type: 'software'}) WHERE ${where}
         RETURN ci ORDER BY ci.license_expiry_date ASC, ci.id SKIP $offset LIMIT 100`,
        { ...params, offset }, { timeout }
      );
      return result.records.map(record =>
        record.get('ci').properties as { id: string; organization_id?: string });
    });
    return rows.map((ci: any) => ({
      id: ci.id,
      name: ci.name,
      vendor: ci.vendor,
      licenseType: ci.license_type,
      licenseStatus: ci.license_status?.toUpperCase(),
      licenseExpiryDate: ci.license_expiry_date?.toString(),
      renewalDate: ci.renewal_date?.toString(),
      monthlyCost: Number(ci.tbm_monthly_cost ?? 0),
      licenseCount: ci.license_count == null ? null : Number(ci.license_count),
      complianceStatus: ci.compliance_status?.toUpperCase(),
    }));
  } catch (error) {
    if (error instanceof CIListUnavailableError) {
      throw new GraphQLError('CI list temporarily unavailable', {
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }
    logger.error('Failed to retrieve software licenses', error);
    throw new GraphQLError('Failed to retrieve software licenses', {
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  } finally {
    await session.close();
  }
}

const Query = {
  costSummary: denyGlobalTbmOperation,
  costsByTower: denyGlobalTbmOperation,

  costsByCapability: async (_parent: any, args: { id: string }, context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(context);
    // Only the caller organization's services are traversed: owned in Postgres
    // (FD-2) and carrying the organization on the node (FD-16 c).
    const orgServiceIds = [...(await ownedBusinessServiceIds(organizationId))];
    try {
      return await readCIList(organizationId, async (pending, timeout) => {
        const session = context._neo4jClient.getSession();
        try {
      const result = await session.run(
        `
        MATCH (cap:BusinessCapability {id: $capabilityId})-[:REALIZES]->(service:BusinessService)
        WHERE service.id IN $orgServiceIds AND service.organization_id = $organizationId
        OPTIONAL MATCH (service)-[:SUPPORTED_BY]->(app:ApplicationService)
        OPTIONAL MATCH costPath = (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
        WHERE all(node IN nodes(costPath) WHERE NOT node:CI OR
          (node.organization_id = $organizationId AND NOT node.id IN $pending))
          AND ci.tbm_monthly_cost IS NOT NULL AND NOT ci.id IN $pending
        WITH cap, collect(DISTINCT service.id) as serviceIds, collect(DISTINCT ci) as cis,
             collect(DISTINCT ci.tbm_resource_tower) as towers
        RETURN
          cap.id as capabilityId,
          cap.name as capabilityName,
          serviceIds,
          reduce(total = 0, node IN cis | total + node.tbm_monthly_cost) as totalCost,
          size(cis) as ciCount,
          towers
        `,
        { capabilityId: args.id, orgServiceIds, organizationId, pending }, { timeout }
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
        OPTIONAL MATCH costPath = (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
        WHERE all(node IN nodes(costPath) WHERE NOT node:CI OR
          (node.organization_id = $organizationId AND NOT node.id IN $pending))
          AND ci.tbm_monthly_cost IS NOT NULL AND ci.tbm_resource_tower IS NOT NULL
          AND NOT ci.id IN $pending
        WITH ci.tbm_resource_tower as tower, collect(DISTINCT ci) as cis
        RETURN
          tower,
          reduce(total = 0, node IN cis | total + node.tbm_monthly_cost) as totalCost,
          size(cis) as ciCount
        ORDER BY totalCost DESC
        `,
        { capabilityId: args.id, orgServiceIds, organizationId, pending }, { timeout }
      );

      const costByTower = towerResult.records.map((r: any) => ({
        tower: r.get('tower'),
        totalCost: Number(r.get('totalCost') || 0),
        ciCount: r.get('ciCount').toNumber(),
      }));

      return {
        capabilityId: record.get('capabilityId'),
        capabilityName: record.get('capabilityName'),
        totalMonthlyCost: Number(record.get('totalCost') || 0),
        ciCount: record.get('ciCount').toNumber(),
        supportingServices: record.get('serviceIds').length,
        costByTower,
      };
        } finally {
          await session.close();
        }
      });
    } catch (error: unknown) {
      if (error instanceof GraphQLError) throw error;
      if (error instanceof CIListUnavailableError) {
        throw new GraphQLError('CI list temporarily unavailable', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
      }
      logger.error('Error getting costs by capability');
      throw new GraphQLError('Failed to retrieve costs by capability', {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
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
    try {
      return await readCIList(organizationId, async (pending, timeout) => {
        const session = context._neo4jClient.getSession();
        try {
      // The node must also carry the caller's organization (FD-16 c): a node
      // with another organization's id, or none, matches nothing (NOT_FOUND).
      const result = await session.run(
        `
        MATCH (service:BusinessService {id: $serviceId})
        WHERE service.organization_id = $organizationId
        OPTIONAL MATCH (service)-[:SUPPORTED_BY]->(app:ApplicationService)
        OPTIONAL MATCH costPath = (app)-[:DEPENDS_ON|RUNS_ON*1..2]->(ci:CI)
        WHERE all(node IN nodes(costPath) WHERE NOT node:CI OR
          (node.organization_id = $organizationId AND NOT node.id IN $pending))
          AND ci.tbm_monthly_cost IS NOT NULL AND NOT ci.id IN $pending
        WITH service, collect(DISTINCT ci) as cis, collect(DISTINCT ci.tbm_resource_tower) as towers
        RETURN
          service.id as serviceId,
          service.name as serviceName,
          service.user_count as userCount,
          reduce(total = 0, node IN cis | total + node.tbm_monthly_cost) as totalCost,
          size(cis) as ciCount,
          towers
        `,
        { serviceId: args.id, organizationId, pending }, { timeout }
      );

      if (result.records.length === 0) {
        throw new GraphQLError('Business service not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      const record = result.records[0]!;
      const totalCost = Number(record.get('totalCost') || 0);
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
        } finally {
          await session.close();
        }
      });
    } catch (error: unknown) {
      if (error instanceof GraphQLError) throw error;
      if (error instanceof CIListUnavailableError) {
        throw new GraphQLError('CI list temporarily unavailable', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
      }
      logger.error('Error getting costs by business service');
      throw new GraphQLError('Failed to retrieve costs by business service', {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
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
  licenses: (_parent: unknown, args: { vendor?: string; status?: string }, context: GraphQLContext) =>
    licenseList(context,
      `1=1${args.vendor ? ' AND ci.vendor = $vendor' : ''}${args.status ? ' AND ci.license_status = $status' : ''}`,
      { vendor: args.vendor, status: args.status?.toLowerCase() }),
  upcomingRenewals: (_parent: unknown, args: { days?: number }, context: GraphQLContext) =>
    licenseList(context,
      `ci.license_expiry_date IS NOT NULL
       AND ci.license_expiry_date <= date() + duration({days: $days})
       AND ci.license_expiry_date >= date()`,
      { days: args.days ?? 90 }),
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
