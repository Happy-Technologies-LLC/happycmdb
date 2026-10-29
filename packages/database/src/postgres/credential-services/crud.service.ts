// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential CRUD Operations Service
 * Handles create, read, update, delete operations for unified credentials
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  UnifiedCredential,
  UnifiedCredentialInput,
  UnifiedCredentialUpdateInput,
  UnifiedCredentialSummary,
} from '@cmdb/common';
import { getEncryptionService } from '@cmdb/common';
import { logger } from '@cmdb/common';

export interface CredentialFilters {
  protocol?: string;
  scope?: string;
  tags?: string[];
  created_by?: string;
  limit?: number;
  offset?: number;
}

/** HAP-774 §2.1: ssh is the only runnable credential-backed discovery provider. */
export const DISCOVERY_CREDENTIAL_PROTOCOLS = ['ssh_password', 'ssh_key'] as const;
export type DiscoveryCredentialProtocol = (typeof DISCOVERY_CREDENTIAL_PROTOCOLS)[number];
export const ERR_CREDENTIAL_DECODE = 'ERR_CREDENTIAL_DECODE';
export type DiscoveryCredentialResolution =
  | { ok: true; protocol: DiscoveryCredentialProtocol; credentials: Record<string, unknown> }
  | { ok: false; code: typeof ERR_CREDENTIAL_DECODE };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CredentialCRUDService {
  private encryptionService = getEncryptionService();

  constructor(private pool: Pool) {}

  private decodeStoredCredentials(raw: unknown): Record<string, unknown> {
    if (this.isEncryptionEnvelope(raw)) {
      return JSON.parse(this.encryptionService.decrypt(raw)) as Record<
        string,
        unknown
      >;
    }
    return raw as Record<string, unknown>;
  }

  private isEncryptionEnvelope(
    raw: unknown
  ): raw is { iv: string; encryptedData: string; authTag: string } {
    if (typeof raw !== 'object' || raw === null) {
      return false;
    }
    const obj = raw as Record<string, unknown>;
    return (
      typeof obj['iv'] === 'string' &&
      typeof obj['encryptedData'] === 'string' &&
      typeof obj['authTag'] === 'string'
    );
  }

  async create(
    input: UnifiedCredentialInput,
    createdBy: string,
    organizationId: string
  ): Promise<UnifiedCredential> {
    const client = await this.pool.connect();
    try {
      const id = uuidv4();

      // Encrypt the credentials object
      const encryptedData = this.encryptionService.encrypt(
        JSON.stringify(input.credentials)
      );

      const result = await client.query(
        `INSERT INTO credentials (
          id, name, description, protocol, scope, credentials,
          affinity, tags, created_by, organization_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          id,
          input.name,
          input.description || null,
          input.protocol,
          input.scope,
          encryptedData,
          input.affinity || {},
          input.tags || [],
          createdBy,
          organizationId,
        ]
      );

      const row = result.rows[0];

      logger.info('Unified credential created', {
        id: row.id,
        name: row.name,
        protocol: row.protocol,
        scope: row.scope,
        created_by: createdBy,
      });

      // Decode credentials before returning (envelope or legacy plaintext)
      const credentialsData = this.decodeStoredCredentials(row.credentials);

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        protocol: row.protocol,
        scope: row.scope,
        credentials: credentialsData,
        affinity: row.affinity,
        tags: row.tags,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_validated_at: row.last_validated_at,
        validation_status: row.validation_status,
      };
    } catch (error: any) {
      if (error.code === '23505') {
        throw new Error(
          `Credential with name '${input.name}' already exists for this user`
        );
      }
      logger.error('Failed to create unified credential', {
        error,
        input: { ...input, credentials: '***REDACTED***' },
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id: string, createdBy: string, organizationId: string): Promise<UnifiedCredential | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM credentials WHERE id = $1 AND created_by = $2 AND organization_id = $3`,
        [id, createdBy, organizationId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // Decode credentials (envelope or legacy plaintext)
      let credentialsData: Record<string, unknown>;
      try {
        credentialsData = this.decodeStoredCredentials(row.credentials);
      } catch (error) {
        logger.error('Failed to decrypt credential', { id, error });
        throw new Error(
          `Failed to decrypt credential ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        protocol: row.protocol,
        scope: row.scope,
        credentials: credentialsData,
        affinity: row.affinity,
        tags: row.tags,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_validated_at: row.last_validated_at,
        validation_status: row.validation_status,
      };
    } finally {
      client.release();
    }
  }

  /** HAP-774 C-6 gate: malformed input never reaches SQL; org, protocol and owner (if given) filter in SQL. */
  private async findDiscoveryCredential(columns: 'id' | 'protocol, credentials', id: unknown, organizationId: unknown, protocols: unknown, owner?: string) {
    const allowed = Array.isArray(protocols) ? protocols.filter((p) => (DISCOVERY_CREDENTIAL_PROTOCOLS as readonly unknown[]).includes(p)) : [];
    if (typeof id !== 'string' || !UUID.test(id) || typeof organizationId !== 'string' || !UUID.test(organizationId) || allowed.length === 0) {
      return null;
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT ${columns} FROM credentials WHERE id = $1 AND organization_id = $2 AND protocol = ANY($3::text[])${owner === undefined ? '' : ' AND created_by = $4'}`,
        owner === undefined ? [id, organizationId, allowed] : [id, organizationId, allowed, owner]
      );
      return result.rows.length === 1 ? result.rows[0] : null;
    } finally {
      client.release();
    }
  }

  /** HAP-774 C-6 attach check: selects the id only and never decodes; every refusal is the same null. */
  async assertDiscoveryCredential(id: string, organizationId: string, owner: string | undefined, protocols: readonly DiscoveryCredentialProtocol[]): Promise<string | null> {
    if (owner !== undefined && (typeof owner !== 'string' || owner === '')) {
      return null;
    }
    const row = await this.findDiscoveryCredential('id', id, organizationId, protocols, owner);
    return row ? (row.id as string) : null;
  }

  /**
   * HAP-774 C-6 execution-time resolution: decodes only a row that already matched the SQL org/protocol
   * filter. Refusals are the same null; a decode failure is a fixed code that logs no id, payload or error.
   */
  async resolveDiscoveryCredential(id: string, organizationId: string, protocols: readonly DiscoveryCredentialProtocol[]): Promise<DiscoveryCredentialResolution | null> {
    const row = await this.findDiscoveryCredential('protocol, credentials', id, organizationId, protocols);
    if (!row) {
      return null;
    }
    try {
      const credentials = this.decodeStoredCredentials(row.credentials);
      if (typeof credentials === 'object' && credentials !== null && !Array.isArray(credentials)) {
        return { ok: true, protocol: row.protocol, credentials };
      }
    } catch {
      // Dropped: the error text can carry plaintext (e.g. a JSON.parse snippet).
    }
    logger.error('Discovery credential decode failed', { code: ERR_CREDENTIAL_DECODE });
    return { ok: false, code: ERR_CREDENTIAL_DECODE };
  }

  async list(
    createdBy: string,
    organizationId: string,
    filters?: CredentialFilters
  ): Promise<UnifiedCredentialSummary[]> {
    const client = await this.pool.connect();
    try {
      const conditions: string[] = ['created_by = $1', 'organization_id = $2'];
      const params: unknown[] = [createdBy, organizationId];
      let paramIndex = 3;

      if (filters?.protocol) {
        conditions.push(`protocol = $${paramIndex++}`);
        params.push(filters.protocol);
      }

      if (filters?.scope) {
        conditions.push(`scope = $${paramIndex++}`);
        params.push(filters.scope);
      }

      if (filters?.created_by && filters.created_by !== createdBy) {
        return [];
      }

      if (filters?.tags && filters.tags.length > 0) {
        conditions.push(`tags && $${paramIndex++}`);
        params.push(filters.tags);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const limit = filters?.limit || 100;
      const offset = filters?.offset || 0;

      const result = await client.query(
        `SELECT
          id, name, description, protocol, scope, affinity, tags,
          created_at, updated_at, last_validated_at, validation_status,
          usage_count, connector_usage_count
        FROM credential_summaries
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
        [...params, limit, offset]
      );

      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        protocol: row.protocol,
        scope: row.scope,
        affinity: row.affinity,
        tags: row.tags,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_validated_at: row.last_validated_at,
        validation_status: row.validation_status,
        usage_count: parseInt(row.usage_count, 10),
        connector_usage_count: parseInt(row.connector_usage_count, 10),
      }));
    } finally {
      client.release();
    }
  }

  async update(
    id: string,
    input: UnifiedCredentialUpdateInput,
    createdBy: string,
    organizationId: string
  ): Promise<UnifiedCredential> {
    const client = await this.pool.connect();
    try {
      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (input.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        params.push(input.name);
      }

      if (input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(input.description);
      }

      if (input.credentials !== undefined) {
        const encryptedData = this.encryptionService.encrypt(
          JSON.stringify(input.credentials)
        );
        updates.push(`credentials = $${paramIndex++}`);
        params.push(encryptedData);
      }

      if (input.affinity !== undefined) {
        updates.push(`affinity = $${paramIndex++}`);
        params.push(input.affinity);
      }

      if (input.tags !== undefined) {
        updates.push(`tags = $${paramIndex++}`);
        params.push(input.tags);
      }

      if (updates.length === 0) {
        const existing = await this.getById(id, createdBy, organizationId);
        if (!existing) {
          throw new Error(`Credential with id ${id} not found`);
        }
        return existing;
      }

      params.push(id, createdBy, organizationId);

      const result = await client.query(
        `UPDATE credentials
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex++} AND created_by = $${paramIndex++} AND organization_id = $${paramIndex}
        RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        throw new Error(`Credential with id ${id} not found`);
      }

      const row = result.rows[0];

      logger.info('Unified credential updated', {
        id: row.id,
        name: row.name,
      });

      const credentialsData = this.decodeStoredCredentials(row.credentials);

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        protocol: row.protocol,
        scope: row.scope,
        credentials: credentialsData,
        affinity: row.affinity,
        tags: row.tags,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_validated_at: row.last_validated_at,
        validation_status: row.validation_status,
      };
    } catch (error: any) {
      if (error.code === '23505') {
        throw new Error(
          `Credential with name '${input.name}' already exists for this user`
        );
      }
      logger.error('Failed to update unified credential', { error, id });
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(id: string, createdBy: string, organizationId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Check ownership before examining usage: foreign and missing IDs must
      // take the same path, without disclosing whether a foreign row is in use.
      const owned = await client.query(
        `SELECT id FROM credentials WHERE id = $1 AND created_by = $2 AND organization_id = $3`,
        [id, createdBy, organizationId]
      );
      if (owned.rows.length === 0) {
        throw new Error(`Credential with id ${id} not found`);
      }
      // Check usage
      const discoveryUsageResult = await client.query(
        `SELECT COUNT(*) as count FROM discovery_definitions dd
         JOIN credentials c ON c.id = dd.credential_id
         WHERE c.id = $1 AND c.created_by = $2 AND c.organization_id = $3`,
        [id, createdBy, organizationId]
      );
      const discoveryUsageCount = parseInt(
        discoveryUsageResult.rows[0].count,
        10
      );

      const connectorUsageResult = await client.query(
        `SELECT COUNT(*) as count FROM connector_configurations cc
         JOIN credentials c ON c.id = cc.credential_id
         WHERE c.id = $1 AND c.created_by = $2 AND c.organization_id = $3`,
        [id, createdBy, organizationId]
      );
      const connectorUsageCount = parseInt(
        connectorUsageResult.rows[0].count,
        10
      );

      const totalUsage = discoveryUsageCount + connectorUsageCount;
      if (totalUsage > 0) {
        const usageDetails = [];
        if (discoveryUsageCount > 0) {
          usageDetails.push(
            `${discoveryUsageCount} discovery definition(s)`
          );
        }
        if (connectorUsageCount > 0) {
          usageDetails.push(
            `${connectorUsageCount} connector configuration(s)`
          );
        }
        throw new Error(
          `Cannot delete credential: it is currently used by ${usageDetails.join(' and ')}`
        );
      }

      const setUsageResult = await client.query(
        `SELECT COUNT(*) as count FROM credential_sets cs
         JOIN credentials c ON c.id = ANY(cs.credential_ids)
         WHERE c.id = $1 AND c.created_by = $2 AND c.organization_id = $3`,
        [id, createdBy, organizationId]
      );
      const setUsageCount = parseInt(setUsageResult.rows[0].count, 10);

      if (setUsageCount > 0) {
        throw new Error(
          `Cannot delete credential: it is currently used by ${setUsageCount} credential set(s)`
        );
      }

      const result = await client.query(
        `DELETE FROM credentials WHERE id = $1 AND created_by = $2 AND organization_id = $3 RETURNING id, name`,
        [id, createdBy, organizationId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Credential with id ${id} not found`);
      }

      logger.info('Unified credential deleted', {
        id: result.rows[0].id,
        name: result.rows[0].name,
      });
    } catch (error) {
      logger.error('Failed to delete unified credential', { error, id });
      throw error;
    } finally {
      client.release();
    }
  }
}
