// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Full Refresh Job
 *
 * This job performs a complete refresh of the PostgreSQL data mart from Neo4j.
 * It is typically run during initial setup or when data synchronization issues
 * require a complete rebuild of the analytical data warehouse.
 *
 * Process:
 * 1. Truncate all fact and dimension tables in PostgreSQL
 * 2. Extract all CIs and relationships from Neo4j
 * 3. Transform and load data into PostgreSQL with proper SCD Type 2 setup
 * 4. Rebuild indexes and update statistics
 */

import { Job } from 'bullmq';
import type { PoolClient } from 'pg';
import { Neo4jClient, PostgresClient } from '@cmdb/database';
import { logger, CI, validateTableNames } from '@cmdb/common';
import { DimensionTransformer } from '../transformers/dimension-transformer';

export interface FullRefreshJobData {
  /** Whether to truncate tables before refresh */
  truncateTables?: boolean;
  /** Batch size for processing */
  batchSize?: number;
  /** Whether to rebuild indexes after refresh */
  rebuildIndexes?: boolean;
}

export interface FullRefreshResult {
  /** Total CIs processed */
  cisProcessed: number;
  /** Total relationships processed */
  relationshipsProcessed: number;
  /** Number of dimension records created */
  dimensionsCreated: number;
  /** Number of fact records created */
  factsCreated: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Timestamp of completion */
  completedAt: string;
  /** Stages completed */
  stagesCompleted: string[];
}

/**
 * Main full refresh processor class
 */
export class FullRefreshJob {
  private neo4jClient: Neo4jClient;
  private postgresClient: PostgresClient;
  private dimensionTransformer: DimensionTransformer;

  constructor(neo4jClient: Neo4jClient, postgresClient: PostgresClient) {
    this.neo4jClient = neo4jClient;
    this.postgresClient = postgresClient;
    this.dimensionTransformer = new DimensionTransformer();
  }

  /**
   * Execute the full refresh job
   */
  async execute(job: Job<FullRefreshJobData>): Promise<FullRefreshResult> {
    const startTime = Date.now();
    const data = job.data;
    const batchSize = data.batchSize || 500;

    logger.info('Starting full refresh job', {
      jobId: job.id,
      data
    });

    const result: FullRefreshResult = {
      cisProcessed: 0,
      relationshipsProcessed: 0,
      dimensionsCreated: 0,
      factsCreated: 0,
      durationMs: 0,
      completedAt: new Date().toISOString(),
      stagesCompleted: []
    };

    try {
      // Stage 1: Truncate tables if requested
      if (data.truncateTables !== false) {
        await this.truncateTables();
        await job.updateProgress(10);
        result.stagesCompleted.push('truncate');
        logger.info('Tables truncated successfully');
      }

      // Stage 2: Extract all CIs from Neo4j
      const cis = await this.extractAllCIs();
      await job.updateProgress(25);
      result.stagesCompleted.push('extract-cis');
      logger.info(`Extracted ${cis.length} CIs from Neo4j`);

      // Stage 3: Load CI dimensions in batches
      for (let i = 0; i < cis.length; i += batchSize) {
        const batch = cis.slice(i, i + batchSize);
        const progress = 25 + ((i / cis.length) * 40);
        await job.updateProgress(progress);

        const batchResult = await this.loadCIDimensions(batch, job.id);
        result.dimensionsCreated += batchResult.created;
        result.cisProcessed += batch.length;
      }

      result.stagesCompleted.push('load-dimensions');
      logger.info(`Loaded ${result.dimensionsCreated} CI dimensions`);

      // Stage 4: Extract and load relationships
      await job.updateProgress(70);
      const relationshipResult = await this.loadRelationships(cis);
      result.relationshipsProcessed = relationshipResult.processed;
      result.factsCreated = relationshipResult.created;
      result.stagesCompleted.push('load-relationships');
      logger.info(`Loaded ${result.factsCreated} relationship facts`);

      // Stage 5: Rebuild indexes if requested
      if (data.rebuildIndexes !== false) {
        await job.updateProgress(90);
        await this.rebuildIndexes();
        result.stagesCompleted.push('rebuild-indexes');
        logger.info('Indexes rebuilt successfully');
      }

      result.durationMs = Date.now() - startTime;
      result.completedAt = new Date().toISOString();

      await job.updateProgress(100);
      logger.info('Full refresh completed successfully', result);

      return result;

    } catch (error) {
      logger.error('Full refresh job failed', { error, jobId: job.id });
      throw error;
    }
  }

  /**
   * Truncate all data mart tables
   * Uses whitelist validation to prevent SQL injection.
   *
   * Table names are the real, schema-qualified cmdb.* tables from
   * packages/database/src/postgres/migrations/001_complete_schema.sql. Failures propagate
   * (no per-table swallow): a truncation failure means the refresh cannot safely proceed and
   * must not be silently skipped while the job goes on to report success.
   */
  private async truncateTables(): Promise<void> {
    logger.info('Truncating data mart tables');

    const tables = [
      'cmdb.fact_ci_relationships',
      'cmdb.fact_ci_changes',
      'cmdb.fact_discovery',
      'cmdb.dim_ci'
    ];

    // Validate all table names against whitelist to prevent SQL injection
    const validatedTables = validateTableNames(tables);

    await this.postgresClient.transaction(async (client: PoolClient) => {
      for (const table of validatedTables) {
        // Safe to use template literal here because table is validated against whitelist.
        // No per-table try/catch: a failed truncation must fail the job, not be skipped.
        await client.query(`TRUNCATE TABLE ${table} CASCADE`);
        logger.debug(`Truncated table: ${table}`);
      }
    });
  }

  /**
   * Extract all CIs from Neo4j
   */
  private async extractAllCIs(): Promise<CI[]> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(`
        MATCH (ci:CI)
        RETURN ci
        ORDER BY ci.created_at
      `);

      return result.records.map((record: any) => {
        const node = record.get('ci');
        const props = node.properties;
        return {
          _id: props.id,
          external_id: props.external_id,
          name: props.name,
          _type: props.type,
          _status: props.status,
          environment: props.environment,
          _created_at: props.created_at,
          _updated_at: props.updated_at,
          _discovered_at: props.discovered_at,
          _metadata: props.metadata ? JSON.parse(props.metadata) : {}
        } as CI;
      });

    } finally {
      await session.close();
    }
  }

  /**
   * Load CI dimensions into PostgreSQL
   *
   * Uses the real v3.0 cmdb.dim_ci / cmdb.fact_discovery schema from
   * packages/database/src/postgres/migrations/001_complete_schema.sql:
   * dim_ci has ci_status (not status) and effective_from/effective_to (not
   * effective_date/end_date); fact_discovery requires discovery_job_id,
   * discovery_provider, and discovery_method (NOT NULL columns).
   */
  private async loadCIDimensions(
    cis: CI[],
    jobId: string = 'full-refresh-etl'
  ): Promise<{ created: number }> {
    let created = 0;

    await this.postgresClient.transaction(async (client: PoolClient) => {
      for (const ci of cis) {
        try {
          const dimension = this.dimensionTransformer.toDimension(ci);

          // Insert new dimension (all as current since this is full refresh)
          const insertResult = await client.query(
            `INSERT INTO cmdb.dim_ci
             (ci_id, ci_name, ci_type, environment, ci_status, external_id,
              effective_from, effective_to, is_current, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '9999-12-31', true, $8, $9)
             RETURNING ci_key`,
            [
              dimension._ci_id,
              dimension._ci_name,
              dimension._ci_type,
              dimension.environment,
              dimension._status,
              dimension.external_id,
              new Date(),
              dimension.created_at || new Date(),
              new Date()
            ]
          );

          const ciKey = insertResult.rows[0].ci_key;

          // Insert discovery fact if available
          const discoveryFact = this.dimensionTransformer.toDiscoveryFact(ci, ciKey);
          if (discoveryFact._ci_key) {
            await client.query(
              `INSERT INTO cmdb.fact_discovery
               (ci_key, date_key, discovered_at, discovery_job_id, discovery_provider, discovery_method)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT DO NOTHING`,
              [
                discoveryFact._ci_key,
                discoveryFact._date_key,
                discoveryFact._discovered_at,
                jobId,
                discoveryFact._discovery_source,
                discoveryFact._discovery_method
              ]
            );
          }

          created++;
        } catch (error) {
          logger.error('Error loading CI dimension', { ciId: ci._id, error });
        }
      }
    });

    return { created };
  }

  /**
   * Load all relationships into fact table
   *
   * Resolves the current surrogate ci_key for each endpoint via
   * cmdb.dim_ci (the natural Neo4j id is not a foreign key on
   * cmdb.fact_ci_relationships), and inserts against the real
   * unique_active_relationship constraint, which includes is_active.
   */
  private async loadRelationships(cis: CI[]): Promise<{ processed: number; created: number }> {
    let processed = 0;
    let created = 0;

    for (const ci of cis) {
      try {
        const relationships = await this.neo4jClient.getRelationships(ci._id, 'out');

        for (const rel of relationships) {
          try {
            const fromCiKey = await this.postgresClient.getCurrentCIKey(ci._id);
            const toCiKey = await this.postgresClient.getCurrentCIKey(rel._ci._id);

            if (fromCiKey === null || toCiKey === null) {
              logger.warn('Skipping relationship - CI dimension not found in cmdb.dim_ci', {
                fromCiId: ci._id,
                toCiId: rel._ci._id
              });
              continue;
            }

            const discoveredAt = new Date();

            await this.postgresClient.query(
              `INSERT INTO cmdb.fact_ci_relationships
               (from_ci_key, to_ci_key, date_key, relationship_type, discovered_at, is_active)
               VALUES ($1, $2, $3, $4, $5, true)
               ON CONFLICT (from_ci_key, to_ci_key, relationship_type, is_active) DO NOTHING`,
              [
                fromCiKey,
                toCiKey,
                this.dimensionTransformer.generateDateKey(discoveredAt),
                rel._type,
                discoveredAt
              ]
            );
            created++;
          } catch (error) {
            logger.error('Error loading relationship', {
              from: ci._id,
              to: rel._ci._id,
              type: rel._type,
              error
            });
          }
        }

        processed++;
      } catch (error) {
        logger.error('Error processing CI relationships', { ciId: ci._id, error });
      }
    }

    return { processed, created };
  }

  /**
   * Rebuild indexes and update statistics
   * Uses whitelist validation to prevent SQL injection
   */
  private async rebuildIndexes(): Promise<void> {
    logger.info('Rebuilding indexes and updating statistics');

    const tables = [
      'cmdb.dim_ci',
      'cmdb.fact_ci_relationships',
      'cmdb.fact_ci_changes',
      'cmdb.fact_discovery'
    ];

    // Validate all table names against whitelist to prevent SQL injection
    const validatedTables = validateTableNames(tables);

    await this.postgresClient.transaction(async (client: PoolClient) => {
      for (const table of validatedTables) {
        try {
          // Safe to use template literals here because table is validated against whitelist
          // Reindex table
          await client.query(`REINDEX TABLE ${table}`);

          // Update statistics
          await client.query(`ANALYZE ${table}`);

          logger.debug(`Rebuilt indexes for table: ${table}`);
        } catch (error) {
          logger.warn(`Failed to rebuild indexes for ${table}`, { error });
        }
      }
    });
  }
}

/**
 * BullMQ job processor function
 */
export async function processFullRefreshJob(
  job: Job<FullRefreshJobData>,
  neo4jClient: Neo4jClient,
  postgresClient: PostgresClient
): Promise<FullRefreshResult> {
  const processor = new FullRefreshJob(neo4jClient, postgresClient);
  return await processor.execute(job);
}
