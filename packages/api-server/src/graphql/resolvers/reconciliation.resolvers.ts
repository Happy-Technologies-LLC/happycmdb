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

const reconciliationEngine = getIdentityReconciliationEngine();
const postgresClient = getPostgresClient();

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

      const match = await reconciliationEngine.findExistingCI(idAttributes, discoveredCI);

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
    }
  ) => {
    try {
      const status = _args._status || 'pending';
      const limit = Math.min(_args._limit || 100, 1000);
      const offset = _args._offset || 0;

      const result = await postgresClient.query(
        `SELECT id, ci_id, conflict_type, source_data, target_data,
                conflicting_fields, status, created_at
         FROM reconciliation_conflicts
         WHERE status = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, limit, offset]
      );

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
  getRules: async () => {
    try {
      const result = await postgresClient.query(
        `SELECT id, name, identification_rules, merge_strategies,
                enabled, created_at, updated_at
         FROM reconciliation_rules
         ORDER BY created_at DESC`
      );

      return result.rows.map(row => ({
        _id: row.id,
        _name: row.name,
        _identificationRules: row.identification_rules.map((rule: any) => ({
          _attribute: rule.attribute,
          _priority: rule.priority,
          _matchType: rule.match_type.toUpperCase(),
          _matchConfidence: rule.match_confidence,
          _fuzzyThreshold: rule.fuzzy_threshold
        })),
        _mergeStrategies: row.merge_strategies.map((strategy: any) => ({
          _fieldName: strategy.field_name,
          _strategy: strategy.strategy.toUpperCase(),
          _conflictThreshold: strategy.conflict_threshold
        })),
        _enabled: row.enabled,
        _createdAt: row.created_at.toISOString(),
        _updatedAt: row.updated_at.toISOString()
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting rules', error);
      throw new GraphQLError('Failed to get rules', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get source authorities
   */
  getSourceAuthorities: async () => {
    try {
      const result = await postgresClient.query(
        `SELECT source_name, authority_score, description
         FROM source_authority
         ORDER BY authority_score DESC`
      );

      return result.rows.map(row => ({
        _sourceName: row.source_name,
        _authorityScore: row.authority_score,
        _description: row.description
      }));
    } catch (error: any) {
      logger.error('GraphQL: Error getting source authorities', error);
      throw new GraphQLError('Failed to get source authorities', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get CI source lineage
   */
  getCILineage: async (
    _parent: any,
    _args: { _ciId: string }
  ) => {
    try {
      const result = await postgresClient.query(
        `SELECT source_name, source_id, confidence_score,
                first_seen_at, last_seen_at
         FROM ci_source_lineage
         WHERE ci_id = $1
         ORDER BY last_seen_at DESC`,
        [_args._ciId]
      );

      return {
        _ciId: _args._ciId,
        _sources: result.rows.map(row => ({
          _sourceName: row.source_name,
          _sourceId: row.source_id,
          _confidenceScore: row.confidence_score,
          _firstSeenAt: row.first_seen_at.toISOString(),
          _lastSeenAt: row.last_seen_at.toISOString()
        }))
      };
    } catch (error: any) {
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
    _args: { _ciId: string }
  ) => {
    try {
      const result = await postgresClient.query(
        `SELECT field_name, field_value, source_name, updated_at
         FROM ci_field_sources
         WHERE ci_id = $1
         ORDER BY field_name`,
        [_args._ciId]
      );

      return {
        _ciId: _args._ciId,
        _fields: result.rows.map(row => ({
          _fieldName: row.field_name,
          _fieldValue: row.field_value,
          _sourceName: row.source_name,
          _updatedAt: row.updated_at.toISOString()
        }))
      };
    } catch (error: any) {
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
    }
  ) => {
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

      const ciId = await reconciliationEngine.reconcileCI(discoveredCI);

      return {
        _success: true,
        _ciId: ciId,
        _action: ciId.includes('_') ? 'created' : 'updated',
        _mergedFields: Object.keys(_args._attributes || {}),
        _conflicts: []
      };
    } catch (error: any) {
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
    }
  ) => {
    try {
      const resolution = _args._resolution.toLowerCase();

      if (!['accept_source', 'accept_target', 'merge'].includes(resolution)) {
        throw new GraphQLError('Invalid resolution type', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      // Get conflict details
      const conflictResult = await postgresClient.query(
        'SELECT * FROM reconciliation_conflicts WHERE id = $1',
        [_args._id]
      );

      if (conflictResult.rows.length === 0) {
        throw new GraphQLError('Conflict not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const conflict = conflictResult.rows[0];

      // Update conflict status
      await postgresClient.query(
        `UPDATE reconciliation_conflicts
         SET status = 'resolved',
             resolution_data = $2,
             resolved_at = NOW()
         WHERE id = $1`,
        [_args._id, JSON.stringify({ resolution, merged_data: _args._mergedData })]
      );

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
  createRule: async (
    _parent: any,
    _args: {
      _input: {
        _name: string;
        _identificationRules: any[];
        _mergeStrategies?: any[];
        _enabled?: boolean;
      };
    }
  ) => {
    try {
      const { _name, _identificationRules, _mergeStrategies, _enabled } = _args._input;

      // Transform GraphQL input to database format
      const identificationRules = _identificationRules.map(rule => ({
        attribute: rule._attribute,
        priority: rule._priority,
        match_type: rule._matchType.toLowerCase(),
        match_confidence: rule._matchConfidence,
        fuzzy_threshold: rule._fuzzyThreshold
      }));

      const mergeStrategies = (_mergeStrategies || []).map(strategy => ({
        field_name: strategy._fieldName,
        strategy: strategy._strategy.toLowerCase(),
        conflict_threshold: strategy._conflictThreshold
      }));

      const result = await postgresClient.query(
        `INSERT INTO reconciliation_rules
         (name, identification_rules, merge_strategies, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING *`,
        [_name, JSON.stringify(identificationRules), JSON.stringify(mergeStrategies), _enabled !== false]
      );

      const row = result.rows[0];

      return {
        _id: row.id,
        _name: row.name,
        _identificationRules: row.identification_rules.map((rule: any) => ({
          _attribute: rule.attribute,
          _priority: rule.priority,
          _matchType: rule.match_type.toUpperCase(),
          _matchConfidence: rule.match_confidence,
          _fuzzyThreshold: rule.fuzzy_threshold
        })),
        _mergeStrategies: row.merge_strategies.map((strategy: any) => ({
          _fieldName: strategy.field_name,
          _strategy: strategy.strategy.toUpperCase(),
          _conflictThreshold: strategy.conflict_threshold
        })),
        _enabled: row.enabled,
        _createdAt: row.created_at.toISOString(),
        _updatedAt: row.updated_at.toISOString()
      };
    } catch (error: any) {
      logger.error('GraphQL: Error creating rule', error);
      throw new GraphQLError('Failed to create rule', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Update source authority
   */
  updateSourceAuthority: async (
    _parent: any,
    _args: {
      _input: {
        _sourceName: string;
        _authorityScore: number;
        _description?: string;
      };
    }
  ) => {
    try {
      const { _sourceName, _authorityScore, _description } = _args._input;

      if (_authorityScore < 1 || _authorityScore > 10) {
        throw new GraphQLError('Authority score must be between 1 and 10', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      await postgresClient.query(
        `INSERT INTO source_authority (source_name, authority_score, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_name)
         DO UPDATE SET authority_score = $2, description = $3`,
        [_sourceName, _authorityScore, _description || null]
      );

      return {
        _sourceName: _sourceName,
        _authorityScore: _authorityScore,
        _description: _description
      };
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      logger.error('GraphQL: Error updating source authority', error);
      throw new GraphQLError('Failed to update source authority', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  }
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
