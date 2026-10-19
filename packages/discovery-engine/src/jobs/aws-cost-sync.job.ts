// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS Cost Sync Job
 * Scheduled BullMQ job to fetch AWS cost data and sync to PostgreSQL
 *
 * Schedule: Daily at 2:00 AM UTC
 * Purpose: Populate tbm_cost_pools table with AWS cost data
 */

import { Job } from 'bullmq';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { subDays, startOfMonth, endOfMonth, format } from 'date-fns';

/**
 * AWS credentials for Cost Explorer access
 */
interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  sessionToken?: string;
  accountId?: string;
}

/**
 * AWS Cost Explorer client stub
 * In production, this would use the AWS SDK Cost Explorer API.
 * The @cmdb/tbm-cost-engine package provides TBM taxonomy/allocation logic,
 * not cloud provider API clients.
 */
class AWSCostExplorer {
  constructor(private credentials: AWSCredentials, private logger: any) {}

  async getCostsByService(
    _startDate: Date,
    _endDate: Date
  ): Promise<Map<string, { totalCost: number; breakdown?: any }>> {
    this.logger.warn('[AWSCostExplorer] Stub implementation - integrate AWS SDK CostExplorer');
    return new Map();
  }

  async getCostsByResource(
    _startDate: Date,
    _endDate: Date
  ): Promise<Map<string, { cost: number; resourceType?: string; region?: string; tags?: any }>> {
    this.logger.warn('[AWSCostExplorer] Stub implementation - integrate AWS SDK CostExplorer');
    return new Map();
  }
}

export interface AWSCostSyncJobData {
  accountId?: string;
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  credentialId?: string; // ID of credential in unified credential system
}

export interface AWSCostSyncResult {
  success: boolean;
  accountId: string;
  costsImported: number;
  totalCost: number;
  startDate: string;
  endDate: string;
  errors?: string[];
}

/**
 * AWS Cost Sync Job Processor
 * Fetches cost data from AWS Cost Explorer and writes to PostgreSQL
 */
export async function processAWSCostSync(
  job: Job<AWSCostSyncJobData>
): Promise<AWSCostSyncResult> {
  const startTime = Date.now();
  logger.info('[AWSCostSync] Starting AWS cost sync job');

  try {
    // Step 1: Get credentials
    const credentials = await getAWSCredentials(job.data.credentialId);
    if (!credentials) {
      throw new Error(
        `No AWS credentials found for ID: ${job.data.credentialId || 'default'}`
      );
    }

    // Step 2: Determine date range (default: current month)
    const startDate = job.data.startDate
      ? new Date(job.data.startDate)
      : startOfMonth(new Date());
    const endDate = job.data.endDate
      ? new Date(job.data.endDate)
      : endOfMonth(new Date());

    logger.info('[AWSCostSync] Fetching costs from AWS Cost Explorer');

    // Step 3: Initialize AWS Cost Explorer client
    const costExplorer = new AWSCostExplorer(credentials, logger);

    // Step 4: Fetch cost data by service
    const costsByService = await costExplorer.getCostsByService(startDate, endDate);

    // Step 5: Fetch cost data by resource (EC2, RDS, S3, etc.)
    const costsByResource = await costExplorer.getCostsByResource(startDate, endDate);

    // Step 6: Insert/update cost data in PostgreSQL
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
            `AWS-${serviceName}`,
            'opex',
            mapServiceToTower(serviceName),
            monthlyCost,
            annualCost,
            'direct',
            format(startDate, 'yyyy-MM'),
            'aws',
            JSON.stringify({
              accountId: job.data.accountId || credentials.accountId,
              serviceName,
              region: credentials.region || 'us-east-1',
              lastSyncedAt: new Date().toISOString(),
              breakdown: costData.breakdown,
            }),
          ]
        );

        costsImported++;
        totalCost += monthlyCost;
      }

      // Import resource-level costs (EC2 instances, RDS databases, etc.)
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
            `AWS-Resource-${resourceId}`,
            'opex',
            resourceCost.resourceType
              ? mapServiceToTower(resourceCost.resourceType)
              : 'compute',
            resourceCost.cost,
            resourceCost.cost * 12,
            'direct',
            format(startDate, 'yyyy-MM'),
            'aws',
            JSON.stringify({
              accountId: job.data.accountId || credentials.accountId,
              resourceId,
              resourceType: resourceCost.resourceType,
              region: resourceCost.region,
              tags: resourceCost.tags,
              lastSyncedAt: new Date().toISOString(),
            }),
          ]
        );

        costsImported++;
        totalCost += resourceCost.cost;
      }

      await client.query('COMMIT');

      logger.info('[AWSCostSync] AWS costs synced successfully', {
        costsImported,
        duration: Date.now() - startTime,
      });

      return {
        success: true,
        accountId: job.data.accountId || credentials.accountId || 'unknown',
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
    logger.error('[AWSCostSync] AWS cost sync failed', { code: 'ERR_INTERNAL' });

    return {
      success: false,
      accountId: job.data.accountId || 'unknown',
      costsImported: 0,
      totalCost: 0,
      startDate: job.data.startDate || format(startOfMonth(new Date()), 'yyyy-MM-dd'),
      endDate: job.data.endDate || format(endOfMonth(new Date()), 'yyyy-MM-dd'),
      errors: ['ERR_INTERNAL'],
    };
  }
}

/**
 * Get AWS credentials from unified credential system
 * Falls back to environment variables if no credential ID provided
 */
async function getAWSCredentials(
  credentialId?: string
): Promise<AWSCredentials & { accountId?: string } | null> {
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
        AND protocol = 'aws'
        AND is_active = true
      `,
      [credentialId]
    );

    if (result.rows.length === 0) {
      logger.warn('[AWSCostSync] No active AWS credential found');
      return null;
    }

    const row = result.rows[0];
    const credentialData = row.credential_data;
    const metadata = row.metadata;

    return {
      accessKeyId: credentialData.access_key_id,
      secretAccessKey: credentialData.secret_access_key,
      region: credentialData.region || metadata?.region || 'us-east-1',
      sessionToken: credentialData.session_token,
      accountId: metadata?.account_id,
    };
  }

  // Fallback to environment variables (legacy)
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    logger.warn(
      '[AWSCostSync] Using environment variables for AWS credentials (legacy mode)'
    );
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'us-east-1',
      sessionToken: process.env.AWS_SESSION_TOKEN,
      accountId: process.env.AWS_ACCOUNT_ID,
    };
  }

  return null;
}

/**
 * Map AWS service names to TBM resource towers
 */
function mapServiceToTower(serviceName: string): string {
  const serviceLower = serviceName.toLowerCase();

  // Compute services
  if (
    serviceLower.includes('ec2') ||
    serviceLower.includes('lambda') ||
    serviceLower.includes('ecs') ||
    serviceLower.includes('eks') ||
    serviceLower.includes('fargate') ||
    serviceLower.includes('batch')
  ) {
    return 'compute';
  }

  // Storage services
  if (
    serviceLower.includes('s3') ||
    serviceLower.includes('ebs') ||
    serviceLower.includes('efs') ||
    serviceLower.includes('fsx') ||
    serviceLower.includes('storage')
  ) {
    return 'storage';
  }

  // Database services
  if (
    serviceLower.includes('rds') ||
    serviceLower.includes('dynamodb') ||
    serviceLower.includes('elasticache') ||
    serviceLower.includes('redshift') ||
    serviceLower.includes('neptune') ||
    serviceLower.includes('documentdb')
  ) {
    return 'database';
  }

  // Network services
  if (
    serviceLower.includes('cloudfront') ||
    serviceLower.includes('route53') ||
    serviceLower.includes('elb') ||
    serviceLower.includes('vpc') ||
    serviceLower.includes('directconnect') ||
    serviceLower.includes('transitgateway')
  ) {
    return 'network';
  }

  // Application services
  if (
    serviceLower.includes('api gateway') ||
    serviceLower.includes('appsync') ||
    serviceLower.includes('eventbridge') ||
    serviceLower.includes('stepfunctions')
  ) {
    return 'application';
  }

  // Security services
  if (
    serviceLower.includes('waf') ||
    serviceLower.includes('shield') ||
    serviceLower.includes('guardduty') ||
    serviceLower.includes('securityhub') ||
    serviceLower.includes('kms') ||
    serviceLower.includes('secrets manager')
  ) {
    return 'security';
  }

  // Monitoring services
  if (
    serviceLower.includes('cloudwatch') ||
    serviceLower.includes('xray') ||
    serviceLower.includes('cloudtrail')
  ) {
    return 'monitoring';
  }

  // Default to "other"
  return 'other';
}

/**
 * Job configuration for BullMQ
 */
export const awsCostSyncJobConfig = {
  jobName: 'aws-cost-sync',
  defaultOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5 seconds
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 500, // Keep last 500 failed jobs for debugging
  },
  cronSchedule: '0 2 * * *', // Daily at 2:00 AM UTC
};
