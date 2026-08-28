// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Reconciliation Job
 *
 * This job detects and resolves data inconsistencies between Neo4j and PostgreSQL.
 * It ensures data integrity across the platform by:
 * - Comparing CI records between sources
 * - Identifying conflicts and discrepancies
 * - Applying resolution strategies
 * - Logging reconciliation actions for audit
 */

import { Job } from 'bullmq';
import { Neo4jClient, PostgresClient } from '@cmdb/database';
import { logger, CI, CIStatus } from '@cmdb/common';

export interface ReconciliationJobData {
  /** CIs to reconcile (if not specified, reconciles all) */
  ciIds?: string[];
  /** Strategy for conflict resolution */
  conflictStrategy?: ConflictResolutionStrategy;
  /** Whether to auto-resolve conflicts */
  autoResolve?: boolean;
  /** Maximum age of data to consider (in hours) */
  maxAgeHours?: number;
}

export type ConflictResolutionStrategy =
  | 'neo4j-wins'        // Neo4j is source of truth
  | 'postgres-wins'     // PostgreSQL is source of truth
  | 'newest-wins'       // Most recently updated wins
  | 'manual'            // Flag for manual resolution
  | 'merge';            // Attempt intelligent merge

export interface ReconciliationResult {
  /** Total CIs checked */
  _cisChecked: number;
  /** Number of conflicts detected */
  _conflictsDetected: number;
  /** Number of conflicts resolved */
  _conflictsResolved: number;
  /** Number of conflicts requiring manual review */
  _manualReviewRequired: number;
  /** Conflicts found */
  _conflicts: Conflict[];
  /** Duration in milliseconds */
  _durationMs: number;
  /** Timestamp of completion */
  _completedAt: string;
}

export interface Conflict {
  /** CI identifier */
  _ciId: string;
  /** Type of conflict */
  _type: ConflictType;
  /** Description of conflict */
  _description: string;
  /** Neo4j value */
  _neo4jValue: any;
  /** PostgreSQL value */
  _postgresValue: any;
  /** Resolution applied (if any) */
  resolution?: string;
  /** Whether conflict was auto-resolved */
  _autoResolved: boolean;
}

export type ConflictType =
  | 'missing-in-neo4j'
  | 'missing-in-postgres'
  | 'status-mismatch'
  | 'metadata-mismatch'
  | 'timestamp-mismatch'
  | 'relationship-mismatch';

/**
 * Main reconciliation processor class
 */
export class ReconciliationJob {
  private neo4jClient: Neo4jClient;
  private postgresClient: PostgresClient;

  constructor(neo4jClient: Neo4jClient, postgresClient: PostgresClient) {
    this.neo4jClient = neo4jClient;
    this.postgresClient = postgresClient;
  }

  /**
   * Execute the reconciliation job
   */
  async execute(job: Job<ReconciliationJobData>): Promise<ReconciliationResult> {
    const startTime = Date.now();
    const data = job.data;

    logger.info('Starting reconciliation job', {
      _jobId: job.id,
      data
    });

    const result: ReconciliationResult = {
      _cisChecked: 0,
      _conflictsDetected: 0,
      _conflictsResolved: 0,
      _manualReviewRequired: 0,
      _conflicts: [],
      _durationMs: 0,
      _completedAt: new Date().toISOString()
    };

    try {
      // Get CIs to reconcile
      const ciIds = data.ciIds || await this.getAllCIIds();

      logger.info(`Reconciling ${ciIds.length} CIs`);

      // Process each CI
      for (let i = 0; i < ciIds.length; i++) {
        const ciId = ciIds[i];
        await job.updateProgress((i / ciIds.length) * 100);

        try {
          const conflicts = await this.reconcileCI(ciId!, data);

          if (conflicts.length > 0) {
            result._conflictsDetected += conflicts.length;
            result._conflicts.push(...conflicts);

            const resolved = conflicts.filter(c => c._autoResolved).length;
            result._conflictsResolved += resolved;
            result._manualReviewRequired += conflicts.length - resolved;
          }

          result._cisChecked++;

        } catch (error) {
          logger.error('Error reconciling CI', { ciId, error });
        }
      }

      result._durationMs = Date.now() - startTime;
      result._completedAt = new Date().toISOString();

      logger.info('Reconciliation job completed', result);
      return result;

    } catch (error) {
      logger.error('Reconciliation job failed', { error, jobId: job.id });
      throw error;
    }
  }

  /**
   * Reconcile a single CI
   */
  private async reconcileCI(
    ciId: string,
    data: ReconciliationJobData
  ): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];

    // Fetch CI from both sources
    const neo4jCI = await this.neo4jClient.getCI(ciId);
    const postgresCI = await this.getPostgresCI(ciId);

    // Check if CI exists in both sources
    if (!neo4jCI && postgresCI) {
      conflicts.push({
        _ciId: ciId,
        _type: 'missing-in-neo4j',
        _description: 'CI exists in PostgreSQL but not in Neo4j',
        _neo4jValue: null,
        _postgresValue: postgresCI,
        _autoResolved: false
      });

      if (data.autoResolve && data.conflictStrategy === 'postgres-wins') {
        await this.resolveByCreatingInNeo4j(postgresCI!);
        conflicts[conflicts.length - 1]!._autoResolved = true;
        conflicts[conflicts.length - 1]!.resolution = 'Created CI in Neo4j from PostgreSQL';
      }

      return conflicts;
    }

    if (neo4jCI && !postgresCI) {
      conflicts.push({
        _ciId: ciId,
        _type: 'missing-in-postgres',
        _description: 'CI exists in Neo4j but not in PostgreSQL',
        _neo4jValue: neo4jCI,
        _postgresValue: null,
        _autoResolved: false
      });

      if (data.autoResolve && data.conflictStrategy === 'neo4j-wins') {
        await this.resolveByCreatingInPostgres(neo4jCI!);
        conflicts[conflicts.length - 1]!._autoResolved = true;
        conflicts[conflicts.length - 1]!.resolution = 'Created CI in PostgreSQL from Neo4j';
      }

      return conflicts;
    }

    if (!neo4jCI && !postgresCI) {
      return conflicts; // CI doesn't exist in either source
    }

    // Both exist - check for discrepancies
    if (neo4jCI && postgresCI) {
      // Status mismatch
      if (neo4jCI._status !== postgresCI._status) {
        const conflict: Conflict = {
          _ciId: ciId,
          _type: 'status-mismatch',
          _description: `Status mismatch: Neo4j='${neo4jCI._status}', PostgreSQL='${postgresCI._status}'`,
          _neo4jValue: neo4jCI._status,
          _postgresValue: postgresCI._status,
          _autoResolved: false
        };

        if (data.autoResolve) {
          const resolved = await this.resolveStatusConflict(
            ciId,
            neo4jCI,
            postgresCI,
            data.conflictStrategy || 'newest-wins'
          );
          if (resolved) {
            conflict._autoResolved = true;
            conflict.resolution = resolved;
          }
        }

        conflicts.push(conflict);
      }

      // Metadata mismatch (simplified check)
      const neo4jMetaKeys = Object.keys(neo4jCI._metadata || {});
      const pgMetaKeys = Object.keys(postgresCI._metadata || {});

      if (neo4jMetaKeys.length !== pgMetaKeys.length) {
        conflicts.push({
          _ciId: ciId,
          _type: 'metadata-mismatch',
          _description: 'Metadata key count mismatch between sources',
          _neo4jValue: neo4jCI._metadata,
          _postgresValue: postgresCI._metadata,
          _autoResolved: false
        });
      }

      // Timestamp comparison (detect stale data)
      const neo4jUpdated = new Date(neo4jCI._updated_at).getTime();
      const pgUpdated = new Date(postgresCI._updated_at).getTime();
      const diff = Math.abs(neo4jUpdated - pgUpdated);

      // If difference is more than 1 hour, flag it
      if (diff > 3600000) {
        conflicts.push({
          _ciId: ciId,
          _type: 'timestamp-mismatch',
          _description: `Large timestamp difference detected: ${diff}ms`,
          _neo4jValue: neo4jCI._updated_at,
          _postgresValue: postgresCI._updated_at,
          _autoResolved: false
        });
      }
    }

    return conflicts;
  }

  /**
   * Get CI from PostgreSQL data mart
   */
  private async getPostgresCI(ciId: string): Promise<CI | null> {
    const result = await this.postgresClient.query(
      `SELECT * FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = true`,
      [ciId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      _id: row.ci_id,
      external_id: row.external_id,
      name: row.ci_name,
      _type: row.ci_type,
      _status: row.ci_status,
      environment: row.environment,
      _created_at: row.created_at,
      _updated_at: row.updated_at,
      _discovered_at: row.discovered_at,
      _metadata: row.metadata || {}
    };
  }

  /**
   * Get all CI IDs from both sources
   */
  private async getAllCIIds(): Promise<string[]> {
    const session = this.neo4jClient.getSession();
    const ciIds = new Set<string>();

    try {
      // Get from Neo4j
      const neo4jResult = await session.run('MATCH (ci:CI) RETURN ci.id as id');
      neo4jResult.records.forEach((record: any) => ciIds.add(record.get('id')));

      // Get from PostgreSQL
      const pgResult = await this.postgresClient.query(
        'SELECT DISTINCT ci_id FROM cmdb.dim_ci WHERE is_current = true'
      );
      pgResult.rows.forEach((row: any) => ciIds.add(row.ci_id));

      return Array.from(ciIds);

    } finally {
      await session.close();
    }
  }

  /**
   * Resolve status conflict based on strategy
   */
  private async resolveStatusConflict(
    ciId: string,
    neo4jCI: CI,
    postgresCI: CI,
    strategy: ConflictResolutionStrategy
  ): Promise<string | null> {
    let sourceOfTruth: 'neo4j' | 'postgres' | null = null;

    switch (strategy) {
      case 'neo4j-wins':
        sourceOfTruth = 'neo4j';
        break;
      case 'postgres-wins':
        sourceOfTruth = 'postgres';
        break;
      case 'newest-wins':
        const neo4jTime = new Date(neo4jCI._updated_at).getTime();
        const pgTime = new Date(postgresCI._updated_at).getTime();
        sourceOfTruth = neo4jTime > pgTime ? 'neo4j' : 'postgres';
        break;
      default:
        return null; // No resolution for manual or merge strategies
    }

    if (sourceOfTruth === 'neo4j') {
      await this.updatePostgresStatus(ciId, neo4jCI._status);
      return `Updated PostgreSQL status to '${neo4jCI._status}' from Neo4j`;
    } else {
      await this.updateNeo4jStatus(ciId, postgresCI._status);
      return `Updated Neo4j status to '${postgresCI._status}' from PostgreSQL`;
    }
  }

  /**
   * Update CI status in PostgreSQL
   */
  private async updatePostgresStatus(ciId: string, status: CIStatus): Promise<void> {
    await this.postgresClient.query(
      `UPDATE cmdb.dim_ci SET ci_status = $1, updated_at = NOW()
       WHERE ci_id = $2 AND is_current = true`,
      [status, ciId]
    );
    logger.info('Updated PostgreSQL CI status', { ciId, status });
  }

  /**
   * Update CI status in Neo4j
   */
  private async updateNeo4jStatus(ciId: string, status: CIStatus): Promise<void> {
    await this.neo4jClient.updateCI(ciId, { status });
    logger.info('Updated Neo4j CI status', { ciId, status });
  }

  /**
   * Create CI in Neo4j from PostgreSQL data
   */
  private async resolveByCreatingInNeo4j(ci: CI): Promise<void> {
    await this.neo4jClient.createCI(ci);
    logger.info('Created CI in Neo4j from PostgreSQL', { ciId: ci._id });
  }

  /**
   * Create CI in PostgreSQL from Neo4j data
   */
  private async resolveByCreatingInPostgres(ci: CI): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO cmdb.dim_ci
       (ci_id, ci_name, ci_type, environment, ci_status, effective_from, is_current)
       VALUES ($1, $2, $3, $4, $5, NOW(), true)`,
      [ci._id, ci.name, ci._type, ci.environment, ci._status]
    );
    logger.info('Created CI in PostgreSQL from Neo4j', { ciId: ci._id });
  }
}

/**
 * BullMQ job processor function
 */
export async function processReconciliationJob(
  job: Job<ReconciliationJobData>,
  neo4jClient: Neo4jClient,
  postgresClient: PostgresClient
): Promise<ReconciliationResult> {
  const processor = new ReconciliationJob(neo4jClient, postgresClient);
  return await processor.execute(job);
}
