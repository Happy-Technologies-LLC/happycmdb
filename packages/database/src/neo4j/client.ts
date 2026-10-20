// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// packages/database/src/neo4j/client.ts

import neo4j, { AuthToken, Config, Driver, Session, Node, Relationship, Path, PathSegment } from 'neo4j-driver';
import { randomUUID } from 'crypto';
import { logger, CI, CIInput, ciIncarnationId, CIAnalyticsLimitError, MAX_CI_ANALYTICS_NODES, sanitizeCITypeForLabel, validateRelationshipType } from '@cmdb/common';
import * as fs from 'fs';
import * as path from 'path';
import { getPostgresClient } from '../postgres/client';
import { enc } from '../journal/encoding';
import {
  assertJournalSchema, JournalGapError, JournalGraphRunner, JournalTargetMissingError, ReconciliationJournal, StoredPlan,
} from '../journal/journal';

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


export const MAX_CI_TRAVERSAL_NODES = 100;
export const MAX_CI_TRAVERSAL_WORK = 400;
const CI_TRAVERSAL_QUERY_TIMEOUT_MS = 5000;

export class CITraversalLimitError extends Error {
  constructor() {
    super('CI traversal resource limit exceeded');
  }
}

export interface CITraversalWork {
  remaining: number;
  nodes: Set<string>;
  pending: Promise<void>;
}

export function createCITraversalWork(): CITraversalWork {
  return { remaining: MAX_CI_TRAVERSAL_WORK, nodes: new Set<string>(), pending: Promise.resolve() };
}

/** Serialize sibling traversals, reserving the remaining row allowance before Neo4j runs. */
export async function runWithinCITraversalBudget<T>(
  work: CITraversalWork, run: (rowLimit: number) => Promise<T[]>
): Promise<T[]> {
  const previous = work.pending;
  let release!: () => void;
  work.pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await previous;
    const reserved = work.remaining;
    if (reserved === 0) throw new CITraversalLimitError();
    work.remaining -= reserved;
    const records = await run(reserved + 1);
    if (records.length > reserved) throw new CITraversalLimitError();
    work.remaining += reserved - records.length;
    return records;
  } finally {
    release();
  }
}

type TraversalEdge = {
  source: Node;
  target: Node;
  relationship: Relationship;
  startNodeId: string;
  endNodeId: string;
};

type TraversalNode = { node: Node; distance: number };

export class Neo4jClient {
  private driver: Driver;
  private activeCIAnalyticsReads = 0;
  private readonly driverConfig: Config;
  private readonly connection: { uri: string; auth: AuthToken };
  /** v16 §4.2: W and the recovery fence run on a dedicated driver with a 5 s acquisition bound. */
  private journalDriver?: Driver;
  private readonly runJournalStatement: JournalGraphRunner = async (query, params) => {
    this.journalDriver ??= neo4j.driver(this.connection.uri, this.connection.auth,
      { ...this.driverConfig, connectionAcquisitionTimeout: 5_000 });
    const session = this.journalDriver.session({ database: 'neo4j' });
    try {
      // Auto-commit only: never executeWrite (managed retry) and never re-sent.
      return (await session.run(query, params, { timeout: 10_000 })).records.map(record => record.toObject());
    } finally {
      await session.close();
    }
  };
  readonly journal = new ReconciliationJournal(this.runJournalStatement);

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

    this.driverConfig = {
      maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
      maxConnectionPoolSize: 50,
      encrypted: sslEnabled ? 'ENCRYPTION_ON' : 'ENCRYPTION_OFF',
      trust: trustStrategy,
    };
    this.connection = { uri, auth: neo4j.auth.basic(username, password) };
    this.driver = neo4j.driver(uri, this.connection.auth, {
      ...this.driverConfig,
      connectionAcquisitionTimeout: 2 * 60 * 1000, // 2 minutes
    });

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
    await this.journalDriver?.close();
    await this.driver.close();
  }

  // CI Operations
  /** Pre-journal unscoped create kept ONLY for the S5-owned ETL writer (HP1-S5 cutover). */
  async legacyCreateCIUnjournaled(ci: CIInput, scope: CIOrganizationScope): Promise<CI> {
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
          incarnation_id: randomUUID(),
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

  /** Raw stored properties of an owned CI (metadata stays its stored string). */
  private async ownedProperties(id: string, organizationId: string): Promise<Record<string, unknown> | null> {
    const session = this.getSession();
    try {
      const result = await session.run(
        'MATCH (ci:CI {id: $id}) WHERE ci.organization_id = $organizationId RETURN properties(ci) AS props',
        { id, organizationId }, { timeout: 10_000 });
      return result.records.length ? result.records[0]!.get('props') as Record<string, unknown> : null;
    } finally {
      await session.close();
    }
  }

  /**
   * v16 §5.2 steps 5–6: schema gate, then the owned lookup. A missing or
   * foreign CI is `false` (the caller's identical 404); the caller's own
   * pending/failed operation on the id is the gap 409.
   */
  private async admitOwned(organizationId: string, ids: string[]): Promise<boolean> {
    await assertJournalSchema(this.runJournalStatement);
    for (const id of ids) {
      if (await this.getCI(id, organizationId, 10_000)) continue;
      const gap = await getPostgresClient().query(`SELECT 1 FROM ci_reconciliation_operations
        WHERE organization_id = $1 AND ci_id = $2 AND state IN ('pending', 'failed') LIMIT 1`, [organizationId, id]);
      if (gap.rows.length) throw new JournalGapError();
      return false;
    }
    return true;
  }

  // CI operations. Every :CI mutation below is one journaled, fenced operation (v16 §3, §4).
  /** Direct create; a client-chosen `id` is the immutable identity and journal key. */
  async createCI(ci: CIInput, organizationId: string, actor: string): Promise<CI> {
    await assertJournalSchema(this.runJournalStatement);
    const id = (ci as { id?: string }).id || ci._id || randomUUID();
    const type = (ci as { type?: string }).type || ci._type;
    const label = sanitizeCITypeForLabel(type);
    const props = {
      external_id: ci.external_id ?? null, name: ci.name, type, status: ci.status || 'active',
      environment: ci.environment || 'development',
      discovered_at: neo4j.types.DateTime.fromStandardDate(new Date(ci.discovered_at || Date.now())),
      discovery_provider: (ci as { discovery_provider?: string }).discovery_provider || null,
      metadata: JSON.stringify(ci.metadata || {}), incarnation_id: randomUUID(),
    };
    return this.journal.run({
      organizationId, actor, operation: 'direct_write', ciIds: [id],
      plan: async () => ({ graph: { kind: 'create', label, params: enc({ id, props }) } }),
      result: async () => (await this.getCI(id, organizationId))!,
    });
  }

  /**
   * Journaled property update of an owned CI; values are stored as given
   * (callers validate them as Neo4j-storable). Null when missing or foreign.
   * Identity, tenant, fence aliases and the incarnation never change in place.
   * With `mergeSource` it is the reconciliation `update` (v16 §3.1), whose T2
   * writes one org-stamped `updated` history row; direct writes are state only (A-10).
   */
  async updateCIProperties(id: string, props: Record<string, unknown>, organizationId: string, actor: string,
    mergeSource?: string): Promise<Record<string, unknown> | null> {
    if (Object.keys(props).some(key => ['id', 'organization_id', 'organizationid', 'op_id', 'reconciliation_op_id',
      'created_at', 'incarnation_id'].includes(key.replace(/^_+/, '').toLowerCase()))) {
      throw new Error('CI identity and incarnation cannot be updated');
    }
    if (!(await this.admitOwned(organizationId, [id]))) return null;
    try {
      return await this.journal.run({
        organizationId, actor, operation: mergeSource ? 'update' : 'direct_write', ciIds: [id],
        plan: async (): Promise<StoredPlan> => {
          const current = await this.ownedProperties(id, organizationId);
          if (!current) throw new JournalTargetMissingError();
          // A pre-incarnation node gets its marker in the same W, so the history row names it.
          const existing = current['incarnation_id'];
          const incarnationId = typeof existing === 'string' ? existing : randomUUID();
          const write = typeof existing === 'string' ? props : { ...props, incarnation_id: incarnationId };
          return {
            graph: { kind: 'update', label: null, params: enc({ id, props: write }) },
            ...(mergeSource ? { history: {
              changeType: 'updated' as const, changedFields: Object.keys(props), source: mergeSource,
              previous: enc(Object.fromEntries(Object.keys(props).map(key => [key, current[key] ?? null]))),
              next: enc(props), incarnationId: ciIncarnationId(incarnationId),
            } } : {}),
          };
        },
        result: () => this.ownedProperties(id, organizationId),
      });
    } catch (error) {
      if (error instanceof JournalTargetMissingError) return null;
      throw error;
    }
  }

  async updateCI(id: string, updates: Partial<CIInput>, organizationId: string, actor: string): Promise<CI | null> {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === null) continue;
      props[key] = key === 'metadata' ? JSON.stringify(value) : value;
    }
    return await this.updateCIProperties(id, props, organizationId, actor) ? this.getCI(id, organizationId) : null;
  }

  /**
   * Journaled restore (v16 §4.1): `props` and the timestamps come from an
   * owned baseline; the caller has dropped reserved keys. Null when missing or foreign.
   */
  async restoreCI(id: string, props: Record<string, unknown>, createdAt: unknown, discoveredAt: unknown,
    organizationId: string, actor: string): Promise<Record<string, unknown> | null> {
    if (!(await this.admitOwned(organizationId, [id]))) return null;
    try {
      return await this.journal.run({
        organizationId, actor, operation: 'restore', ciIds: [id],
        plan: async () => ({ graph: { kind: 'restore', label: null, params: enc({ id, props, createdAt, discoveredAt }) } }),
        result: () => this.ownedProperties(id, organizationId),
      });
    } catch (error) {
      if (error instanceof JournalTargetMissingError) return null;
      throw error;
    }
  }

  /** Enumerate at most one bounded page; never serialize an entire tenant graph into SQL. */
  async listCIIncarnations(scope: CIOrganizationScope): Promise<Array<{
    ciId: string; incarnationId: string; organizationId: string; ciType: string | null
  }>> {
    if (this.activeCIAnalyticsReads >= 8) throw new CIAnalyticsLimitError();
    this.activeCIAnalyticsReads++;
    const organizationId = organizationIdParam(scope);
    try {
      const session = this.getSession();
      try {
        const result = await session.run(
          `MATCH (ci:CI) WHERE ${organizationId === null ? 'ci.organization_id IS NOT NULL' : 'ci.organization_id = $organizationId'}
           RETURN ci.id AS ciId, ci.incarnation_id AS incarnationId, ci.organization_id AS ownerId,
                  coalesce(ci.type, ci.ci_type) AS ciType
           LIMIT $rowLimit`,
          { organizationId, rowLimit: neo4j.int(MAX_CI_ANALYTICS_NODES + 1) },
          { timeout: 5000 }
        );
        if (result.records.length > MAX_CI_ANALYTICS_NODES) throw new CIAnalyticsLimitError();
        const incarnations: Array<{ ciId: string; incarnationId: string; organizationId: string; ciType: string | null }> = [];
        for (const record of result.records) {
          const incarnationId = ciIncarnationId(record.get('incarnationId') as string | null);
          const ownerId = record.get('ownerId');
          if (incarnationId && typeof ownerId === 'string') {
            incarnations.push({ ciId: record.get('ciId') as string, incarnationId,
              organizationId: ownerId, ciType: record.get('ciType') as string | null });
          }
        }
        return incarnations;
      } finally {
        await session.close();
      }
    } finally {
      this.activeCIAnalyticsReads--;
    }
  }

  /**
   * Tenant-only keyset pages for anomaly aggregates. Never return a partial
   * aggregate after the work budget is exhausted, even if some rows are NULL.
   * Single-CI mutations use getCI instead and are independent of tenant size.
   */
  async *iterateScopedAnomalyIncarnationPages(scope: CIOrganizationScope): AsyncGenerator<Array<{
    ciId: string; incarnationId: string
  }>> {
    const organizationId = organizationIdParam(scope);
    if (!organizationId) throw new CIAnalyticsLimitError();
    if (this.activeCIAnalyticsReads >= 8) throw new CIAnalyticsLimitError();
    this.activeCIAnalyticsReads++;
    let afterId = '';
    try {
      for (let page = 0; page < 8; page++) {
        const session = this.getSession();
        let records: Array<{ get(key: string): unknown }>;
        try {
          const result = await session.run(
            `MATCH (ci:CI)
             WHERE ci.organization_id = $organizationId AND ci.id > $afterId
             RETURN ci.id AS ciId, ci.incarnation_id AS incarnationId
             ORDER BY ci.id LIMIT $rowLimit`,
            { organizationId, afterId, rowLimit: neo4j.int(MAX_CI_ANALYTICS_NODES + 1) },
            { timeout: 5000 }
          );
          records = result.records;
        } finally {
          await session.close();
        }
        const count = Math.min(records.length, MAX_CI_ANALYTICS_NODES);
        if (count === 0) return;
        const incarnations: Array<{ ciId: string; incarnationId: string }> = [];
        for (let i = 0; i < count; i++) {
          const record = records[i]!;
          const incarnationId = ciIncarnationId(record.get('incarnationId') as string | null);
          if (incarnationId) incarnations.push({ ciId: record.get('ciId') as string, incarnationId });
        }
        afterId = records[count - 1]!.get('ciId') as string;
        if (incarnations.length > 0) yield incarnations;
        if (records.length <= MAX_CI_ANALYTICS_NODES) return;
      }
      throw new CIAnalyticsLimitError();
    } finally {
      this.activeCIAnalyticsReads--;
    }
  }

  /**
   * System anomaly scans consume every organization in bounded keyset pages.
   * This does not share request analytics admission: tenant traffic cannot
   * suppress a scheduled scan by filling the request concurrency slots.
   */
  async *iterateUnscopedCIIncarnationPages(): AsyncGenerator<Array<{
    ciId: string; incarnationId: string; organizationId: string; ciType: string | null
  }>> {
    let afterId = '';
    while (true) {
      const session = this.getSession();
      let records: Array<{ get(key: string): unknown }>;
      try {
        const result = await session.run(
          `MATCH (ci:CI)
           WHERE ci.id > $afterId AND ci.organization_id IS NOT NULL
           RETURN ci.id AS ciId, ci.incarnation_id AS incarnationId, ci.organization_id AS ownerId,
                  coalesce(ci.type, ci.ci_type) AS ciType
           ORDER BY ci.id
           LIMIT $rowLimit`,
          { afterId, rowLimit: neo4j.int(MAX_CI_ANALYTICS_NODES) },
          { timeout: 5000 }
        );
        records = result.records;
      } finally {
        await session.close();
      }
      if (records.length === 0) return;
      afterId = records[records.length - 1]!.get('ciId') as string;
      const incarnations: Array<{ ciId: string; incarnationId: string; organizationId: string; ciType: string | null }> = [];
      for (const record of records) {
        const incarnationId = ciIncarnationId(record.get('incarnationId') as string | null);
        const ownerId = record.get('ownerId');
        if (incarnationId && typeof ownerId === 'string') {
          incarnations.push({ ciId: record.get('ciId') as string, incarnationId,
            organizationId: ownerId, ciType: record.get('ciType') as string | null });
        }
      }
      if (incarnations.length > 0) yield incarnations;
      if (records.length < MAX_CI_ANALYTICS_NODES) return;
    }
  }

  async getCI(id: string, scope: CIOrganizationScope, timeoutMs?: number): Promise<CI | null> {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (ci:CI {id: $id}) ${nodeScopeClause(organizationId)} RETURN ci`,
        { id, organizationId },
        timeoutMs === undefined ? undefined : { timeout: timeoutMs }
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
   * Existing graph CIs predate incarnation IDs. Assign on the first owned
   * derived write, atomically in Neo4j; racing writers receive the same ID.
   * An absent/foreign CI returns null without exposing which case occurred.
   */
  async ensureCIIncarnation(id: string, scope: CIOrganizationScope, timeoutMs?: number): Promise<string | null> {
    const organizationId = organizationIdParam(scope);
    const session = this.getSession();
    try {
      const result = await session.run(
        `MATCH (ci:CI {id: $id})
         ${nodeScopeClause(organizationId)}
         SET ci.incarnation_id = coalesce(ci.incarnation_id, randomUUID())
         RETURN ci.incarnation_id AS incarnationId`,
        { id, organizationId },
        timeoutMs === undefined ? undefined : { timeout: timeoutMs }
      );
      return result.records.length ? result.records[0]!.get('incarnationId') as string : null;
    } finally {
      await session.close();
    }
  }

  /**
   * Journaled delete (v16 §6.4). The snapshot is the raw property map read by
   * one statement under the slot; T2 writes exactly one org-stamped `deleted`
   * history row and purges this incarnation's derived drift/impact rows. Prior
   * history is evidence and is never purged. False when missing or foreign.
   */
  async deleteCI(id: string, organizationId: string, actor: string): Promise<boolean> {
    if (!(await this.admitOwned(organizationId, [id]))) return false;
    try {
      return await this.journal.run({
        organizationId, actor, operation: 'delete', ciIds: [id],
        plan: async (): Promise<StoredPlan> => {
          const props = await this.ownedProperties(id, organizationId);
          if (!props) throw new JournalTargetMissingError();
          return {
            graph: { kind: 'delete', label: null, params: enc({ id }) },
            history: { changeType: 'deleted', changedFields: ['*'], source: 'api', previous: enc(props), next: null,
              incarnationId: ciIncarnationId(props['incarnation_id'] as string | null) },
          };
        },
        result: async () => true,
      });
    } catch (error) {
      if (error instanceof JournalTargetMissingError) return false;
      throw error;
    }
  }

  /**
   * Journaled two-key relationship write (both endpoints reserved in one T1,
   * one W with two fences). False (nothing written) when either endpoint is
   * missing or foreign, or, on delete, when no such relationship exists.
   */
  async writeRelationship(kind: 'relationship_create' | 'relationship_delete', fromId: string, toId: string,
    type: string, organizationId: string, actor: string, props: Record<string, unknown> = {}): Promise<boolean> {
    const label = validateRelationshipType(type);
    if (!(await this.admitOwned(organizationId, [fromId, toId]))) return false;
    try {
      return await this.journal.run({
        organizationId, actor, operation: 'relationship_write', ciIds: [fromId, toId],
        plan: async () => ({ graph: { kind, label, params: enc({ from: fromId, to: toId, props }) } }),
        result: async () => true,
      });
    } catch (error) {
      if (error instanceof JournalTargetMissingError) return false;
      throw error;
    }
  }

  /**
   * Expand owned CI nodes once per hop. Each statement caps adjacency rows
   * before transfer; the shared budget also charges parallel relationships.
   */
  private async traverseCIs(
    ciId: string, scope: CIOrganizationScope, depth: number,
    direction: 'in' | 'out', dependencyOnly: boolean, work: CITraversalWork
  ): Promise<{ nodes: TraversalNode[]; edges: TraversalEdge[]; paths: Path[] }> {
    const organizationId = organizationIdParam(scope);
    if (!Number.isInteger(depth) || depth < 1 || depth > 10) throw new CITraversalLimitError();
    work.nodes.add(ciId);
    if (work.nodes.size > MAX_CI_TRAVERSAL_NODES) throw new CITraversalLimitError();
    const session = this.getSession();
    const nodes: TraversalNode[] = [];
    const edges: TraversalEdge[] = [];
    const discovered = new Set<string>([ciId]);
    const nodeById = new Map<string, Node>();
    const parents = new Map<string, { sourceId: string; relationship: Relationship }>();
    let frontier = [ciId];
    const relation = dependencyOnly ? ':DEPENDS_ON' : '';
    const pattern = direction === 'out'
      ? `(source)-[relationship${relation}]->(target:CI)`
      : `(source)<-[relationship${relation}]-(target:CI)`;
    try {
      for (let distance = 1; distance <= depth && frontier.length > 0; distance++) {
        const records = await runWithinCITraversalBudget(work, async rowLimit => {
          const result = await session.run(
            `UNWIND $frontier AS sourceId
             MATCH (source:CI {id: sourceId})
             ${organizationId === null ? '' : 'WHERE source.organization_id = $organizationId'}
             MATCH ${pattern}
             ${organizationId === null ? '' : 'WHERE target.organization_id = $organizationId'}
             RETURN DISTINCT source, target, relationship,
                    startNode(relationship).id AS startNodeId,
                    endNode(relationship).id AS endNodeId
             LIMIT $rowLimit`,
            { frontier, organizationId, rowLimit: neo4j.int(rowLimit) },
            { timeout: CI_TRAVERSAL_QUERY_TIMEOUT_MS }
          );
          return result.records;
        });
        const next: string[] = [];
        for (const record of records) {
          const source = record.get('source') as Node;
          const target = record.get('target') as Node;
          const relationship = record.get('relationship') as Relationship;
          const sourceId = source.properties['id'] as string;
          const targetId = target.properties['id'] as string;
          nodeById.set(sourceId, source);
          edges.push({
            source, target, relationship,
            startNodeId: record.get('startNodeId'),
            endNodeId: record.get('endNodeId'),
          });
          if (discovered.has(targetId)) continue;
          discovered.add(targetId);
          work.nodes.add(targetId);
          if (work.nodes.size > MAX_CI_TRAVERSAL_NODES) throw new CITraversalLimitError();
          nodeById.set(targetId, target);
          parents.set(targetId, { sourceId, relationship });
          nodes.push({ node: target, distance });
          next.push(targetId);
        }
        frontier = next;
      }
      const paths: Path[] = [];
      for (const { node } of nodes) {
        const segments: PathSegment[] = [];
        let at = node.properties['id'] as string;
        while (at !== ciId) {
          const parent = parents.get(at)!;
          segments.push(new neo4j.types.PathSegment(
            nodeById.get(parent.sourceId)!, parent.relationship, nodeById.get(at)!
          ));
          at = parent.sourceId;
        }
        segments.reverse();
        paths.push(new neo4j.types.Path(nodeById.get(ciId)!, node, segments));
      }
      return { nodes, edges, paths };
    } finally {
      await session.close();
    }
  }

  async getRelationships(
    ciId: string, scope: CIOrganizationScope,
    direction: 'in' | 'out' | 'both' = 'both', depth: number = 1,
    work: CITraversalWork = createCITraversalWork()
  ) {
    const seen = new Set<string>();
    const relationships: Array<{
      _type: string; _ci: CI; _startCI: CI; _endCI: CI; _properties: Record<string, unknown>;
      _startNodeId: string; _endNodeId: string;
    }> = [];
    for (const orientation of (direction === 'both' ? ['out', 'in'] : [direction]) as Array<'out' | 'in'>) {
      const traversal = await this.traverseCIs(ciId, scope, depth, orientation, false, work);
      for (const edge of traversal.edges) {
        const type = edge.relationship.type;
        const key = JSON.stringify([type, edge.startNodeId, edge.endNodeId]);
        if (seen.has(key)) continue;
        seen.add(key);
        const origin = this.recordToCI(edge.source);
        const neighbor = this.recordToCI(edge.target);
        const originIsStart = edge.startNodeId === origin._id;
        relationships.push({
          _type: type,
          _ci: neighbor,
          _startCI: originIsStart ? origin : neighbor,
          _endCI: originIsStart ? neighbor : origin,
          _properties: edge.relationship.properties,
          _startNodeId: edge.startNodeId,
          _endNodeId: edge.endNodeId,
        });
      }
    }
    return relationships;
  }

  /** One shortest owned path per reachable dependency; never enumerate paths. */
  async getDependencies(
    ciId: string, scope: CIOrganizationScope, depth: number = 5,
    work: CITraversalWork = createCITraversalWork()
  ): Promise<Path[]> {
    return (await this.traverseCIs(ciId, scope, depth, 'out', true, work)).paths;
  }

  async impactAnalysis(
    ciId: string, scope: CIOrganizationScope, depth: number = 5,
    work: CITraversalWork = createCITraversalWork()
  ) {
    return (await this.traverseCIs(ciId, scope, depth, 'in', true, work)).nodes.map(({ node, distance }) => ({
      _ci: this.recordToCI(node), _distance: distance,
    }));
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
      _incarnation_id: props.incarnation_id,
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

/** v16 §4.3: every journaling process sweeps eligible pending operations every 15 s. Returns a stop function. */
export function startJournalSweeper(intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    getNeo4jClient().journal.sweep()
      .catch(() => logger.warn('HP1 journal sweep failed; retrying next interval'))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
