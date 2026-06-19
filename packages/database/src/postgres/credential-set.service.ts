// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential Set Service
 *
 * Manages credential sets for HappyCMDB's unified credential system.
 * Credential sets allow grouping multiple credentials to try in order,
 * perfect for NMAP scanning where you want to try admin creds, then root, then service accounts.
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  CredentialSet,
  CredentialSetInput,
  CredentialSetUpdateInput,
  CredentialSetSummary,
  CredentialSetStrategy,
  CredentialMatchContext,
  UnifiedCredential,
  UnifiedCredentialSummary,
} from '@cmdb/common';
import { logger } from '@cmdb/common';
import { getEncryptionService } from '@cmdb/common';

export class CredentialSetService {
  private encryptionService = getEncryptionService();

  constructor(private pool: Pool) {}

  /**
   * Create a new credential set
   */
  async create(
    input: CredentialSetInput,
    createdBy: string
  ): Promise<CredentialSet> {
    const client = await this.pool.connect();
    try {
      // Validate credential_ids array is not empty
      if (!input.credential_ids || input.credential_ids.length === 0) {
        throw new Error('Credential set must contain at least one credential');
      }

      // Validate all credential IDs exist
      const credentialCheckResult = await client.query(
        `
        SELECT id FROM credentials WHERE id = ANY($1::uuid[])
        `,
        [input.credential_ids]
      );

      if (credentialCheckResult.rows.length !== input.credential_ids.length) {
        const foundIds = credentialCheckResult.rows.map((row) => row.id);
        const missingIds = input.credential_ids.filter(
          (id) => !foundIds.includes(id)
        );
        throw new Error(
          `The following credential IDs do not exist: ${missingIds.join(', ')}`
        );
      }

      const id = uuidv4();
      const strategy = input.strategy || 'sequential';
      const stopOnSuccess = input.stop_on_success !== undefined ? input.stop_on_success : true;

      // Validate strategy
      if (!['sequential', 'parallel', 'adaptive'].includes(strategy)) {
        throw new Error(
          `Invalid strategy: ${strategy}. Must be one of: sequential, parallel, adaptive`
        );
      }

      const result = await client.query(
        `
        INSERT INTO credential_sets (
          id,
          name,
          description,
          credential_ids,
          strategy,
          stop_on_success,
          tags,
          created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
          id,
          input.name,
          input.description || null,
          input.credential_ids,
          strategy,
          stopOnSuccess,
          input.tags || [],
          createdBy,
        ]
      );

      const row = result.rows[0];

      logger.info('Credential set created', {
        id: row.id,
        name: row.name,
        strategy: row.strategy,
        credential_count: row.credential_ids.length,
        created_by: createdBy,
      });

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        credential_ids: row.credential_ids,
        strategy: row.strategy,
        stop_on_success: row.stop_on_success,
        tags: row.tags,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    } catch (error: any) {
      if (error.code === '23505') {
        // Unique constraint violation
        throw new Error(`Credential set with name '${input.name}' already exists`);
      }
      logger.error('Failed to create credential set', { error, input });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get credential set by ID (basic info without expanded credentials)
   */
  async getById(id: string): Promise<CredentialSet | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT * FROM credential_sets WHERE id = $1
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        credential_ids: row.credential_ids,
        strategy: row.strategy,
        stop_on_success: row.stop_on_success,
        tags: row.tags,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get credential set with expanded credential details
   * Uses the credential_set_summaries view which includes full credential info
   */
  async getWithCredentials(id: string): Promise<CredentialSetSummary | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT
          id,
          name,
          description,
          strategy,
          stop_on_success,
          tags,
          created_by,
          created_at,
          updated_at,
          credential_ids,
          usage_count,
          credentials
        FROM credential_set_summaries
        WHERE id = $1
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      // Parse credentials JSON array into UnifiedCredentialSummary objects
      const credentials: UnifiedCredentialSummary[] = row.credentials || [];

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        credentials,
        strategy: row.strategy,
        stop_on_success: row.stop_on_success,
        tags: row.tags,
        created_at: row.created_at,
        updated_at: row.updated_at,
        usage_count: parseInt(row.usage_count || '0', 10),
      };
    } finally {
      client.release();
    }
  }

  /**
   * List all credential sets with expanded credentials
   */
  async list(): Promise<CredentialSetSummary[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `
        SELECT
          id,
          name,
          description,
          strategy,
          stop_on_success,
          tags,
          created_by,
          created_at,
          updated_at,
          credential_ids,
          usage_count,
          credentials
        FROM credential_set_summaries
        ORDER BY created_at DESC
        `
      );

      return result.rows.map((row) => {
        const credentials: UnifiedCredentialSummary[] = row.credentials || [];

        return {
          id: row.id,
          name: row.name,
          description: row.description,
          credentials,
          strategy: row.strategy,
          stop_on_success: row.stop_on_success,
          tags: row.tags,
          created_at: row.created_at,
          updated_at: row.updated_at,
          usage_count: parseInt(row.usage_count || '0', 10),
        };
      });
    } finally {
      client.release();
    }
  }

  /**
   * Update credential set
   */
  async update(
    id: string,
    input: CredentialSetUpdateInput
  ): Promise<CredentialSet> {
    const client = await this.pool.connect();
    try {
      // If credential_ids provided, validate they exist
      if (input.credential_ids && input.credential_ids.length > 0) {
        const credentialCheckResult = await client.query(
          `
          SELECT id FROM credentials WHERE id = ANY($1::uuid[])
          `,
          [input.credential_ids]
        );

        if (credentialCheckResult.rows.length !== input.credential_ids.length) {
          const foundIds = credentialCheckResult.rows.map((row) => row.id);
          const missingIds = input.credential_ids.filter(
            (id) => !foundIds.includes(id)
          );
          throw new Error(
            `The following credential IDs do not exist: ${missingIds.join(', ')}`
          );
        }
      }

      // Validate strategy if provided
      if (input.strategy && !['sequential', 'parallel', 'adaptive'].includes(input.strategy)) {
        throw new Error(
          `Invalid strategy: ${input.strategy}. Must be one of: sequential, parallel, adaptive`
        );
      }

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

      if (input.credential_ids !== undefined) {
        updates.push(`credential_ids = $${paramIndex++}`);
        params.push(input.credential_ids);
      }

      if (input.strategy !== undefined) {
        updates.push(`strategy = $${paramIndex++}`);
        params.push(input.strategy);
      }

      if (input.stop_on_success !== undefined) {
        updates.push(`stop_on_success = $${paramIndex++}`);
        params.push(input.stop_on_success);
      }

      if (input.tags !== undefined) {
        updates.push(`tags = $${paramIndex++}`);
        params.push(input.tags);
      }

      if (updates.length === 0) {
        const existing = await this.getById(id);
        if (!existing) {
          throw new Error(`Credential set with ID ${id} not found`);
        }
        return existing;
      }

      params.push(id);

      const result = await client.query(
        `
        UPDATE credential_sets
        SET ${updates.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
        `,
        params
      );

      if (result.rows.length === 0) {
        throw new Error(`Credential set with ID ${id} not found`);
      }

      const row = result.rows[0];

      logger.info('Credential set updated', {
        id: row.id,
        name: row.name,
        updates: Object.keys(input),
      });

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        credential_ids: row.credential_ids,
        strategy: row.strategy,
        stop_on_success: row.stop_on_success,
        tags: row.tags,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    } catch (error: any) {
      if (error.code === '23505') {
        throw new Error(`Credential set with name '${input.name}' already exists`);
      }
      logger.error('Failed to update credential set', { error, id });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete credential set
   * Only allowed if not in use by any discovery definitions
   */
  async delete(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Check if credential set is in use
      const usageResult = await client.query(
        `
        SELECT COUNT(*) as count
        FROM discovery_definitions
        WHERE credential_set_id = $1
        `,
        [id]
      );

      const usageCount = parseInt(usageResult.rows[0].count, 10);
      if (usageCount > 0) {
        throw new Error(
          `Cannot delete credential set: it is currently used by ${usageCount} discovery definition(s)`
        );
      }

      // Delete credential set
      const result = await client.query(
        `
        DELETE FROM credential_sets
        WHERE id = $1
        RETURNING id, name
        `,
        [id]
      );

      if (result.rows.length === 0) {
        throw new Error(`Credential set with ID ${id} not found`);
      }

      logger.info('Credential set deleted', {
        id: result.rows[0].id,
        name: result.rows[0].name,
      });
    } catch (error) {
      logger.error('Failed to delete credential set', { error, id });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Select credentials from a set with strategy application
   *
   * @param setId - Credential set ID
   * @param context - Context for affinity matching
   * @param strategy - Optional strategy override (defaults to set's strategy)
   * @returns Ordered array of UnifiedCredential objects (decrypted)
   */
  async selectCredentials(
    setId: string,
    context: CredentialMatchContext,
    strategy?: CredentialSetStrategy
  ): Promise<UnifiedCredential[]> {
    const client = await this.pool.connect();
    try {
      // Fetch credential set
      const set = await this.getById(setId);
      if (!set) {
        throw new Error(`Credential set with ID ${setId} not found`);
      }

      const effectiveStrategy = strategy || set.strategy;

      // Fetch all credentials in the set (with decryption)
      const credentialResults = await client.query(
        `
        SELECT * FROM credentials
        WHERE id = ANY($1::uuid[])
        `,
        [set.credential_ids]
      );

      // Decrypt credentials and convert to UnifiedCredential objects
      const credentials: UnifiedCredential[] = credentialResults.rows.map((row) => {
        // Decrypt credentials
        const credentialsData = JSON.parse(
          this.encryptionService.decrypt(row.credentials)
        );

        return {
          id: row.id,
          name: row.name,
          description: row.description,
          protocol: row.protocol,
          scope: row.scope,
          credentials: credentialsData,
          affinity: row.affinity || {},
          tags: row.tags || [],
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          last_validated_at: row.last_validated_at,
          validation_status: row.validation_status,
        };
      });

      // Apply strategy
      switch (effectiveStrategy) {
        case 'sequential':
          // Return credentials in array order, no reordering
          return this.sortBySetOrder(credentials, set.credential_ids);

        case 'parallel':
          // Return all credentials as-is (caller will try in parallel)
          // Still respect the set order as a hint
          return this.sortBySetOrder(credentials, set.credential_ids);

        case 'adaptive':
          // Use affinity matching to rank credentials, then merge with set order
          return this.applyAdaptiveStrategy(credentials, set.credential_ids, context);

        default:
          throw new Error(`Unknown strategy: ${effectiveStrategy}`);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Sort credentials by their order in the credential set
   */
  private sortBySetOrder(
    credentials: UnifiedCredential[],
    credentialIds: string[]
  ): UnifiedCredential[] {
    const orderMap = new Map<string, number>();
    credentialIds.forEach((id, index) => {
      orderMap.set(id, index);
    });

    return credentials.sort((a, b) => {
      const orderA = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const orderB = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    });
  }

  /**
   * Apply adaptive strategy: rank by affinity, then merge with set order
   * Credentials that match affinity are boosted to the front
   */
  private applyAdaptiveStrategy(
    credentials: UnifiedCredential[],
    credentialIds: string[],
    context: CredentialMatchContext
  ): UnifiedCredential[] {
    // Calculate affinity scores for each credential
    const scoredCredentials = credentials.map((credential) => ({
      credential,
      affinityScore: this.calculateAffinityScore(credential, context),
      setOrder: credentialIds.indexOf(credential.id),
    }));

    // Sort by affinity score (descending), then by set order (ascending)
    scoredCredentials.sort((a, b) => {
      // If affinity scores are different, prefer higher score
      if (a.affinityScore !== b.affinityScore) {
        return b.affinityScore - a.affinityScore;
      }
      // If affinity scores are the same, use set order
      return a.setOrder - b.setOrder;
    });

    return scoredCredentials.map((item) => item.credential);
  }

  /**
   * Calculate affinity score for a credential based on context
   *
   * NOTE: This is a simplified implementation. When UnifiedCredentialService is implemented,
   * this should delegate to UnifiedCredentialService.rankCredentials() instead.
   *
   * Scoring:
   * - Network match (CIDR): +30
   * - Hostname pattern match (glob): +25
   * - OS type match: +20
   * - Device type match: +15
   * - Environment match: +10
   * - Cloud provider match: +20
   * - Priority boost: (priority * 2) points (10-20 points for priority 5-10)
   */
  private calculateAffinityScore(
    credential: UnifiedCredential,
    context: CredentialMatchContext
  ): number {
    let score = 0;
    const affinity = credential.affinity;

    // Network match (CIDR notation)
    if (context.ip && affinity.networks && affinity.networks.length > 0) {
      const isInNetwork = affinity.networks.some((cidr) =>
        this.isIpInCidr(context.ip!, cidr)
      );
      if (isInNetwork) {
        score += 30;
      }
    }

    // Hostname pattern match (glob or regex)
    if (context.hostname && affinity.hostname_patterns && affinity.hostname_patterns.length > 0) {
      const matchesPattern = affinity.hostname_patterns.some((pattern) =>
        this.matchesHostnamePattern(context.hostname!, pattern)
      );
      if (matchesPattern) {
        score += 25;
      }
    }

    // OS type match
    if (context.os_type && affinity.os_types && affinity.os_types.includes(context.os_type)) {
      score += 20;
    }

    // Device type match
    if (context.device_type && affinity.device_types && affinity.device_types.includes(context.device_type)) {
      score += 15;
    }

    // Environment match
    if (context.environment && affinity.environments && affinity.environments.includes(context.environment)) {
      score += 10;
    }

    // Cloud provider match
    if (context.cloud_provider && affinity.cloud_providers && affinity.cloud_providers.includes(context.cloud_provider)) {
      score += 20;
    }

    // Required protocol match
    if (context.required_protocol && credential.protocol !== context.required_protocol) {
      // Penalize heavily if protocol doesn't match (but don't exclude)
      score -= 50;
    }

    // Required scope match
    if (context.required_scope && credential.scope !== context.required_scope && credential.scope !== 'universal') {
      // Penalize if scope doesn't match (unless credential is universal)
      score -= 30;
    }

    // Priority boost (1-10, higher = try first)
    const priority = affinity.priority || 5;
    score += priority * 2;

    return Math.max(0, score); // Ensure non-negative
  }

  /**
   * Check if IP address is within CIDR range
   * Simple implementation - for production, use a proper CIDR library like 'ip-cidr'
   */
  private isIpInCidr(ip: string, cidr: string): boolean {
    try {
      // Very basic CIDR matching - in production, use a proper library
      const [network, bits] = cidr.split('/');
      if (!network) {
        return false;
      }
      if (!bits) {
        // Exact IP match
        return ip === network;
      }

      const ipParts = ip.split('.').map(Number);
      const networkParts = network.split('.').map(Number);
      const maskBits = parseInt(bits, 10);

      if (ipParts.length !== 4 || networkParts.length !== 4) {
        return false;
      }

      // Check for undefined parts
      if (
        ipParts[0] === undefined || ipParts[1] === undefined || ipParts[2] === undefined || ipParts[3] === undefined ||
        networkParts[0] === undefined || networkParts[1] === undefined || networkParts[2] === undefined || networkParts[3] === undefined
      ) {
        return false;
      }

      // Convert IP and network to 32-bit integers
      const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
      const networkInt = (networkParts[0] << 24) | (networkParts[1] << 16) | (networkParts[2] << 8) | networkParts[3];

      // Create mask
      const mask = ~((1 << (32 - maskBits)) - 1);

      // Check if IP is in network
      return (ipInt & mask) === (networkInt & mask);
    } catch (error) {
      logger.warn('Failed to parse CIDR', { ip, cidr, error });
      return false;
    }
  }

  /**
   * Check if hostname matches pattern (glob-style)
   * Supports: *, ?, and exact matches
   */
  private matchesHostnamePattern(hostname: string, pattern: string): boolean {
    try {
      // Convert glob pattern to regex
      const regexPattern = pattern
        .replace(/\./g, '\\.') // Escape dots
        .replace(/\*/g, '.*')  // * matches any characters
        .replace(/\?/g, '.');  // ? matches single character

      const regex = new RegExp(`^${regexPattern}$`, 'i'); // Case-insensitive
      return regex.test(hostname);
    } catch (error) {
      logger.warn('Failed to match hostname pattern', { hostname, pattern, error });
      return false;
    }
  }
}

// Singleton instance
let credentialSetService: CredentialSetService | null = null;

export function getCredentialSetService(pool: Pool): CredentialSetService {
  if (!credentialSetService) {
    credentialSetService = new CredentialSetService(pool);
  }
  return credentialSetService;
}
