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
import { ExtractedCI, dimCiOrganizationId, withStringIds } from '../transformers/ci-organization';

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
      const cis = withStringIds(await this.extractAllCIs(), ci => ci._id, 'full-refresh');
      await job.updateProgress(25);
      result.stagesCompleted.push('extract-cis');
      logger.info(`Extracted ${cis.length} CIs from Neo4j`);

      const acceptedOrganizations = new Map<string, string>();
      // Stage 3: Load CI dimensions in batches
      for (let i = 0; i < cis.length; i += batchSize) {
        const batch = cis.slice(i, i + batchSize);
        const progress = 25 + ((i / cis.length) * 40);
        await job.updateProgress(progress);

        const batchResult = await this.loadCIDimensions(batch, job.id);
        result.dimensionsCreated += batchResult.created;
        for (const [ciId, organizationId] of batchResult.acceptedOrganizations) {
          acceptedOrganizations.set(ciId, organizationId);
        }
        result.cisProcessed += batch.length;
      }

      result.stagesCompleted.push('load-dimensions');
      logger.info(`Loaded ${result.dimensionsCreated} CI dimensions`);

      // Stage 4: Extract and load relationships
      await job.updateProgress(70);
      const relationshipResult = await this.loadRelationships(cis, acceptedOrganizations);
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
  private async extractAllCIs(): Promise<ExtractedCI[]> {
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
          _metadata: props.metadata ? JSON.parse(props.metadata) : {},
          organization_id: props.organization_id
        } as ExtractedCI;
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
    cis: ExtractedCI[],
    jobId: string = 'full-refresh-etl'
  ): Promise<{ created: number; acceptedOrganizations: Map<string, string> }> {
    let created = 0;
    const acceptedOrganizations = new Map<string, string>();

    await this.postgresClient.transaction(async (client: PoolClient) => {
      for (const ci of cis) {
        await client.query('SAVEPOINT ci_dimension_load');
        try {
          const dimension = this.dimensionTransformer.toDimension(ci);

          // Insert new dimension (all as current since this is full refresh)
          const insertResult = await client.query(
            `INSERT INTO cmdb.dim_ci
             (ci_id, ci_name, ci_type, environment, ci_status, external_id,
              effective_from, effective_to, is_current, created_at, updated_at, organization_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, '9999-12-31', true, $8, $9, $10)
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
              new Date(),
              dimension.organization_id
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

          await client.query('RELEASE SAVEPOINT ci_dimension_load');
          acceptedOrganizations.set(ci._id, dimension.organization_id);
          created++;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT ci_dimension_load');
          await client.query('RELEASE SAVEPOINT ci_dimension_load');
          logger.error('Error loading CI dimension', { ciId: ci._id, error });
        }
      }
    });

    return { created, acceptedOrganizations };
  }

  /**
   * Load all relationships into fact table
   *
   * Resolves the current surrogate ci_key for both committed endpoint
   * lineages, after matching the edge and both current node tenants in one
   * graph query. The natural Neo4j id alone is not a tenant identity.
   */
  private async loadRelationships(
    cis: CI[],
    acceptedOrganizations: Map<string, string>
  ): Promise<{ processed: number; created: number }> {
    let processed = 0;
    let created = 0;

    for (const ci of cis) {
      const fromOrganization = acceptedOrganizations.get(ci._id);
      if (!fromOrganization) continue;
      const session = this.neo4jClient.getSession();
      try {
        const graphResult = await session.run(
          `MATCH (source:CI {id: $ciId})-[rel]->(target:CI)
           RETURN source.id AS from_id, source.organization_id AS from_organization_id,
                  target.id AS to_id, target.organization_id AS to_organization_id,
                  type(rel) AS relationship_type`,
          { ciId: ci._id }
        );

        for (const record of graphResult.records) {
          const fromId = record.get('from_id');
          const toId = record.get('to_id');
          const toOrganization = acceptedOrganizations.get(toId);
          if (fromId !== ci._id ||
              dimCiOrganizationId(record.get('from_organization_id')) !== fromOrganization ||
              !toOrganization ||
              dimCiOrganizationId(record.get('to_organization_id')) !== toOrganization) {
            logger.warn('Skipping relationship - graph endpoints conflict with committed CI lineage', {
              fromCiId: ci._id, toCiId: toId
            });
            continue;
          }

          const relationshipType = record.get('relationship_type');
          try {
            const keys = await this.postgresClient.query(
              `SELECT source.ci_key AS from_ci_key, target.ci_key AS to_ci_key
               FROM cmdb.dim_ci source CROSS JOIN cmdb.dim_ci target
               WHERE source.ci_id = $1 AND source.organization_id = $2 AND source.is_current = TRUE
                 AND target.ci_id = $3 AND target.organization_id = $4 AND target.is_current = TRUE`,
              [fromId, fromOrganization, toId, toOrganization]
            );
            if (keys.rows.length === 0) {
              logger.warn('Skipping relationship - current CI dimensions do not match committed lineage', {
                fromCiId: fromId, toCiId: toId
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
                keys.rows[0].from_ci_key,
                keys.rows[0].to_ci_key,
                this.dimensionTransformer.generateDateKey(discoveredAt),
                relationshipType,
                discoveredAt
              ]
            );
            created++;
          } catch (error) {
            logger.error('Error loading relationship', {
              from: fromId, to: toId, type: relationshipType, error
            });
          }
        }

        processed++;
      } catch (error) {
        logger.error('Error processing CI relationships', { ciId: ci._id, error });
      } finally {
        await session.close();
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
