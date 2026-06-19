// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { getPostgresClient, queueManager, getUnifiedCredentialService } from '@cmdb/database';
import { logger } from '@cmdb/common';
import {
  DiscoveryDefinition,
  DiscoveryDefinitionInput,
  DiscoveryProvider,
  JobStatus,
} from '@cmdb/common';

/**
 * Discovery Definition Service
 *
 * Manages reusable discovery configurations that combine credentials,
 * provider settings, and schedules. Provides CRUD operations and
 * execution triggering for discovery definitions.
 */
export class DiscoveryDefinitionService {
  private postgresClient = getPostgresClient();
  private credentialService = getUnifiedCredentialService(this.postgresClient.pool);

  /**
   * Create a new discovery definition
   */
  async createDefinition(
    input: DiscoveryDefinitionInput,
    userId: string
  ): Promise<DiscoveryDefinition> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Validate that credential exists and matches provider (skip for nmap)
      if (input.credential_id) {
        const credentialResult = await client.query(
          `SELECT id AS credential_id, protocol AS provider, true AS is_active
           FROM credentials
           WHERE id = $1`,
          [input.credential_id]
        );

        if (credentialResult.rows.length === 0) {
          throw new Error(`Credential with ID ${input.credential_id} not found`);
        }

        const credential = credentialResult.rows[0];

        if (!credential.is_active) {
          throw new Error(`Credential ${input.credential_id} is not active`);
        }

        // Validate provider matches credential provider
        if (credential.provider !== input.provider) {
          throw new Error(
            `Provider mismatch: Definition provider '${input.provider}' does not match credential provider '${credential.provider}'`
          );
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
          config, schedule, is_active, tags, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      logger.error('Error creating discovery definition', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get a discovery definition by ID
   */
  async getDefinition(id: string): Promise<DiscoveryDefinition | null> {
    try {
      const result = await this.postgresClient.query(
        `SELECT
          id,
          name, description, provider, method, credential_id,
          config, schedule, is_active, tags, created_by,
          created_at, updated_at, last_run_at, last_run_status, last_job_id
        FROM discovery_definitions
        WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToDefinition(result.rows[0]);
    } catch (error) {
      logger.error('Error getting discovery definition', { id, error });
      throw error;
    }
  }

  /**
   * List discovery definitions with optional filters
   */
  async listDefinitions(filters?: {
    provider?: DiscoveryProvider;
    active?: boolean;
    created_by?: string;
    tags?: string[];
  }): Promise<DiscoveryDefinition[]> {
    try {
      const conditions: string[] = [];
      const params: any[] = [];

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
      logger.error('Error listing discovery definitions', { filters, error });
      throw error;
    }
  }

  /**
   * Update a discovery definition
   */
  async updateDefinition(
    id: string,
    updates: Partial<DiscoveryDefinitionInput>
  ): Promise<DiscoveryDefinition> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Check if definition exists
      const existingResult = await client.query(
        'SELECT id, credential_id, provider FROM discovery_definitions WHERE id = $1',
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error(`Discovery definition ${id} not found`);
      }

      const existing = existingResult.rows[0];

      // If updating credential_id, validate it
      if (updates.credential_id && updates.credential_id !== existing.credential_id) {
        const credentialResult = await client.query(
          'SELECT id AS credential_id, protocol AS provider, true AS is_active FROM credentials WHERE id = $1',
          [updates.credential_id]
        );

        if (credentialResult.rows.length === 0) {
          throw new Error(`Credential with ID ${updates.credential_id} not found`);
        }

        const credential = credentialResult.rows[0];

        if (!credential.is_active) {
          throw new Error(`Credential ${updates.credential_id} is not active`);
        }

        // Validate provider matches (use new provider if being updated, otherwise existing)
        const targetProvider = updates.provider || existing.provider;
        if (credential.provider !== targetProvider) {
          throw new Error(
            `Provider mismatch: Definition provider '${targetProvider}' does not match credential provider '${credential.provider}'`
          );
        }
      }

      // If updating provider, validate against credential
      if (updates.provider && updates.provider !== existing.provider) {
        const credentialId = updates.credential_id || existing.credential_id;
        const credentialResult = await client.query(
          'SELECT protocol AS provider FROM credentials WHERE id = $1',
          [credentialId]
        );

        if (credentialResult.rows[0].provider !== updates.provider) {
          throw new Error(
            `Provider mismatch: New provider '${updates.provider}' does not match credential provider '${credentialResult.rows[0].provider}'`
          );
        }
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
      updateParams.push(id);

      const result = await client.query(
        `UPDATE discovery_definitions
        SET ${updateFields.join(', ')}
        WHERE id = $${updateParams.length}
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
      logger.error('Error updating discovery definition', { id, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a discovery definition
   */
  async deleteDefinition(id: string): Promise<void> {
    try {
      const result = await this.postgresClient.query(
        'DELETE FROM discovery_definitions WHERE id = $1',
        [id]
      );

      if (result.rowCount === 0) {
        throw new Error(`Discovery definition ${id} not found`);
      }

      logger.info('Discovery definition deleted', { definitionId: id });
    } catch (error) {
      logger.error('Error deleting discovery definition', { id, error });
      throw error;
    }
  }

  /**
   * Trigger a discovery job from a definition
   * Returns the job ID of the triggered discovery
   */
  async runDefinition(id: string, triggeredBy: string): Promise<string> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Get the definition
      const definitionResult = await client.query(
        `SELECT
          id,
          name, description, provider, method, credential_id,
          config, schedule, is_active, tags, created_by,
          created_at, updated_at, last_run_at, last_run_status, last_job_id
        FROM discovery_definitions
        WHERE id = $1`,
        [id]
      );

      if (definitionResult.rows.length === 0) {
        throw new Error(`Discovery definition ${id} not found`);
      }

      const definition = this.mapRowToDefinition(definitionResult.rows[0]);

      if (!definition.is_active) {
        throw new Error(`Discovery definition ${id} is not active`);
      }

      // Generate job ID (removed "discovery-" prefix to match new format)
      const jobId = `${definition.provider}-${Date.now()}`;

      // Fetch and decrypt credential if credential_id is provided
      let credentials;
      if (definition.credential_id) {
        const credential = await this.credentialService.getById(definition.credential_id);
        logger.info('Fetched credential for discovery', {
          credentialId: definition.credential_id,
          hasCredential: !!credential,
          credentialKeys: credential?.credentials ? Object.keys(credential.credentials) : []
        });
        if (credential) {
          // Use credentials directly (they're already decrypted by getById)
          credentials = credential.credentials;
          logger.info('Using unified credentials', {
            protocol: credential.protocol,
            scope: credential.scope
          });
        }
      }

      // Merge credentials into config
      const jobConfig = {
        ...definition.config,
        credentials,
      };

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
          definition_name: definition.name,
          triggered_by: triggeredBy,
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
        WHERE id = $2`,
        [jobId, id]
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
      logger.error('Error running discovery definition', { id, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update last run information for a definition
   */
  async updateLastRun(
    id: string,
    jobId: string,
    status: JobStatus,
    cisDiscovered?: number
  ): Promise<void> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Update definition last run info
      await client.query(
        `UPDATE discovery_definitions
        SET last_run_at = CURRENT_TIMESTAMP,
            last_run_status = $1,
            last_job_id = $2
        WHERE id = $3`,
        [status, jobId, id]
      );

      await client.query('COMMIT');

      logger.info('Discovery definition last run updated', {
        definitionId: id,
        jobId,
        status,
        cisDiscovered,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating last run', { id, jobId, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get discovery run history for a definition
   * Note: Run history is tracked in BullMQ/Redis, not in PostgreSQL
   * This method returns basic last run info from the definition itself
   */
  async getRunHistory(
    definitionId: string,
    _limit: number = 50
  ): Promise<any[]> {
    try {
      // For now, return just the last run info from the definition
      // In the future, this could query BullMQ for job history
      const result = await this.postgresClient.query(
        `SELECT
          last_job_id as job_id,
          last_run_at as started_at,
          last_run_status as status
        FROM discovery_definitions
        WHERE id = $1
        AND last_job_id IS NOT NULL`,
        [definitionId]
      );

      return result.rows;
    } catch (error) {
      logger.error('Error getting run history', { definitionId, error });
      throw error;
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
      config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
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
  async enableSchedule(id: string): Promise<DiscoveryDefinition> {
    try {
      // Get the definition first to validate it has a schedule
      const definition = await this.getDefinition(id);

      if (!definition) {
        throw new Error(`Discovery definition ${id} not found`);
      }

      if (!definition.schedule) {
        throw new Error(
          `Cannot enable schedule for definition ${id}: no schedule configured`
        );
      }

      // Update is_active to true
      return await this.updateDefinition(id, { is_active: true });
    } catch (error) {
      logger.error('Error enabling schedule', { id, error });
      throw error;
    }
  }

  /**
   * Disable scheduled execution for a definition
   */
  async disableSchedule(id: string): Promise<DiscoveryDefinition> {
    try {
      // Check if definition exists
      const definition = await this.getDefinition(id);

      if (!definition) {
        throw new Error(`Discovery definition ${id} not found`);
      }

      // Update is_active to false
      return await this.updateDefinition(id, { is_active: false });
    } catch (error) {
      logger.error('Error disabling schedule', { id, error });
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
