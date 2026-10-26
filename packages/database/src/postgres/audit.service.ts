// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { AuditLogEntry, AuditChange, AuditLogQuery, AuditLogResponse } from '@cmdb/common';
import { logger } from '@cmdb/common';
import {
  createAuditChain,
  type AuditChainFields,
  type ChainKernel,
  type ChainRow,
  type ChainVerification,
} from '@happy-technologies/audit';

/**
 * happycmdb's audit_log has no tenant_id column: it is a single
 * append-only log for the whole instance, so every row shares one chain
 * partition. This constant is both the `tenantId` passed into the shared
 * kernel (AuditChainFields.tenantId) and the input to `hashtext()` for the
 * per-partition Postgres advisory lock that serializes chained writes.
 */
export const AUDIT_CHAIN_PARTITION = 'global';

/**
 * Map a happycmdb audit_log row's content columns onto the shared kernel's
 * AuditChainFields. This mapping MUST be used identically at write time
 * (computeEntryHash) and at verify time (rebuilding ChainRow[] from stored
 * rows) or the chain will not verify.
 *
 *   action        -> action
 *   actor          -> actorId
 *   entity_type    -> resourceType
 *   entity_id      -> resourceId
 *   metadata       -> metadata
 *   ip_address     -> ipAddress
 *   user_agent     -> userAgent
 *   (constant)     -> tenantId ('global', single-partition log)
 */
function toChainFields(row: {
  id: string;
  action: string;
  actor: string;
  entity_type: string;
  entity_id: string;
  metadata?: Record<string, any> | null;
  ip_address?: string | null;
  user_agent?: string | null;
}): AuditChainFields {
  return {
    id: row.id,
    action: row.action,
    actorId: row.actor,
    tenantId: AUDIT_CHAIN_PARTITION,
    resourceType: row.entity_type,
    resourceId: row.entity_id,
    metadata: row.metadata ?? {},
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
  };
}

/**
 * Lazily-memoized keyed audit chain kernel, bound to the app-held secret in
 * AUDIT_CHAIN_KEY. Read lazily (not at module load) so importing this module
 * never throws when the key is unset; the error only surfaces when an audit
 * chain operation is actually attempted.
 */
let auditChainKernel: ChainKernel | null = null;

function getAuditChainKernel(): ChainKernel {
  if (!auditChainKernel) {
    const secret = process.env['AUDIT_CHAIN_KEY'];
    if (!secret) {
      throw new Error(
        'AUDIT_CHAIN_KEY environment variable is not set; it is required to compute or verify the audit hash chain'
      );
    }
    auditChainKernel = createAuditChain(secret);
  }
  return auditChainKernel;
}

/** HAP-784: whether the chain kernel can be built (AUDIT_CHAIN_KEY set); CI CRUD writes are refused without it. */
export function auditChainReady(): boolean {
  try { return Boolean(getAuditChainKernel()); } catch { return false; }
}

/**
 * Appends one hash-chained audit_log row on the caller's open transaction: logAudit's own, or the
 * HP1 journal T2 (HAP-784). The timestamp is taken after the chain lock, so verifyAuditChain's
 * (timestamp, id) order is the chain order even when the transaction began before its predecessor's.
 */
export async function appendAuditEntry(client: PoolClient, entry: Omit<AuditLogEntry, 'id' | 'timestamp'>,
  organizationId: string): Promise<void> {
  if (!organizationId || !entry['actor']) throw new Error('Verified actor and organization required');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AUDIT_CHAIN_PARTITION]);
  const prevResult = await client.query<{ entry_hash: string | null }>(
    'SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 1');
  const prevHash = prevResult.rows[0]?.entry_hash ?? null;
  const id = randomUUID();
  const metadata = { ...(entry['metadata'] ?? {}), organization_id: organizationId };
  const entryHash = getAuditChainKernel().computeEntryHash(toChainFields({
    id, action: entry['action'], actor: entry['actor'], entity_type: entry['entity_type'], entity_id: entry['entity_id'],
    metadata, ip_address: entry['ip_address'] ?? null, user_agent: entry['user_agent'] ?? null,
  }), prevHash);
  await client.query(
    `INSERT INTO audit_log (
      id, entity_type, entity_id, action, actor, actor_type, changes,
      metadata, ip_address, user_agent, prev_hash, entry_hash, organization_id, timestamp
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, clock_timestamp())`,
    [
      id, entry['entity_type'], entry['entity_id'], entry['action'],
      entry['actor'], entry['actor_type'], JSON.stringify(entry['changes']),
      JSON.stringify(metadata), entry['ip_address'] || null,
      entry['user_agent'] || null, prevHash, entryHash, organizationId,
    ]
  );
}

export type HP1ChainVerification = ChainVerification & { orgBindingViolations: string[] };

export class AuditService {
  constructor(private pool: Pool) {}

  /**
   * Log an audit entry for CI or relationship changes.
   *
   * Writes are hash-chained via the shared @happy-technologies/audit
   * kernel: inside one transaction, a Postgres advisory lock on the chain
   * partition (hashtext('global')) serializes concurrent writers, the
   * partition's last entry_hash is read, computeEntryHash() derives this
   * row's entry_hash from the mapped content fields plus that prev_hash,
   * and the row (including prev_hash + entry_hash) is inserted atomically.
   * Any DB trigger that inserts audit_log rows outside this path is NOT
   * part of the app-side chain and will appear as an unhashed (entry_hash
   * IS NULL) row when verified.
   */
  async logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>, organizationId: string): Promise<void> {
    if (!organizationId || !entry['actor']) throw new Error('Verified actor and organization required');
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      try {
        await appendAuditEntry(client, entry, organizationId);
        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      }
    } catch (error) {
      logger.error('Failed to log audit entry');
      throw error;
    } finally {
      client?.release();
    }
  }

  /**
   * Verify the audit_log hash chain for the single ('global') partition.
   * Reads rows ordered (timestamp ASC, id ASC) -- the order they were
   * written in -- rebuilds each row's AuditChainFields using the same
   * mapping as logAudit, and delegates to the shared kernel's
   * verifyAuditChain. Rows with entry_hash IS NULL (pre-migration, or
   * inserted by a path other than logAudit, e.g. a DB trigger) are treated
   * as unhashed by the kernel and are skipped until the first hashed row.
   */
  async verifyAuditChain(): Promise<HP1ChainVerification> {
    const result = await this.pool.query<{
      id: string;
      entity_type: string;
      entity_id: string;
      action: string;
      actor: string;
      metadata: Record<string, any> | null;
      organization_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      prev_hash: string | null;
      entry_hash: string | null;
    }>(
      `
      SELECT id, entity_type, entity_id, action, actor, metadata, organization_id, ip_address, user_agent, prev_hash, entry_hash
      FROM audit_log
      ORDER BY timestamp ASC, id ASC
      `
    );

    const rows: ChainRow[] = result.rows.map((row) => ({
      ...toChainFields(row),
      prevHash: row.prev_hash ?? null,
      entryHash: row.entry_hash ?? null,
    }));

    const kernel = getAuditChainKernel().verifyAuditChain(rows);
    const orgBindingViolations = result.rows.filter(row =>
      row.organization_id === null
        ? row.metadata !== null && Object.prototype.hasOwnProperty.call(row.metadata, 'organization_id')
        : row.metadata?.['organization_id'] !== row.organization_id
    ).map(row => row.id);
    return { ...kernel, ok: kernel.ok && orgBindingViolations.length === 0, orgBindingViolations };
  }


  /**
   * Log a CI create event
   */
  async logCICreate(ciId: string, organizationId: string, actor: string, actorType: 'user' | 'system' | 'discovery', newData: Record<string, unknown>): Promise<void> {
    const changes: AuditChange[] = Object.entries(newData).map(([field, value]) => ({
      field,
      old_value: null,
      new_value: value,
    }));

    await this.logAudit({
      entity_type: 'CI',
      entity_id: ciId,
      action: 'CREATE',
      actor,
      actor_type: actorType,
      changes,
    }, organizationId);
  }

  /**
   * Log a CI update event
   */
  async logCIUpdate(
    ciId: string,
    organizationId: string,
    actor: string,
    actorType: 'user' | 'system' | 'discovery',
    oldData: Record<string, unknown>,
    newData: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const changes: AuditChange[] = [];

    // Compare old and new data to find changes
    for (const [field, newValue] of Object.entries(newData)) {
      const oldValue = oldData[field];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({
          field,
          old_value: oldValue,
          new_value: newValue,
        });
      }
    }

    // Only log if there are actual changes
    if (changes.length > 0) {
      await this.logAudit({
        entity_type: 'CI',
        entity_id: ciId,
        action: 'UPDATE',
        actor,
        actor_type: actorType,
        changes,
        metadata,
      }, organizationId);
    }
  }

  /**
   * Log a CI delete event
   */
  async logCIDelete(ciId: string, organizationId: string, actor: string, actorType: 'user' | 'system' | 'discovery', deletedData: Record<string, unknown>): Promise<void> {
    const changes: AuditChange[] = Object.entries(deletedData).map(([field, value]) => ({
      field,
      old_value: value,
      new_value: null,
    }));

    await this.logAudit({
      entity_type: 'CI',
      entity_id: ciId,
      action: 'DELETE',
      actor,
      actor_type: actorType,
      changes,
    }, organizationId);
  }

  /**
   * Log a relationship add event
   */
  async logRelationshipAdd(
    fromId: string,
    toId: string,
    type: string,
    organizationId: string,
    actor: string,
    actorType: 'user' | 'system' | 'discovery',
    properties?: Record<string, unknown>
  ): Promise<void> {
    const relationshipId = `${fromId}-${type}-${toId}`;

    await this.logAudit({
      entity_type: 'RELATIONSHIP',
      entity_id: relationshipId,
      action: 'RELATIONSHIP_ADD',
      actor,
      actor_type: actorType,
      changes: [
        { field: 'from_id', old_value: null, new_value: fromId },
        { field: 'to_id', old_value: null, new_value: toId },
        { field: 'type', old_value: null, new_value: type },
        { field: 'properties', old_value: null, new_value: properties },
      ],
    }, organizationId);
  }

  /**
   * Log a relationship remove event
   */
  async logRelationshipRemove(
    fromId: string,
    toId: string,
    type: string,
    organizationId: string,
    actor: string,
    actorType: 'user' | 'system' | 'discovery',
    properties?: Record<string, unknown>
  ): Promise<void> {
    const relationshipId = `${fromId}-${type}-${toId}`;

    await this.logAudit({
      entity_type: 'RELATIONSHIP',
      entity_id: relationshipId,
      action: 'RELATIONSHIP_REMOVE',
      actor,
      actor_type: actorType,
      changes: [
        { field: 'from_id', old_value: fromId, new_value: null },
        { field: 'to_id', old_value: toId, new_value: null },
        { field: 'type', old_value: type, new_value: null },
        { field: 'properties', old_value: properties, new_value: null },
      ],
    }, organizationId);
  }

  /**
   * Log a discovery update event
   */
  async logDiscoveryUpdate(
    ciId: string,
    discoveryJobId: string,
    organizationId: string,
    oldData: Record<string, unknown>,
    newData: Record<string, unknown>
  ): Promise<void> {
    const changes: AuditChange[] = [];

    for (const [field, newValue] of Object.entries(newData)) {
      const oldValue = oldData[field];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({
          field,
          old_value: oldValue,
          new_value: newValue,
        });
      }
    }

    if (changes.length > 0) {
      await this.logAudit({
        entity_type: 'CI',
        entity_id: ciId,
        action: 'DISCOVERY_UPDATE',
        actor: 'discovery-engine',
        actor_type: 'discovery',
        changes,
        metadata: {
          discovery_job_id: discoveryJobId,
        },
      }, organizationId);
    }
  }

  /**
   * Query audit logs with filters and pagination
   */
  async queryAuditLogs(query: AuditLogQuery & { organizationId?: string }): Promise<AuditLogResponse> {
    const client = await this.pool.connect();
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (query.entity_type) {
        conditions.push(`entity_type = $${paramIndex++}`);
        params.push(query.entity_type);
      }

      if (query.entity_id) {
        conditions.push(`entity_id = $${paramIndex++}`);
        params.push(query.entity_id);
      }

      if (query.action) {
        conditions.push(`action = $${paramIndex++}`);
        params.push(query.action);
      }

      if (query.actor) {
        conditions.push(`actor = $${paramIndex++}`);
        params.push(query.actor);
      }

      if (query.from_date) {
        conditions.push(`timestamp >= $${paramIndex++}`);
        params.push(query.from_date);
      }

      if (query.to_date) {
        conditions.push(`timestamp <= $${paramIndex++}`);
        params.push(query.to_date);
      }
      if (query.organizationId) {
        conditions.push(`organization_id = $${paramIndex}::uuid AND metadata->>'organization_id' = $${paramIndex}::text`);
        params.push(query.organizationId);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = await client.query(
        `SELECT COUNT(*) as total FROM audit_log ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total, 10);

      // Get paginated results
      const limit = query.limit || 50;
      const offset = query.offset || 0;
      const page = Math.floor(offset / limit) + 1;

      const dataResult = await client.query(
        `
        SELECT
          id,
          entity_type,
          entity_id,
          action,
          actor,
          actor_type,
          changes,
          metadata,
          timestamp,
          ip_address,
          user_agent
        FROM audit_log
        ${whereClause}
        ORDER BY timestamp DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
        `,
        [...params, limit, offset]
      );

      const entries: AuditLogEntry[] = dataResult.rows.map((row) => ({
        id: row.id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        action: row.action,
        actor: row.actor,
        actor_type: row.actor_type,
        changes: row.changes,
        metadata: row.metadata,
        timestamp: row.timestamp.toISOString(),
        ip_address: row.ip_address,
        user_agent: row.user_agent,
      }));

      return {
        entries,
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get audit history for a specific CI
   */
  async getCIAuditHistory(ciId: string, organizationId: string, limit = 100): Promise<AuditLogEntry[]> {
    if (!organizationId) throw new Error('Organization required for CI audit history');
    const response = await this.queryAuditLogs({
      entity_type: 'CI',
      entity_id: ciId,
      organizationId,
      limit,
    });
    return response.entries;
  }
}

// Singleton instance
let auditService: AuditService | null = null;

export function getAuditService(pool: Pool): AuditService {
  if (!auditService) {
    auditService = new AuditService(pool);
  }
  return auditService;
}
