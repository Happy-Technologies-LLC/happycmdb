// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/api-server/src/graphql/resolvers/index.ts

import { randomUUID } from 'crypto';
import { GraphQLError } from 'graphql';
import { GraphQLScalarType, Kind } from 'graphql';
import neo4j from 'neo4j-driver';
import type { Integer } from 'neo4j-driver';
import {
  Neo4jClient, getPostgresClient, CITraversalLimitError, createCITraversalWork,
  type CITraversalWork,
} from '@cmdb/database';
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
  ciIncarnationId,
} from '@cmdb/common';
import { analyticsResolvers } from './analytics.resolver';
import { connectorResolvers } from './connector.resolvers';
import { connectorFieldResolvers } from './connector-fields.resolvers';
import { reconciliationResolvers } from './reconciliation.resolvers';
import { itilRecordQueries, itilRecordMutations, itilNestedRecords } from './itil-record.resolvers';
import type { TokenPayload } from '../../auth/types';
import { checkGraphQLPermission } from '../../middleware/auth.middleware';
import { requireGraphQLOrganization } from '../require-organization';
import type { CILoaderKey } from '../dataloaders/ci-loader';
import { GRAPHQL_PAGE_DEFAULTS, normalizePagination } from '../pagination';
import { readCIList, readSingleCI, assertNoCIGap, CIGapError, CIListUnavailableError } from '../../read-admission';
import {
  assertCIId, assertNoReservedMembers, assertRequestShape, assertStorableProperties, isReservedKey,
  journalGraphQLError, RequestShapeError,
} from '../../journal-http';

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
  /** Credential kind set by authentication, never supplied by GraphQL input. */
  credentialType?: 'jwt' | 'api-key';
  _ciTraversalWork?: () => CITraversalWork;
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

/** Default to five owned BFS hops; REST and GraphQL both permit at most ten. */
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

function traversalError(error: unknown, fallback: string): GraphQLError {
  if (error instanceof CITraversalLimitError) {
    return new GraphQLError('CI traversal resource limit exceeded', {
      extensions: { code: 'SERVICE_UNAVAILABLE' },
    });
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && (code.includes('TransactionTimedOut') || code.includes('Transaction.Terminated'))) {
    return new GraphQLError('CI traversal timed out', { extensions: { code: 'GATEWAY_TIMEOUT' } });
  }
  return new GraphQLError(fallback, { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
}

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
      const limit = normalizePagination(_args.limit, GRAPHQL_PAGE_DEFAULTS.getCIs);
      const offset = normalizePagination(_args.offset, 0);
      const conditions: string[] = ['ci.organization_id = $organizationId', 'NOT ci.id IN $pending'];
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
      return await readCIList(organizationId, async (pending, timeout) => {
        const result = await session.run(
          `MATCH (ci:CI)
           ${whereClause}
           RETURN ci ORDER BY ci.created_at DESC, ci.id SKIP $offset LIMIT $limit`,
          { ...params, pending }, { timeout }
        );
        return result.records.map(row =>
          toGraphQLCI((row.get('ci') as { properties: CIValue }).properties));
      });
    } catch (error: unknown) {
      if (error instanceof CIListUnavailableError) {
        throw new GraphQLError('CI list temporarily unavailable', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
      }
      throw new GraphQLError('Failed to fetch CIs', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
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
      const owned = await _context._neo4jClient.getCI(_args.id, organizationId);
      if (!owned) {
        await assertNoCIGap(organizationId, _args.id);
        return null;
      }
      const ci = await readSingleCI(organizationId, _args.id,
        () => _context._loaders._ciLoader.load(ciKey(_args.id, organizationId)));
      return ci ? toGraphQLCI(ci) : null;
    } catch (error: unknown) {
      if (error instanceof CIGapError) {
        throw new GraphQLError('CI is temporarily unavailable', { extensions: { code: 'CONFLICT' } });
      }
      throw new GraphQLError('Failed to fetch CI', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
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
        'NOT ci.id IN $pending',
        '(ci.name CONTAINS $query OR ci.external_id CONTAINS $query)',
      ];
      const params: Record<string, unknown> = {
        organizationId,
        query,
        limit: neo4j.int(normalizePagination(_args.limit, GRAPHQL_PAGE_DEFAULTS.searchCIs)),
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

      return await readCIList(organizationId, async (pending, timeout) => {
        const result = await session.run(
          `MATCH (ci:CI)
           WHERE ${conditions.join(' AND ')}
           RETURN ci ORDER BY ci.name, ci.id LIMIT $limit`,
          { ...params, pending }, { timeout }
        );
        return result.records.map(row =>
          toGraphQLCI((row.get('ci') as { properties: CIValue }).properties));
      });
    } catch (error: unknown) {
      if (error instanceof CIListUnavailableError) {
        throw new GraphQLError('CI list temporarily unavailable', { extensions: { code: 'SERVICE_UNAVAILABLE' } });
      }
      throw new GraphQLError('Failed to search CIs', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
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
  ): Promise<Array<{ _type: string; _ci: GraphQLCI; _properties: unknown }>> => {
    const organizationId = requireGraphQLOrganization(_context);
    await requireCIInOrganization(_context, _args.id, organizationId);
    try {
      const direction = _args.direction === 'in' ? 'in' : _args.direction === 'out' ? 'out' : 'both';
      // Both ends of every relationship must be in the caller's organization.
      const key = ciKey(_args.id, organizationId);

      // Entries are mapped like CI._relationships/_dependents, so the related CI's
      // enum and timestamp fields serialize.
      if (direction === 'out') {
        return (await _context._loaders._relationshipLoader.load(key)).map(toGraphQLRelatedCI);
      } else if (direction === 'in') {
        return (await _context._loaders._dependentLoader.load(key)).map(toGraphQLRelatedCI);
      } else {
        // For 'both', get both directions
        const [outgoing, incoming] = await Promise.all([
          _context._loaders._relationshipLoader.load(key),
          _context._loaders._dependentLoader.load(key),
        ]);
        return [...outgoing, ...incoming].map(toGraphQLRelatedCI);
      }
    } catch (error) {
      throw traversalError(error, 'Failed to fetch CI relationships');
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
    try {
      const paths = await _context._neo4jClient.getDependencies(
        _args.id, organizationId, depth,
        _context._ciTraversalWork?.() ?? createCITraversalWork()
      );
      return paths.map(path => toGraphQLCI(path.end.properties));
    } catch (error) {
      throw traversalError(error, 'Failed to fetch CI dependencies');
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
    try {
      const impacted = await _context._neo4jClient.impactAnalysis(
        _args.id, organizationId, depth,
        _context._ciTraversalWork?.() ?? createCITraversalWork()
      );
      return impacted.map(item => ({ _ci: toGraphQLCI(item._ci), _distance: item._distance }));
    } catch (error) {
      throw traversalError(error, 'Failed to perform impact analysis');
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
      assertGraphQLWriteInput(_args.input);
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
      const ci = await _context._neo4jClient.createCI(ciInput, organizationId, graphQLActor(_context));
      _context._loaders._ciLoader.clear(ciKey(ci._id, organizationId));
      return toGraphQLCI(ci);
    } catch (error: unknown) {
      throw mutationError(error, 'Failed to create CI');
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
      assertCIId(_args.id);
      assertGraphQLWriteInput(_args.input);
      const updates = validateAsRest<Partial<CIInput>>(ciUpdateSchema, {
        name: _args.input._name,
        status: enumInput(_args.input._status),
        environment: enumInput(_args.input._environment),
        metadata: _args.input._metadata,
      });

      const ci = await _context._neo4jClient.updateCI(_args.id, updates, organizationId, graphQLActor(_context));
      if (!ci) throw ciNotFound();
      _context._loaders._ciLoader.clear(ciKey(_args.id, organizationId));
      // Related CI snapshots can be cached under any neighboring CI's key.
      _context._loaders._relationshipLoader.clearAll();
      _context._loaders._dependentLoader.clearAll();
      return toGraphQLCI(ci);
    } catch (error: unknown) {
      throw mutationError(error, 'Failed to update CI');
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
      assertCIId(_args.id);
      if (!(await _context._neo4jClient.deleteCI(_args.id, organizationId, graphQLActor(_context)))) {
        throw ciNotFound();
      }
      const key = ciKey(_args.id, organizationId);
      _context._loaders._ciLoader.clear(key);
      // Deletion removes every incident edge, not just edges cached under this id.
      _context._loaders._relationshipLoader.clearAll();
      _context._loaders._dependentLoader.clearAll();
      return true;
    } catch (error: unknown) {
      throw mutationError(error, 'Failed to delete CI');
    }
  },

  /**
   * Create a relationship between two CIs of the caller's organization. A
   * missing or foreign endpoint writes nothing and gets NOT_FOUND.
   */
  createRelationship: async (
    __parent: unknown,
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
      assertCIId(_fromId);
      assertCIId(_toId);
      assertRequestShape(_properties);
      assertNoReservedMembers(_properties);
      assertStorableProperties(_properties);
      if (!(await _context._neo4jClient.writeRelationship('relationship_create', _fromId, _toId, _type,
        organizationId, graphQLActor(_context), _properties))) {
        throw ciNotFound();
      }
      _context._loaders._relationshipLoader.clear(ciKey(_fromId, organizationId));
      _context._loaders._dependentLoader.clear(ciKey(_toId, organizationId));
      return true;
    } catch (error: unknown) {
      throw mutationError(error, 'Failed to create relationship');
    }
  },

  /**
   * Delete a relationship between two CIs of the caller's organization
   */
  deleteRelationship: async (
    __parent: unknown,
    _args: { fromId: string; toId: string; type: RelationshipType },
    _context: GraphQLContext
  ): Promise<boolean> => {
    const organizationId = requireGraphQLOrganization(_context);
    checkGraphQLPermission(_context, 'write');
    try {
      assertCIId(_args.fromId);
      assertCIId(_args.toId);
      if (!(await _context._neo4jClient.writeRelationship('relationship_delete', _args.fromId, _args.toId,
        _args.type, organizationId, graphQLActor(_context)))) {
        throw new GraphQLError('Relationship not found', { extensions: { code: 'NOT_FOUND' } });
      }
      _context._loaders._relationshipLoader.clear(ciKey(_args.fromId, organizationId));
      _context._loaders._dependentLoader.clear(ciKey(_args.toId, organizationId));
      return true;
    } catch (error: unknown) {
      throw mutationError(error, 'Failed to delete relationship');
    }
  },
};

/** The verified user id: the journal actor. requireGraphQLOrganization has established `user`. */
function graphQLActor(context: GraphQLContext): string {
  const actor = context.user?._userId;
  if (!actor) throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
  return actor;
}

/** v16 §3.6/§4.4 on a direct-write input: shape limits, no reserved field or metadata member. */
function assertGraphQLWriteInput(input: Record<string, unknown>): void {
  assertRequestShape(input);
  if (Object.keys(input).some(isReservedKey)) throw new RequestShapeError();
  assertNoReservedMembers(input['_metadata']);
}

/** Journal outcomes and GraphQL errors pass through; anything else is a sanitized internal error. */
function mutationError(error: unknown, message: string): GraphQLError {
  if (error instanceof GraphQLError) return error;
  return journalGraphQLError(error) ?? new GraphQLError(message, { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
}

/**
 * CI type resolvers for nested fields
 */
const CIResolvers = {
  /**
   * Resolve outgoing relationships
   */
  _relationships: async (parent: CIValue, _args: unknown, _context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const relationships = await _context._loaders._relationshipLoader.load(ciKey(parent._id, organizationId));
      return relationships.map(toGraphQLRelatedCI);
    } catch (error) {
      throw traversalError(error, 'Failed to fetch CI relationships');
    }
  },

  /**
   * Resolve incoming relationships (dependents)
   */
  _dependents: async (parent: CIValue, _args: unknown, _context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const dependents = await _context._loaders._dependentLoader.load(ciKey(parent._id, organizationId));
      return dependents.map(toGraphQLRelatedCI);
    } catch (error) {
      throw traversalError(error, 'Failed to fetch CI dependents');
    }
  },

  /**
   * Resolve all dependencies recursively, within the caller's organization
   */
  _dependencies: async (parent: CIValue, _args: unknown, _context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(_context);
    try {
      const paths = await _context._neo4jClient.getDependencies(
        parent._id, organizationId, 5,
        _context._ciTraversalWork?.() ?? createCITraversalWork()
      );
      return paths.map(path => toGraphQLCI(path.end.properties));
    } catch (error) {
      throw traversalError(error, 'Failed to fetch CI dependencies');
    }
  },

  _externalId: (parent: CIValue) => parent.external_id ?? parent._externalId,
  _name: (parent: CIValue) => parent.name ?? parent._name,
  _environment: (parent: CIValue) => parent.environment ?? parent._environment,
  _createdAt: (parent: CIValue) => timestampString(parent._created_at ?? parent._createdAt),
  _updatedAt: (parent: CIValue) => timestampString(parent._updated_at ?? parent._updatedAt),
  _discoveredAt: (parent: CIValue) => timestampString(parent._discovered_at ?? parent._discoveredAt),
};

/** The ITIL GraphQL CI fields share the same organization boundary as REST. */
async function maybeITILCI(context: GraphQLContext, id: string, organizationId: string): Promise<Record<string, unknown> | null> {
  const owned = await context._neo4jClient.getCI(id, organizationId);
  if (!owned) {
    await assertNoCIGap(organizationId, id);
    return null;
  }
  return readSingleCI(organizationId, id, async () => {
    const session = context._neo4jClient.getSession();
    try {
      const result = await session.run(
        'MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId RETURN ci',
        { id, organizationId }, { timeout: 10_000 }
      );
      if (result.records.length === 0) return null;
      const properties = result.records[0]!.get('ci').properties as CIValue;
      return { ...properties, ...toGraphQLCI(properties) };
    } finally {
      await session.close();
    }
  });
}

async function itilCI(context: GraphQLContext, id: string, organizationId: string): Promise<Record<string, unknown>> {
  const ci = await maybeITILCI(context, id, organizationId);
  if (!ci) throw ciNotFound();
  return ci;
}

async function itilHistory(context: GraphQLContext, id: string, limit: number) {
  const organizationId = requireGraphQLOrganization(context);
  await requireCIInOrganization(context, id, organizationId);
  return readSingleCI(organizationId, id, async () => {
    const incarnationId = ciIncarnationId(await context._loaders._ciLoader.load(ciKey(id, organizationId)));
    if (!incarnationId) return [];
    const result = await getPostgresClient().pool.query(
      `SELECT h.id, h.ci_id, h.changed_at, h.changed_by, h.change_type,
              h.changed_fields, h.previous_values, h.new_values
       FROM ci_change_history h WHERE h.ci_id = $1
         AND h.organization_id = $3 AND h.ci_incarnation_id = $4
       ORDER BY h.changed_at DESC LIMIT $2`,
      [id, Math.min(Math.max(limit, 1), 500), organizationId, incarnationId]
    );
    return result.rows.map((row: {
      id: string; ci_id: string; changed_at: Date; changed_by: string;
      change_type: string; changed_fields: string[] | null;
      previous_values: unknown; new_values: unknown;
    }) => ({
      id: row.id, ciId: row.ci_id, changedAt: row.changed_at,
      changedBy: row.changed_by, changeType: row.change_type,
      attributeName: row.changed_fields?.join(', ') ?? '',
      oldValue: row.previous_values === null ? null : JSON.stringify(row.previous_values),
      newValue: row.new_values === null ? null : JSON.stringify(row.new_values),
    }));
  });
}

const itilCIQueries = {
  configurationItems: async (_parent: unknown, args: {
    lifecycle?: string; status?: string; ciType?: string; page?: number; limit?: number;
  }, context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(context);
    const session = context._neo4jClient.getSession();
    const conditions = ['ci.organization_id = $organizationId', 'NOT ci.id IN $pending'];
    const params: Record<string, unknown> = { organizationId };
    if (args.lifecycle) { conditions.push('ci.itil_lifecycle = $lifecycle'); params.lifecycle = args.lifecycle; }
    if (args.status) { conditions.push('ci.itil_config_status = $status'); params.status = args.status; }
    if (args.ciType) { conditions.push('ci.type = $ciType'); params.ciType = convertEnumToDbFormat(args.ciType); }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const page = Math.max(1, normalizePagination(args.page, 1));
    const limit = Math.min(100, Math.max(1, normalizePagination(args.limit, GRAPHQL_PAGE_DEFAULTS.configurationItems)));
    try {
      return await readCIList(organizationId, async (pending, timeout) => {
        const query = `MATCH (ci:CI) ${where}`;
        const queryParams = { ...params, pending, offset: neo4j.int((page - 1) * limit),
          limit: neo4j.int(limit) };
        const expiresAt = Date.now() + timeout;
        const remaining = () => {
          const milliseconds = expiresAt - Date.now();
          if (milliseconds <= 0) throw new CIListUnavailableError();
          return milliseconds;
        };
        const countResult = await session.run(
          `${query} RETURN count(ci) AS total`, queryParams, { timeout: remaining() });
        const pageResult = await session.run(
          `${query} RETURN ci ORDER BY ci.name, ci.id SKIP $offset LIMIT $limit`,
          queryParams, { timeout: remaining() });
        const total = countResult.records[0]!.get('total').toNumber() as number;
        return {
          items: pageResult.records.map(row => {
            const ci = (row.get('ci') as { properties: CIValue }).properties;
            return { ...ci, ...toGraphQLCI(ci) };
          }),
          total, page, limit, pages: Math.ceil(total / limit),
        };
      });
    } finally {
      await session.close();
    }
  },
  configurationItem: (_parent: unknown, args: { id: string }, context: GraphQLContext) =>
    itilCI(context, args.id, requireGraphQLOrganization(context)),
  ciHistory: (_parent: unknown, args: { id: string; limit?: number }, context: GraphQLContext) =>
    itilHistory(context, args.id, args.limit ?? GRAPHQL_PAGE_DEFAULTS.ciHistory),
  cisDueForAudit: async (_parent: unknown, args: { limit?: number }, context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(context);
    const session = context._neo4jClient.getSession();
    try {
      return await readCIList(organizationId, async (pending, timeout) => {
        const result = await session.run(
          `MATCH (ci:CI) WHERE ci.organization_id = $organizationId
           AND NOT ci.id IN $pending
           AND (ci.itil_next_audit_date <= datetime() OR ci.itil_last_audited IS NULL)
           RETURN ci ORDER BY ci.itil_next_audit_date, ci.id LIMIT $limit`,
          { organizationId, pending,
            limit: neo4j.int(Math.min(100, Math.max(1, args.limit ?? GRAPHQL_PAGE_DEFAULTS.cisDueForAudit))) },
          { timeout }
        );
        return result.records.map(row => {
          const ci = (row.get('ci') as { properties: CIValue }).properties;
          return { ...ci, ...toGraphQLCI(ci) };
        });
      });
    } finally {
      await session.close();
    }
  },
  configurationAccuracy: async (_parent: unknown, _args: unknown, context: GraphQLContext) => {
    const organizationId = requireGraphQLOrganization(context);
    const session = context._neo4jClient.getSession();
    try {
      const result = await session.run(
        `MATCH (ci:CI) WHERE ci.organization_id = $organizationId
         AND ci.itil_audit_status IS NOT NULL
         RETURN count(CASE WHEN ci.itil_audit_status = 'COMPLIANT' THEN 1 END) AS compliantCount,
                count(ci) AS totalAudited`,
        { organizationId }
      );
      const compliantCount = result.records[0]!.get('compliantCount').toNumber() as number;
      const totalAudited = result.records[0]!.get('totalAudited').toNumber() as number;
      return { accuracy: totalAudited ? compliantCount / totalAudited * 100 : 0,
        compliantCount, totalAudited, timestamp: new Date().toISOString() };
    } finally {
      await session.close();
    }
  },
};

/** ITIL lifecycle/status/audit mutations are journaled direct writes (v16 §3.1). */
async function updateITILCI(context: GraphQLContext, id: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
  const organizationId = requireGraphQLOrganization(context);
  checkGraphQLPermission(context, 'write');
  try {
    assertCIId(id);
    assertRequestShape(updates);
    const ci = await context._neo4jClient.updateCIProperties(id, updates, organizationId, graphQLActor(context)) as CIValue | null;
    if (!ci) throw ciNotFound();
    context._loaders._ciLoader.clear(ciKey(id, organizationId));
    return { ...ci, ...toGraphQLCI(ci) };
  } catch (error: unknown) {
    throw mutationError(error, 'Failed to update CI');
  }
}

function auditDate(value: string): unknown {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GraphQLError('Invalid request', { extensions: { code: 'BAD_USER_INPUT' } });
  return neo4j.types.DateTime.fromStandardDate(date);
}

const itilCIMutations = {
  updateLifecycleStage: (_parent: unknown, args: { id: string; stage: string }, context: GraphQLContext) =>
    updateITILCI(context, args.id, { itil_lifecycle: args.stage }),
  updateConfigurationStatus: (_parent: unknown, args: { id: string; status: string }, context: GraphQLContext) =>
    updateITILCI(context, args.id, { itil_config_status: args.status }),
  scheduleAudit: (_parent: unknown, args: { id: string; auditDate: string; auditor?: string; notes?: string }, context: GraphQLContext) =>
    updateITILCI(context, args.id, { itil_next_audit_date: auditDate(args.auditDate),
      itil_audit_scheduled_by: args.auditor ?? null, itil_audit_notes: args.notes ?? null }),
  completeAudit: (_parent: unknown, args: { id: string; auditStatus: string; findings?: string; completedBy: string }, context: GraphQLContext) =>
    updateITILCI(context, args.id, { itil_audit_status: args.auditStatus, itil_last_audited: neo4j.types.DateTime.fromStandardDate(new Date()),
      itil_audit_findings: args.findings ?? null, itil_audit_completed_by: args.completedBy }),
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
    ...itilCIQueries,
    ...itilRecordQueries,
  },
  Mutation: {
    ...Mutation,
    ...connectorResolvers.Mutation,
    ...reconciliationResolvers.Mutation,
    ...itilCIMutations,
    ...itilRecordMutations,
  },
  Incident: {
    affectedCI: (parent: { affectedCIId: string }, _args: unknown, context: GraphQLContext) =>
      maybeITILCI(context, parent.affectedCIId, requireGraphQLOrganization(context)),
  },
  Change: {
    affectedCIs: async (parent: { affectedCIIds: string[] }, _args: unknown, context: GraphQLContext) => {
      const organizationId = requireGraphQLOrganization(context);
      const uniqueIds = [...new Set(parent.affectedCIIds)];
      if (uniqueIds.length > 100) {
        throw new GraphQLError('Change has more than 100 distinct affected CIs',
          { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const cis = new Map<string, Record<string, unknown> | null>();
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(8, uniqueIds.length) }, async () => {
        while (next < uniqueIds.length) {
          const id = uniqueIds[next++]!;
          cis.set(id, await maybeITILCI(context, id, organizationId));
        }
      }));
      return parent.affectedCIIds.map(id => cis.get(id) ?? null);
    },
  },
  CI: {
    ...CIResolvers,
    itilAttributes: async (parent: { _id: string }, _args: unknown, context: GraphQLContext) => {
      const ci = await itilCI(context, parent._id, requireGraphQLOrganization(context));
      const field = (name: string): string | null => typeof ci[name] === 'string' ? ci[name] as string : null;
      return {
        ciClass: field('itil_class'), lifecycleStage: field('itil_lifecycle'),
        configurationStatus: field('itil_config_status'), version: field('itil_version'),
        baselineId: field('itil_baseline_id'), lastAudited: timestampString(ci['itil_last_audited']),
        auditStatus: field('itil_audit_status'), nextAuditDate: timestampString(ci['itil_next_audit_date']),
      };
    },
    history: (parent: { _id: string }, args: { limit?: number }, context: GraphQLContext) =>
      itilHistory(context, parent._id, args.limit ?? GRAPHQL_PAGE_DEFAULTS.history),
    incidents: async (parent: { _id: string }, args: { status?: string; limit?: number }, context: GraphQLContext) => {
      await itilCI(context, parent._id, requireGraphQLOrganization(context));
      return itilNestedRecords.incidents(parent._id, args, context);
    },
    changes: async (parent: { _id: string }, args: { status?: string; limit?: number }, context: GraphQLContext) => {
      await itilCI(context, parent._id, requireGraphQLOrganization(context));
      return itilNestedRecords.changes(parent._id, args, context);
    },
  },
  JSON: JSONScalar,
  AnalyticsQuery: analyticsResolvers.AnalyticsQuery,
  ReconciliationQuery: reconciliationResolvers.ReconciliationQuery,
  ReconciliationMutation: reconciliationResolvers.ReconciliationMutation,
  ...connectorFieldResolvers,
};
