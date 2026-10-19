// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GCP Cost Sync Job
 * Scheduled BullMQ job to fetch GCP cost data and sync to PostgreSQL
 *
 * Schedule: Daily at 3:00 AM UTC (offset from AWS/Azure to avoid concurrent API load)
 * Purpose: Populate tbm_cost_pools table with GCP cost data
 */

import { Job } from 'bullmq';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { subDays, startOfMonth, endOfMonth, format } from 'date-fns';

/**
 * GCP credentials for Cloud Billing access
 */
interface GCPCredentials {
  serviceAccountKey: any;
  projectId?: string;
}

/**
 * GCP Cloud Billing client stub
 * In production, this would use the Google Cloud Billing API.
 * The @cmdb/tbm-cost-engine package provides TBM taxonomy/allocation logic,
 * not cloud provider API clients.
 */
class GCPCloudBilling {
  constructor(private credentials: GCPCredentials, private logger: any) {}

  async getCostsByService(
    _startDate: Date,
    _endDate: Date,
    _projectId?: string,
    _billingAccountId?: string
  ): Promise<Map<string, { totalCost: number; breakdown?: any }>> {
    this.logger.warn('[GCPCloudBilling] Stub implementation - integrate Google Cloud Billing SDK');
    return new Map();
  }

  async getCostsBySKU(
    _startDate: Date,
    _endDate: Date,
    _projectId?: string,
    _billingAccountId?: string
  ): Promise<Map<string, { cost: number; description?: string; service?: string; region?: string; labels?: any }>> {
    this.logger.warn('[GCPCloudBilling] Stub implementation - integrate Google Cloud Billing SDK');
    return new Map();
  }

  async getCostsByProject(
    _startDate: Date,
    _endDate: Date,
    _billingAccountId?: string
  ): Promise<Map<string, { totalCost: number; projectName?: string }>> {
    this.logger.warn('[GCPCloudBilling] Stub implementation - integrate Google Cloud Billing SDK');
    return new Map();
  }
}

export interface GCPCostSyncJobData {
  projectId?: string;
  billingAccountId?: string;
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  credentialId?: string; // ID of credential in unified credential system
}

export interface GCPCostSyncResult {
  success: boolean;
  projectId: string;
  costsImported: number;
  totalCost: number;
  startDate: string;
  endDate: string;
  errors?: string[];
}

/**
 * GCP Cost Sync Job Processor
 * Fetches cost data from GCP Cloud Billing API and writes to PostgreSQL
 */
export async function processGCPCostSync(
  job: Job<GCPCostSyncJobData>
): Promise<GCPCostSyncResult> {
  const startTime = Date.now();
  logger.info('[GCPCostSync] Starting GCP cost sync job');

  try {
    // Step 1: Get credentials
    const credentials = await getGCPCredentials(job.data.credentialId);
    if (!credentials) {
      throw new Error(
        `No GCP credentials found for ID: ${job.data.credentialId || 'default'}`
      );
    }

    // Step 2: Determine date range (default: current month)
    const startDate = job.data.startDate
      ? new Date(job.data.startDate)
      : startOfMonth(new Date());
    const endDate = job.data.endDate
      ? new Date(job.data.endDate)
      : endOfMonth(new Date());

    logger.info('[GCPCostSync] Fetching costs from GCP Cloud Billing');

    // Step 3: Initialize GCP Cloud Billing client
    const cloudBilling = new GCPCloudBilling(credentials, logger);

    // Step 4: Fetch cost data by service
    const costsByService = await cloudBilling.getCostsByService(
      startDate,
      endDate,
      job.data.projectId,
      job.data.billingAccountId
    );

    // Step 5: Fetch cost data by SKU (detailed cost breakdown)
    const costsBySKU = await cloudBilling.getCostsBySKU(
      startDate,
      endDate,
      job.data.projectId,
      job.data.billingAccountId
    );

    // Step 6: Fetch cost data by project (if querying at billing account level)
    const costsByProject = job.data.billingAccountId
      ? await cloudBilling.getCostsByProject(
          startDate,
          endDate,
          job.data.billingAccountId
        )
      : new Map();

    // Step 7: Insert/update cost data in PostgreSQL
    const pgClient = getPostgresClient();
    const pool = pgClient.pool;

    let costsImported = 0;
    let totalCost = 0;

    // Begin transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Import service-level costs
      for (const [serviceName, costData] of costsByService.entries()) {
        const monthlyCost = costData.totalCost;
        const annualCost = monthlyCost * 12;

        await client.query(
          `
          INSERT INTO tbm_cost_pools (
            pool_name,
            cost_category,
            resource_tower,
            monthly_cost,
            annual_cost,
            allocation_method,
            fiscal_period,
            source_system,
            metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (pool_name, fiscal_period)
          DO UPDATE SET
            monthly_cost = EXCLUDED.monthly_cost,
            annual_cost = EXCLUDED.annual_cost,
            updated_at = NOW(),
            metadata = EXCLUDED.metadata
          `,
          [
            `GCP-${serviceName}`,
            'opex',
            mapServiceToTower(serviceName),
            monthlyCost,
            annualCost,
            'direct',
            format(startDate, 'yyyy-MM'),
            'gcp',
            JSON.stringify({
              projectId: job.data.projectId || credentials.projectId,
              billingAccountId: job.data.billingAccountId,
              serviceName,
              lastSyncedAt: new Date().toISOString(),
              breakdown: costData.breakdown,
            }),
          ]
        );

        costsImported++;
        totalCost += monthlyCost;
      }

      // Import SKU-level costs (detailed cost breakdown)
      for (const [skuId, skuCost] of costsBySKU.entries()) {
        await client.query(
          `
          INSERT INTO tbm_cost_pools (
            pool_name,
            cost_category,
            resource_tower,
            monthly_cost,
            annual_cost,
            allocation_method,
            fiscal_period,
            source_system,
            metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (pool_name, fiscal_period)
          DO UPDATE SET
            monthly_cost = EXCLUDED.monthly_cost,
            annual_cost = EXCLUDED.annual_cost,
            updated_at = NOW(),
            metadata = EXCLUDED.metadata
          `,
          [
            `GCP-SKU-${skuId}`,
            'opex',
            skuCost.service ? mapServiceToTower(skuCost.service) : 'other',
            skuCost.cost,
            skuCost.cost * 12,
            'direct',
            format(startDate, 'yyyy-MM'),
            'gcp',
            JSON.stringify({
              projectId: job.data.projectId || credentials.projectId,
              billingAccountId: job.data.billingAccountId,
              skuId,
              skuDescription: skuCost.description,
              service: skuCost.service,
              region: skuCost.region,
              labels: skuCost.labels,
              lastSyncedAt: new Date().toISOString(),
            }),
          ]
        );

        costsImported++;
        totalCost += skuCost.cost;
      }

      // Import project-level costs (if querying at billing account level)
      for (const [projectId, projectCost] of costsByProject.entries()) {
        await client.query(
          `
          INSERT INTO tbm_cost_pools (
            pool_name,
            cost_category,
            resource_tower,
            monthly_cost,
            annual_cost,
            allocation_method,
            fiscal_period,
            source_system,
            metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (pool_name, fiscal_period)
          DO UPDATE SET
            monthly_cost = EXCLUDED.monthly_cost,
            annual_cost = EXCLUDED.annual_cost,
            updated_at = NOW(),
            metadata = EXCLUDED.metadata
          `,
          [
            `GCP-Project-${projectId}`,
            'opex',
            'application', // Projects map to application tower
            projectCost.totalCost,
            projectCost.totalCost * 12,
            'usage_based',
            format(startDate, 'yyyy-MM'),
            'gcp',
            JSON.stringify({
              billingAccountId: job.data.billingAccountId,
              projectId,
              projectName: projectCost.projectName,
              lastSyncedAt: new Date().toISOString(),
            }),
          ]
        );

        costsImported++;
        totalCost += projectCost.totalCost;
      }

      await client.query('COMMIT');

      logger.info('[GCPCostSync] GCP costs synced successfully', {
        costsImported,
        duration: Date.now() - startTime,
      });

      return {
        success: true,
        projectId: job.data.projectId || credentials.projectId || 'unknown',
        costsImported,
        totalCost,
        startDate: format(startDate, 'yyyy-MM-dd'),
        endDate: format(endDate, 'yyyy-MM-dd'),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch {
    logger.error('[GCPCostSync] GCP cost sync failed', { code: 'ERR_INTERNAL' });

    return {
      success: false,
      projectId: job.data.projectId || 'unknown',
      costsImported: 0,
      totalCost: 0,
      startDate: job.data.startDate || format(startOfMonth(new Date()), 'yyyy-MM-dd'),
      endDate: job.data.endDate || format(endOfMonth(new Date()), 'yyyy-MM-dd'),
      errors: ['ERR_INTERNAL'],
    };
  }
}

/**
 * Get GCP credentials from unified credential system
 * Falls back to environment variables if no credential ID provided
 */
async function getGCPCredentials(
  credentialId?: string
): Promise<GCPCredentials & { projectId?: string } | null> {
  if (credentialId) {
    // Query unified credentials table
    const pgClient = getPostgresClient();
    const pool = pgClient.pool;

    const result = await pool.query(
      `
      SELECT
        credential_name,
        credential_data,
        metadata
      FROM unified_credentials
      WHERE id = $1
        AND protocol = 'gcp'
        AND is_active = true
      `,
      [credentialId]
    );

    if (result.rows.length === 0) {
      logger.warn('[GCPCostSync] No active GCP credential found');
      return null;
    }

    const row = result.rows[0];
    const credentialData = row.credential_data;
    const metadata = row.metadata;

    return {
      serviceAccountKey: credentialData.service_account_key,
      projectId: credentialData.project_id || metadata?.project_id,
    };
  }

  // Fallback to environment variables (legacy)
  if (process.env.GCP_SERVICE_ACCOUNT_KEY || process.env.GCP_SERVICE_ACCOUNT_KEY_PATH) {
    logger.warn(
      '[GCPCostSync] Using environment variables for GCP credentials (legacy mode)'
    );

    let serviceAccountKey: any;
    if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
      // Parse JSON from environment variable
      serviceAccountKey = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
    } else if (process.env.GCP_SERVICE_ACCOUNT_KEY_PATH) {
      // Read from file path
      const fs = await import('fs');
      const keyFileContent = fs.readFileSync(
        process.env.GCP_SERVICE_ACCOUNT_KEY_PATH,
        'utf8'
      );
      serviceAccountKey = JSON.parse(keyFileContent);
    }

    return {
      serviceAccountKey,
      projectId: process.env.GCP_PROJECT_ID || serviceAccountKey.project_id,
    };
  }

  return null;
}

/**
 * Map GCP service names to TBM resource towers
 */
function mapServiceToTower(serviceName: string): string {
  const serviceLower = serviceName.toLowerCase();

  // Compute services
  if (
    serviceLower.includes('compute engine') ||
    serviceLower.includes('app engine') ||
    serviceLower.includes('cloud functions') ||
    serviceLower.includes('cloud run') ||
    serviceLower.includes('kubernetes engine') ||
    serviceLower.includes('gke')
  ) {
    return 'compute';
  }

  // Storage services
  if (
    serviceLower.includes('cloud storage') ||
    serviceLower.includes('persistent disk') ||
    serviceLower.includes('filestore')
  ) {
    return 'storage';
  }

  // Database services
  if (
    serviceLower.includes('cloud sql') ||
    serviceLower.includes('spanner') ||
    serviceLower.includes('bigtable') ||
    serviceLower.includes('firestore') ||
    serviceLower.includes('datastore') ||
    serviceLower.includes('memorystore')
  ) {
    return 'database';
  }

  // Network services
  if (
    serviceLower.includes('cloud cdn') ||
    serviceLower.includes('cloud load balancing') ||
    serviceLower.includes('cloud armor') ||
    serviceLower.includes('cloud vpn') ||
    serviceLower.includes('cloud interconnect') ||
    serviceLower.includes('cloud nat')
  ) {
    return 'network';
  }

  // Application services
  if (
    serviceLower.includes('pub/sub') ||
    serviceLower.includes('cloud tasks') ||
    serviceLower.includes('cloud scheduler') ||
    serviceLower.includes('apigee') ||
    serviceLower.includes('api gateway')
  ) {
    return 'application';
  }

  // Security services
  if (
    serviceLower.includes('security command center') ||
    serviceLower.includes('identity-aware proxy') ||
    serviceLower.includes('cloud kms') ||
    serviceLower.includes('secret manager') ||
    serviceLower.includes('recaptcha')
  ) {
    return 'security';
  }

  // Monitoring services
  if (
    serviceLower.includes('cloud monitoring') ||
    serviceLower.includes('cloud logging') ||
    serviceLower.includes('cloud trace') ||
    serviceLower.includes('cloud profiler')
  ) {
    return 'monitoring';
  }

  // Data & Analytics services
  if (
    serviceLower.includes('bigquery') ||
    serviceLower.includes('dataflow') ||
    serviceLower.includes('dataproc') ||
    serviceLower.includes('data fusion') ||
    serviceLower.includes('composer')
  ) {
    return 'data_analytics';
  }

  // AI/ML services
  if (
    serviceLower.includes('vertex ai') ||
    serviceLower.includes('aiplatform') ||
    serviceLower.includes('ml engine') ||
    serviceLower.includes('automl') ||
    serviceLower.includes('vision api') ||
    serviceLower.includes('natural language') ||
    serviceLower.includes('translation')
  ) {
    return 'ai_ml';
  }

  // Default to "other"
  return 'other';
}

/**
 * Job configuration for BullMQ
 */
export const gcpCostSyncJobConfig = {
  jobName: 'gcp-cost-sync',
  defaultOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5 seconds
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 500, // Keep last 500 failed jobs for debugging
  },
  cronSchedule: '0 3 * * *', // Daily at 3:00 AM UTC (offset from AWS/Azure)
};
