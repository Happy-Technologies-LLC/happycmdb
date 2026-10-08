// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential Affinity Matching Service
 * Handles affinity-based credential matching and scoring
 */

import { Pool } from 'pg';
import {
  UnifiedCredential,
  CredentialMatchContext,
  CredentialMatchResult,
} from '@cmdb/common';
import { getEncryptionService } from '@cmdb/common';
import { logger } from '@cmdb/common';
import { isIpInCidr, matchGlob } from './utils';

export class CredentialAffinityService {
  private encryptionService = getEncryptionService();

  constructor(private pool: Pool) {}

  async findBestMatch(
    context: CredentialMatchContext,
    createdBy: string,
    organizationId: string
  ): Promise<CredentialMatchResult | null> {
    const matches = await this.rankCredentials(context, createdBy, organizationId);
    return matches.length > 0 ? matches[0] ?? null : null;
  }

  async rankCredentials(
    context: CredentialMatchContext,
    createdBy: string,
    organizationId: string
  ): Promise<CredentialMatchResult[]> {
    const client = await this.pool.connect();
    try {
      const conditions: string[] = ['created_by = $1', 'organization_id = $2'];
      const params: unknown[] = [createdBy, organizationId];
      let paramIndex = 3;

      // Filter by required protocol
      if (context.required_protocol) {
        conditions.push(`protocol = $${paramIndex++}`);
        params.push(context.required_protocol);
      }

      // Filter by required scope
      if (context.required_scope) {
        conditions.push(`scope = $${paramIndex++}`);
        params.push(context.required_scope);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const result = await client.query(
        `SELECT * FROM credentials ${whereClause}`,
        params
      );

      // Decrypt and score each credential
      const scoredCredentials: CredentialMatchResult[] = [];

      for (const row of result.rows) {
        try {
          const credentialsData = JSON.parse(
            this.encryptionService.decrypt(row.credentials)
          );

          const credential: UnifiedCredential = {
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

          const { score, reasons } = this.calculateAffinityScore(
            credential,
            context
          );

          scoredCredentials.push({
            credential,
            score,
            reasons,
          });
        } catch (error) {
          logger.error('Failed to decrypt credential during matching', {
            id: row.id,
            error,
          });
        }
      }

      // Sort by score descending
      scoredCredentials.sort((a, b) => b.score - a.score);

      return scoredCredentials;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate affinity score for a credential against a context
   *
   * Scoring:
   * - Network match (CIDR): +30 points
   * - Hostname pattern match (glob): +25 points
   * - OS type match: +20 points
   * - Device type match: +15 points
   * - Environment match: +10 points
   * - Cloud provider match: +20 points
   * - Priority boost: +(priority * 2) points (10-20 bonus for priority 5-10)
   */
  calculateAffinityScore(
    credential: UnifiedCredential,
    context: CredentialMatchContext
  ): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];
    const affinity = credential.affinity;

    // Network match (CIDR)
    if (context.ip && affinity.networks && affinity.networks.length > 0) {
      for (const network of affinity.networks) {
        if (network && isIpInCidr(context.ip, network)) {
          score += 30;
          reasons.push(`Network match: ${network}`);
          break;
        }
      }
    }

    // Hostname pattern match (glob)
    if (
      context.hostname &&
      affinity.hostname_patterns &&
      affinity.hostname_patterns.length > 0
    ) {
      for (const pattern of affinity.hostname_patterns) {
        if (pattern && matchGlob(context.hostname, pattern)) {
          score += 25;
          reasons.push(`Hostname match: ${pattern}`);
          break;
        }
      }
    }

    // OS type match
    if (
      context.os_type &&
      affinity.os_types &&
      affinity.os_types.includes(context.os_type)
    ) {
      score += 20;
      reasons.push(`OS type match: ${context.os_type}`);
    }

    // Device type match
    if (
      context.device_type &&
      affinity.device_types &&
      affinity.device_types.includes(context.device_type)
    ) {
      score += 15;
      reasons.push(`Device type match: ${context.device_type}`);
    }

    // Environment match
    if (
      context.environment &&
      affinity.environments &&
      affinity.environments.includes(context.environment)
    ) {
      score += 10;
      reasons.push(`Environment match: ${context.environment}`);
    }

    // Cloud provider match
    if (
      context.cloud_provider &&
      affinity.cloud_providers &&
      affinity.cloud_providers.includes(context.cloud_provider)
    ) {
      score += 20;
      reasons.push(`Cloud provider match: ${context.cloud_provider}`);
    }

    // Priority boost (1-10 scale, multiply by 2 for 2-20 bonus)
    if (affinity.priority !== undefined) {
      const priorityBonus = affinity.priority * 2;
      score += priorityBonus;
      reasons.push(`Priority boost: +${priorityBonus} (priority ${affinity.priority})`);
    }

    // If no affinity matches but credential still matches protocol/scope, give base score
    if (reasons.length === 0) {
      score = 1;
      reasons.push('Default match (no affinity specified)');
    }

    return { score, reasons };
  }
}
