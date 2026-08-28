// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern Storage Service
 * Manages discovery patterns in PostgreSQL with Redis caching
 */

import { getPostgresClient } from '@cmdb/database';
import type { PoolClient } from 'pg';
import { DiscoveryPattern, AIDiscoveryContext } from './types';
import { logger } from '@cmdb/common';
import { PatternCacheService } from './pattern-cache.service';

/**
 * Workflow transition action recorded to ai_pattern_review_history
 * (004_run_logs_and_pattern_review.sql). Shared between
 * PatternStorageService.recordReviewAction()/transitionPattern() and
 * PatternWorkflow.WorkflowAction so both sides of the audit trail agree on
 * the same five actions.
 */
export type PatternReviewAction = 'submit' | 'approve' | 'reject' | 'activate' | 'deactivate';

/**
 * Filters accepted by PatternStorageService.listPatterns(). Unlike
 * loadPatterns() (which is the pattern-matcher's hot-path, active-only,
 * Redis-cached view), this queries ai_discovery_patterns directly across
 * every lifecycle status so the Pattern Library admin UI can browse
 * draft/review/approved/deprecated patterns too.
 */
export interface PatternListFilters {
  status?: string[];
  category?: string;
  isActive?: boolean;
  minConfidence?: number;
  minUsage?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * A single ai_pattern_usage row, enriched with the target host/port of the
 * discovery session that produced it (ai_pattern_usage itself only stores
 * the session_id foreign key).
 */
export interface PatternUsageRecord {
  patternId: string;
  timestamp: Date;
  executionTimeMs: number;
  success: boolean;
  confidenceScore?: number;
  errorMessage?: string;
  matchedHost?: string;
  matchedPort?: number;
}

export class PatternStorageService {
  private patterns: Map<string, DiscoveryPattern> = new Map();
  private postgresClient = getPostgresClient();
  private cache: PatternCacheService;

  constructor() {
    this.cache = new PatternCacheService();
  }

  /**
   * Load all active patterns from database
   * Checks Redis cache first, then falls back to database
   */
  async loadPatterns(): Promise<DiscoveryPattern[]> {
    // Check Redis cache first
    const cached = await this.cache.getActivePatterns();
    if (cached) {
      // Update in-memory cache
      this.patterns.clear();
      for (const pattern of cached) {
        this.patterns.set(pattern.patternId, pattern);
      }
      logger.debug('Loaded patterns from Redis cache', { count: cached.length });
      return cached;
    }
    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `SELECT
          id, pattern_id, name, version, category,
          detection_code, discovery_code,
          description, author, license,
          confidence_score, usage_count, success_count, failure_count,
          avg_execution_time_ms,
          learned_from_sessions, ai_model,
          status, is_active,
          registry_url, community_upvotes, community_downvotes,
          test_cases,
          created_at, updated_at, approved_at, approved_by
        FROM ai_discovery_patterns
        WHERE is_active = true
        ORDER BY confidence_score DESC, usage_count DESC`
      );

      const patterns = result.rows.map(row => this.rowToPattern(row));

      // Cache patterns in memory
      this.patterns.clear();
      for (const pattern of patterns) {
        this.patterns.set(pattern.patternId, pattern);
      }

      // Cache in Redis for next time
      await this.cache.setActivePatterns(patterns);

      logger.info(`Loaded ${patterns.length} active patterns from database`);

      return patterns;
    } catch (error) {
      logger.error('Failed to load patterns', { error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get pattern by ID
   * Checks in-memory cache, then Redis, then database
   */
  async getPattern(patternId: string): Promise<DiscoveryPattern | null> {
    // Check in-memory cache first (fastest)
    if (this.patterns.has(patternId)) {
      return this.patterns.get(patternId)!;
    }

    // Check Redis cache second
    const cached = await this.cache.getPattern(patternId);
    if (cached) {
      // Update in-memory cache
      this.patterns.set(patternId, cached);
      logger.debug('Pattern loaded from Redis cache', { patternId });
      return cached;
    }

    // Load from database as last resort
    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `SELECT * FROM ai_discovery_patterns WHERE pattern_id = $1`,
        [patternId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const pattern = this.rowToPattern(result.rows[0]);

      // Cache in Redis and memory for next time
      await this.cache.setPattern(pattern);
      this.patterns.set(patternId, pattern);

      return pattern;
    } catch (error) {
      logger.error('Failed to get pattern', { patternId, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Save new pattern
   */
  async savePattern(pattern: Omit<DiscoveryPattern, 'id'>): Promise<DiscoveryPattern> {
    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `INSERT INTO ai_discovery_patterns (
          pattern_id, name, version, category,
          detection_code, discovery_code,
          description, author, license,
          confidence_score,
          learned_from_sessions, ai_model,
          status, is_active,
          test_cases
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          pattern.patternId,
          pattern.name,
          pattern.version,
          pattern.category,
          pattern.detectionCode,
          pattern.discoveryCode,
          pattern.description,
          pattern.author,
          pattern.license,
          pattern.confidenceScore,
          pattern.learnedFromSessions ? JSON.stringify(pattern.learnedFromSessions) : null,
          pattern.aiModel,
          pattern.status,
          pattern.isActive,
          pattern.testCases ? JSON.stringify(pattern.testCases) : null,
        ]
      );

      const savedPattern = this.rowToPattern(result.rows[0]);

      // Update in-memory and Redis cache
      this.patterns.set(savedPattern.patternId, savedPattern);
      await this.cache.setPattern(savedPattern);

      // Invalidate the pattern list cache (so it gets refreshed with new pattern)
      await this.cache.invalidatePattern(savedPattern.patternId);

      logger.info('Pattern saved', {
        patternId: savedPattern.patternId,
        version: savedPattern.version,
      });

      return savedPattern;
    } catch (error) {
      logger.error('Failed to save pattern', { pattern, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update pattern
   */
  async updatePattern(
    patternId: string,
    updates: Partial<DiscoveryPattern>
  ): Promise<void> {
    const client = await this.postgresClient.getClient();

    try {
      await this.applyPatternUpdate(client, patternId, updates);

      // Invalidate in-memory and Redis cache
      this.patterns.delete(patternId);
      await this.cache.invalidatePattern(patternId);

      logger.info('Pattern updated', { patternId });
    } catch (error) {
      logger.error('Failed to update pattern', { patternId, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Build and execute the ai_discovery_patterns UPDATE for the given field
   * subset, against a caller-supplied client/transaction. Shared by
   * updatePattern() (its own short-lived connection) and
   * transitionPattern() (a connection shared with the paired
   * ai_pattern_review_history insert, so both commit or roll back
   * together).
   */
  private async applyPatternUpdate(
    client: Pick<PoolClient, 'query'>,
    patternId: string,
    updates: Partial<DiscoveryPattern>
  ): Promise<void> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.detectionCode !== undefined) {
      setClauses.push(`detection_code = $${paramIndex++}`);
      values.push(updates.detectionCode);
    }
    if (updates.discoveryCode !== undefined) {
      setClauses.push(`discovery_code = $${paramIndex++}`);
      values.push(updates.discoveryCode);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.isActive !== undefined) {
      setClauses.push(`is_active = $${paramIndex++}`);
      values.push(updates.isActive);
    }
    if (updates.approvedBy !== undefined) {
      setClauses.push(`approved_by = $${paramIndex++}`);
      values.push(updates.approvedBy);
    }
    if (updates.approvedAt !== undefined) {
      setClauses.push(`approved_at = $${paramIndex++}`);
      values.push(updates.approvedAt);
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);

    values.push(patternId);

    await client.query(
      `UPDATE ai_discovery_patterns
       SET ${setClauses.join(', ')}
       WHERE pattern_id = $${paramIndex}`,
      values
    );
  }

  /**
   * Create the discovery-session row backing a pattern execution.
   *
   * ai_pattern_usage.session_id is a NOT NULL foreign key into
   * ai_discovery_sessions.session_id, so a usage row can only be recorded
   * once a real session exists to reference. Pattern executions aren't
   * driven by an LLM session, so we synthesize a minimal completed/failed
   * session row here to carry that foreign key.
   */
  async createExecutionSession(
    sessionId: string,
    patternId: string,
    context: AIDiscoveryContext,
    status: 'completed' | 'failed',
    durationMs: number,
    discoveredCIs?: unknown[],
    errorMessage?: string
  ): Promise<void> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query(
        `INSERT INTO ai_discovery_sessions (
          session_id, target_host, target_port, scan_result,
          status, completed_at, duration_ms, ai_model,
          discovered_cis, pattern_matched, tool_calls, error_message
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8, $9, $10, $11)`,
        [
          sessionId,
          context.targetHost,
          context.targetPort,
          context.scanResult ? JSON.stringify(context.scanResult) : null,
          status,
          durationMs,
          'pattern-matcher',
          discoveredCIs ? JSON.stringify(discoveredCIs) : null,
          patternId,
          JSON.stringify([]),
          errorMessage ?? null,
        ]
      );

      logger.debug('Recorded discovery session for pattern execution', {
        sessionId,
        patternId,
        status,
      });
    } catch (error) {
      logger.error('Failed to create discovery session for pattern execution', {
        sessionId,
        patternId,
        error,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Record pattern usage
   */
  async recordUsage(
    patternId: string,
    sessionId: string,
    success: boolean,
    executionTimeMs: number,
    confidenceScore?: number,
    errorMessage?: string
  ): Promise<void> {
    const client = await this.postgresClient.getClient();

    try {
      await client.query(
        `INSERT INTO ai_pattern_usage (
          pattern_id, session_id, success, execution_time_ms,
          confidence_score, error_message
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [patternId, sessionId, success, executionTimeMs, confidenceScore, errorMessage]
      );

      logger.debug('Pattern usage recorded', {
        patternId,
        sessionId,
        success,
        executionTimeMs,
      });
    } catch (error) {
      logger.error('Failed to record pattern usage', { patternId, sessionId, error });
      // Don't throw - this is non-critical
    } finally {
      client.release();
    }
  }

  /**
   * Record a workflow transition (submit/approve/reject/activate/
   * deactivate) against a pattern, including any comment/reason the actor
   * gave. A pattern can be commented on at more than one transition
   * (submitted with a note, later rejected with a different one), so this
   * is an append-only per-transition row rather than a column on
   * ai_discovery_patterns.
   */
  async recordReviewAction(
    patternId: string,
    action: PatternReviewAction,
    performedBy: string,
    comment?: string
  ): Promise<void> {
    const client = await this.postgresClient.getClient();

    try {
      await this.insertReviewAction(client, patternId, action, performedBy, comment);
      logger.debug('Pattern review action recorded', { patternId, action, performedBy });
    } catch (error) {
      logger.error('Failed to record pattern review action', { patternId, action, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Insert one ai_pattern_review_history row against a caller-supplied
   * client/transaction. Shared by recordReviewAction() (its own
   * short-lived connection) and transitionPattern() (a connection shared
   * with the paired ai_discovery_patterns UPDATE).
   */
  private async insertReviewAction(
    client: Pick<PoolClient, 'query'>,
    patternId: string,
    action: PatternReviewAction,
    performedBy: string,
    comment?: string
  ): Promise<void> {
    await client.query(
      `INSERT INTO ai_pattern_review_history (
        pattern_id, action, performed_by, comment
      ) VALUES ($1, $2, $3, $4)`,
      [patternId, action, performedBy, comment ?? null]
    );
  }

  /**
   * Atomically apply a lifecycle field update (status/is_active/
   * approvedBy/approvedAt) together with its paired
   * ai_pattern_review_history row, in a single Postgres transaction.
   *
   * PatternWorkflow's five transition methods (submit/approve/reject/
   * activate/deactivate) use this instead of separate updatePattern() +
   * recordReviewAction() calls: if the history insert fails, the status/
   * is_active/approval field change is rolled back with it, so a workflow
   * method can never report a committed lifecycle change with no matching
   * audit row (or vice versa).
   */
  async transitionPattern(
    patternId: string,
    updates: Partial<DiscoveryPattern>,
    action: PatternReviewAction,
    performedBy: string,
    comment?: string
  ): Promise<void> {
    try {
      await this.postgresClient.transaction(async client => {
        await this.applyPatternUpdate(client, patternId, updates);
        await this.insertReviewAction(client, patternId, action, performedBy, comment);
      });
    } catch (error) {
      logger.error('Failed to transition pattern', { patternId, action, error });
      throw error;
    }

    // Only invalidate the in-memory/Redis cache once the transaction has
    // actually committed -- a rolled-back transition must leave the
    // previously cached pattern (still reflecting the pre-transition
    // status) intact rather than evicting it based on a mutation that
    // never happened.
    this.patterns.delete(patternId);
    await this.cache.invalidatePattern(patternId);

    logger.info('Pattern transitioned', { patternId, action, performedBy });
  }

  /**
   * Get the full workflow transition history for a pattern, ordered oldest
   * first, including each actor's comment/reason.
   */
  async getReviewHistory(patternId: string): Promise<
    Array<{
      action: PatternReviewAction;
      performedBy: string;
      comment: string | null;
      createdAt: Date;
    }>
  > {
    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `SELECT action, performed_by, comment, created_at
         FROM ai_pattern_review_history
         WHERE pattern_id = $1
         ORDER BY created_at ASC`,
        [patternId]
      );

      return result.rows.map(row => ({
        action: row.action,
        performedBy: row.performed_by,
        comment: row.comment,
        createdAt: row.created_at,
      }));
    } catch (error) {
      logger.error('Failed to get pattern review history', { patternId, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get patterns by category
   */
  async getPatternsByCategory(category: string): Promise<DiscoveryPattern[]> {
    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `SELECT * FROM ai_discovery_patterns
         WHERE category = $1 AND is_active = true
         ORDER BY confidence_score DESC`,
        [category]
      );

      return result.rows.map(row => this.rowToPattern(row));
    } catch (error) {
      logger.error('Failed to get patterns by category', { category, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * List patterns across every lifecycle status with optional filters, for
   * the Pattern Library admin UI. Unlike loadPatterns()/getCachedPatterns(),
   * this always hits Postgres directly (it needs to see draft/review/
   * deprecated patterns the active-only Redis cache never holds) and is not
   * itself cached.
   */
  async listPatterns(filters: PatternListFilters = {}): Promise<DiscoveryPattern[]> {
    const client = await this.postgresClient.getClient();

    try {
      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (filters.status && filters.status.length > 0) {
        conditions.push(`status = ANY($${paramIndex++})`);
        values.push(filters.status);
      }
      if (filters.category !== undefined) {
        conditions.push(`category = $${paramIndex++}`);
        values.push(filters.category);
      }
      if (filters.isActive !== undefined) {
        conditions.push(`is_active = $${paramIndex++}`);
        values.push(filters.isActive);
      }
      if (filters.minConfidence !== undefined) {
        conditions.push(`confidence_score >= $${paramIndex++}`);
        values.push(filters.minConfidence);
      }
      if (filters.minUsage !== undefined) {
        conditions.push(`usage_count >= $${paramIndex++}`);
        values.push(filters.minUsage);
      }
      if (filters.search) {
        conditions.push(
          `(name ILIKE $${paramIndex} OR pattern_id ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`
        );
        values.push(`%${filters.search}%`);
        paramIndex++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Bound the scan: an admin browsing the library never needs the
      // entire table in one response, and an unbounded SELECT here would
      // let an unfiltered request scan every pattern ever compiled.
      const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
      const offset = Math.max(filters.offset ?? 0, 0);
      values.push(limit, offset);

      const result = await client.query(
        `SELECT * FROM ai_discovery_patterns
         ${where}
         ORDER BY confidence_score DESC, usage_count DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        values
      );

      return result.rows.map(row => this.rowToPattern(row));
    } catch (error) {
      logger.error('Failed to list patterns', { filters, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Delete a pattern outright. ai_pattern_usage and ai_pattern_review_history
   * rows referencing it are removed via ON DELETE CASCADE (see
   * 003_z_ai_discovery_schema.sql / 004_run_logs_and_pattern_review.sql).
   * Returns whether a row was actually deleted.
   */
  async deletePattern(patternId: string): Promise<boolean> {
    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `DELETE FROM ai_discovery_patterns WHERE pattern_id = $1`,
        [patternId]
      );

      this.patterns.delete(patternId);
      await this.cache.invalidatePattern(patternId);

      const deleted = (result.rowCount ?? 0) > 0;
      if (deleted) {
        logger.info('Pattern deleted', { patternId });
      }
      return deleted;
    } catch (error) {
      logger.error('Failed to delete pattern', { patternId, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get per-execution usage records for a pattern over the trailing N days,
   * enriched with the target host/port of the discovery session each
   * execution ran against.
   */
  async getPatternUsage(patternId: string, days: number = 30): Promise<PatternUsageRecord[]> {
    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `SELECT
          u.timestamp, u.execution_time_ms, u.success,
          u.confidence_score, u.error_message,
          s.target_host, s.target_port
        FROM ai_pattern_usage u
        LEFT JOIN ai_discovery_sessions s ON s.session_id = u.session_id
        WHERE u.pattern_id = $1
          AND u.timestamp >= NOW() - ($2 || ' days')::interval
        ORDER BY u.timestamp DESC`,
        [patternId, days]
      );

      return result.rows.map(row => ({
        patternId,
        timestamp: row.timestamp,
        executionTimeMs: row.execution_time_ms,
        success: row.success,
        confidenceScore:
          row.confidence_score !== null && row.confidence_score !== undefined
            ? parseFloat(row.confidence_score)
            : undefined,
        errorMessage: row.error_message ?? undefined,
        matchedHost: row.target_host ?? undefined,
        matchedPort: row.target_port ?? undefined,
      }));
    } catch (error) {
      logger.error('Failed to get pattern usage', { patternId, days, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Convert database row to DiscoveryPattern
   */
  private rowToPattern(row: any): DiscoveryPattern {
    return {
      id: row.id,
      patternId: row.pattern_id,
      name: row.name,
      version: row.version,
      category: row.category,
      detectionCode: row.detection_code,
      discoveryCode: row.discovery_code,
      description: row.description,
      author: row.author,
      license: row.license,
      confidenceScore: parseFloat(row.confidence_score),
      usageCount: row.usage_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      avgExecutionTimeMs: row.avg_execution_time_ms,
      learnedFromSessions: row.learned_from_sessions || [],
      aiModel: row.ai_model,
      status: row.status,
      isActive: row.is_active,
      registryUrl: row.registry_url,
      communityUpvotes: row.community_upvotes,
      communityDownvotes: row.community_downvotes,
      testCases: row.test_cases || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
    };
  }

  /**
   * Get all cached patterns (for quick access)
   */
  getCachedPatterns(): DiscoveryPattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Warm up cache with active patterns
   * Call this during application startup for better initial performance
   */
  async warmupCache(): Promise<void> {
    try {
      const patterns = await this.loadPatterns();
      await this.cache.warmup(patterns);
      logger.info('Pattern cache warmed up', { count: patterns.length });
    } catch (error) {
      logger.error('Failed to warm up cache', { error });
      // Don't throw - this is optional optimization
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    return this.cache.getStats();
  }
}
