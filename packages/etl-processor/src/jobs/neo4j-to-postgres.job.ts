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
import {
  ExtractedCI, dimCiOrganizationId, lockCIDimensions, storedCiOrganizationId, withDimCiIds,
} from '../transformers/ci-organization';

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
      const cis = withDimCiIds(await this.extractCIs(data), ci => ci._id, 'neo4j-to-postgres');
      // Only committed, tenant-resolved dimensions can supply relationship keys.
      const acceptedOrganizations = data.fullRefresh || !data.incrementalSince
        ? new Map<string, string>() : undefined;
      logger.info(`Extracted ${cis.length} CIs from Neo4j`);

      // Step 2: Process CIs in batches
      for (let i = 0; i < cis.length; i += batchSize) {
        const batch = cis.slice(i, i + batchSize);
        await job.updateProgress((i / cis.length) * 100);

        try {
          const batchResult = await this.processBatch(batch, data.fullRefresh || false, job.id, acceptedOrganizations);
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
      if (acceptedOrganizations) {
        const relationshipsResult = await this.processRelationships(cis, acceptedOrganizations);
        result.relationshipsProcessed = relationshipsResult.processed;
        result.recordsInserted += relationshipsResult.inserted;
      }

      // Every live node was extracted. A CI without one keeps no 011 backfill
      // marker, even when a batch failed (a failing batch must not hold the
      // window open): a node created later with its id must not be taken for
      // a backfilled CI (see storedCiOrganizationId). CIs whose batch failed
      // keep theirs until a later run processes them.
      const visitedEveryNode =
        !(data.incrementalSince && !data.fullRefresh) && !(data.ciTypes && data.ciTypes.length > 0);
      if (visitedEveryNode) {
        const liveIds = cis.map(ci => ci._id).filter((id): id is string => typeof id === 'string');
        await this.postgresClient.query(
          'UPDATE cmdb.dim_ci SET org_backfilled = FALSE WHERE org_backfilled AND NOT (ci_id = ANY($1::varchar[]))',
          [liveIds]
        );
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
  private async extractCIs(data: Neo4jToPostgresJobData): Promise<ExtractedCI[]> {
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
          _metadata: props.metadata ? JSON.parse(props.metadata) : {},
          organization_id: props.organization_id
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
    cis: ExtractedCI[],
    fullRefresh: boolean,
    jobId: string = 'neo4j-to-postgres-etl',
    acceptedOrganizations?: Map<string, string>
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
      // Do not retain identities from a transaction that fails and is retried.
      const acceptedInAttempt: Array<[string, string]> | null = acceptedOrganizations ? [] : null;
      try {
        await this.postgresClient.transaction(async (client: any) => {
          // Serialize writers of these CIs through COMMIT, before reading any current row.
          await lockCIDimensions(client, cis.map(ci => ci._id));
          for (const ci of cis) {
            try {
              // Transform CI to dimensional model
              const dimension = this.dimensionTransformer.toDimension(ci);

              // Check if CI dimension already exists
              const existingResult = await client.query(
                `SELECT ci_key, ci_name, ci_type, ci_status, environment, organization_id, org_backfilled
                 FROM cmdb.dim_ci WHERE ci_id = $1 AND is_current = true`,
                [ci._id]
              );
              let resolvedOrganizationId = dimension.organization_id;

              if (existingResult.rows.length > 0) {
                const existing = existingResult.rows[0];

                // See storedCiOrganizationId: no stored row changes
                // organization; a 011 backfilled CI whose node names another
                // organization gets a new version in it.
                const organizationId = storedCiOrganizationId(ci.organization_id, {
                  organizationId: existing.organization_id,
                  backfilled: existing.org_backfilled === true,
                });
                if (organizationId === null) {
                  logger.warn('CI node organization conflicts with its cmdb.dim_ci history; skipped', { ciId: ci._id });
                  continue;
                }
                resolvedOrganizationId = organizationId;
                if (existing.org_backfilled === true) {
                  await client.query(
                    'UPDATE cmdb.dim_ci SET org_backfilled = FALSE WHERE ci_id = $1 AND org_backfilled',
                    [ci._id]
                  );
                }

                // Check if data has actually changed (avoid unnecessary updates)
                const hasChanged =
                  existing.ci_name !== dimension._ci_name ||
                  existing.ci_type !== dimension._ci_type ||
                  existing.ci_status !== dimension._status ||
                  existing.environment !== dimension.environment ||
                  organizationId !== existing.organization_id;

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
                      organizationId
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
              if (acceptedInAttempt) {
                acceptedInAttempt.push([ci._id, resolvedOrganizationId]);
              }

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
        if (acceptedOrganizations && acceptedInAttempt) {
          for (const [ciId, organizationId] of acceptedInAttempt) {
            acceptedOrganizations.set(ciId, organizationId);
          }
        }

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
    cis: CI[],
    acceptedOrganizations: Map<string, string>
  ): Promise<{ processed: number; inserted: number }> {
    const result = { processed: 0, inserted: 0 };

    // Ids this run extracted. A ciTypes-filtered run extracts only some CIs;
    // an edge to a CI it did not extract may use that CI's committed current
    // row, when that row is in the organization the same graph match reads.
    const extractedIds = new Set(cis.map(ci => ci._id));
    for (const ci of cis) {
      const fromOrganization = acceptedOrganizations.get(ci._id);
      if (!fromOrganization) continue;
      const session = this.neo4jClient.getSession();
      try {
        // One graph match binds the edge and BOTH current endpoint tenants.
        // A separate id-only read could observe a replacement after the CI
        // batch, then attribute its new edge to the former tenant's dim_ci.
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
          const toGraphOrganization = dimCiOrganizationId(record.get('to_organization_id'));
          // A target this run extracted needs an accepted identity (without one,
          // its batch failed or its node conflicts with its stored history).
          // Another target is identified by the organization this match reads.
          const toOrganization = acceptedOrganizations.get(toId)
            ?? (extractedIds.has(toId) ? undefined : toGraphOrganization);
          if (fromId !== ci._id || typeof toId !== 'string' ||
              dimCiOrganizationId(record.get('from_organization_id')) !== fromOrganization ||
              !toOrganization ||
              toGraphOrganization !== toOrganization) {
            logger.warn('Skipping relationship - current graph endpoints conflict with accepted CI lineage', {
              fromCiId: ci._id,
              toCiId: toId
            });
            continue;
          }
          // Both keys must be current rows in those organizations: an accepted
          // one resolved from a committed node/dimension pair, or a target's
          // graph organization. An id alone can name stale history.
          const keys = await this.postgresClient.query(
            `SELECT source.ci_key AS from_ci_key, target.ci_key AS to_ci_key
             FROM cmdb.dim_ci source CROSS JOIN cmdb.dim_ci target
             WHERE source.ci_id = $1 AND source.organization_id = $2 AND source.is_current = TRUE
               AND target.ci_id = $3 AND target.organization_id = $4 AND target.is_current = TRUE`,
            [fromId, fromOrganization, toId, toOrganization]
          );
          if (keys.rows.length === 0) {
            logger.warn('Skipping relationship - current CI dimension does not match accepted lineage', {
              fromCiId: ci._id,
              toCiId: toId
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
              record.get('relationship_type'),
              discoveredAt
            ]
          );

          result.inserted++;
        }

        result.processed++;

      } catch (error) {
        logger.error('Error processing relationships', { ciId: ci._id, error });
      } finally {
        await session.close();
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
