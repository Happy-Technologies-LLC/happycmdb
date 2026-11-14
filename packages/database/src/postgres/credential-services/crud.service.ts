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
import { getEncryptionService, CredentialProtocolAdapter, DuplicateCredentialNameError, CredentialInUseError, CredentialNotFoundError } from '@cmdb/common';
import { logger, errorClassFields } from '@cmdb/common';

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
/** HAP-1444: the tag that marks an organization's HappyLab C4 bearer principal (one per organization). */
export const C4_PRINCIPAL_TAG = 'happylab-c4';
export type C4PrincipalResolution =
  | { token: string }
  | { code: 'c4_no_credential' | 'c4_credential_ambiguous' | 'c4_credential_invalid' };
/**
 * HAP-1613: only an organization admin may set, keep (edit a tagged row), remove or delete the C4 principal tag;
 * the error carries this code only (no id, name or secret).
 */
export const C4_PRINCIPAL_ADMIN_REQUIRED = 'c4_principal_admin_required';
const c4AdminRequired = (): Error => Object.assign(new Error(C4_PRINCIPAL_ADMIN_REQUIRED), { code: C4_PRINCIPAL_ADMIN_REQUIRED });
const carriesC4Tag = (tags: unknown): boolean => Array.isArray(tags) && tags.includes(C4_PRINCIPAL_TAG);
/** HAP-444 K1: every writer (REST, GraphQL, scripts) gets the shared SSH port rule before anything is persisted. */
function assertSshPort(protocol: unknown, credentials: Record<string, unknown> | undefined): void {
  const port = credentials?.['port'];
  if ((DISCOVERY_CREDENTIAL_PROTOCOLS as readonly unknown[]).includes(protocol) && port !== undefined && !CredentialProtocolAdapter.isSshPort(port)) {
    throw new Error(CredentialProtocolAdapter.INVALID_SSH_PORT);
  }
}

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

  /** HAP-1800: a stored-credential decode failure names the inner class only, never its message: a JSON.parse failure quotes the decrypted plaintext. */
  private decryptFailure(id: string, error: unknown): Error {
    return new Error(`Failed to decrypt credential ${id} (${error instanceof Error ? error.constructor.name : typeof error})`);
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
    organizationId: string,
    isOrgAdmin: boolean
  ): Promise<UnifiedCredential> {
    if (isOrgAdmin !== true && carriesC4Tag(input.tags)) {
      throw c4AdminRequired();
    }
    assertSshPort(input.protocol, input.credentials);
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
        throw new DuplicateCredentialNameError();
      }
      logger.error('Failed to create unified credential', {
        error: errorClassFields(error),
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
        logger.error('Failed to decrypt credential', { id, error: errorClassFields(error) });
        throw this.decryptFailure(id, error);
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

  /**
   * HAP-1444: this organization's HappyLab C4 bearer token, read-only. The org and tag filter in SQL; none, more than one
   * or an undecodable/malformed row is a fixed code, and nothing (id, payload or error) is logged.
   */
  async resolveC4Principal(organizationId: string): Promise<C4PrincipalResolution> {
    if (typeof organizationId !== 'string' || !UUID.test(organizationId)) return { code: 'c4_no_credential' };
    const { rows } = await this.pool.query(`SELECT credentials FROM credentials
      WHERE organization_id = $1 AND protocol = 'bearer' AND tags @> ARRAY[$2]::text[] LIMIT 2`, [organizationId, C4_PRINCIPAL_TAG]);
    if (rows.length === 0) return { code: 'c4_no_credential' };
    if (rows.length > 1) return { code: 'c4_credential_ambiguous' };
    try {
      const token = this.decodeStoredCredentials(rows[0].credentials)?.['token'];
      if (typeof token === 'string' && /^[\x21-\x7e]{1,512}$/.test(token)) return { token };
    } catch {
      // Dropped: the error text can carry plaintext.
    }
    return { code: 'c4_credential_invalid' };
  }

  /** HAP-1444: the organizations that hold a HappyLab C4 principal (ids only; nothing is decoded). */
  async listC4PrincipalOrganizations(): Promise<string[]> {
    const { rows } = await this.pool.query(`SELECT DISTINCT organization_id FROM credentials
      WHERE organization_id IS NOT NULL AND protocol = 'bearer' AND tags @> ARRAY[$1]::text[] ORDER BY organization_id`, [C4_PRINCIPAL_TAG]);
    return rows.map(row => row.organization_id as string);
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

      // usage_count / connector_usage_count are recomputed here, not read from the view: credential_summaries counts
      // every referencing row with no organization filter. Keep this rule identical to the delete refusal below.
      const result = await client.query(
        `SELECT
          cs.id, cs.name, cs.description, cs.protocol, cs.scope, cs.affinity, cs.tags,
          cs.created_at, cs.updated_at, cs.last_validated_at, cs.validation_status,
          (SELECT COUNT(*) FROM discovery_definitions dd
            WHERE dd.credential_id = cs.id AND dd.organization_id = cs.organization_id) AS usage_count,
          (SELECT COUNT(*) FROM connector_configurations cc
            WHERE cc.credential_id = cs.id AND cc.organization_id = cs.organization_id) AS connector_usage_count
        FROM credential_summaries cs
        ${whereClause}
        ORDER BY cs.created_at DESC
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
    organizationId: string,
    isOrgAdmin: boolean
  ): Promise<UnifiedCredential> {
    const client = await this.pool.connect();
    let inTransaction = false;
    let releaseError: Error | undefined;
    try {
      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      // HAP-1814: one transaction for every update, so the UPDATE commits only once its returned row decodes; a stored
      // value that cannot be decoded (bad envelope, non-JSON plaintext) rolls the write back instead of committing it
      // behind a 500.
      await client.query('BEGIN');
      inTransaction = true;
      // The protocol (credentials) and the tags (non-admins, HAP-1613) are only known from the row; lock it so the
      // checked row is the one updated.
      if (input.credentials !== undefined || isOrgAdmin !== true) {
        const locked = await client.query<{ protocol: string; tags: string[] | null }>(
          'SELECT protocol, tags FROM credentials WHERE id = $1 AND created_by = $2 AND organization_id = $3 FOR UPDATE',
          [id, createdBy, organizationId]
        );
        // A missing or foreign row matches nothing here and in the UPDATE below, which reports it as not found
        // before any tag check, so the refusal never discloses a row.
        const row = locked.rows[0];
        if (row !== undefined && isOrgAdmin !== true && (carriesC4Tag(row.tags) || carriesC4Tag(input.tags))) {
          throw c4AdminRequired();
        }
        if (input.credentials !== undefined) {
          assertSshPort(row?.protocol, input.credentials);
        }
      }

      if (input.name !== undefined) {
        updates.push(`name = $${paramIndex++}`);
        params.push(input.name);
      }

      if (input.description !== undefined) {
        updates.push(`description = $${paramIndex++}`);
        params.push(input.description.trim() || null);
      }

      if (input.credentials !== undefined) {
        const encryptedData = this.encryptionService.encrypt(
          JSON.stringify(input.credentials)
        );
        updates.push(`credentials = $${paramIndex++}`, 'validation_status = NULL', 'last_validated_at = NULL');
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
        await client.query('COMMIT');
        inTransaction = false;
        const existing = await this.getById(id, createdBy, organizationId);
        if (!existing) {
          throw new CredentialNotFoundError(id);
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
        throw new CredentialNotFoundError(id);
      }

      const row = result.rows[0];

      let credentialsData: Record<string, unknown>;
      try {
        credentialsData = this.decodeStoredCredentials(row.credentials);
      } catch (error) {
        throw this.decryptFailure(id, error);
      }

      await client.query('COMMIT');
      inTransaction = false;

      logger.info('Unified credential updated', {
        id: row.id,
        name: row.name,
      });

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
      if (inTransaction) {
        // A failed ROLLBACK leaves the session in an unknown state: release it with the error so the pool destroys it.
        await client.query('ROLLBACK').catch((rollbackError: unknown) => {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK failed');
        });
      }
      if (error.code === '23505') {
        throw new DuplicateCredentialNameError();
      }
      logger.error('Failed to update unified credential', { error: errorClassFields(error), id });
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async delete(id: string, createdBy: string, organizationId: string, isOrgAdmin: boolean): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Check ownership before examining usage: foreign and missing IDs must
      // take the same path, without disclosing whether a foreign row is in use.
      const owned = await client.query<{ tags: string[] | null }>(
        `SELECT tags FROM credentials WHERE id = $1 AND created_by = $2 AND organization_id = $3`,
        [id, createdBy, organizationId]
      );
      if (owned.rows.length === 0) {
        throw new CredentialNotFoundError(id);
      }
      // HAP-1613: deleting the C4 principal removes the tag; the final delete query repeats this check atomically.
      if (isOrgAdmin !== true && carriesC4Tag(owned.rows[0]?.tags)) {
        throw c4AdminRequired();
      }
      // Check usage. Only references of the credential's own organization are counted and reported, here and in the
      // list alike. The FK on credential_id (001, ON DELETE RESTRICT) checks no organization, so a row of another
      // organization (or with no organization) can carry this id: it is neither counted nor reported, but the FK
      // still refuses the DELETE below (23503/23001, mapped by the controller to a count-free 409).
      const count = (result: { rows: Array<{ total: string }> }) => parseInt(result.rows[0]?.total ?? '0', 10);
      const discoveryUsage = count(await client.query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM discovery_definitions dd
         JOIN credentials c ON c.id = dd.credential_id AND dd.organization_id = c.organization_id
         WHERE c.id = $1 AND c.created_by = $2 AND c.organization_id = $3`,
        [id, createdBy, organizationId]
      ));
      const connectorUsage = count(await client.query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM connector_configurations cc
         JOIN credentials c ON c.id = cc.credential_id AND cc.organization_id = c.organization_id
         WHERE c.id = $1 AND c.created_by = $2 AND c.organization_id = $3`,
        [id, createdBy, organizationId]
      ));

      if (discoveryUsage + connectorUsage > 0) {
        throw new CredentialInUseError({
          discoveryDefinitions: discoveryUsage,
          connectorConfigurations: connectorUsage,
        });
      }

      const setUsage = count(await client.query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM credential_sets cs
         JOIN credentials c ON c.id = ANY(cs.credential_ids) AND cs.organization_id = c.organization_id
         WHERE c.id = $1 AND c.created_by = $2 AND c.organization_id = $3`,
        [id, createdBy, organizationId]
      ));

      if (setUsage > 0) {
        throw new CredentialInUseError({ credentialSets: setUsage });
      }

      const result = await client.query(
        `DELETE FROM credentials WHERE id = $1 AND created_by = $2 AND organization_id = $3
          AND ($4::boolean OR NOT COALESCE(tags @> ARRAY[$5]::text[], false)) RETURNING id, name`,
        [id, createdBy, organizationId, isOrgAdmin === true, C4_PRINCIPAL_TAG]
      );

      if (result.rows.length === 0) {
        throw new CredentialNotFoundError(id);
      }

      logger.info('Unified credential deleted', {
        id: result.rows[0].id,
        name: result.rows[0].name,
      });
    } catch (error) {
      logger.error('Failed to delete unified credential', { error: errorClassFields(error), id });
      throw error;
    } finally {
      client.release();
    }
  }
}
