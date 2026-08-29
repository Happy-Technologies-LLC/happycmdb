// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/index.ts

import { GraphQLError } from 'graphql';
import { GraphQLScalarType, Kind } from 'graphql';
import neo4j from 'neo4j-driver';
import { Neo4jClient } from '@cmdb/database';
import { CI, CIInput, CIType, CIStatus, Environment, RelationshipType } from '@cmdb/common';
import { analyticsResolvers } from './analytics.resolver';
import { connectorResolvers } from './connector.resolvers';
import { connectorFieldResolvers } from './connector-fields.resolvers';
import { reconciliationResolvers } from './reconciliation.resolvers';
// TEMPORARILY DISABLED - V3.0
// import { itilResolvers } from './itil.resolvers';
import type { TokenPayload } from '../../auth/types';
import { checkGraphQLPermission } from '../../middleware/auth.middleware';

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
  /** Authenticated identity resolved from the request's bearer token or API key, when present. */
  user?: TokenPayload;
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
interface GraphQLCI {
  _id: string;
  _externalId?: string;
  _name: string;
  _type: string;
  _status: string;
  _environment?: string;
  _metadata: Record<string, unknown>;
  _createdAt: string;
  _updatedAt: string;
  _discoveredAt: string;
}

type CIValue = Partial<CI> & {
  id?: string;
  type?: CIType;
  status?: CIStatus;
  metadata?: unknown;
  created_at?: string;
  updated_at?: string;
  discovered_at?: string;
  _externalId?: string;
  _name?: string;
  _environment?: Environment;
  _createdAt?: string;
  _updatedAt?: string;
  _discoveredAt?: string;
};

function validateCIInput(input: { _id?: unknown; _name?: unknown; _type?: unknown }): void {
  if (!input._id || typeof input._id !== 'string') {
    throw new GraphQLError('CI ID is required and must be a string', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }

  if (!input._name || typeof input._name !== 'string') {
    throw new GraphQLError('CI name is required and must be a string', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }

  if (!input._type) {
    throw new GraphQLError('CI type is required', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

function normalizePagination(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function convertDbEnumToGraphQL(value: string): string {
  return value.toUpperCase().replace(/-/g, '_');
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (typeof metadata === 'string') {
    return JSON.parse(metadata) as Record<string, unknown>;
  }
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
}

function toGraphQLCI(ci: CIValue): GraphQLCI {
  return {
    _id: ci._id ?? ci.id ?? '',
    _externalId: ci.external_id ?? ci._externalId,
    _name: ci.name ?? ci._name ?? '',
    _type: convertDbEnumToGraphQL(ci._type ?? ci.type ?? 'server'),
    _status: convertDbEnumToGraphQL(ci._status ?? ci.status ?? 'active'),
    _environment: ci.environment ?? ci._environment
      ? convertDbEnumToGraphQL(ci.environment ?? ci._environment ?? 'development')
      : undefined,
    _metadata: parseMetadata(ci._metadata ?? ci.metadata),
    _createdAt: ci._created_at ?? ci._createdAt ?? ci.created_at ?? '',
    _updatedAt: ci._updated_at ?? ci._updatedAt ?? ci.updated_at ?? '',
    _discoveredAt: ci._discovered_at ?? ci._discoveredAt ?? ci.discovered_at ?? '',
  };
}

function toGraphQLRelatedCI(relationship: {
  _type?: string;
  type?: string;
  _ci?: CIValue;
  ci?: CIValue;
  _properties?: unknown;
  properties?: unknown;
}): { _type: string; _ci: GraphQLCI; _properties: unknown } {
  return {
    _type: relationship._type ?? relationship.type ?? '',
    _ci: toGraphQLCI(relationship._ci ?? relationship.ci ?? {}),
    _properties: relationship._properties ?? relationship.properties ?? {},
  };
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
        _type?: CIType;
        _status?: CIStatus;
        _environment?: Environment;
        _name?: string;
      };
      limit?: number;
      offset?: number;
    },
    _context: GraphQLContext
  ): Promise<GraphQLCI[]> => {
    const session = _context._neo4jClient.getSession();

    try {
      const { filter } = _args;
      const limit = normalizePagination(_args.limit, 100);
      const offset = normalizePagination(_args.offset, 0);
      const conditions: string[] = [];
      const params: Record<string, unknown> = {
        limit: neo4j.int(limit),
        offset: neo4j.int(offset),
      };

      if (filter?._type) {
        conditions.push('ci.type = $type');
        params.type = convertEnumToDbFormat(filter._type);
      }

      if (filter?._status) {
        conditions.push('ci.status = $status');
        params.status = convertEnumToDbFormat(filter._status);
      }

      if (filter?._environment) {
        conditions.push('ci.environment = $environment');
        params.environment = convertEnumToDbFormat(filter._environment);
      }

      if (filter?._name) {
        conditions.push('ci.name CONTAINS $name');
        params.name = filter._name;
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

      return result.records.map((record: any) => toGraphQLCI(record.get('ci').properties));
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
  ): Promise<GraphQLCI | null> => {
    try {
      const ci = await _context._loaders._ciLoader.load(_args.id);
      return ci ? toGraphQLCI(ci) : null;
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
      query: string;
      filter?: {
        _type?: CIType;
        _status?: CIStatus;
        _environment?: Environment;
        _name?: string;
      };
      limit?: number;
    },
    _context: GraphQLContext
  ): Promise<GraphQLCI[]> => {
    const session = _context._neo4jClient.getSession();

    try {
      const { query, filter } = _args;
      const conditions: string[] = ['(ci.name CONTAINS $query OR ci.external_id CONTAINS $query)'];
      const params: Record<string, unknown> = {
        query,
        limit: neo4j.int(normalizePagination(_args.limit, 50)),
      };

      if (filter?._type) {
        conditions.push('ci.type = $type');
        params.type = convertEnumToDbFormat(filter._type);
      }

      if (filter?._status) {
        conditions.push('ci.status = $status');
        params.status = convertEnumToDbFormat(filter._status);
      }

      if (filter?._environment) {
        conditions.push('ci.environment = $environment');
        params.environment = convertEnumToDbFormat(filter._environment);
      }

      if (filter?._name) {
        conditions.push('ci.name CONTAINS $name');
        params.name = filter._name;
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

      return result.records.map((record: any) => toGraphQLCI(record.get('ci').properties));
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
  ): Promise<GraphQLCI[]> => {
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

      return result.records.map((record: any) => toGraphQLCI(record.get('dep').properties));
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
  ): Promise<Array<{ _ci: GraphQLCI; _distance: number }>> => {
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

      return result.records.map((record: any) => ({
        _ci: toGraphQLCI(record.get('impacted').properties),
        _distance: record.get('distance').toNumber(),
      }));
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
    _args: {
      input: {
        _id: string;
        _externalId?: string;
        _name: string;
        _type: string;
        _status?: string;
        _environment?: string;
        _discoveredAt?: string;
        _metadata?: Record<string, unknown>;
      };
    },
    _context: GraphQLContext
  ): Promise<GraphQLCI> => {
    checkGraphQLPermission(_context, 'write');
    try {
      validateCIInput(_args.input);
      const ciInput: CIInput = {
        _id: _args.input._id,
        external_id: _args.input._externalId,
        name: _args.input._name,
        _type: convertEnumToDbFormat(_args.input._type) as CIType,
        status: _args.input._status
          ? convertEnumToDbFormat(_args.input._status) as CIStatus
          : 'active',
        environment: _args.input._environment
          ? convertEnumToDbFormat(_args.input._environment) as Environment
          : undefined,
        discovered_at: _args.input._discoveredAt ?? new Date().toISOString(),
        metadata: _args.input._metadata ?? {},
      };
      const ci = await _context._neo4jClient.createCI(ciInput);
      _context._loaders._ciLoader.clear(ci._id);
      return toGraphQLCI(ci);
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
    _args: {
      id: string;
      input: {
        _name?: string;
        _status?: string;
        _environment?: string;
        _metadata?: Record<string, unknown>;
      };
    },
    _context: GraphQLContext
  ): Promise<GraphQLCI> => {
    checkGraphQLPermission(_context, 'write');
    try {
      const updates: Partial<CIInput> = {};

      if (_args.input._name !== undefined) {
        updates.name = _args.input._name;
      }
      if (_args.input._status !== undefined) {
        updates.status = convertEnumToDbFormat(_args.input._status) as CIStatus;
      }
      if (_args.input._environment !== undefined) {
        updates.environment = convertEnumToDbFormat(_args.input._environment) as Environment;
      }
      if (_args.input._metadata !== undefined) {
        updates.metadata = _args.input._metadata;
      }

      const ci = await _context._neo4jClient.updateCI(_args.id, updates);
      _context._loaders._ciLoader.clear(_args.id);
      return toGraphQLCI(ci);
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
    checkGraphQLPermission(_context, 'write');
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
      input: {
        _fromId: string;
        _toId: string;
        _type: RelationshipType;
        _properties?: Record<string, unknown>;
      };
    },
    _context: GraphQLContext
  ): Promise<boolean> => {
    checkGraphQLPermission(_context, 'write');
    try {
      const { _fromId, _toId, _type, _properties = {} } = _args.input;
      await _context._neo4jClient.createRelationship(_fromId, _toId, _type, _properties);
      _context._loaders._relationshipLoader.clear(_fromId);
      _context._loaders._dependentLoader.clear(_toId);
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
    _args: { fromId: string; toId: string; type: RelationshipType },
    _context: GraphQLContext
  ): Promise<boolean> => {
    checkGraphQLPermission(_context, 'write');
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (from:CI {id: $fromId})-[r:${_args.type}]->(to:CI {id: $toId})
        DELETE r
        RETURN count(r) as deleted
        `,
        { fromId: _args.fromId, toId: _args.toId }
      );
      const deleted = result.records[0]?.get('deleted').toNumber() || 0;
      if (deleted === 0) {
        throw new GraphQLError('Relationship not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      _context._loaders._relationshipLoader.clear(_args.fromId);
      _context._loaders._dependentLoader.clear(_args.toId);
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
  _relationships: async (parent: CIValue, _args: any, _context: GraphQLContext) => {
    const relationships = await _context._loaders._relationshipLoader.load(parent._id);
    return relationships.map(toGraphQLRelatedCI);
  },

  /**
   * Resolve incoming relationships (dependents)
   */
  _dependents: async (parent: CIValue, _args: any, _context: GraphQLContext) => {
    const dependents = await _context._loaders._dependentLoader.load(parent._id);
    return dependents.map(toGraphQLRelatedCI);
  },

  /**
   * Resolve all dependencies recursively
   */
  _dependencies: async (parent: CIValue, _args: any, _context: GraphQLContext) => {
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH path = (ci:CI {id: $id})-[:DEPENDS_ON*1..5]->(dep:CI)
        RETURN DISTINCT dep
        `,
        { id: parent._id }
      );
      return result.records.map((record: any) => toGraphQLCI(record.get('dep').properties));
    } finally {
      await session.close();
    }
  },

  _externalId: (parent: CIValue) => parent.external_id ?? parent._externalId,
  _name: (parent: CIValue) => parent.name ?? parent._name,
  _environment: (parent: CIValue) => parent.environment ?? parent._environment,
  _createdAt: (parent: CIValue) => parent._created_at ?? parent._createdAt,
  _updatedAt: (parent: CIValue) => parent._updated_at ?? parent._updatedAt,
  _discoveredAt: (parent: CIValue) => parent._discovered_at ?? parent._discoveredAt,
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
