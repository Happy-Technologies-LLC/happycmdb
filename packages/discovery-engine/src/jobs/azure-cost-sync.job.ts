// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Azure Cost Sync Job
 * Scheduled BullMQ job to fetch Azure cost data and sync to PostgreSQL
 *
 * Schedule: Daily at 2:30 AM UTC (offset from AWS to avoid concurrent API load)
 * Purpose: Populate tbm_cost_pools table with Azure cost data
 */

import { Job } from 'bullmq';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { subDays, startOfMonth, endOfMonth, format } from 'date-fns';

/**
 * Azure credentials for Cost Management access
 */
interface AzureCredentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  subscriptionId?: string;
}

/**
 * Azure Cost Management client stub
 * In production, this would use the Azure SDK Cost Management API.
 * The @cmdb/tbm-cost-engine package provides TBM taxonomy/allocation logic,
 * not cloud provider API clients.
 */
class AzureCostManagement {
  constructor(private credentials: AzureCredentials, private logger: any) {}

  async getCostsByService(
    _startDate: Date,
    _endDate: Date,
    _subscriptionId?: string
  ): Promise<Map<string, { totalCost: number; breakdown?: any }>> {
    this.logger.warn('[AzureCostManagement] Stub implementation - integrate Azure SDK');
    return new Map();
  }

  async getCostsByResourceGroup(
    _startDate: Date,
    _endDate: Date,
    _subscriptionId?: string
  ): Promise<Map<string, { totalCost: number }>> {
    this.logger.warn('[AzureCostManagement] Stub implementation - integrate Azure SDK');
    return new Map();
  }

  async getCostsByResource(
    _startDate: Date,
    _endDate: Date,
    _subscriptionId?: string
  ): Promise<Map<string, { cost: number; resourceType?: string; resourceGroupName?: string; location?: string; tags?: any }>> {
    this.logger.warn('[AzureCostManagement] Stub implementation - integrate Azure SDK');
    return new Map();
  }
}

export interface AzureCostSyncJobData {
  subscriptionId?: string;
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  credentialId?: string; // ID of credential in unified credential system
}

export interface AzureCostSyncResult {
  success: boolean;
  subscriptionId: string;
  costsImported: number;
  totalCost: number;
  startDate: string;
  endDate: string;
  errors?: string[];
}

/**
 * Azure Cost Sync Job Processor
 * Fetches cost data from Azure Cost Management API and writes to PostgreSQL
 */
export async function processAzureCostSync(
  job: Job<AzureCostSyncJobData>
): Promise<AzureCostSyncResult> {
  const startTime = Date.now();
  logger.info('[AzureCostSync] Starting Azure cost sync job');

  try {
    // Step 1: Get credentials
    const credentials = await getAzureCredentials(job.data.credentialId);
    if (!credentials) {
      throw new Error(
        `No Azure credentials found for ID: ${job.data.credentialId || 'default'}`
      );
    }

    // Step 2: Determine date range (default: current month)
    const startDate = job.data.startDate
      ? new Date(job.data.startDate)
      : startOfMonth(new Date());
    const endDate = job.data.endDate
      ? new Date(job.data.endDate)
      : endOfMonth(new Date());

    logger.info('[AzureCostSync] Fetching costs from Azure Cost Management');

    // Step 3: Initialize Azure Cost Management client
    const costManagement = new AzureCostManagement(credentials, logger);

    // Step 4: Fetch cost data by service
    const costsByService = await costManagement.getCostsByService(
      startDate,
      endDate,
      job.data.subscriptionId
    );

    // Step 5: Fetch cost data by resource group
    const costsByResourceGroup = await costManagement.getCostsByResourceGroup(
      startDate,
      endDate,
      job.data.subscriptionId
    );

    // Step 6: Fetch cost data by individual resource
    const costsByResource = await costManagement.getCostsByResource(
      startDate,
      endDate,
      job.data.subscriptionId
    );

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
            `Azure-${serviceName}`,
            'opex',
            mapServiceToTower(serviceName),
            monthlyCost,
            annualCost,
            'direct',
            format(startDate, 'yyyy-MM'),
            'azure',
            JSON.stringify({
              subscriptionId: job.data.subscriptionId || credentials.subscriptionId,
              serviceName,
              tenantId: credentials.tenantId,
              lastSyncedAt: new Date().toISOString(),
              breakdown: costData.breakdown,
            }),
          ]
        );

        costsImported++;
        totalCost += monthlyCost;
      }

      // Import resource group-level costs
      for (const [rgName, costData] of costsByResourceGroup.entries()) {
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
            `Azure-RG-${rgName}`,
            'opex',
            'application', // Resource groups map to application tower
            costData.totalCost,
            costData.totalCost * 12,
            'usage_based',
            format(startDate, 'yyyy-MM'),
            'azure',
            JSON.stringify({
              subscriptionId: job.data.subscriptionId || credentials.subscriptionId,
              resourceGroupName: rgName,
              lastSyncedAt: new Date().toISOString(),
            }),
          ]
        );

        costsImported++;
        totalCost += costData.totalCost;
      }

      // Import resource-level costs (VMs, DBs, Storage Accounts, etc.)
      for (const [resourceId, resourceCost] of costsByResource.entries()) {
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
            `Azure-Resource-${resourceId}`,
            'opex',
            resourceCost.resourceType
              ? mapServiceToTower(resourceCost.resourceType)
              : 'compute',
            resourceCost.cost,
            resourceCost.cost * 12,
            'direct',
            format(startDate, 'yyyy-MM'),
            'azure',
            JSON.stringify({
              subscriptionId: job.data.subscriptionId || credentials.subscriptionId,
              resourceId,
              resourceType: resourceCost.resourceType,
              resourceGroupName: resourceCost.resourceGroupName,
              location: resourceCost.location,
              tags: resourceCost.tags,
              lastSyncedAt: new Date().toISOString(),
            }),
          ]
        );

        costsImported++;
        totalCost += resourceCost.cost;
      }

      await client.query('COMMIT');

      logger.info('[AzureCostSync] Azure costs synced successfully', {
        costsImported,
        duration: Date.now() - startTime,
      });

      return {
        success: true,
        subscriptionId:
          job.data.subscriptionId || credentials.subscriptionId || 'unknown',
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
    logger.error('[AzureCostSync] Azure cost sync failed', { code: 'ERR_INTERNAL' });

    return {
      success: false,
      subscriptionId: job.data.subscriptionId || 'unknown',
      costsImported: 0,
      totalCost: 0,
      startDate: job.data.startDate || format(startOfMonth(new Date()), 'yyyy-MM-dd'),
      endDate: job.data.endDate || format(endOfMonth(new Date()), 'yyyy-MM-dd'),
      errors: ['ERR_INTERNAL'],
    };
  }
}

/**
 * Get Azure credentials from unified credential system
 * Falls back to environment variables if no credential ID provided
 */
async function getAzureCredentials(
  credentialId?: string
): Promise<AzureCredentials & { subscriptionId?: string } | null> {
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
        AND protocol = 'azure'
        AND is_active = true
      `,
      [credentialId]
    );

    if (result.rows.length === 0) {
      logger.warn('[AzureCostSync] No active Azure credential found');
      return null;
    }

    const row = result.rows[0];
    const credentialData = row.credential_data;
    const metadata = row.metadata;

    return {
      clientId: credentialData.client_id,
      clientSecret: credentialData.client_secret,
      tenantId: credentialData.tenant_id,
      subscriptionId: credentialData.subscription_id || metadata?.subscription_id,
    };
  }

  // Fallback to environment variables (legacy)
  if (
    process.env.AZURE_CLIENT_ID &&
    process.env.AZURE_CLIENT_SECRET &&
    process.env.AZURE_TENANT_ID
  ) {
    logger.warn(
      '[AzureCostSync] Using environment variables for Azure credentials (legacy mode)'
    );
    return {
      clientId: process.env.AZURE_CLIENT_ID,
      clientSecret: process.env.AZURE_CLIENT_SECRET,
      tenantId: process.env.AZURE_TENANT_ID,
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
    };
  }

  return null;
}

/**
 * Map Azure service names to TBM resource towers
 */
function mapServiceToTower(serviceName: string): string {
  const serviceLower = serviceName.toLowerCase();

  // Compute services
  if (
    serviceLower.includes('virtual machines') ||
    serviceLower.includes('vm') ||
    serviceLower.includes('functions') ||
    serviceLower.includes('app service') ||
    serviceLower.includes('container instances') ||
    serviceLower.includes('kubernetes') ||
    serviceLower.includes('batch')
  ) {
    return 'compute';
  }

  // Storage services
  if (
    serviceLower.includes('storage') ||
    serviceLower.includes('blob') ||
    serviceLower.includes('file') ||
    serviceLower.includes('disk') ||
    serviceLower.includes('managed disks')
  ) {
    return 'storage';
  }

  // Database services
  if (
    serviceLower.includes('sql') ||
    serviceLower.includes('cosmos') ||
    serviceLower.includes('mysql') ||
    serviceLower.includes('postgresql') ||
    serviceLower.includes('database') ||
    serviceLower.includes('redis cache')
  ) {
    return 'database';
  }

  // Network services
  if (
    serviceLower.includes('cdn') ||
    serviceLower.includes('load balancer') ||
    serviceLower.includes('application gateway') ||
    serviceLower.includes('vpn') ||
    serviceLower.includes('expressroute') ||
    serviceLower.includes('traffic manager') ||
    serviceLower.includes('virtual network')
  ) {
    return 'network';
  }

  // Application services
  if (
    serviceLower.includes('api management') ||
    serviceLower.includes('service bus') ||
    serviceLower.includes('event grid') ||
    serviceLower.includes('event hubs') ||
    serviceLower.includes('logic apps')
  ) {
    return 'application';
  }

  // Security services
  if (
    serviceLower.includes('key vault') ||
    serviceLower.includes('security center') ||
    serviceLower.includes('sentinel') ||
    serviceLower.includes('firewall') ||
    serviceLower.includes('ddos')
  ) {
    return 'security';
  }

  // Monitoring services
  if (
    serviceLower.includes('monitor') ||
    serviceLower.includes('log analytics') ||
    serviceLower.includes('application insights')
  ) {
    return 'monitoring';
  }

  // Default to "other"
  return 'other';
}

/**
 * Job configuration for BullMQ
 */
export const azureCostSyncJobConfig = {
  jobName: 'azure-cost-sync',
  defaultOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5 seconds
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 500, // Keep last 500 failed jobs for debugging
  },
  cronSchedule: '30 2 * * *', // Daily at 2:30 AM UTC (offset from AWS)
};
