// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/index.ts

import { GraphQLError } from 'graphql';
import { GraphQLScalarType, Kind } from 'graphql';
import { Neo4jClient } from '@cmdb/database';
import { CI, CIInput, CIType, CIStatus, Environment, RelationshipType } from '@cmdb/common';
import { analyticsResolvers } from './analytics.resolver';
import { connectorResolvers } from './connector.resolvers';
import { connectorFieldResolvers } from './connector-fields.resolvers';
import { reconciliationResolvers } from './reconciliation.resolvers';
// TEMPORARILY DISABLED - V3.0
// import { itilResolvers } from './itil.resolvers';

/**
 * GraphQL Context type containing database clients and dataloaders
 */
export interface GraphQLContext {
  _neo4jClient: Neo4jClient;
  _loaders: {
    _ciLoader: any;
    _relationshipLoader: any;
    _dependentLoader: any;
  };
}

/**
 * Custom JSON scalar type for handling arbitrary JSON data
 */
const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'JSON custom scalar type',
  serialize(value: any) {
    return value;
  },
  parseValue(value: any) {
    return value;
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.OBJECT) {
      const value = Object.create(null);
      ast.fields.forEach(field => {
        value[field.name.value] = parseLiteral(field.value);
      });
      return value;
    }
    if (ast.kind === Kind.LIST) {
      return ast.values.map(parseLiteral);
    }
    return parseLiteral(ast);
  },
});

function parseLiteral(ast: any): any {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.OBJECT:
      return ast.fields.reduce((acc: any, field: any) => {
        acc[field.name.value] = parseLiteral(field.value);
        return acc;
      }, {});
    case Kind.LIST:
      return ast.values.map(parseLiteral);
    case Kind.NULL:
      return null;
    default:
      return null;
  }
}

/**
 * Convert GraphQL enum values to database format
 */
function convertEnumToDbFormat(value: string): string {
  return value.toLowerCase().replace(/_/g, '-');
}


/**
 * Validate CI input data
 */
function validateCIInput(input: any): void {
  if (!input.id || typeof input.id !== 'string') {
    throw new GraphQLError('CI ID is required and must be a string', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }

  if (!input.name || typeof input.name !== 'string') {
    throw new GraphQLError('CI name is required and must be a string', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }

  if (!input.type) {
    throw new GraphQLError('CI type is required', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

/**
 * Query resolvers
 */
const Query = {
  /**
   * Get all CIs with optional filtering
   */
  getCIs: async (
    __parent: any,
    _args: {
      filter?: {
        type?: CIType;
        status?: CIStatus;
        environment?: Environment;
        name?: string;
      };
      limit?: number;
      offset?: number;
    },
    _context: GraphQLContext
  ): Promise<CI[]> => {
    const session = _context._neo4jClient.getSession();

    try {
      const { filter, limit = 100, offset = 0 } = _args;
      const conditions: string[] = [];
      const params: any = { limit, offset };

      if (filter?.type) {
        conditions.push('ci.type = $type');
        params.type = convertEnumToDbFormat(filter.type);
      }

      if (filter?.status) {
        conditions.push('ci.status = $status');
        params.status = convertEnumToDbFormat(filter.status);
      }

      if (filter?.environment) {
        conditions.push('ci.environment = $environment');
        params.environment = convertEnumToDbFormat(filter.environment);
      }

      if (filter?.name) {
        conditions.push('ci.name CONTAINS $name');
        params.name = filter.name;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await session.run(
        `
        MATCH (ci:CI)
        ${whereClause}
        RETURN ci
        ORDER BY ci.created_at DESC
        SKIP $offset
        LIMIT $limit
        `,
        params
      );

      return result.records.map((record: any) => {
        const props = record.get('ci').properties;
        return {
          _id: props.id,
          external_id: props.external_id,
          name: props.name,
          _type: props.type,
          _status: props.status,
          environment: props.environment,
          _created_at: props.created_at,
          _updated_at: props.updated_at,
          _discovered_at: props.discovered_at,
          _metadata: props.metadata ? JSON.parse(props.metadata) : {},
        };
      });
    } catch (error: any) {
      throw new GraphQLError('Failed to fetch CIs', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    } finally {
      await session.close();
    }
  },

  /**
   * Get a single CI by ID
   */
  getCI: async (
    __parent: any,
    _args: { id: string },
    _context: GraphQLContext
  ): Promise<CI | null> => {
    try {
      // Use DataLoader for caching and batching
      return await _context._loaders._ciLoader.load(_args.id);
    } catch (error: any) {
      throw new GraphQLError('Failed to fetch CI', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Search CIs using full-text search
   */
  searchCIs: async (
    __parent: any,
    _args: {
      _query: string;
      filter?: {
        type?: CIType;
        status?: CIStatus;
        environment?: Environment;
      };
      limit?: number;
    },
    _context: GraphQLContext
  ): Promise<CI[]> => {
    const session = _context._neo4jClient.getSession();

    try {
      const { _query, filter, limit = 50 } = _args;
      const conditions: string[] = ['ci.name CONTAINS $query OR ci.external_id CONTAINS $query'];
      const params: any = { query: _query, limit };

      if (filter?.type) {
        conditions.push('ci.type = $type');
        params.type = convertEnumToDbFormat(filter.type);
      }

      if (filter?.status) {
        conditions.push('ci.status = $status');
        params.status = convertEnumToDbFormat(filter.status);
      }

      if (filter?.environment) {
        conditions.push('ci.environment = $environment');
        params.environment = convertEnumToDbFormat(filter.environment);
      }

      const result = await session.run(
        `
        MATCH (ci:CI)
        WHERE ${conditions.join(' AND ')}
        RETURN ci
        ORDER BY ci.name
        LIMIT $limit
        `,
        params
      );

      return result.records.map((record: any) => {
        const props = record.get('ci').properties;
        return {
          _id: props.id,
          external_id: props.external_id,
          name: props.name,
          _type: props.type,
          _status: props.status,
          environment: props.environment,
          _created_at: props.created_at,
          _updated_at: props.updated_at,
          _discovered_at: props.discovered_at,
          _metadata: props.metadata ? JSON.parse(props.metadata) : {},
        };
      });
    } catch (error: any) {
      throw new GraphQLError('Failed to search CIs', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    } finally {
      await session.close();
    }
  },

  /**
   * Get relationships for a specific CI
   */
  getCIRelationships: async (
    __parent: any,
    _args: { id: string; direction?: string },
    _context: GraphQLContext
  ): Promise<any[]> => {
    try {
      const direction = _args.direction === 'in' ? 'in' : _args.direction === 'out' ? 'out' : 'both';

      if (direction === 'out') {
        return await _context._loaders._relationshipLoader.load(_args.id);
      } else if (direction === 'in') {
        return await _context._loaders._dependentLoader.load(_args.id);
      } else {
        // For 'both', get both directions
        const [outgoing, incoming] = await Promise.all([
          _context._loaders._relationshipLoader.load(_args.id),
          _context._loaders._dependentLoader.load(_args.id),
        ]);
        return [...outgoing, ...incoming];
      }
    } catch (error: any) {
      throw new GraphQLError('Failed to fetch CI relationships', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Get all dependencies for a CI (recursive)
   */
  getCIDependencies: async (
    __parent: any,
    _args: { id: string; depth?: number },
    _context: GraphQLContext
  ): Promise<CI[]> => {
    const session = _context._neo4jClient.getSession();

    try {
      const depth = _args.depth || 5;

      const result = await session.run(
        `
        MATCH path = (ci:CI {id: $id})-[:DEPENDS_ON*1..${depth}]->(dep:CI)
        RETURN DISTINCT dep
        `,
        { id: _args.id }
      );

      return result.records.map((record: any) => {
        const props = record.get('dep').properties;
        return {
          _id: props.id,
          external_id: props.external_id,
          name: props.name,
          _type: props.type,
          _status: props.status,
          environment: props.environment,
          _created_at: props.created_at,
          _updated_at: props.updated_at,
          _discovered_at: props.discovered_at,
          _metadata: props.metadata ? JSON.parse(props.metadata) : {},
        };
      });
    } catch (error: any) {
      throw new GraphQLError('Failed to fetch CI dependencies', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    } finally {
      await session.close();
    }
  },

  /**
   * Perform impact analysis for a CI
   */
  getImpactAnalysis: async (
    __parent: any,
    _args: { id: string; depth?: number },
    _context: GraphQLContext
  ): Promise<Array<{ ci: CI; distance: number }>> => {
    const session = _context._neo4jClient.getSession();

    try {
      const depth = _args.depth || 5;

      const result = await session.run(
        `
        MATCH path = (ci:CI {id: $id})<-[:DEPENDS_ON*1..${depth}]-(impacted:CI)
        RETURN DISTINCT impacted, length(path) as distance
        ORDER BY distance
        `,
        { id: _args.id }
      );

      return result.records.map((record: any) => {
        const props = record.get('impacted').properties;
        return {
          ci: {
            _id: props.id,
            external_id: props.external_id,
            name: props.name,
            _type: props.type,
            _status: props.status,
            environment: props.environment,
            _created_at: props.created_at,
            _updated_at: props.updated_at,
            _discovered_at: props.discovered_at,
            _metadata: props.metadata ? JSON.parse(props.metadata) : {},
          },
          distance: record.get('distance').toNumber(),
        };
      });
    } catch (error: any) {
      throw new GraphQLError('Failed to perform impact analysis', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    } finally {
      await session.close();
    }
  },
};

/**
 * Mutation resolvers
 */
const Mutation = {
  /**
   * Create a new CI
   */
  createCI: async (
    __parent: any,
    _args: { input: any },
    _context: GraphQLContext
  ): Promise<CI> => {
    try {
      validateCIInput(_args.input);

      const ciInput: CIInput = {
        _id: _args.input.id,
        external_id: _args.input.externalId,
        name: _args.input.name,
        _type: convertEnumToDbFormat(_args.input.type) as CIType,
        status: _args.input.status ? convertEnumToDbFormat(_args.input.status) as CIStatus : 'active',
        environment: _args.input.environment ? convertEnumToDbFormat(_args.input.environment) as Environment : undefined,
        discovered_at: _args.input.discoveredAt || new Date().toISOString(),
        metadata: _args.input.metadata || {},
      };

      const ci = await _context._neo4jClient.createCI(ciInput);

      // Clear cache
      _context._loaders._ciLoader.clear(ci._id);

      return ci;
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to create CI', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Update an existing CI
   */
  updateCI: async (
    __parent: any,
    _args: { id: string; input: any },
    _context: GraphQLContext
  ): Promise<CI> => {
    try {
      const updates: Partial<CIInput> = {};

      if (_args.input.name) {
        updates.name = _args.input.name;
      }

      if (_args.input.status) {
        updates.status = convertEnumToDbFormat(_args.input.status) as CIStatus;
      }

      if (_args.input.environment) {
        updates.environment = convertEnumToDbFormat(_args.input.environment) as Environment;
      }

      if (_args.input.metadata) {
        updates.metadata = _args.input.metadata;
      }

      const ci = await _context._neo4jClient.updateCI(_args.id, updates);

      // Clear cache
      _context._loaders._ciLoader.clear(_args.id);

      return ci;
    } catch (error: any) {
      throw new GraphQLError('Failed to update CI', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Delete a CI
   */
  deleteCI: async (
    __parent: any,
    _args: { id: string },
    _context: GraphQLContext
  ): Promise<boolean> => {
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (ci:CI {id: $id})
        DETACH DELETE ci
        RETURN count(ci) as deleted
        `,
        { id: _args.id }
      );

      const deleted = result.records[0]?.get('deleted').toNumber() || 0;

      if (deleted === 0) {
        throw new GraphQLError('CI not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Clear cache
      _context._loaders._ciLoader.clear(_args.id);

      return true;
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to delete CI', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    } finally {
      await session.close();
    }
  },

  /**
   * Create a relationship between two CIs
   */
  createRelationship: async (
    __parent: any,
    _args: {
      _input: {
        _fromId: string;
        _toId: string;
        _type: RelationshipType;
        properties?: Record<string, any>;
      };
    },
    _context: GraphQLContext
  ): Promise<boolean> => {
    try {
      await _context._neo4jClient.createRelationship(
        _args._input._fromId,
        _args._input._toId,
        _args._input._type,
        _args._input.properties || {}
      );

      // Clear caches for both CIs
      _context._loaders._relationshipLoader.clear(_args._input._fromId);
      _context._loaders._dependentLoader.clear(_args._input._toId);

      return true;
    } catch (error: any) {
      throw new GraphQLError('Failed to create relationship', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Delete a relationship between two CIs
   */
  deleteRelationship: async (
    __parent: any,
    _args: {
      _fromId: string;
      _toId: string;
      _type: RelationshipType;
    },
    _context: GraphQLContext
  ): Promise<boolean> => {
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (from:CI {id: $fromId})-[r:${_args._type}]->(to:CI {id: $toId})
        DELETE r
        RETURN count(r) as deleted
        `,
        { fromId: _args._fromId, toId: _args._toId }
      );

      const deleted = result.records[0]?.get('deleted').toNumber() || 0;

      if (deleted === 0) {
        throw new GraphQLError('Relationship not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      // Clear caches
      _context._loaders._relationshipLoader.clear(_args._fromId);
      _context._loaders._dependentLoader.clear(_args._toId);

      return true;
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to delete relationship', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    } finally {
      await session.close();
    }
  },
};

/**
 * CI type resolvers for nested fields
 */
const CIResolvers = {
  /**
   * Resolve outgoing relationships
   */
  _relationships: async (parent: CI, _args: any, _context: GraphQLContext) => {
    return await _context._loaders._relationshipLoader.load(parent._id);
  },

  /**
   * Resolve incoming relationships (dependents)
   */
  _dependents: async (parent: CI, _args: any, _context: GraphQLContext) => {
    return await _context._loaders._dependentLoader.load(parent._id);
  },

  /**
   * Resolve all dependencies recursively
   */
  _dependencies: async (parent: CI, _args: any, _context: GraphQLContext) => {
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH path = (ci:CI {id: $id})-[:DEPENDS_ON*1..5]->(dep:CI)
        RETURN DISTINCT dep
        `,
        { id: parent._id }
      );

      return result.records.map((record: any) => {
        const props = record.get('dep').properties;
        return {
          _id: props.id,
          external_id: props.external_id,
          name: props.name,
          _type: props.type,
          _status: props.status,
          environment: props.environment,
          _created_at: props.created_at,
          _updated_at: props.updated_at,
          _discovered_at: props.discovered_at,
          _metadata: props.metadata ? JSON.parse(props.metadata) : {},
        };
      });
    } finally {
      await session.close();
    }
  },

  /**
   * Convert field names to match GraphQL schema
   */
  _externalId: (parent: CI) => parent.external_id,
  _createdAt: (parent: CI) => parent._created_at,
  _updatedAt: (parent: CI) => parent._updated_at,
  _discoveredAt: (parent: CI) => parent._discovered_at,
};

/**
 * Export all resolvers
 */
export const resolvers = {
  Query: {
    ...Query,
    ...analyticsResolvers.Query,
    ...connectorResolvers.Query,
    ...reconciliationResolvers.Query,
    // ...itilResolvers.Query,
  },
  Mutation: {
    ...Mutation,
    ...connectorResolvers.Mutation,
    ...reconciliationResolvers.Mutation,
    // ...itilResolvers.Mutation,
  },
  CI: {
    ...CIResolvers,
    // ...itilResolvers.CI,
  },
  JSON: JSONScalar,
  AnalyticsQuery: analyticsResolvers.AnalyticsQuery,
  ReconciliationQuery: reconciliationResolvers.ReconciliationQuery,
  ReconciliationMutation: reconciliationResolvers.ReconciliationMutation,
//   _Incident: itilResolvers.Incident,
//   _Change: itilResolvers.Change,
//   _ConfigurationBaseline: itilResolvers.ConfigurationBaseline,
  ...connectorFieldResolvers,
};
