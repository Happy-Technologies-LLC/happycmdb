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
  async logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AUDIT_CHAIN_PARTITION]);

        const prevResult = await client.query<{ entry_hash: string | null }>(
          `
          SELECT entry_hash FROM audit_log
          WHERE entry_hash IS NOT NULL
          ORDER BY timestamp DESC, id DESC
          LIMIT 1
          `
        );
        const prevHash = prevResult.rows[0]?.entry_hash ?? null;

        const id = randomUUID();
        const chainFields = toChainFields({
          id,
          action: entry['action'],
          actor: entry['actor'],
          entity_type: entry['entity_type'],
          entity_id: entry['entity_id'],
          metadata: entry['metadata'] ?? null,
          ip_address: entry['ip_address'] ?? null,
          user_agent: entry['user_agent'] ?? null,
        });
        const entryHash = getAuditChainKernel().computeEntryHash(chainFields, prevHash);

        await client.query(
          `
          INSERT INTO audit_log (
            id,
            entity_type,
            entity_id,
            action,
            actor,
            actor_type,
            changes,
            metadata,
            ip_address,
            user_agent,
            prev_hash,
            entry_hash
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            id,
            entry['entity_type'],
            entry['entity_id'],
            entry['action'],
            entry['actor'],
            entry['actor_type'],
            JSON.stringify(entry['changes']),
            entry['metadata'] ? JSON.stringify(entry['metadata']) : null,
            entry['ip_address'] || null,
            entry['user_agent'] || null,
            prevHash,
            entryHash,
          ]
        );

        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        throw txError;
      }
    } catch (error) {
      logger.error('Failed to log audit entry', { error, entry });
      // Don't throw - audit logging shouldn't break the main operation
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
  async verifyAuditChain(): Promise<ChainVerification> {
    const result = await this.pool.query<{
      id: string;
      entity_type: string;
      entity_id: string;
      action: string;
      actor: string;
      metadata: Record<string, any> | null;
      ip_address: string | null;
      user_agent: string | null;
      prev_hash: string | null;
      entry_hash: string | null;
    }>(
      `
      SELECT id, entity_type, entity_id, action, actor, metadata, ip_address, user_agent, prev_hash, entry_hash
      FROM audit_log
      ORDER BY timestamp ASC, id ASC
      `
    );

    const rows: ChainRow[] = result.rows.map((row) => ({
      ...toChainFields(row),
      prevHash: row.prev_hash ?? null,
      entryHash: row.entry_hash ?? null,
    }));

    return getAuditChainKernel().verifyAuditChain(rows);
  }


  /**
   * Log a CI create event
   */
  async logCICreate(ciId: string, actor: string, actorType: 'user' | 'system' | 'discovery', newData: any): Promise<void> {
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
    });
  }

  /**
   * Log a CI update event
   */
  async logCIUpdate(
    ciId: string,
    actor: string,
    actorType: 'user' | 'system' | 'discovery',
    oldData: any,
    newData: any,
    metadata?: Record<string, any>
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
      });
    }
  }

  /**
   * Log a CI delete event
   */
  async logCIDelete(ciId: string, actor: string, actorType: 'user' | 'system' | 'discovery', deletedData: any): Promise<void> {
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
    });
  }

  /**
   * Log a relationship add event
   */
  async logRelationshipAdd(
    fromId: string,
    toId: string,
    type: string,
    actor: string,
    actorType: 'user' | 'system' | 'discovery',
    properties?: Record<string, any>
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
    });
  }

  /**
   * Log a relationship remove event
   */
  async logRelationshipRemove(
    fromId: string,
    toId: string,
    type: string,
    actor: string,
    actorType: 'user' | 'system' | 'discovery',
    properties?: Record<string, any>
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
    });
  }

  /**
   * Log a discovery update event
   */
  async logDiscoveryUpdate(
    ciId: string,
    discoveryJobId: string,
    oldData: any,
    newData: any
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
      });
    }
  }

  /**
   * Query audit logs with filters and pagination
   */
  async queryAuditLogs(query: AuditLogQuery): Promise<AuditLogResponse> {
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
  async getCIAuditHistory(ciId: string, limit = 100): Promise<AuditLogEntry[]> {
    const response = await this.queryAuditLogs({
      entity_type: 'CI',
      entity_id: ciId,
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
