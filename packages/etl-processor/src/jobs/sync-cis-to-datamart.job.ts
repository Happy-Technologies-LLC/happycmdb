// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync CIs to Data Mart Job (v3.0 Enhanced)
 *
 * Syncs enriched Configuration Items from Neo4j to PostgreSQL dimensional model
 * INCLUDING v3.0 attributes: ITIL, TBM, and BSM
 *
 * This job replaces/enhances the basic neo4j-to-postgres job by ensuring
 * all v3.0 framework attributes are properly synced to the data mart for
 * reporting, analytics, and Metabase dashboards.
 *
 * Schedule: Every 6 hours (cron: 0 0/6 * * *)
 */

import { Job } from 'bullmq';
import { logger } from '@cmdb/common';
import { getPostgresClient, getNeo4jClient } from '@cmdb/database';
import { dimCiOrganizationId } from '../transformers/ci-organization';

export interface SyncCIsJobData {
  /** Batch size for processing CIs (default: 100) */
  batchSize?: number;
  /** Only sync CIs updated since this timestamp (ISO 8601) */
  incrementalSince?: string;
  /** Force full refresh instead of incremental */
  fullRefresh?: boolean;
  /** Specific CI types to sync (default: all) */
  ciTypes?: string[];
}

export interface SyncCIsJobResult {
  success: boolean;
  cisProcessed: number;
  cisInserted: number;
  cisUpdated: number;
  cisSkipped: number;
  errors: string[];
  startTime: string;
  endTime: string;
  durationMs: number;
}

/**
 * Main job processor for syncing CIs from Neo4j to PostgreSQL dim_ci table
 */
export async function processSyncCIsToDatamart(
  job: Job<SyncCIsJobData>
): Promise<SyncCIsJobResult> {
  const startTime = Date.now();
  const result: SyncCIsJobResult = {
    success: false,
    cisProcessed: 0,
    cisInserted: 0,
    cisUpdated: 0,
    cisSkipped: 0,
    errors: [],
    startTime: new Date().toISOString(),
    endTime: '',
    durationMs: 0,
  };

  logger.info('[SyncCIsToDatamart] Starting CI sync job', {
    jobId: job.id,
    data: job.data,
  });

  try {
    const batchSize = job.data.batchSize || 100;
    const incrementalSince = job.data.incrementalSince;
    const fullRefresh = job.data.fullRefresh || false;
    const ciTypes = job.data.ciTypes;

    // Step 1: Extract CIs from Neo4j with v3 attributes
    const cis = await extractCIsFromNeo4j(incrementalSince, fullRefresh, ciTypes);
    logger.info('[SyncCIsToDatamart] Extracted CIs from Neo4j', {
      count: cis.length,
      incrementalSince,
      fullRefresh,
    });

    // Step 2: Process in batches
    for (let i = 0; i < cis.length; i += batchSize) {
      const batch = cis.slice(i, i + batchSize);
      const progress = Math.round((i / cis.length) * 100);
      await job.updateProgress(progress);

      logger.info('[SyncCIsToDatamart] Processing batch', {
        batchNumber: Math.floor(i / batchSize) + 1,
        batchSize: batch.length,
        progress: `${progress}%`,
      });

      try {
        const batchResult = await processCIBatch(batch, fullRefresh);
        result.cisProcessed += batchResult.processed;
        result.cisInserted += batchResult.inserted;
        result.cisUpdated += batchResult.updated;
        result.cisSkipped += batchResult.skipped;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${errorMsg}`);
        logger.error('[SyncCIsToDatamart] Batch processing failed', {
          batchNumber: Math.floor(i / batchSize) + 1,
          error: errorMsg,
        });
      }
    }

    await job.updateProgress(100);

    result.success = result.errors.length === 0;
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - startTime;

    logger.info('[SyncCIsToDatamart] CI sync job completed', {
      ...result,
      durationSeconds: Math.round(result.durationMs / 1000),
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Fatal error: ${errorMsg}`);
    result.success = false;
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - startTime;

    logger.error('[SyncCIsToDatamart] CI sync job failed', {
      jobId: job.id,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return result;
  }
}

/**
 * Extract CIs from Neo4j including v3.0 ITIL, TBM, and BSM attributes
 */
async function extractCIsFromNeo4j(
  incrementalSince?: string,
  fullRefresh: boolean = false,
  ciTypes?: string[]
): Promise<any[]> {
  const neo4jClient = getNeo4jClient();
  const session = neo4jClient.getSession();

  try {
    // Build Cypher query
    let query = 'MATCH (ci:CI)';
    const params: Record<string, any> = {};

    // Filter conditions
    const conditions: string[] = [];

    if (ciTypes && ciTypes.length > 0) {
      conditions.push('ci.ci_type IN $ciTypes');
      params['ciTypes'] = ciTypes;
    }

    if (incrementalSince && !fullRefresh) {
      conditions.push('ci.updated_at >= datetime($since)');
      params['since'] = incrementalSince;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += `
      RETURN
        ci.ci_id AS ci_id,
        ci.ci_name AS ci_name,
        ci.ci_type AS ci_type,
        ci.ci_status AS ci_status,
        ci.environment AS environment,
        ci.external_id AS external_id,
        ci.metadata AS metadata,
        ci.itil_attributes AS itil_attributes,
        ci.tbm_attributes AS tbm_attributes,
        ci.bsm_attributes AS bsm_attributes,
        ci.created_at AS created_at,
        ci.updated_at AS updated_at,
        ci.organization_id AS organization_id
      ORDER BY ci.updated_at DESC
    `;

    const result = await session.run(query, params);

    return result.records.map((record) => ({
      ci_id: record.get('ci_id'),
      ci_name: record.get('ci_name'),
      ci_type: record.get('ci_type'),
      ci_status: record.get('ci_status'),
      environment: record.get('environment'),
      external_id: record.get('external_id'),
      metadata: record.get('metadata'),
      itil_attributes: record.get('itil_attributes'),
      tbm_attributes: record.get('tbm_attributes'),
      bsm_attributes: record.get('bsm_attributes'),
      created_at: record.get('created_at'),
      updated_at: record.get('updated_at'),
      // Raw node value; resolved per row in processCIBatch (dimCiOrganizationId).
      organization_id: record.get('organization_id'),
    }));
  } finally {
    await session.close();
  }
}

/**
 * Process a batch of CIs and upsert to PostgreSQL dim_ci table
 */
async function processCIBatch(
  cis: any[],
  fullRefresh: boolean
): Promise<{ processed: number; inserted: number; updated: number; skipped: number }> {
  const result = { processed: 0, inserted: 0, updated: 0, skipped: 0 };

  const pgClient = getPostgresClient();
  const client = await pgClient.pool.connect();

  try {
    await client.query('BEGIN');

    for (const ci of cis) {
      try {
        // Check if CI already exists in dim_ci (current record)
        const existingResult = await client.query(
          `SELECT
            ci_key,
            ci_name,
            ci_type,
            ci_status,
            environment,
            itil_attributes,
            tbm_attributes,
            bsm_attributes,
            organization_id
          FROM cmdb.dim_ci
          WHERE ci_id = $1 AND is_current = true`,
          [ci.ci_id]
        );

        if (existingResult.rows.length > 0) {
          const existing = existingResult.rows[0];

          // Every version of a CI carries its one organization (see
          // dimCiOrganizationId): relabel them all when the node names
          // another one; an org-less node keeps the stored organization.
          const organizationId = dimCiOrganizationId(ci.organization_id, existing.organization_id);
          if (organizationId !== existing.organization_id) {
            await client.query(
              'UPDATE cmdb.dim_ci SET organization_id = $1 WHERE ci_id = $2',
              [organizationId, ci.ci_id]
            );
          }

          // Check if data has changed
          const hasChanged =
            existing.ci_name !== ci.ci_name ||
            existing.ci_type !== ci.ci_type ||
            existing.ci_status !== ci.ci_status ||
            existing.environment !== ci.environment ||
            JSON.stringify(existing.itil_attributes) !== JSON.stringify(ci.itil_attributes) ||
            JSON.stringify(existing.tbm_attributes) !== JSON.stringify(ci.tbm_attributes) ||
            JSON.stringify(existing.bsm_attributes) !== JSON.stringify(ci.bsm_attributes);

          if (hasChanged || fullRefresh) {
            // Type 2 SCD: Expire old record
            await client.query(
              `UPDATE cmdb.dim_ci
               SET is_current = false,
                   effective_to = NOW(),
                   updated_at = NOW()
               WHERE ci_key = $1`,
              [existing.ci_key]
            );

            // Insert new version
            await client.query(
              `INSERT INTO cmdb.dim_ci (
                ci_id, ci_name, ci_type, ci_status, environment, external_id,
                metadata, itil_attributes, tbm_attributes, bsm_attributes,
                effective_from, effective_to, is_current, created_at, updated_at, organization_id
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), '9999-12-31', true, $11, NOW(), $12)`,
              [
                ci.ci_id,
                ci.ci_name,
                ci.ci_type,
                ci.ci_status,
                ci.environment,
                ci.external_id,
                ci.metadata,
                ci.itil_attributes,
                ci.tbm_attributes,
                ci.bsm_attributes,
                ci.created_at || new Date(),
                organizationId,
              ]
            );

            result.updated++;
            logger.debug('[SyncCIsToDatamart] Updated CI (Type 2 SCD)', {
              ci_id: ci.ci_id,
              old_key: existing.ci_key,
            });
          } else {
            result.skipped++;
            logger.debug('[SyncCIsToDatamart] CI unchanged, skipping', {
              ci_id: ci.ci_id,
            });
          }
        } else {
          // Insert new CI
          await client.query(
            `INSERT INTO cmdb.dim_ci (
              ci_id, ci_name, ci_type, ci_status, environment, external_id,
              metadata, itil_attributes, tbm_attributes, bsm_attributes,
              effective_from, effective_to, is_current, created_at, updated_at, organization_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), '9999-12-31', true, $11, NOW(), $12)`,
            [
              ci.ci_id,
              ci.ci_name,
              ci.ci_type,
              ci.ci_status,
              ci.environment,
              ci.external_id,
              ci.metadata,
              ci.itil_attributes,
              ci.tbm_attributes,
              ci.bsm_attributes,
              ci.created_at || new Date(),
              dimCiOrganizationId(ci.organization_id),
            ]
          );

          result.inserted++;
          logger.debug('[SyncCIsToDatamart] Inserted new CI', {
            ci_id: ci.ci_id,
          });
        }

        result.processed++;
      } catch (error) {
        logger.error('[SyncCIsToDatamart] Error processing CI', {
          ci_id: ci.ci_id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    await client.query('COMMIT');
    logger.info('[SyncCIsToDatamart] Batch committed successfully', result);

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[SyncCIsToDatamart] Batch failed, rolled back', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Job configuration for BullMQ
 */
export const syncCIsJobConfig = {
  jobName: 'sync-cis-to-datamart',
  defaultOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5 seconds
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 500, // Keep last 500 failed jobs for debugging
  },
  cronSchedule: '0 */6 * * *', // Every 6 hours
};
