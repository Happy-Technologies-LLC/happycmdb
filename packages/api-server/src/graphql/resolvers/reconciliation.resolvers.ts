// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GraphQL Resolvers for Identity Reconciliation
 */

import { GraphQLError } from 'graphql';
import { logger } from '@cmdb/common';
import { getIdentityReconciliationEngine } from '@cmdb/identity-resolution';
import { getPostgresClient } from '@cmdb/database';
import { TransformedCI, IdentificationAttributes } from '@cmdb/integration-framework';
import { GraphQLContext } from './index';
import { checkGraphQLPermission } from '../../middleware/auth.middleware';
import { requireGraphQLOrganization } from '../require-organization';
import { GRAPHQL_PAGE_DEFAULTS } from '../pagination';
import {
  getOwnedConflict, getOwnedFieldSources, getOwnedLineage,
  listOwnedConflicts, updateOwnedConflict
} from '../../reconciliation/tenant-queries';

const reconciliationEngine = getIdentityReconciliationEngine();
const postgresClient = getPostgresClient();
function refuseGlobalPolicy(context: GraphQLContext): never {
  if (!context.user) throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
  throw new GraphQLError('Global reconciliation policy unavailable', { extensions: { code: 'FORBIDDEN' } });
}

/**
 * Reconciliation Query Resolvers
 */
const ReconciliationQuery = {
  /**
   * Find matching CIs based on identification attributes
   */
  findMatches: async (
    _parent: any,
    _args: {
      _identifiers: any;
      _source?: string;
    },
    _context: GraphQLContext
  ) => {
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const { _identifiers, _source } = _args;

      // Transform GraphQL input to IdentificationAttributes
      const idAttributes: IdentificationAttributes = {
        external_id: _identifiers._externalId,
        serial_number: _identifiers._serialNumber,
        uuid: _identifiers._uuid,
        mac_address: _identifiers._macAddress,
        fqdn: _identifiers._fqdn,
        hostname: _identifiers._hostname,
        ip_address: _identifiers._ipAddress
      };

      // Create minimal TransformedCI for matching context
      const discoveredCI: TransformedCI = {
        name: _identifiers._hostname || _identifiers._fqdn || 'unknown',
        ci_type: 'server',
        source: _source || 'graphql',
        source_id: _identifiers._externalId || 'unknown',
        identifiers: idAttributes,
        attributes: {},
        relationships: [],
        confidence_score: 100,
        status: 'active'
      };

      const match = await reconciliationEngine.findExistingCI(idAttributes, discoveredCI, organizationId);

      if (!match) {
        return null;
      }

      return {
        _ciId: match.ci_id,
        _confidence: match.confidence,
        _matchStrategy: match.match_strategy,
        _matchedAttributes: match.matched_attributes
      };
    } catch (error: any) {
      logger.error('GraphQL: Error finding matches', error);
      throw new GraphQLError('Failed to find matches', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * List reconciliation conflicts
   */
  listConflicts: async (
    _parent: any,
    _args: {
      _status?: string;
      _limit?: number;
      _offset?: number;
    },
    _context: GraphQLContext
  ) => {
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const status = (_args._status || 'pending').toLowerCase();
      const limit = Math.min(_args._limit || GRAPHQL_PAGE_DEFAULTS.listConflicts, 1000);
      const offset = _args._offset || 0;

      const result = await listOwnedConflicts(postgresClient, status, limit, offset, organizationId);

      return result.rows.map(row => ({
        _id: row.id,
        _ciId: row.ci_id,
        _conflictType: row.conflict_type.toUpperCase(),
        _sourceData: row.source_data,
        _targetData: row.target_data,
        _conflictingFields: row.conflicting_fields,
        _status: row.status.toUpperCase(),
        _createdAt: row.created_at.toISOString()
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error listing conflicts', error);
      throw new GraphQLError('Failed to list conflicts', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get reconciliation rules
   */
  getRules: async (_parent: unknown, _args: unknown, context: GraphQLContext) => refuseGlobalPolicy(context),

  /**
   * Get source authorities
   */
  getSourceAuthorities: async (_parent: unknown, _args: unknown, context: GraphQLContext) => refuseGlobalPolicy(context),

  /**
   * Get CI source lineage
   */
  getCILineage: async (
    _parent: any,
    _args: { _ciId: string },
    _context: GraphQLContext
  ) => {
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const result = await getOwnedLineage(postgresClient, _args._ciId, organizationId);
      if (result.rows.length === 0) {
        throw new GraphQLError('CI not found', { extensions: { code: 'NOT_FOUND' } });
      }

      return {
        _ciId: _args._ciId,
        _sources: result.rows.filter(row => row.source_name !== null).map(row => ({
          _sourceName: row.source_name,
          _sourceId: row.source_id,
          _confidenceScore: row.confidence_score,
          _firstSeenAt: row.first_seen_at.toISOString(),
          _lastSeenAt: row.last_seen_at.toISOString()
        }))
      };
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions['code'] === 'NOT_FOUND') throw error;
      logger.error('GraphQL: Error getting CI lineage', error);
      throw new GraphQLError('Failed to get CI lineage', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get CI field sources
   */
  getCIFieldSources: async (
    _parent: any,
    _args: { _ciId: string },
    _context: GraphQLContext
  ) => {
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const result = await getOwnedFieldSources(postgresClient, _args._ciId, organizationId);
      if (result.rows.length === 0) {
        throw new GraphQLError('CI not found', { extensions: { code: 'NOT_FOUND' } });
      }

      return {
        _ciId: _args._ciId,
        _fields: result.rows.filter(row => row.field_name !== null).map(row => ({
          _fieldName: row.field_name,
          _fieldValue: row.field_value,
          _sourceName: row.source_name,
          _updatedAt: row.updated_at.toISOString()
        }))
      };
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions['code'] === 'NOT_FOUND') throw error;
      logger.error('GraphQL: Error getting CI field sources', error);
      throw new GraphQLError('Failed to get CI field sources', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  }
};

/**
 * Reconciliation Mutation Resolvers
 */
const ReconciliationMutation = {
  /**
   * Merge/reconcile a discovered CI into CMDB
   */
  mergeCI: async (
    _parent: any,
    _args: {
      _name: string;
      _ciType: string;
      _source: string;
      _sourceId: string;
      _identifiers: any;
      _attributes?: any;
      _confidenceScore?: number;
      _environment?: string;
      _status?: string;
    },
    _context: GraphQLContext
  ) => {
    checkGraphQLPermission(_context, 'write');
    const organizationId = requireGraphQLOrganization(_context);
    try {
      // Transform GraphQL input to TransformedCI
      const discoveredCI: TransformedCI = {
        name: _args._name,
        ci_type: _args._ciType,
        source: _args._source,
        source_id: _args._sourceId,
        identifiers: {
          external_id: _args._identifiers._externalId,
          serial_number: _args._identifiers._serialNumber,
          uuid: _args._identifiers._uuid,
          mac_address: _args._identifiers._macAddress,
          fqdn: _args._identifiers._fqdn,
          hostname: _args._identifiers._hostname,
          ip_address: _args._identifiers._ipAddress
        },
        attributes: _args._attributes || {},
        relationships: [],
        confidence_score: _args._confidenceScore || 100,
        environment: _args._environment,
        status: _args._status || 'active'
      };

      const ciId = await reconciliationEngine.reconcileCI(discoveredCI, organizationId, false);
      if (ciId === null) {
        throw new GraphQLError('CI not found', { extensions: { code: 'NOT_FOUND', http: { status: 404 } } });
      }

      return {
        _success: true,
        _ciId: ciId,
        _action: 'updated',
        _mergedFields: Object.keys(_args._attributes || {}),
        _conflicts: []
      };
    } catch (error: any) {
      if (error instanceof GraphQLError && error.extensions['code'] === 'NOT_FOUND') throw error;
      logger.error('GraphQL: Error merging CI', error);
      throw new GraphQLError('Failed to merge CI', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Resolve a reconciliation conflict
   */
  resolveConflict: async (
    _parent: any,
    _args: {
      _id: string;
      _resolution: string;
      _mergedData?: any;
    },
    _context: GraphQLContext
  ) => {
    checkGraphQLPermission(_context, 'write');
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const resolution = _args._resolution.toLowerCase();

      if (!['accept_source', 'accept_target', 'merge'].includes(resolution)) {
        throw new GraphQLError('Invalid resolution type', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      const conflictResult = await getOwnedConflict(postgresClient, _args._id, organizationId);

      if (conflictResult.rows.length === 0) {
        throw new GraphQLError('Conflict not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const conflict = conflictResult.rows[0];

      const updated = await updateOwnedConflict(
        postgresClient, _args._id, organizationId,
        JSON.stringify({ resolution, merged_data: _args._mergedData })
      );
      if (updated.rows.length === 0) {
        throw new GraphQLError('Conflict not found', { extensions: { code: 'NOT_FOUND' } });
      }

      return {
        _id: _args._id,
        _ciId: conflict.ci_id,
        _conflictType: conflict.conflict_type.toUpperCase(),
        _sourceData: conflict.source_data,
        _targetData: conflict.target_data,
        _conflictingFields: conflict.conflicting_fields,
        _status: 'RESOLVED',
        _createdAt: conflict.created_at.toISOString()
      };
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      logger.error('GraphQL: Error resolving conflict', error);
      throw new GraphQLError('Failed to resolve conflict', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Create a reconciliation rule
   */
  createRule: async (_parent: unknown, _args: unknown, context: GraphQLContext) => refuseGlobalPolicy(context),

  /**
   * Update source authority
   */
  updateSourceAuthority: async (_parent: unknown, _args: unknown, context: GraphQLContext) => refuseGlobalPolicy(context)
};

/**
 * Root resolver that returns the ReconciliationQuery object
 */
const QueryResolvers = {
  _reconciliation: () => ({})
};

/**
 * Root resolver that returns the ReconciliationMutation object
 */
const MutationResolvers = {
  _reconciliation: () => ({})
};

/**
 * Export all reconciliation resolvers
 */
export const reconciliationResolvers = {
  Query: QueryResolvers,
  Mutation: MutationResolvers,
  ReconciliationQuery,
  ReconciliationMutation
};
