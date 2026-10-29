// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { getPostgresClient, queueManager } from '@cmdb/database';
import {
  logger, safeDiscoveryScanConfig, strictDiscoveryDefinitionConfig,
  publicDiscoveryDefinitionConfig, hasUnsafeDiscoveryDefinitionConfig,
} from '@cmdb/common';
import {
  DiscoveryDefinition,
  DiscoveryDefinitionInput,
  DiscoveryProvider,
} from '@cmdb/common';

// HAP-774 C-1: only ssh consumes a credential; AD/SNMP attach is unsupported and nmap forbids one.
const PROVIDER_CREDENTIAL_PROTOCOLS: Record<string, readonly string[]> = {
  ssh: ['ssh_password', 'ssh_key'],
};


function requireCredentialForProvider(provider: string, credentialId: string | null | undefined): void {
  if ((provider === 'active-directory' || provider === 'snmp') &&
      (credentialId === undefined || credentialId === null || credentialId === '')) {
    throw new Error('Discovery provider requires credential');
  }
  if (provider === 'ssh' && !credentialId) throw new Error('Discovery provider requires credential');
  if (credentialId && !PROVIDER_CREDENTIAL_PROTOCOLS[provider]) throw new Error('Provider mismatch');
}

/** C-4: ssh dials each target, so hostnames and IP literals only (no CIDR, no range); config is already strict. */
function rejectSshRanges(provider: string, config: { range?: unknown; targets?: string[] } | undefined): void {
  if (provider === 'ssh' && (config?.range !== undefined || config?.targets?.some(target => target.includes('/')))) {
    throw new Error('Invalid discovery scan configuration');
  }
}

// C-3: owner + org + protocol in SQL, never the payload; every miss is the same "not found".
const ATTACHABLE_CREDENTIAL = 'AND created_by = $3 AND protocol = ANY($4::text[])';

/**
 * Discovery Definition Service
 *
 * Manages reusable discovery configurations that combine credentials,
 * provider settings, and schedules. Provides CRUD operations and
 * execution triggering for discovery definitions.
 */
export class DiscoveryDefinitionService {
  private postgresClient = getPostgresClient();

  /**
   * Create a new discovery definition
   */
  async createDefinition(
    input: DiscoveryDefinitionInput,
    userId: string,
    organizationId: string
  ): Promise<DiscoveryDefinition> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');
      strictDiscoveryDefinitionConfig(input.config ?? {});
      rejectSshRanges(input.provider, input.config);
      requireCredentialForProvider(input.provider, input.credential_id);

      // Validate that credential exists and matches provider (skip for nmap)
      if (input.credential_id) {
        const credentialResult = await client.query(
          `SELECT id AS credential_id, protocol AS provider
           FROM credentials WHERE id = $1 AND organization_id = $2 ${ATTACHABLE_CREDENTIAL}`,
          [input.credential_id, organizationId, userId, PROVIDER_CREDENTIAL_PROTOCOLS['ssh']]
        );

        if (credentialResult.rows.length === 0) {
          throw new Error(`Credential with ID ${input.credential_id} not found`);
        }
      }

      // Validate cron expression if schedule is provided
      if (input.schedule) {
        this.validateCronExpression(input.schedule);
      }

      // Insert discovery definition
      const result = await client.query(
        `INSERT INTO discovery_definitions (
          name, description, provider, method, credential_id, agent_id,
          config, schedule, is_active, tags, created_by, organization_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING
          id,
          name, description, provider, method, credential_id, agent_id,
          config, schedule, is_active, tags, created_by,
          created_at, updated_at, last_run_at, last_run_status, last_job_id`,
        [
          input.name,
          input.description || null,
          input.provider,
          input.method,
          input.credential_id || null,
          input.agent_id || null,
          input.config || {}, // PostgreSQL JSONB handles object directly
          input.schedule || null,
          input.is_active !== undefined ? input.is_active : true,
          input.tags || [],
          userId,
          organizationId,
        ]
      );

      await client.query('COMMIT');

      const definition = this.mapRowToDefinition(result.rows[0]);
      logger.info('Discovery definition created', {
        definitionId: definition.id,
        name: definition.name,
        provider: definition.provider,
      });

      return definition;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating discovery definition');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get a discovery definition by ID
   */
  async getDefinition(id: string, organizationId: string): Promise<DiscoveryDefinition | null> {
    try {
      const result = await this.postgresClient.query(
        `SELECT
          id,
          name, description, provider, method, credential_id,
          config, schedule, is_active, tags, created_by,
          created_at, updated_at, last_run_at, last_run_status, last_job_id
        FROM discovery_definitions
        WHERE id = $1 AND organization_id = $2`,
        [id, organizationId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToDefinition(result.rows[0]);
    } catch (error) {
      logger.error('Error getting discovery definition');
      throw error;
    }
  }

  /**
   * List discovery definitions with optional filters
   */
  async listDefinitions(filters: {
    provider?: DiscoveryProvider;
    active?: boolean;
    created_by?: string;
    tags?: string[];
  } | undefined, organizationId: string): Promise<DiscoveryDefinition[]> {
    try {
      const conditions: string[] = ['organization_id = $1'];
      const params: unknown[] = [organizationId];

      if (filters?.provider) {
        params.push(filters.provider);
        conditions.push(`provider = $${params.length}`);
      }

      if (filters?.active !== undefined) {
        params.push(filters.active);
        conditions.push(`is_active = $${params.length}`);
      }

      if (filters?.created_by) {
        params.push(filters.created_by);
        conditions.push(`created_by = $${params.length}`);
      }

      if (filters?.tags && filters.tags.length > 0) {
        params.push(filters.tags);
        conditions.push(`tags && $${params.length}`); // Array overlap operator
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await this.postgresClient.query(
        `SELECT
          id,
          name, description, provider, method, credential_id,
          config, schedule, is_active, tags, created_by,
          created_at, updated_at, last_run_at, last_run_status, last_job_id
        FROM discovery_definitions
        ${whereClause}
        ORDER BY created_at DESC`
      , params);

      return result.rows.map(row => this.mapRowToDefinition(row));
    } catch (error) {
      logger.error('Error listing discovery definitions');
      throw error;
    }
  }

  /** Inventory only opaque IDs; never return or log stored legacy JSON. */
  async listUnsafeDefinitionIds(organizationId: string): Promise<string[]> {
    const result = await this.postgresClient.query(
      'SELECT id, config FROM discovery_definitions WHERE organization_id = $1 ORDER BY id',
      [organizationId]
    );
    return result.rows.filter(row => hasUnsafeDiscoveryDefinitionConfig(row.config)).map(row => row.id);
  }

  /**
   * Update a discovery definition
   */
  async updateDefinition(
    id: string,
    updates: Partial<DiscoveryDefinitionInput>,
    organizationId: string,
    actorId?: string // D3: credential attach requires the requesting user to own it; absent actor matches nothing.
  ): Promise<DiscoveryDefinition> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Check if definition exists
      const existingResult = await client.query(
        'SELECT id, credential_id, credential_set_id, provider, config FROM discovery_definitions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [id, organizationId]
      );

      if (existingResult.rows.length === 0) {
        throw new Error(`Discovery definition ${id} not found`);
      }

      const existing = existingResult.rows[0];
      if (hasUnsafeDiscoveryDefinitionConfig(existing.config)) {
        throw new Error('Unsafe legacy discovery configuration requires migration');
      }
      if (updates.config !== undefined) {
        strictDiscoveryDefinitionConfig(updates.config);
      }
      if (updates.config !== undefined || updates.provider !== undefined) {
        rejectSshRanges(updates.provider ?? existing.provider, updates.config ?? existing.config);
      }
      if (updates.provider !== undefined || updates.credential_id !== undefined) {
        requireCredentialForProvider(updates.provider ?? existing.provider,
          updates.credential_id !== undefined ? updates.credential_id : existing.credential_id);
      }

      // Every explicit attachment must revalidate current ownership, even if
      // the credential ID matches an older association. R3: new config re-checks the bound credential; a set cannot (D2).
      if (updates.config !== undefined && existing.credential_set_id) throw new Error('Credential not found');
      const attachId = updates.credential_id || (updates.config !== undefined ? existing.credential_id : null);
      if (attachId) {
        const credentialResult = await client.query(
          `SELECT id AS credential_id, protocol AS provider FROM credentials WHERE id = $1 AND organization_id = $2 ${ATTACHABLE_CREDENTIAL}`,
          [attachId, organizationId, actorId, PROVIDER_CREDENTIAL_PROTOCOLS['ssh']]
        );

        if (credentialResult.rows.length === 0) {
          throw new Error(`Credential with ID ${attachId} not found`);
        }
      }

      // If updating provider, validate against credential
      if (updates.provider && updates.provider !== existing.provider &&
          (updates.credential_id || existing.credential_id)) {
        const credentialId = updates.credential_id || existing.credential_id;
        const credentialResult = await client.query(
          `SELECT protocol AS provider FROM credentials WHERE id = $1 AND organization_id = $2 ${ATTACHABLE_CREDENTIAL}`,
          [credentialId, organizationId, actorId, PROVIDER_CREDENTIAL_PROTOCOLS['ssh']]
        );

        if (!credentialResult.rows.length) throw new Error('Credential not found');
      }

      // Validate cron expression if schedule is being updated
      if (updates.schedule) {
        this.validateCronExpression(updates.schedule);
      }

      // Build update query dynamically
      const updateFields: string[] = [];
      const updateParams: any[] = [];

      if (updates.name !== undefined) {
        updateParams.push(updates.name);
        updateFields.push(`name = $${updateParams.length}`);
      }

      if (updates.description !== undefined) {
        updateParams.push(updates.description);
        updateFields.push(`description = $${updateParams.length}`);
      }

      if (updates.provider !== undefined) {
        updateParams.push(updates.provider);
        updateFields.push(`provider = $${updateParams.length}`);
      }

      if (updates.method !== undefined) {
        updateParams.push(updates.method);
        updateFields.push(`method = $${updateParams.length}`);
      }

      if (updates.credential_id !== undefined) {
        updateParams.push(updates.credential_id);
        updateFields.push(`credential_id = $${updateParams.length}`);
      }

      if (updates.config !== undefined) {
        updateParams.push(updates.config);
        updateFields.push(`config = $${updateParams.length}`);
      }

      if (updates.schedule !== undefined) {
        updateParams.push(updates.schedule);
        updateFields.push(`schedule = $${updateParams.length}`);
      }

      if (updates.is_active !== undefined) {
        updateParams.push(updates.is_active);
        updateFields.push(`is_active = $${updateParams.length}`);
      }

      if (updates.tags !== undefined) {
        updateParams.push(updates.tags);
        updateFields.push(`tags = $${updateParams.length}`);
      }

      if (updateFields.length === 0) {
        throw new Error('No fields to update');
      }

      // Add definition_id as last parameter
      updateParams.push(id, organizationId);

      const result = await client.query(
        `UPDATE discovery_definitions
        SET ${updateFields.join(', ')}
        WHERE id = $${updateParams.length - 1} AND organization_id = $${updateParams.length}
        RETURNING
          id,
          name, description, provider, method, credential_id,
          config, schedule, is_active, tags, created_by,
          created_at, updated_at, last_run_at, last_run_status, last_job_id`,
        updateParams
      );

      await client.query('COMMIT');

      const definition = this.mapRowToDefinition(result.rows[0]);
      logger.info('Discovery definition updated', {
        definitionId: definition.id,
        updates: Object.keys(updates),
      });

      return definition;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating discovery definition');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a discovery definition
   */
  async deleteDefinition(id: string, organizationId: string): Promise<void> {
    const client = await this.postgresClient.getClient();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT config FROM discovery_definitions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [id, organizationId]
      );
      if (!existing.rows.length) throw new Error(`Discovery definition ${id} not found`);
      if (hasUnsafeDiscoveryDefinitionConfig(existing.rows[0].config)) {
        throw new Error('Unsafe legacy discovery configuration requires migration');
      }
      await client.query('DELETE FROM discovery_definitions WHERE id = $1 AND organization_id = $2', [id, organizationId]);
      await client.query('COMMIT');
      logger.info('Discovery definition deleted', { definitionId: id });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error deleting discovery definition');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Trigger a discovery job from a definition
   * Returns the job ID of the triggered discovery
   */
  async runDefinition(id: string, triggeredBy: string, organizationId: string): Promise<string> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Get the definition
      const definitionResult = await client.query(
        `SELECT
          id,
          name, description, provider, method, credential_id, credential_set_id,
          config, schedule, is_active, tags, created_by,
          created_at, updated_at, last_run_at, last_run_status, last_job_id
        FROM discovery_definitions
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [id, organizationId]
      );

      if (definitionResult.rows.length === 0) {
        throw new Error(`Discovery definition ${id} not found`);
      }
      if (hasUnsafeDiscoveryDefinitionConfig(definitionResult.rows[0].config)) {
        throw new Error('Unsafe legacy discovery configuration requires migration');
      }
      // Approved T1a fail-closed boundary: HP1-S5 owns credential-backed runs.
      // Do not resolve credentials, enqueue, or change last-run state here.
      if (definitionResult.rows[0].credential_id || definitionResult.rows[0].credential_set_id) {
        throw new Error('Credential-backed discovery execution is unavailable');
      }
      if (definitionResult.rows[0].provider !== 'nmap') {
        throw new Error('Credential-backed discovery execution is unavailable');
      }

      const definition = this.mapRowToDefinition(definitionResult.rows[0]);

      if (!definition.is_active) {
        throw new Error(`Discovery definition ${id} is not active`);
      }

      // Generate job ID (removed "discovery-" prefix to match new format)
      const jobId = `${definition.provider}-${Date.now()}`;

      const jobConfig = safeDiscoveryScanConfig(definition.config);

      // Get the queue for this provider
      const queueName = `discovery-${definition.provider}`;
      const queue = queueManager.getQueue(queueName);

      // Add job to queue
      await queue.add(
        'discover',
        {
          jobId,
          provider: definition.provider,
          config: jobConfig,
          definition_id: definition.id,
          triggered_by: triggeredBy,
          organizationId,
        },
        {
          jobId, // Use our generated ID
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        }
      );

      // Update last run info in discovery_definitions
      await client.query(
        `UPDATE discovery_definitions
        SET last_job_id = $1,
            last_run_at = CURRENT_TIMESTAMP,
            last_run_status = 'pending'
        WHERE id = $2 AND organization_id = $3`,
        [jobId, id, organizationId]
      );

      await client.query('COMMIT');

      logger.info('Discovery definition run triggered', {
        definitionId: id,
        jobId,
        queueName,
        triggeredBy,
      });

      return jobId;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error running discovery definition');
      throw error;
    } finally {
      client.release();
    }
  }


  /**
   * Map database row to DiscoveryDefinition object
   */
  private mapRowToDefinition(row: any): DiscoveryDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      provider: row.provider,
      method: row.method,
      credential_id: row.credential_id,
      config: publicDiscoveryDefinitionConfig(typeof row.config === 'string' ? JSON.parse(row.config) : row.config),
      schedule: row.schedule,
      is_active: row.is_active,
      tags: row.tags || [],
      created_by: row.created_by,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      last_run_at: row.last_run_at ? row.last_run_at.toISOString() : undefined,
      last_run_status: row.last_run_status,
      last_job_id: row.last_job_id,
    };
  }

  /**
   * Enable scheduled execution for a definition
   */
  async enableSchedule(id: string, organizationId: string): Promise<DiscoveryDefinition> {
    try {
      // Get the definition first to validate it has a schedule
      const definition = await this.getDefinition(id, organizationId);

      if (!definition) {
        throw new Error(`Discovery definition ${id} not found`);
      }
      // Do not arm a schedule that background workers must refuse.
      const boundSet = await this.postgresClient.query(
        'SELECT credential_set_id, config FROM discovery_definitions WHERE id = $1 AND organization_id = $2',
        [id, organizationId]
      );
      if (hasUnsafeDiscoveryDefinitionConfig(boundSet.rows[0]?.config)) {
        throw new Error('Unsafe legacy discovery configuration requires migration');
      }
      if (definition.provider !== 'nmap') {
        throw new Error('Credential-backed discovery execution is unavailable');
      }
      if (definition.credential_id || boundSet.rows[0]?.credential_set_id) {
        throw new Error('Credential-backed discovery execution is unavailable');
      }


      if (!definition.schedule) {
        throw new Error(
          `Cannot enable schedule for definition ${id}: no schedule configured`
        );
      }

      // Update is_active to true
      return await this.updateDefinition(id, { is_active: true }, organizationId);
    } catch (error) {
      logger.error('Error enabling schedule');
      throw error;
    }
  }

  /**
   * Disable scheduled execution for a definition
   */
  async disableSchedule(id: string, organizationId: string): Promise<DiscoveryDefinition> {
    try {
      // Check if definition exists
      const definition = await this.getDefinition(id, organizationId);

      if (!definition) {
        throw new Error(`Discovery definition ${id} not found`);
      }

      // Update is_active to false
      return await this.updateDefinition(id, { is_active: false }, organizationId);
    } catch (error) {
      logger.error('Error disabling schedule');
      throw error;
    }
  }

  /**
   * Validate cron expression format
   * Simple validation - checks for 5 or 6 fields
   */
  private validateCronExpression(expression: string): void {
    const parts = expression.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      throw new Error(
        `Invalid cron expression: ${expression}. Expected 5 or 6 fields, got ${parts.length}`
      );
    }
  }
}
