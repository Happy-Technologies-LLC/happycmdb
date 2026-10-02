// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/index.ts

import { randomUUID } from 'crypto';
import { GraphQLError } from 'graphql';
import { GraphQLScalarType, Kind } from 'graphql';
import neo4j from 'neo4j-driver';
import type { Integer } from 'neo4j-driver';
import { Neo4jClient } from '@cmdb/database';
import type { Schema } from 'joi';
import {
  CI,
  CIInput,
  CIType,
  CIStatus,
  Environment,
  RelationshipType,
  ciInputSchema,
  ciUpdateSchema,
  validate,
} from '@cmdb/common';
import { analyticsResolvers } from './analytics.resolver';
import { connectorResolvers } from './connector.resolvers';
import { connectorFieldResolvers } from './connector-fields.resolvers';
import { reconciliationResolvers } from './reconciliation.resolvers';
// TEMPORARILY DISABLED - V3.0
// import { itilResolvers } from './itil.resolvers';
import type { TokenPayload } from '../../auth/types';
import { checkGraphQLPermission } from '../../middleware/auth.middleware';
import { requireGraphQLOrganization } from '../require-organization';
import type { CILoaderKey } from '../dataloaders/ci-loader';

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

/** A CI create body after REST's ciInputSchema (defaults applied, values converted). */
interface ValidatedCIInput {
  id: string;
  name: string;
  type: CIType;
  status: CIStatus;
  environment?: Environment;
  discovered_at?: string;
  metadata: Record<string, unknown>;
}

/** GraphQL input field for each REST body key validated by validateAsRest. */
const GRAPHQL_FIELD_BY_REST_KEY: Record<string, string> = {
  id: '_id',
  external_id: '_externalId',
  name: '_name',
  type: '_type',
  status: '_status',
  environment: '_environment',
  discovered_at: '_discoveredAt',
  metadata: '_metadata',
};

/**
 * Validates GraphQL CI input, mapped to the REST body shape, with the REST
 * schema itself (ciInputSchema / ciUpdateSchema from @cmdb/common) and the
 * REST validation middleware's options (`validate`: abortEarly false,
 * stripUnknown true). Returns Joi's converted value, e.g. discovered_at as an
 * ISO string, exactly as REST hands it to the controller. GraphQL null means
 * "not given", so null fields are dropped first. A Joi error is BAD_USER_INPUT,
 * with each message naming the GraphQL input field.
 */
function validateAsRest<T>(schema: Schema, fields: Record<string, unknown>): T {
  const data = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)
  );
  const result = validate<T>(schema, data);
  if (!result.valid) {
    const details: Array<{ message: string; path: Array<string | number> }> = result.details ?? [];
    const messages = details.map(({ message, path }) => {
      const key = String(path[0]);
      return message.replace(`"${key}"`, `"${GRAPHQL_FIELD_BY_REST_KEY[key] ?? key}"`);
    });
    throw new GraphQLError(messages.length > 0 ? messages.join('. ') : 'Invalid CI input', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return result.value as T;
}

/** GraphQL enum value (e.g. VIRTUAL_MACHINE) in the REST/database format, or undefined. */
function enumInput(value: string | null | undefined): string | undefined {
  return typeof value === 'string' ? convertEnumToDbFormat(value) : undefined;
}

/**
 * Traversal depth spliced into `[:DEPENDS_ON*1..depth]`: defaults to 5 and must
 * be an integer from 1 to 10, the same rule as the REST CI routes.
 */
function traversalDepth(depth: number | null | undefined): number {
  if (depth === undefined || depth === null) {
    return 5;
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > 10) {
    throw new GraphQLError('Depth must be an integer between 1 and 10', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return depth;
}

/**
 * The one error for a CI that is missing or belongs to another organization,
 * so a caller cannot tell the two apart (GraphQL counterpart of the REST 404).
 */
function ciNotFound(): GraphQLError {
  return new GraphQLError('CI not found', { extensions: { code: 'NOT_FOUND' } });
}

/** Dataloader key of a CI in the caller's organization (the org is part of the cache key). */
function ciKey(id: string, organizationId: string): CILoaderKey {
  return { id, organizationId };
}

/**
 * Scoped lookup of the CI a traversal starts from, like the REST
 * relationships/dependencies/impact routes: a missing CI and another
 * organization's CI both throw the same NOT_FOUND, so an empty traversal result
 * always means an existing CI of the caller's organization.
 */
async function requireCIInOrganization(context: GraphQLContext, id: string, organizationId: string): Promise<void> {
  let ci: CI | null;
  try {
    ci = await context._loaders._ciLoader.load(ciKey(id, organizationId));
  } catch (error: any) {
    throw new GraphQLError('Failed to fetch CI', {
      extensions: { code: 'INTERNAL_SERVER_ERROR', originalError: error.message },
    });
  }
  if (!ci) {
    throw ciNotFound();
  }
}

/** Keeps only traversal paths whose every node is in the caller's organization. */
const PATH_IN_ORGANIZATION = 'all(n IN nodes(path) WHERE n.organization_id = $organizationId)';

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

/**
 * A CI timestamp as the GraphQL `String` the schema declares. Neo4j returns
 * `datetime()` properties as driver temporal objects, which GraphQL cannot
 * serialize; they are formatted exactly as REST's convertNeo4jTypes formats
 * them (`YYYY-MM-DDTHH:mm:ss.000Z`). Strings pass through unchanged.
 */
function timestampString(value: unknown): string | undefined {
  if (neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) || neo4j.isDate(value)) {
    const time = value as { hour?: number | Integer; minute?: number | Integer; second?: number | Integer };
    const pad = (part: number | Integer | undefined) =>
      String(part === undefined ? 0 : neo4j.integer.toNumber(part)).padStart(2, '0');
    const date = `${neo4j.integer.toNumber(value.year)}-${pad(value.month)}-${pad(value.day)}`;
    return `${date}T${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}.000Z`;
  }
  return typeof value === 'string' ? value : undefined;
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
    _createdAt: timestampString(ci._created_at ?? ci._createdAt ?? ci.created_at) ?? '',
    _updatedAt: timestampString(ci._updated_at ?? ci._updatedAt ?? ci.updated_at) ?? '',
    _discoveredAt: timestampString(ci._discovered_at ?? ci._discoveredAt ?? ci.discovered_at) ?? '',
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
    const organizationId = requireGraphQLOrganization(_context);
    const session = _context._neo4jClient.getSession();

    try {
      const { filter } = _args;
      const limit = normalizePagination(_args.limit, 100);
      const offset = normalizePagination(_args.offset, 0);
      // The org filter runs before SKIP/LIMIT, so other tenants' CIs never use up a page.
      const conditions: string[] = ['ci.organization_id = $organizationId'];
      const params: Record<string, unknown> = {
        organizationId,
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

      const whereClause = `WHERE ${conditions.join(' AND ')}`;
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
    const organizationId = requireGraphQLOrganization(_context);
    try {
      // A CI of another organization resolves to null, exactly like a missing one.
      const ci = await _context._loaders._ciLoader.load(ciKey(_args.id, organizationId));
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
    const organizationId = requireGraphQLOrganization(_context);
    const session = _context._neo4jClient.getSession();

    try {
      const { query, filter } = _args;
      // The org filter runs before LIMIT, so other tenants' hits never use up the page.
      const conditions: string[] = [
        'ci.organization_id = $organizationId',
        '(ci.name CONTAINS $query OR ci.external_id CONTAINS $query)',
      ];
      const params: Record<string, unknown> = {
        organizationId,
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
    const organizationId = requireGraphQLOrganization(_context);
    await requireCIInOrganization(_context, _args.id, organizationId);
    try {
      const direction = _args.direction === 'in' ? 'in' : _args.direction === 'out' ? 'out' : 'both';
      // Both ends of every relationship must be in the caller's organization.
      const key = ciKey(_args.id, organizationId);

      if (direction === 'out') {
        return await _context._loaders._relationshipLoader.load(key);
      } else if (direction === 'in') {
        return await _context._loaders._dependentLoader.load(key);
      } else {
        // For 'both', get both directions
        const [outgoing, incoming] = await Promise.all([
          _context._loaders._relationshipLoader.load(key),
          _context._loaders._dependentLoader.load(key),
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
    const organizationId = requireGraphQLOrganization(_context);
    const depth = traversalDepth(_args.depth);
    await requireCIInOrganization(_context, _args.id, organizationId);
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId
        MATCH path = (ci)-[:DEPENDS_ON*1..${depth}]->(dep:CI)
        WHERE ${PATH_IN_ORGANIZATION}
        RETURN DISTINCT dep
        `,
        { id: _args.id, organizationId }
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
    const organizationId = requireGraphQLOrganization(_context);
    const depth = traversalDepth(_args.depth);
    await requireCIInOrganization(_context, _args.id, organizationId);
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId
        MATCH path = (ci)<-[:DEPENDS_ON*1..${depth}]-(impacted:CI)
        WHERE ${PATH_IN_ORGANIZATION}
        RETURN DISTINCT impacted, length(path) as distance
        ORDER BY distance
        `,
        { id: _args.id, organizationId }
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
 * Mutation resolvers. Each resolves the caller's organization from the token
 * before any data access; a CI of another organization behaves exactly like a
 * missing one.
 */
const Mutation = {
  /**
   * Create a new CI in the caller's organization. The organization comes only
   * from the token: the input fields are whitelisted, so no input can set it.
   * CI ids and external ids are unique across all organizations, so a client
   * choosing either could probe another organization's CIs (free value:
   * created; used value: rejected). The server therefore assigns the id, and
   * neither `_id` nor `_externalId` is accepted.
   */
  createCI: async (
    __parent: unknown,
    _args: {
      input: {
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
    const organizationId = requireGraphQLOrganization(_context);
    checkGraphQLPermission(_context, 'write');
    // CreateCIInput has no such fields; this keeps a direct resolver call from
    // reaching the database with a caller-chosen globally unique key. The
    // answer is the same whatever the value.
    if ('_id' in _args.input || '_externalId' in _args.input) {
      throw new GraphQLError('CI _id and _externalId are assigned by the server and cannot be supplied', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    try {
      const input = validateAsRest<ValidatedCIInput>(ciInputSchema, {
        id: randomUUID(),
        name: _args.input._name,
        type: enumInput(_args.input._type),
        status: enumInput(_args.input._status),
        environment: enumInput(_args.input._environment),
        discovered_at: _args.input._discoveredAt,
        metadata: _args.input._metadata,
      });
      const ciInput: CIInput = {
        _id: input.id,
        name: input.name,
        _type: input.type,
        status: input.status,
        environment: input.environment,
        discovered_at: input.discovered_at ?? new Date().toISOString(),
        metadata: input.metadata,
      };
      const ci = await _context._neo4jClient.createCI(ciInput, organizationId);
      _context._loaders._ciLoader.clear(ciKey(ci._id, organizationId));
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
   * Update a CI of the caller's organization. Only name, status, environment
   * and metadata can change; organization_id is never part of the update.
   */
  updateCI: async (
    __parent: unknown,
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
    const organizationId = requireGraphQLOrganization(_context);
    checkGraphQLPermission(_context, 'write');
    try {
      if (!(await _context._neo4jClient.getCI(_args.id, organizationId))) {
        throw ciNotFound();
      }

      // Validated after the scoped lookup, so a foreign id still gets NOT_FOUND.
      const updates = validateAsRest<Partial<CIInput>>(ciUpdateSchema, {
        name: _args.input._name,
        status: enumInput(_args.input._status),
        environment: enumInput(_args.input._environment),
        metadata: _args.input._metadata,
      });

      const ci = await _context._neo4jClient.updateCI(_args.id, updates, organizationId);
      _context._loaders._ciLoader.clear(ciKey(_args.id, organizationId));
      return toGraphQLCI(ci);
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to update CI', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Delete a CI of the caller's organization; a foreign id deletes nothing
   * and gets the same NOT_FOUND as a missing one.
   */
  deleteCI: async (
    __parent: unknown,
    _args: { id: string },
    _context: GraphQLContext
  ): Promise<boolean> => {
    const organizationId = requireGraphQLOrganization(_context);
    checkGraphQLPermission(_context, 'write');
    try {
      if (!(await _context._neo4jClient.deleteCI(_args.id, organizationId))) {
        throw ciNotFound();
      }
      const key = ciKey(_args.id, organizationId);
      _context._loaders._ciLoader.clear(key);
      _context._loaders._relationshipLoader.clear(key);
      _context._loaders._dependentLoader.clear(key);
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
    }
  },

  /**
   * Create a relationship between two CIs of the caller's organization. A
   * missing or foreign endpoint writes nothing and gets NOT_FOUND.
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
    const organizationId = requireGraphQLOrganization(_context);
    checkGraphQLPermission(_context, 'write');
    try {
      const { _fromId, _toId, _type, _properties = {} } = _args.input;
      const created = await _context._neo4jClient.createRelationship(
        _fromId,
        _toId,
        _type,
        organizationId,
        _properties
      );
      if (!created) {
        throw ciNotFound();
      }
      _context._loaders._relationshipLoader.clear(ciKey(_fromId, organizationId));
      _context._loaders._dependentLoader.clear(ciKey(_toId, organizationId));
      return true;
    } catch (error: any) {
      if (error instanceof GraphQLError) {
        throw error;
      }
      throw new GraphQLError('Failed to create relationship', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
          originalError: error.message,
        },
      });
    }
  },

  /**
   * Delete a relationship between two CIs of the caller's organization
   */
  deleteRelationship: async (
    __parent: any,
    _args: { fromId: string; toId: string; type: RelationshipType },
    _context: GraphQLContext
  ): Promise<boolean> => {
    const organizationId = requireGraphQLOrganization(_context);
    checkGraphQLPermission(_context, 'write');
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (from:CI {id: $fromId})-[r:${_args.type}]->(to:CI {id: $toId})
        WHERE from.organization_id = $organizationId AND to.organization_id = $organizationId
        DELETE r
        RETURN count(r) as deleted
        `,
        { fromId: _args.fromId, toId: _args.toId, organizationId }
      );
      const deleted = result.records[0]?.get('deleted').toNumber() || 0;
      if (deleted === 0) {
        throw new GraphQLError('Relationship not found', {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      _context._loaders._relationshipLoader.clear(ciKey(_args.fromId, organizationId));
      _context._loaders._dependentLoader.clear(ciKey(_args.toId, organizationId));
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
  _relationships: async (parent: CIValue, _args: unknown, _context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(_context);
    const relationships = await _context._loaders._relationshipLoader.load(ciKey(parent._id, organizationId));
    return relationships.map(toGraphQLRelatedCI);
  },

  /**
   * Resolve incoming relationships (dependents)
   */
  _dependents: async (parent: CIValue, _args: unknown, _context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(_context);
    const dependents = await _context._loaders._dependentLoader.load(ciKey(parent._id, organizationId));
    return dependents.map(toGraphQLRelatedCI);
  },

  /**
   * Resolve all dependencies recursively, within the caller's organization
   */
  _dependencies: async (parent: CIValue, _args: unknown, _context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(_context);
    const session = _context._neo4jClient.getSession();

    try {
      const result = await session.run(
        `
        MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId
        MATCH path = (ci)-[:DEPENDS_ON*1..5]->(dep:CI)
        WHERE ${PATH_IN_ORGANIZATION}
        RETURN DISTINCT dep
        `,
        { id: parent._id, organizationId }
      );
      return result.records.map((record: any) => toGraphQLCI(record.get('dep').properties));
    } finally {
      await session.close();
    }
  },

  _externalId: (parent: CIValue) => parent.external_id ?? parent._externalId,
  _name: (parent: CIValue) => parent.name ?? parent._name,
  _environment: (parent: CIValue) => parent.environment ?? parent._environment,
  _createdAt: (parent: CIValue) => timestampString(parent._created_at ?? parent._createdAt),
  _updatedAt: (parent: CIValue) => timestampString(parent._updated_at ?? parent._updatedAt),
  _discoveredAt: (parent: CIValue) => timestampString(parent._discovered_at ?? parent._discoveredAt),
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
