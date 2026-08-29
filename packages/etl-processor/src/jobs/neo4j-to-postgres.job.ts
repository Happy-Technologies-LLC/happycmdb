// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Neo4j to PostgreSQL ETL Job
 *
 * This job extracts Configuration Items (CIs) from Neo4j graph database,
 * transforms them into a dimensional model, and loads them into the
 * PostgreSQL data mart for reporting and analytics.
 *
 * ETL Flow:
 * 1. Extract: Query CIs and relationships from Neo4j
 * 2. Transform: Convert graph data to dimensional model (facts and dimensions)
 * 3. Load: Insert/update records in PostgreSQL data mart tables
 */

import { Job } from 'bullmq';
import { Neo4jClient, PostgresClient } from '@cmdb/database';
import { logger, CI, CIType } from '@cmdb/common';
import { DimensionTransformer } from '../transformers/dimension-transformer';

export interface Neo4jToPostgresJobData {
  /** Batch size for processing CIs */
  batchSize?: number;
  /** Types of CIs to process (if not specified, processes all) */
  ciTypes?: CIType[];
  /** Start date for incremental sync (ISO 8601 format) */
  incrementalSince?: string;
  /** Whether to perform full refresh instead of incremental */
  fullRefresh?: boolean;
}

export interface ETLJobResult {
  /** Total CIs processed */
  cisProcessed: number;
  /** Total relationships processed */
  relationshipsProcessed: number;
  /** Number of records inserted */
  recordsInserted: number;
  /** Number of records updated */
  recordsUpdated: number;
  /** Number of errors encountered */
  errors: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Timestamp of completion */
  completedAt: string;
}

/**
 * Main ETL processor class for Neo4j to PostgreSQL sync
 */
export class Neo4jToPostgresJob {
  private neo4jClient: Neo4jClient;
  private postgresClient: PostgresClient;
  private dimensionTransformer: DimensionTransformer;

  constructor(neo4jClient: Neo4jClient, postgresClient: PostgresClient) {
    this.neo4jClient = neo4jClient;
    this.postgresClient = postgresClient;
    this.dimensionTransformer = new DimensionTransformer();
  }

  /**
   * Execute the ETL job
   */
  async execute(job: Job<Neo4jToPostgresJobData>): Promise<ETLJobResult> {
    const startTime = Date.now();
    const data = job.data;
    const batchSize = data.batchSize || 100;

    logger.info('Starting Neo4j to PostgreSQL ETL job', {
      _jobId: job.id,
      data
    });

    const result: ETLJobResult = {
      cisProcessed: 0,
      relationshipsProcessed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      errors: 0,
      durationMs: 0,
      completedAt: new Date().toISOString()
    };

    try {
      // Step 1: Extract CIs from Neo4j
      const cis = await this.extractCIs(data);
      logger.info(`Extracted ${cis.length} CIs from Neo4j`);

      // Step 2: Process CIs in batches
      for (let i = 0; i < cis.length; i += batchSize) {
        const batch = cis.slice(i, i + batchSize);
        await job.updateProgress((i / cis.length) * 100);

        try {
          const batchResult = await this.processBatch(batch, data.fullRefresh || false, job.id);
          result.cisProcessed += batchResult.cisProcessed;
          result.recordsInserted += batchResult.recordsInserted;
          result.recordsUpdated += batchResult.recordsUpdated;

          logger.debug(`Processed batch ${i / batchSize + 1}`, batchResult);
        } catch (error) {
          result.errors++;
          logger.error('Error processing batch', { batch: i / batchSize + 1, error });
        }
      }

      // Step 3: Process relationships
      if (data.fullRefresh || !data.incrementalSince) {
        const relationshipsResult = await this.processRelationships(cis);
        result.relationshipsProcessed = relationshipsResult.processed;
        result.recordsInserted += relationshipsResult.inserted;
      }

      result.durationMs = Date.now() - startTime;
      result.completedAt = new Date().toISOString();

      logger.info('ETL job completed successfully', result);
      return result;

    } catch (error) {
      logger.error('ETL job failed', { error, jobId: job.id });
      throw error;
    }
  }

  /**
   * Extract CIs from Neo4j based on job parameters
   */
  private async extractCIs(data: Neo4jToPostgresJobData): Promise<CI[]> {
    const session = this.neo4jClient.getSession();

    try {
      let query = 'MATCH (ci:CI)';
      const params: Record<string, unknown> = {};

      // Filter by CI types if specified
      if (data.ciTypes && data.ciTypes.length > 0) {
        query += ' WHERE ci.type IN $ciTypes';
        params['ciTypes'] = data.ciTypes;
      }

      // Incremental sync - only CIs updated since last sync
      if (data.incrementalSince && !data.fullRefresh) {
        query += data.ciTypes ? ' AND' : ' WHERE';
        query += ' ci.updated_at >= datetime($since)';
        params['since'] = data.incrementalSince;
      }

      query += ' RETURN ci ORDER BY ci.updated_at';

      const result = await session.run(query, params);

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
        };
      });

    } finally {
      await session.close();
    }
  }

  /**
   * Process a batch of CIs - transform and load into PostgreSQL
   * Implements Type 2 SCD with retry logic and detailed logging
   */
  private async processBatch(
    cis: CI[],
    fullRefresh: boolean,
    jobId: string = 'neo4j-to-postgres-etl'
  ): Promise<{ cisProcessed: number; recordsInserted: number; recordsUpdated: number }> {
    const batchStartTime = Date.now();
    const result = { cisProcessed: 0, recordsInserted: 0, recordsUpdated: 0 };

    logger.info('Processing batch', {
      _batchSize: cis.length,
      fullRefresh
    });

    // Retry configuration
    const maxRetries = 3;
    const retryDelayMs = 1000;

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < maxRetries) {
      try {
        await this.postgresClient.transaction(async (client: any) => {
          for (const ci of cis) {
            try {
              // Transform CI to dimensional model
              const dimension = this.dimensionTransformer.toDimension(ci);

              // Check if CI dimension already exists
              const existingResult = await client.query(
                'SELECT ci_key, ci_name, ci_type, ci_status, environment FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = true',
                [ci._id]
              );

              if (existingResult.rows.length > 0) {
                const existing = existingResult.rows[0];

                // Check if data has actually changed (avoid unnecessary updates)
                const hasChanged =
                  existing.ci_name !== dimension._ci_name ||
                  existing.ci_type !== dimension._ci_type ||
                  existing.ci_status !== dimension._status ||
                  existing.environment !== dimension.environment;

                if (hasChanged || fullRefresh) {
                  const ciKey = existing.ci_key;

                  // Type 2 SCD: Expire old record
                  await client.query(
                    `UPDATE cmdb.dim_ci
                     SET is_current = false,
                         effective_to = $1,
                         updated_at = $1
                     WHERE ci_key = $2`,
                    [new Date(), ciKey]
                  );

                  // Insert new version with full attributes
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

                  const newCiKey = insertResult.rows[0].ci_key;

                  // Insert discovery fact if available
                  const discoveryFact = this.dimensionTransformer.toDiscoveryFact(ci, newCiKey);
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

                  result.recordsUpdated++;
                  logger.debug('Updated CI dimension (Type 2 SCD)', {
                    _ciId: ci._id,
                    _oldKey: ciKey,
                    _newKey: newCiKey
                  });
                } else {
                  // No change, just count as processed
                  logger.debug('CI unchanged, skipping update', { ciId: ci._id });
                }

              } else {
                // Insert new dimension
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

                // Insert discovery fact
                const discoveryFact = this.dimensionTransformer.toDiscoveryFact(ci, ciKey);
                if (discoveryFact._ci_key) {
                  await client.query(
                    `INSERT INTO cmdb.fact_discovery
                     (ci_key, date_key, discovered_at, discovery_job_id, discovery_provider, discovery_method)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
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

                result.recordsInserted++;
                logger.debug('Inserted new CI dimension', { ciId: ci._id, ciKey });
              }

              result.cisProcessed++;

            } catch (error) {
              logger.error('Error processing CI in batch', {
                _ciId: ci._id,
                error,
                _attempt: attempt + 1
              });
              throw error;
            }
          }
        });

        // Success - exit retry loop
        const batchDuration = Date.now() - batchStartTime;
        logger.info('Batch processed successfully', {
          ...result,
          _durationMs: batchDuration,
          _avgTimePerCI: Math.round(batchDuration / cis.length)
        });

        return result;

      } catch (error) {
        lastError = error as Error;
        attempt++;

        if (attempt < maxRetries) {
          const delay = retryDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
          logger.warn('Batch processing failed, retrying', {
            attempt,
            maxRetries,
            _delayMs: delay,
            _error: lastError.message
          });
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    logger.error('Batch processing failed after all retries', {
      _attempts: maxRetries,
      _error: lastError
    });
    throw lastError || new Error('Batch processing failed');
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Process relationships between CIs
   */
  private async processRelationships(
    cis: CI[]
  ): Promise<{ processed: number; inserted: number }> {
    const result = { processed: 0, inserted: 0 };

    for (const ci of cis) {
      try {
        const relationships = await this.neo4jClient.getRelationships(ci._id, 'out');

        for (const rel of relationships) {
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

          result.inserted++;
        }

        result.processed++;

      } catch (error) {
        logger.error('Error processing relationships', { ciId: ci._id, error });
      }
    }

    return result;
  }
}

/**
 * BullMQ job processor function
 */
export async function processNeo4jToPostgresJob(
  job: Job<Neo4jToPostgresJobData>,
  neo4jClient: Neo4jClient,
  postgresClient: PostgresClient
): Promise<ETLJobResult> {
  const processor = new Neo4jToPostgresJob(neo4jClient, postgresClient);
  return await processor.execute(job);
}
