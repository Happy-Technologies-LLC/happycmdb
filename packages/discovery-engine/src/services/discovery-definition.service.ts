// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Definition Service
 *
 * Manages CRUD operations for discovery definitions - reusable discovery configurations
 * that combine credentials, provider settings, and schedules.
 */

import { getPostgresClient, queueManager, QUEUE_NAMES } from '@cmdb/database';
import { logger, DiscoveryDefinition, DiscoveryDefinitionInput, DiscoveryProvider, DiscoveryJob } from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';

export class DiscoveryDefinitionService {
  private postgresClient = getPostgresClient();

  /**
   * Create a new discovery definition
   * Validates that credential_id exists before creating
   */
  async createDefinition(
    input: DiscoveryDefinitionInput,
    created_by: string
  ): Promise<DiscoveryDefinition> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Validate credential exists
      const credResult = await client.query(
        'SELECT id FROM credentials WHERE id = $1',
        [input.credential_id]
      );

      if (credResult.rows.length === 0) {
        throw new Error(`Credential with ID '${input.credential_id}' not found`);
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      const result = await client.query(
        `INSERT INTO discovery_definitions (
          id, name, description, provider, method, credential_id,
          config, schedule, is_active, tags, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          id,
          input.name,
          input.description || null,
          input.provider,
          input.method,
          input.credential_id,
          JSON.stringify(input.config),
          input.schedule || null,
          input.is_active !== undefined ? input.is_active : true,
          input.tags || [],
          created_by,
          now,
          now,
        ]
      );

      await client.query('COMMIT');

      const definition = this.mapRowToDefinition(result.rows[0]);
      logger.info(`Discovery definition created: ${id}`, { name: input.name, provider: input.provider });

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
    const result = await this.postgresClient.query(
      'SELECT * FROM discovery_definitions WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToDefinition(result.rows[0]);
  }

  /**
   * List discovery definitions with optional filters
   */
  async listDefinitions(filters?: {
    provider?: DiscoveryProvider;
    is_active?: boolean;
    created_by?: string;
  }): Promise<DiscoveryDefinition[]> {
    let query = 'SELECT * FROM discovery_definitions WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (filters?.provider) {
      query += ` AND provider = $${paramIndex}`;
      params.push(filters.provider);
      paramIndex++;
    }

    if (filters?.is_active !== undefined) {
      query += ` AND is_active = $${paramIndex}`;
      params.push(filters.is_active);
      paramIndex++;
    }

    if (filters?.created_by) {
      query += ` AND created_by = $${paramIndex}`;
      params.push(filters.created_by);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const result = await this.postgresClient.query(query, params);
    return result.rows.map((row: Record<string, any>) => this.mapRowToDefinition(row));
  }

  /**
   * Update an existing discovery definition
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
        'SELECT id FROM discovery_definitions WHERE id = $1',
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error(`Discovery definition with ID '${id}' not found`);
      }

      // Validate credential if being updated
      if (updates.credential_id) {
        const credResult = await client.query(
          'SELECT id FROM credentials WHERE id = $1',
          [updates.credential_id]
        );

        if (credResult.rows.length === 0) {
          throw new Error(`Credential with ID '${updates.credential_id}' not found`);
        }
      }

      const updateFields: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (updates.name !== undefined) {
        updateFields.push(`name = $${paramIndex}`);
        params.push(updates.name);
        paramIndex++;
      }

      if (updates.description !== undefined) {
        updateFields.push(`description = $${paramIndex}`);
        params.push(updates.description);
        paramIndex++;
      }

      if (updates.provider !== undefined) {
        updateFields.push(`provider = $${paramIndex}`);
        params.push(updates.provider);
        paramIndex++;
      }

      if (updates.method !== undefined) {
        updateFields.push(`method = $${paramIndex}`);
        params.push(updates.method);
        paramIndex++;
      }

      if (updates.credential_id !== undefined) {
        updateFields.push(`credential_id = $${paramIndex}`);
        params.push(updates.credential_id);
        paramIndex++;
      }

      if (updates.config !== undefined) {
        updateFields.push(`config = $${paramIndex}`);
        params.push(JSON.stringify(updates.config));
        paramIndex++;
      }

      if (updates.schedule !== undefined) {
        updateFields.push(`schedule = $${paramIndex}`);
        params.push(updates.schedule);
        paramIndex++;
      }

      if (updates.is_active !== undefined) {
        updateFields.push(`is_active = $${paramIndex}`);
        params.push(updates.is_active);
        paramIndex++;
      }

      if (updates.tags !== undefined) {
        updateFields.push(`tags = $${paramIndex}`);
        params.push(updates.tags);
        paramIndex++;
      }

      // Always update updated_at
      updateFields.push(`updated_at = $${paramIndex}`);
      params.push(new Date().toISOString());
      paramIndex++;

      // Add ID as final parameter
      params.push(id);

      const result = await client.query(
        `UPDATE discovery_definitions SET ${updateFields.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *`,
        params
      );

      await client.query('COMMIT');

      const definition = this.mapRowToDefinition(result.rows[0]);
      logger.info(`Discovery definition updated: ${id}`, { updates: Object.keys(updates) });

      return definition;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating discovery definition', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a discovery definition
   */
  async deleteDefinition(id: string): Promise<void> {
    const result = await this.postgresClient.query(
      'DELETE FROM discovery_definitions WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      throw new Error(`Discovery definition with ID '${id}' not found`);
    }

    logger.info(`Discovery definition deleted: ${id}`);
  }

  /**
   * Run a discovery definition
   * Creates a discovery job using the definition's configuration and credentials
   */
  async runDefinition(id: string): Promise<{ job_id: string; definition: DiscoveryDefinition }> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query('BEGIN');

      // Get definition with credentials
      const defResult = await client.query(
        `SELECT dd.*, c.credentials
         FROM discovery_definitions dd
         JOIN credentials c ON dd.credential_id = c.id
         WHERE dd.id = $1`,
        [id]
      );

      if (defResult.rows.length === 0) {
        throw new Error(`Discovery definition with ID '${id}' not found`);
      }

      const defRow = defResult.rows[0];
      const definition = this.mapRowToDefinition(defRow);
      const credentials = defRow.credentials;

      // Map provider to queue name
      // NOTE: Cloud providers (AWS, Azure, GCP, Kubernetes) are NOT part of Discovery system.
      // They are for Connector use only.
      const queueNameMap: Record<DiscoveryProvider, string> = {
        ssh: QUEUE_NAMES._DISCOVERY_SSH,
        nmap: QUEUE_NAMES._DISCOVERY_NMAP,
        'active-directory': 'discovery-active-directory',
        snmp: 'discovery-snmp',
      };

      const queueName = queueNameMap[definition.provider];
      if (!queueName) {
        throw new Error(`Unsupported provider: ${definition.provider}`);
      }

      // Create job ID
      const jobId = uuidv4();

      // Create discovery job with merged config and credentials
      const discoveryJob: Partial<DiscoveryJob> = {
        id: jobId,
        provider: definition.provider,
        method: definition.method,
        config: {
          ...definition.config,
          credentials,
        },
        status: 'pending',
        created_at: new Date().toISOString(),
      };

      // Get queue and add job
      const queue = queueManager.getQueue(queueName);
      await queue.add('discover', discoveryJob, {
        jobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      });

      // Update definition with last run info
      await client.query(
        `UPDATE discovery_definitions
         SET last_run_at = $1, last_job_id = $2, updated_at = $3
         WHERE id = $4`,
        [new Date().toISOString(), jobId, new Date().toISOString(), id]
      );

      await client.query('COMMIT');

      logger.info(`Discovery definition executed: ${id}`, { jobId, provider: definition.provider });

      return { job_id: jobId, definition };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error running discovery definition', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Enable scheduled execution for a definition
   */
  async enableSchedule(id: string): Promise<DiscoveryDefinition> {
    const definition = await this.getDefinition(id);

    if (!definition) {
      throw new Error(`Discovery definition with ID '${id}' not found`);
    }

    if (!definition.schedule) {
      throw new Error('Cannot enable schedule: no schedule configured for this definition');
    }

    return this.updateDefinition(id, { is_active: true });
  }

  /**
   * Disable scheduled execution for a definition
   */
  async disableSchedule(id: string): Promise<DiscoveryDefinition> {
    return this.updateDefinition(id, { is_active: false });
  }

  /**
   * Map database row to DiscoveryDefinition object
   */
  private mapRowToDefinition(row: Record<string, any>): DiscoveryDefinition {
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
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_run_at: row.last_run_at,
      last_run_status: row.last_run_status,
      last_job_id: row.last_job_id,
    };
  }
}
