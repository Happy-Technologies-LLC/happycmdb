// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/database/src/neo4j/client.ts

import neo4j, { Driver, Session } from 'neo4j-driver';
import { logger, CI, CIInput, sanitizeCITypeForLabel, validateRelationshipType } from '@cmdb/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Explicit opt-out of CI tenant scoping, for callers that have no request
 * organization: system jobs (ETL, reconciliation) and API paths whose tenant
 * scoping has not landed yet. Reads and traversals match CIs of every
 * organization; createCI writes no organization_id, so org-scoped reads never
 * return that CI.
 */
export const UNSCOPED_CI_ACCESS: unique symbol = Symbol('UNSCOPED_CI_ACCESS');

/**
 * Tenant scope of a CI operation: the caller's organization id, or
 * UNSCOPED_CI_ACCESS. With an organization id, reads/updates/deletes only match
 * :CI nodes whose organization_id equals it, traversals never hop through or
 * return a node of another organization, and createCI stamps it.
 */
export type CIOrganizationScope = string | typeof UNSCOPED_CI_ACCESS;

/** The $organizationId parameter for a scope; null only for UNSCOPED_CI_ACCESS. */
function organizationIdParam(scope: CIOrganizationScope): string | null {
  if (scope === UNSCOPED_CI_ACCESS) {
    return null;
  }
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new Error('CI organization scope must be an organization id or UNSCOPED_CI_ACCESS');
  }
  return scope;
}

/** WHERE clause restricting `ci` to the scope's organization ('' when unscoped). */
function nodeScopeClause(organizationId: string | null): string {
  return organizationId === null ? '' : 'WHERE ci.organization_id = $organizationId';
}

/** WHERE clause keeping only paths whose every node is in the scope's organization. */
function pathScopeClause(organizationId: string | null): string {
  return organizationId === null
    ? ''
    : 'WHERE all(n IN nodes(path) WHERE n.organization_id = $organizationId)';
}

export class Neo4jClient {
  private driver: Driver;

  constructor(uri: string, username: string, password: string, config?: {
    encrypted?: boolean;
    trust?: 'TRUST_ALL_CERTIFICATES' | 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES';
  }) {
    // Determine if encryption should be enabled
    const sslEnabled = process.env['NEO4J_SSL_ENABLED'] === 'true' ||
                       process.env['NEO4J_ENCRYPTION'] === 'true' ||
                       config?.encrypted === true;

    // Determine trust strategy
    const trustStrategy = config?.trust ||
                         (process.env['NEO4J_SSL_TRUST_STRATEGY'] as any) ||
                         'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES';

    this.driver = neo4j.driver(
      uri,
      neo4j.auth.basic(username, password),
      {
        maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 2 * 60 * 1000, // 2 minutes
        encrypted: sslEnabled ? 'ENCRYPTION_ON' : 'ENCRYPTION_OFF',
        trust: trustStrategy,
      }
    );

    if (sslEnabled) {
      logger.info('Neo4j client initialized with SSL/TLS encryption enabled');
    } else {
      logger.warn('Neo4j client initialized WITHOUT encryption (development mode)');
    }
  }

  async verifyConnectivity(): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('RETURN 1');
      logger.info('Neo4j connection verified');
    } finally {
      await session.close();
    }
  }

  /**
   * Initialize Neo4j database schema by executing the init-neo4j.cypher script
   * Creates constraints, indexes, and full-text search capabilities
   * @param schemaFilePath - Optional custom path to schema file
   */
  async initializeSchema(schemaFilePath?: string): Promise<void> {
    const session = this.driver.session();

    try {
      // Determine the schema file path
      const defaultSchemaPath = path.resolve(
        __dirname,
        '../../../../infrastructure/scripts/init-neo4j.cypher'
      );
      const filePath = schemaFilePath || defaultSchemaPath;

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`Schema file not found at: ${filePath}`);
      }

      // Read the Cypher script
      const cypherScript = fs.readFileSync(filePath, 'utf-8');

      // Split the script into individual statements
      // Filter out comments and empty lines
      const statements = cypherScript
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => {
          // Remove empty statements and comment-only lines
          const lines = stmt.split('\n').filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('//');
          });
          return lines.length > 0;
        });

      logger.info(`Initializing Neo4j schema from: ${filePath}`);
      logger.info(`Executing ${statements.length} statements...`);

      // Execute each statement
      let successCount = 0;
      let skipCount = 0;

      for (const statement of statements) {
        if (!statement) continue;

        try {
          await session.run(statement);
          successCount++;

          // Log progress for major operations
          if (statement.includes('CREATE CONSTRAINT')) {
            const match = statement.match(/FOR \((\w+):(\w+)\)/);
            if (match) {
              logger.info(`Created constraint for :${match[2]}`);
            }
          } else if (statement.includes('CREATE INDEX')) {
            const match = statement.match(/FOR \((\w+):(\w+)\)/);
            if (match) {
              logger.info(`Created index for :${match[2]}`);
            }
          } else if (statement.includes('CREATE FULLTEXT INDEX')) {
            logger.info('Created full-text search index');
          }
        } catch (error: any) {
          // Skip if constraint/index already exists
          if (error.message && error.message.includes('already exists')) {
            skipCount++;
          } else {
            logger.error(`Failed to execute statement: ${statement.substring(0, 100)}...`);
            throw error;
          }
        }
      }

      logger.info(`Schema initialization complete: ${successCount} statements executed, ${skipCount} skipped (already exist)`);

      // Verify schema by showing constraints and indexes
      const constraints = await session.run('SHOW CONSTRAINTS');
      const indexes = await session.run('SHOW INDEXES');

      logger.info(`Total constraints: ${constraints.records.length}`);
      logger.info(`Total indexes: ${indexes.records.length}`);

    } catch (error) {
      logger.error('Failed to initialize Neo4j schema', error);
      throw error;
    } finally {
      await session.close();
    }
  }

  getSession(database = 'neo4j'): Session {
    return this.driver.session({ database });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  // CI Operations
  async createCI(ci: CIInput, scope: CIOrganizationScope): Promise<CI> {
    // The organization comes only from the scope, never from the CI input.
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      // Handle both API format (id, type) and internal format (_id, _type)
      const ciId = (ci as any).id || ci._id;
      const ciType = (ci as any).type || ci._type;

      // Validate and sanitize CI type to prevent Cypher injection
      const sanitizedType = sanitizeCITypeForLabel(ciType);

      // Safe to use template literal here because sanitizedType is validated against whitelist
      const result = await session.run(
        `
        CREATE (ci:CI:${sanitizedType} {
          id: $id,
          external_id: $external_id,
          name: $name,
          type: $type,
          status: $status,
          environment: $environment,
          created_at: datetime(),
          updated_at: datetime(),
          discovered_at: datetime($discovered_at),
          discovery_provider: $discovery_provider,
          metadata: $metadata,
          organization_id: $organizationId
        })
        RETURN ci
        `,
        {
          id: ciId,
          external_id: ci.external_id ?? null,
          name: ci.name,
          type: ciType,
          status: ci.status || 'active',
          environment: ci.environment || 'development',
          discovered_at: ci.discovered_at || new Date().toISOString(),
          discovery_provider: (ci as any).discovery_provider || null,
          metadata: JSON.stringify(ci.metadata || {}),
          organizationId,
        }
      );
      return this.recordToCI(result.records[0]!.get('ci'));
    } finally {
      await session.close();
    }
  }

  async updateCI(id: string, updates: Partial<CIInput>, scope: CIOrganizationScope): Promise<CI> {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      // Process updates to handle both underscore and non-underscore prefixes
      // and stringify any nested objects
      const processedUpdates: any = {};

      for (const [key, value] of Object.entries(updates)) {
        // Remove underscore prefix if present
        const cleanKey = key.startsWith('_') ? key.substring(1) : key;

        // Skip undefined/null values
        if (value === undefined || value === null) {
          continue;
        }

        // Handle metadata specially - always stringify
        if (cleanKey === 'metadata') {
          processedUpdates[cleanKey] = JSON.stringify(value);
        }
        // Stringify any other nested objects or arrays of objects
        else if (typeof value === 'object' && value !== null) {
          // Check if it's an array of objects or a plain object
          if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
            processedUpdates[cleanKey] = JSON.stringify(value);
          } else if (!Array.isArray(value)) {
            processedUpdates[cleanKey] = JSON.stringify(value);
          } else {
            // Primitive array - keep as is
            processedUpdates[cleanKey] = value;
          }
        } else {
          // Primitive value - keep as is
          processedUpdates[cleanKey] = value;
        }
      }

      // The tenant is fixed at creation; an update must never move a CI between organizations.
      if ('organization_id' in processedUpdates) {
        throw new Error('organization_id cannot be updated');
      }

      const result = await session.run(
        `
        MATCH (ci:CI {id: $id})
        ${nodeScopeClause(organizationId)}
        SET ci += $updates,
            ci.updated_at = datetime()
        RETURN ci
        `,
        { id, updates: processedUpdates, organizationId }
      );

      if (result.records.length === 0) {
        throw new Error(`CI not found: ${id}`);
      }

      return this.recordToCI(result.records[0]!.get('ci'));
    } finally {
      await session.close();
    }
  }

  async getCI(id: string, scope: CIOrganizationScope): Promise<CI | null> {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (ci:CI {id: $id}) ${nodeScopeClause(organizationId)} RETURN ci`,
        { id, organizationId }
      );

      if (result.records.length === 0) {
        return null;
      }

      return this.recordToCI(result.records[0]!.get('ci'));
    } finally {
      await session.close();
    }
  }

  /**
   * DETACH DELETE a CI in the scope. Returns false (and deletes nothing) when
   * no CI with that id exists in the scope's organization.
   */
  async deleteCI(id: string, scope: CIOrganizationScope): Promise<boolean> {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH (ci:CI {id: $id})
        ${nodeScopeClause(organizationId)}
        DETACH DELETE ci
        RETURN count(*) AS deleted
        `,
        { id, organizationId }
      );

      return result.records[0]!.get('deleted').toNumber() > 0;
    } finally {
      await session.close();
    }
  }

  /**
   * MERGE a relationship between two CIs of the scope. Returns false (and
   * writes nothing) when either endpoint does not exist in the scope's
   * organization, so a cross-organization relationship can never be created.
   */
  async createRelationship(
    fromId: string,
    toId: string,
    type: string,
    scope: CIOrganizationScope,
    properties: Record<string, any> = {}
  ): Promise<boolean> {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      // Validate relationship type to prevent Cypher injection
      const validatedType = validateRelationshipType(type);
      const endpointScope = organizationId === null
        ? ''
        : 'WHERE from.organization_id = $organizationId AND to.organization_id = $organizationId';

      // Safe to use template literal here because validatedType is validated against whitelist
      const result = await session.run(
        `
        MATCH (from:CI {id: $fromId})
        MATCH (to:CI {id: $toId})
        ${endpointScope}
        MERGE (from)-[r:${validatedType}]->(to)
        SET r += $properties,
            r.created_at = coalesce(r.created_at, datetime()),
            r.updated_at = datetime()
        RETURN count(r) AS created
        `,
        { fromId, toId, properties, organizationId }
      );

      return result.records[0]!.get('created').toNumber() > 0;
    } finally {
      await session.close();
    }
  }

  async getRelationships(
    ciId: string,
    scope: CIOrganizationScope,
    direction: 'in' | 'out' | 'both' = 'both',
    depth: number = 1
  ) {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      // For depth > 1, we need to handle paths
      // For now, we'll query outgoing and incoming separately to preserve direction
      const queries = [];

      if (direction === 'out' || direction === 'both') {
        queries.push({
          query: `
            MATCH path = (ci:CI {id: $ciId})-[r*1..${depth}]->(related:CI)
            ${pathScopeClause(organizationId)}
            WITH ci, related, relationships(path) as rels
            UNWIND rels as r
            RETURN DISTINCT type(r) as type, related, r as relationship,
                   startNode(r).id as startNodeId, endNode(r).id as endNodeId,
                   'outgoing' as queryDirection
          `,
          params: { ciId, organizationId }
        });
      }

      if (direction === 'in' || direction === 'both') {
        queries.push({
          query: `
            MATCH path = (ci:CI {id: $ciId})<-[r*1..${depth}]-(related:CI)
            ${pathScopeClause(organizationId)}
            WITH ci, related, relationships(path) as rels
            UNWIND rels as r
            RETURN DISTINCT type(r) as type, related, r as relationship,
                   startNode(r).id as startNodeId, endNode(r).id as endNodeId,
                   'incoming' as queryDirection
          `,
          params: { ciId, organizationId }
        });
      }

      const allRelationships = [];
      for (const { query, params } of queries) {
        const result = await session.run(query, params);
        const rels = result.records.map(record => ({
          _type: record.get('type'),
          _ci: this.recordToCI(record.get('related')),
          _properties: record.get('relationship').properties,
          _startNodeId: record.get('startNodeId'),
          _endNodeId: record.get('endNodeId'),
        }));
        allRelationships.push(...rels);
      }

      // Deduplicate based on relationship type, start node, and end node
      const seen = new Set();
      return allRelationships.filter(rel => {
        const key = `${rel._type}-${rel._startNodeId}-${rel._endNodeId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } finally {
      await session.close();
    }
  }

  async getDependencies(ciId: string, scope: CIOrganizationScope, depth: number = 5) {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH path = (ci:CI {id: $ciId})-[:DEPENDS_ON*1..${depth}]->(dep:CI)
        ${pathScopeClause(organizationId)}
        RETURN path
        `,
        { ciId, organizationId }
      );

      return result.records.map(record => record.get('path'));
    } finally {
      await session.close();
    }
  }

  async impactAnalysis(ciId: string, scope: CIOrganizationScope, depth: number = 5) {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      const result = await session.run(
        `
        MATCH path = (ci:CI {id: $ciId})<-[:DEPENDS_ON*1..${depth}]-(impacted:CI)
        ${pathScopeClause(organizationId)}
        RETURN DISTINCT impacted, length(path) as distance
        ORDER BY distance
        `,
        { ciId, organizationId }
      );

      return result.records.map(record => ({
        _ci: this.recordToCI(record.get('impacted')),
        _distance: record.get('distance').toNumber(),
      }));
    } finally {
      await session.close();
    }
  }

  private recordToCI(node: any): CI {
    const props = node.properties;
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
  }
}

// Singleton instance
let neo4jClient: Neo4jClient | null = null;

export function getNeo4jClient(): Neo4jClient {
  if (!neo4jClient) {
    neo4jClient = new Neo4jClient(
      process.env['NEO4J_URI'] || 'bolt://localhost:7687',
      process.env['NEO4J_USERNAME'] || 'neo4j',
      process.env['NEO4J_PASSWORD'] || 'password'
    );
  }
  return neo4jClient;
}
