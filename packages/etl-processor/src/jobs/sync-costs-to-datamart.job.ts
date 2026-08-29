// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync Cost Data to Data Mart Job (v3.0)
 *
 * Validates and enriches TBM cost data in the PostgreSQL data mart
 * Ensures cost data from cloud providers (AWS, Azure, GCP) and GL mappings
 * is properly structured for reporting and analytics.
 *
 * This job works with the tbm_cost_pools table which is already populated
 * by the cloud cost sync jobs (aws-cost-sync, azure-cost-sync, gcp-cost-sync).
 *
 * Schedule: Daily at 4:00 AM UTC (after cost sync jobs complete)
 */

import { Job } from 'bullmq';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { format } from 'date-fns';

/**
 * Valid `tbm_cost_pools.cost_pool_type` values, mirroring the
 * `tbm_cost_pools_type_check` CHECK constraint in
 * packages/database/src/postgres/migrations/001_complete_schema.sql. The table has no
 * dedicated opex/capex flag, so category validity is judged against this real taxonomy.
 */
const VALID_COST_POOL_TYPES = [
  'labor_internal',
  'labor_external',
  'hardware',
  'software',
  'cloud',
  'outside_services',
  'facilities',
  'telecom',
];

export interface SyncCostsJobData {
  /** Fiscal period to process (YYYY-MM format), defaults to current month */
  fiscalPeriod?: string;
  /** Number of months to process (for backfill), default: 1 */
  monthsToProcess?: number;
  /** Validate cost allocations against CIs */
  validateAllocations?: boolean;
}

export interface SyncCostsJobResult {
  success: boolean;
  periodsProcessed: number;
  costPoolsValidated: number;
  costPoolsEnriched: number;
  totalMonthlyCost: number;
  totalAnnualCost: number;
  validationErrors: string[];
  enrichmentErrors: string[];
  startTime: string;
  endTime: string;
  durationMs: number;
}

/**
 * Main job processor for syncing and validating cost data
 */
export async function processSyncCostsToDatamart(
  job: Job<SyncCostsJobData>
): Promise<SyncCostsJobResult> {
  const startTime = Date.now();
  const result: SyncCostsJobResult = {
    success: false,
    periodsProcessed: 0,
    costPoolsValidated: 0,
    costPoolsEnriched: 0,
    totalMonthlyCost: 0,
    totalAnnualCost: 0,
    validationErrors: [],
    enrichmentErrors: [],
    startTime: new Date().toISOString(),
    endTime: '',
    durationMs: 0,
  };

  logger.info('[SyncCostsToDatamart] Starting cost data sync job', {
    jobId: job.id,
    data: job.data,
  });

  try {
    const fiscalPeriod = job.data.fiscalPeriod || format(new Date(), 'yyyy-MM');
    const monthsToProcess = job.data.monthsToProcess || 1;
    const validateAllocations = job.data.validateAllocations !== false;

    // Generate list of fiscal periods to process. fiscalPeriod is a plain 'YYYY-MM' string with
    // no timezone information; build every period with UTC-only date arithmetic (Date.UTC +
    // getUTC* accessors) so the requested first month is never shifted by the host's local
    // timezone. Mixing a UTC-parsed `new Date(fiscalPeriod + '-01')` with local-time date-fns
    // calls (subMonths/format) silently rolled the first period back a month in any
    // negative-UTC-offset timezone - do not reintroduce that mix here.
    const fiscalPeriodMatch = fiscalPeriod.match(/^(\d{4})-(\d{2})$/);
    if (!fiscalPeriodMatch || !fiscalPeriodMatch[1] || !fiscalPeriodMatch[2]) {
      throw new Error(`Invalid fiscalPeriod format, expected 'YYYY-MM': ${fiscalPeriod}`);
    }
    const fiscalYear = Number(fiscalPeriodMatch[1]);
    const fiscalMonth = Number(fiscalPeriodMatch[2]);
    const periods: string[] = [];
    for (let i = 0; i < monthsToProcess; i++) {
      const periodDate = new Date(Date.UTC(fiscalYear, fiscalMonth - 1 - i, 1));
      periods.push(`${periodDate.getUTCFullYear()}-${String(periodDate.getUTCMonth() + 1).padStart(2, '0')}`);
    }

    logger.info('[SyncCostsToDatamart] Processing fiscal periods', { periods });

    // tbm_cost_pools is not period-partitioned (no fiscal_period column exists on it - see the
    // real-column note in processCostPools below), so every requested period would read and
    // validate/enrich the exact same pool set. Query, validate, and enrich the pool definitions
    // exactly once per job run, then reuse that single immutable result for every requested
    // period instead of re-summing identical totals into the aggregate on each iteration of a
    // multi-month backfill (monthsToProcess > 1) - that previously multiplied
    // totalMonthlyCost/totalAnnualCost/costPoolsValidated/costPoolsEnriched by monthsToProcess.
    try {
      const poolResult = await processCostPools(validateAllocations);

      result.costPoolsValidated = poolResult.validated;
      result.costPoolsEnriched = poolResult.enriched;
      result.totalMonthlyCost = poolResult.monthlyTotal;
      result.totalAnnualCost = poolResult.annualTotal;
      result.validationErrors.push(...poolResult.validationErrors);
      result.enrichmentErrors.push(...poolResult.enrichmentErrors);

      for (const period of periods) {
        result.periodsProcessed++;
        logger.info('[SyncCostsToDatamart] Processed fiscal period', {
          period,
          validated: poolResult.validated,
          enriched: poolResult.enriched,
          monthlyTotal: poolResult.monthlyTotal,
          annualTotal: poolResult.annualTotal,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.validationErrors.push(`Fiscal periods ${periods.join(', ')}: ${errorMsg}`);
      logger.error('[SyncCostsToDatamart] Failed to process cost pools', {
        periods,
        error: errorMsg,
      });
    }

    result.success = result.validationErrors.length === 0;
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - startTime;

    logger.info('[SyncCostsToDatamart] Cost data sync job completed', {
      ...result,
      durationSeconds: Math.round(result.durationMs / 1000),
    });

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.validationErrors.push(`Fatal error: ${errorMsg}`);
    result.success = false;
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - startTime;

    logger.error('[SyncCostsToDatamart] Cost data sync job failed', {
      jobId: job.id,
      error: errorMsg,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return result;
  }
}

/**
 * Query, validate, and enrich every TBM cost pool definition exactly once.
 *
 * tbm_cost_pools has no fiscal_period column - it is not period-partitioned, so there is no
 * per-period variant of this data to query. Callers that need to report against multiple
 * requested fiscal periods (backfill) must reuse this single result rather than invoking it
 * once per period.
 */
async function processCostPools(
  validateAllocations: boolean
): Promise<{
  validated: number;
  enriched: number;
  monthlyTotal: number;
  annualTotal: number;
  validationErrors: string[];
  enrichmentErrors: string[];
}> {
  const result: {
    validated: number;
    enriched: number;
    monthlyTotal: number;
    annualTotal: number;
    validationErrors: string[];
    enrichmentErrors: string[];
  } = {
    validated: 0,
    enriched: 0,
    monthlyTotal: 0,
    annualTotal: 0,
    validationErrors: [],
    enrichmentErrors: [],
  };

  const pgClient = getPostgresClient();
  const pool = pgClient.pool;

  // Step 1: Get all cost pools. tbm_cost_pools (see 001_complete_schema.sql) has no
  // pool_name/cost_category/resource_tower/monthly_cost/annual_cost/allocation_method/
  // source_system/metadata/fiscal_period columns - those are pre-v3.0 field names. The table
  // also is not period-partitioned (no fiscal_period column exists at all), so there is only
  // ever one current set of pool definitions to read. Real columns: name, cost_pool_type,
  // cost_center (closest analog for a resource-tower grouping - there is no dedicated tower
  // column on this table), monthly_budget, annual_budget, allocation_rules->>'allocation_method',
  // and allocation_rules itself doubling as the free-form metadata blob (there is no separate
  // metadata column).
  const costPoolsResult = await pool.query(
    `SELECT
      id,
      name AS pool_name,
      cost_pool_type AS cost_category,
      cost_center AS resource_tower,
      monthly_budget AS monthly_cost,
      annual_budget AS annual_cost,
      allocation_rules->>'allocation_method' AS allocation_method,
      allocation_rules AS metadata
    FROM tbm_cost_pools
    ORDER BY monthly_budget DESC`
  );

  const costPools = costPoolsResult.rows;
  logger.info('[SyncCostsToDatamart] Retrieved cost pools', {
    count: costPools.length,
  });

  // Step 2: Validate and enrich each cost pool
  for (const pool of costPools) {
    try {
      // Validate cost data
      const validationResult = await validateCostPool(pool);
      if (!validationResult.isValid) {
        result.validationErrors.push(
          `Cost pool ${pool.pool_name}: ${validationResult.errors.join(', ')}`
        );
      } else {
        result.validated++;
      }

      // Enrich metadata if needed
      if (validateAllocations) {
        const enrichmentResult = await enrichCostPoolMetadata(pool);
        if (enrichmentResult.enriched) {
          result.enriched++;
        }
        if (enrichmentResult.errors.length > 0) {
          result.enrichmentErrors.push(
            `Cost pool ${pool.pool_name}: ${enrichmentResult.errors.join(', ')}`
          );
        }
      }

      // Aggregate totals
      result.monthlyTotal += parseFloat(pool.monthly_cost) || 0;
      result.annualTotal += parseFloat(pool.annual_cost) || 0;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.validationErrors.push(`Cost pool ${pool.pool_name}: ${errorMsg}`);
      logger.error('[SyncCostsToDatamart] Error processing cost pool', {
        pool_name: pool.pool_name,
        error: errorMsg,
      });
    }
  }

  return result;
}

/**
 * Validate cost pool data integrity
 */
async function validateCostPool(pool: any): Promise<{
  isValid: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  // Check for required fields
  if (!pool.pool_name) {
    errors.push('Missing pool_name');
  }

  if (!pool.cost_category || !VALID_COST_POOL_TYPES.includes(pool.cost_category)) {
    errors.push(`Invalid cost_category: ${pool.cost_category}`);
  }

  if (!pool.resource_tower) {
    errors.push('Missing resource_tower');
  }

  // Validate cost values
  const monthlyConst = parseFloat(pool.monthly_cost) || 0;
  const annualCost = parseFloat(pool.annual_cost) || 0;

  if (monthlyConst < 0) {
    errors.push(`Negative monthly_cost: ${monthlyConst}`);
  }

  if (annualCost < 0) {
    errors.push(`Negative annual_cost: ${annualCost}`);
  }

  // Validate annual cost is approximately 12x monthly (allow 10% variance)
  if (monthlyConst > 0 && annualCost > 0) {
    const expectedAnnual = monthlyConst * 12;
    const variance = Math.abs(annualCost - expectedAnnual) / expectedAnnual;
    if (variance > 0.10) {
      errors.push(
        `Annual cost mismatch: expected ${expectedAnnual.toFixed(2)}, got ${annualCost}`
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Enrich cost pool metadata with CI mappings and allocation details
 */
async function enrichCostPoolMetadata(pool: any): Promise<{
  enriched: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let enriched = false;

  const pgClient = getPostgresClient();
  const poolInstance = pgClient.pool;

  try {
    const metadata = pool.metadata || {};

    // If this is a resource-specific cost pool, verify the CI exists
    if (pool.pool_name.startsWith('AWS-Resource-') ||
        pool.pool_name.startsWith('Azure-Resource-') ||
        pool.pool_name.startsWith('GCP-Resource-')) {

      const resourceId = metadata.resourceId || metadata.resource_id;
      if (resourceId) {
        // Check if CI exists in dim_ci
        const ciResult = await poolInstance.query(
          `SELECT ci_key, ci_name, ci_type
           FROM cmdb.dim_ci
           WHERE external_id = $1 AND is_current = true
           LIMIT 1`,
          [resourceId]
        );

        if (ciResult.rows.length > 0) {
          const ci = ciResult.rows[0];
          metadata.ci_key = ci.ci_key;
          metadata.ci_name = ci.ci_name;
          metadata.ci_type = ci.ci_type;
          metadata.ci_validated = true;
          metadata.ci_validated_at = new Date().toISOString();

          // Update cost pool metadata. tbm_cost_pools has no metadata column - the enriched
          // blob is persisted back into allocation_rules, the table's only free-form JSONB
          // store (see the SELECT in processFiscalPeriod above).
          await poolInstance.query(
            `UPDATE tbm_cost_pools
             SET allocation_rules = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [JSON.stringify(metadata), pool.id]
          );

          enriched = true;
          logger.debug('[SyncCostsToDatamart] Enriched cost pool with CI mapping', {
            pool_name: pool.pool_name,
            ci_key: ci.ci_key,
            ci_name: ci.ci_name,
          });
        } else {
          errors.push(`CI not found for resource: ${resourceId}`);
        }
      }
    }

    return { enriched, errors };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errors.push(`Enrichment failed: ${errorMsg}`);
    return { enriched, errors };
  }
}

/**
 * Job configuration for BullMQ
 */
export const syncCostsJobConfig = {
  jobName: 'sync-costs-to-datamart',
  defaultOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5 seconds
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 500, // Keep last 500 failed jobs for debugging
  },
  cronSchedule: '0 4 * * *', // Daily at 4:00 AM UTC (after cost sync jobs)
};
