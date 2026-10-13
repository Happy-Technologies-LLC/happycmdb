// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/analytics.resolver.ts

import { GraphQLError } from 'graphql';
import { AnalyticsService, DependencyDepthLimitError } from '../../services/analytics.service';
import { logger, CIAnalyticsLimitError } from '@cmdb/common';
import { requireGraphQLOrganization } from '../require-organization';
import type { TokenPayload } from '../../auth/types';

/**
 * GraphQL Context type (imported from main resolvers)
 */
export interface GraphQLContext {
  _neo4jClient: any;
  _loaders: any;
  user?: TokenPayload;
}

/**
 * Convert GraphQL enum to internal format
 */
function convertTimeInterval(interval?: string): 'hour' | 'day' | 'week' | 'month' {
  const mapping: Record<string, 'hour' | 'day' | 'week' | 'month'> = {
    HOUR: 'hour',
    DAY: 'day',
    WEEK: 'week',
    MONTH: 'month',
  };
  return mapping[interval || 'DAY'] || 'day';
}

/**
 * Convert GraphQL enum to internal format
 */
function convertRelationshipDirection(direction?: string): 'in' | 'out' | 'both' {
  const mapping: Record<string, 'in' | 'out' | 'both'> = {
    IN: 'in',
    OUT: 'out',
    BOTH: 'both',
  };
  return mapping[direction || 'BOTH'] || 'both';
}

/**
 * Convert GraphQL enum to internal metrics interval format
 */
function convertMetricsInterval(interval?: string): '5m' | '15m' | '1h' | '6h' | '1d' {
  const mapping: Record<string, '5m' | '15m' | '1h' | '6h' | '1d'> = {
    FIVE_MINUTES: '5m',
    FIFTEEN_MINUTES: '15m',
    ONE_HOUR: '1h',
    SIX_HOURS: '6h',
    ONE_DAY: '1d',
  };
  return mapping[interval || 'ONE_HOUR'] || '1h';
}

/**
 * Parse date string to Date object
 */
function parseDate(dateStr?: string): Date | undefined {
  if (!dateStr) return undefined;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new GraphQLError('Invalid date format', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return date;
}

/**
 * Analytics Query Resolvers
 */
const AnalyticsQueryResolvers = {
  /**
   * Get CI counts by type
   */
  getCICountsByType: async (_parent: any, _args: any, context: GraphQLContext): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const results = await service.getCICountsByType(organizationId);

      return results.map(row => ({
        _ciType: row.ci_type,
        _count: parseInt(String(row.count)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting CI counts by type', error);
      throw new GraphQLError('Failed to retrieve CI counts by type', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get CI counts by status
   */
  getCICountsByStatus: async (_parent: any, _args: any, context: GraphQLContext): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const results = await service.getCICountsByStatus(organizationId);

      return results.map(row => ({
        _status: row.status,
        _count: parseInt(String(row.count)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting CI counts by status', error);
      throw new GraphQLError('Failed to retrieve CI counts by status', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get CI counts by environment
   */
  getCICountsByEnvironment: async (_parent: any, _args: any, context: GraphQLContext): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const results = await service.getCICountsByEnvironment(organizationId);

      return results.map(row => ({
        _environment: row.environment,
        _count: parseInt(String(row.count)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting CI counts by environment', error);
      throw new GraphQLError('Failed to retrieve CI counts by environment', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get relationship counts by type
   */
  getRelationshipCounts: async (_parent: any, _args: any, context: GraphQLContext): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const results = await service.getRelationshipCounts(organizationId);

      return results.map(row => ({
        _relationshipType: row.relationship_type,
        _count: parseInt(String(row.count)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting relationship counts', error);
      throw new GraphQLError('Failed to retrieve relationship counts', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get discovery statistics
   */
  getDiscoveryStats: async (
    _parent: any,
    args: { startDate?: string; endDate?: string },
    context: GraphQLContext
  ): Promise<any> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const startDate = parseDate(args.startDate);
      const endDate = parseDate(args.endDate);

      const results = await service.getDiscoveryStats(organizationId, startDate, endDate);

      return {
        _summary: {
          _totalCis: parseInt(String(results.summary.total_cis)),
          _uniqueTypes: parseInt(String(results.summary.unique_types)),
          _firstDiscovery: results.summary.first_discovery?.toISOString() || new Date().toISOString(),
          _lastDiscovery: results.summary.last_discovery?.toISOString() || new Date().toISOString(),
        },
        _byProvider: results.by_provider.map(row => ({
          _discoveryProvider: row.discovery_provider,
          _count: parseInt(String(row.count)),
        })),
      };
    } catch (error: any) {
      logger.error('GraphQL: Error getting discovery stats', error);
      throw new GraphQLError('Failed to retrieve discovery statistics', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get discovery timeline
   */
  getDiscoveryTimeline: async (
    _parent: any,
    args: { interval?: string; limit?: number },
    context: GraphQLContext
  ): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const interval = convertTimeInterval(args.interval);
      const limit = Math.min(args.limit || 30, 365);

      const results = await service.getDiscoveryTimeline(organizationId, interval, limit);

      return results.map(row => ({
        _period: row.period.toISOString(),
        _count: parseInt(String(row.count)),
        _uniqueTypes: parseInt(String(row.unique_types)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting discovery timeline', error);
      throw new GraphQLError('Failed to retrieve discovery timeline', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get top connected CIs
   */
  getTopConnectedCIs: async (
    _parent: any,
    args: { limit?: number; direction?: string },
    context: GraphQLContext
  ): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const limit = Math.min(args.limit || 10, 100);
      const direction = convertRelationshipDirection(args.direction);

      const results = await service.getTopConnectedCIs(organizationId, limit, direction);

      return results.map(row => ({
        _ciId: row.ci_id,
        _ciName: row.ci_name,
        _ciType: row.ci_type,
        _relationshipCount: parseInt(String(row.relationship_count)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting top connected CIs', error);
      throw new GraphQLError('Failed to retrieve top connected CIs', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get dependency depth statistics
   */
  getDependencyDepthStats: async (_parent: any, _args: any, context: GraphQLContext): Promise<any> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const results = await service.getDependencyDepthStats(organizationId);

      return {
        _topCis: results.top_cis.map(row => ({
          _ciId: row.ci_id,
          _maxDepth: parseInt(String(row.max_depth)),
          _totalDependencies: parseInt(String(row.total_dependencies)),
        })),
        _depthDistribution: results.depth_distribution.map(row => ({
          _maxDepth: parseInt(String(row.max_depth)),
          _count: parseInt(String(row.count)),
        })),
      };
    } catch (error: unknown) {
      logger.error('GraphQL: Error getting dependency depth stats', error);
      const limited = error instanceof DependencyDepthLimitError ||
        (typeof error === 'object' && error !== null && 'code' in error && error.code === '57014');
      throw new GraphQLError(limited ? 'Dependency depth resource limit exceeded' : 'Failed to retrieve dependency depth statistics', {
        extensions: { code: limited ? 'RESOURCE_LIMIT_EXCEEDED' : 'INTERNAL_SERVER_ERROR' },
      });
    }
  },

  /**
   * Get CI change history
   */
  getChangeHistory: async (
    _parent: any,
    args: { ciId: string; limit?: number },
    context: GraphQLContext
  ): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      if (!args.ciId) {
        throw new GraphQLError('CI ID is required', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      const service = new AnalyticsService();
      const limit = Math.min(args.limit || 50, 1000);

      const results = await service.getChangeHistory(args.ciId, organizationId, limit);

      return results.map(row => ({
        _changeTimestamp: row.change_timestamp.toISOString(),
        _changeType: row.change_type,
        _fieldName: row.field_name || null,
        _oldValue: row.old_value || null,
        _newValue: row.new_value || null,
        _changedBy: row.changed_by || null,
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting change history', error);
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to retrieve change history', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get change frequency by CI type
   */
  getChangeFrequencyByType: async (
    _parent: any,
    args: { startDate?: string; endDate?: string; interval?: string },
    context: GraphQLContext
  ): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const startDate = parseDate(args.startDate);
      const endDate = parseDate(args.endDate);
      const interval = convertTimeInterval(args.interval);

      const results = await service.getChangeFrequencyByType(organizationId, startDate, endDate, interval);

      return results.map(row => ({
        _ciType: row.ci_type,
        _period: row.period.toISOString(),
        _changeCount: parseInt(String(row.change_count)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting change frequency by type', error);
      if (error instanceof CIAnalyticsLimitError) {
        throw new GraphQLError('Analytics resource limit exceeded', {
          extensions: { code: 'SERVICE_UNAVAILABLE' },
        });
      }
      throw new GraphQLError('Failed to retrieve change frequency', {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    }
  },

  /**
   * Get dashboard statistics
   */
  getDashboardStats: async (_parent: any, _args: any, context: GraphQLContext): Promise<any> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const results = await service.getDashboardStats(organizationId);

      return {
        _summary: {
          _totalCis: results.summary.total_cis,
          _uniqueTypes: results.summary.unique_types,
          _uniqueEnvironments: results.summary.unique_environments,
          _totalRelationships: results.summary.total_relationships,
          _recentDiscoveries24h: results.summary.recent_discoveries_24h,
        },
        _breakdown: {
          _byType: results.breakdown.by_type.map(row => ({
            _ciType: row.ci_type,
            _count: parseInt(String(row.count)),
          })),
          _byStatus: results.breakdown.by_status.map(row => ({
            _status: row.status,
            _count: parseInt(String(row.count)),
          })),
          _byEnvironment: results.breakdown.by_environment.map(row => ({
            _environment: row.environment,
            _count: parseInt(String(row.count)),
          })),
        },
      };
    } catch (error: any) {
      logger.error('GraphQL: Error getting dashboard stats', error);
      throw new GraphQLError('Failed to retrieve dashboard statistics', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get CI health metrics (time-series)
   */
  getCIHealthMetrics: async (_parent: any, _args: any, context: GraphQLContext): Promise<any[]> => {
    requireGraphQLOrganization(context);
    // The legacy metrics_ci_health reader has no tenant/incarnation provenance.
    throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
  },

  /**
   * Get inventory report
   */
  getInventoryReport: async (
    _parent: any,
    args: { filter?: { _type?: string; _status?: string; _environment?: string } },
    context: GraphQLContext
  ): Promise<any[]> => {
    const organizationId = requireGraphQLOrganization(context);
    try {
      const service = new AnalyticsService();
      const filter = args.filter
        ? {
            type: args.filter._type,
            status: args.filter._status,
            environment: args.filter._environment,
          }
        : undefined;

      const results = await service.getInventoryReport(organizationId, filter);

      return results.map(row => ({
        _ciId: row.ci_id,
        _ciName: row.ci_name,
        _ciType: row.ci_type,
        _status: row.status,
        _environment: row.environment || null,
        _discoveredAt: row.discovered_at.toISOString(),
        _relationshipCount: parseInt(String(row.relationship_count)),
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting inventory report', error);
      throw new GraphQLError('Failed to retrieve inventory report', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },
};

/**
 * Root Query resolver that returns the analytics resolver object
 */
export const analyticsResolvers = {
  Query: {
    analytics: () => ({}), // Return empty object, actual resolvers are on AnalyticsQuery type
  },
  AnalyticsQuery: AnalyticsQueryResolvers,
};
