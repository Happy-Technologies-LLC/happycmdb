// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Synchronization Service
 * Orchestrates daily/monthly cost synchronization from all sources
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { Logger } from 'winston';
import { getRedisClient, getPostgresClient } from '@cmdb/database';
import { startOfMonth, endOfMonth, subDays } from 'date-fns';
import { AWSCostExplorer, AWSCredentials } from './aws-cost-explorer';
import { AzureCostManagement, AzureCredentials } from './azure-cost-management';
import { GCPBilling, GCPCredentials } from './gcp-billing';
import { GLIntegration } from './gl-integration';
import { LicenseTracker } from './license-tracker';
import {
  SyncResult,
  CostSyncConfig,
  ReconciliationReport,
} from './types/cloud-cost-types';

export interface CostSyncOptions {
  provider: 'aws' | 'azure' | 'gcp' | 'gl' | 'license';
  credentialId: string;
  lookbackDays?: number;
  batchSize?: number;
}

export class CostSyncService {
  private logger: Logger;
  private syncQueue: Queue;
  private queueEvents: QueueEvents;
  private dbClient: any;
  private redisClient: any;

  constructor(logger: Logger) {
    this.logger = logger;
    this.redisClient = getRedisClient().getConnection();
    this.dbClient = getPostgresClient();

    // Initialize BullMQ queue for cost sync jobs
    this.syncQueue = new Queue('cost-sync', {
      connection: this.redisClient,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          count: 100,
          age: 86400, // 1 day
        },
        removeOnFail: {
          count: 500,
        },
      },
    });

    // Initialize QueueEvents for job completion tracking
    this.queueEvents = new QueueEvents('cost-sync', {
      connection: this.redisClient,
    });

    // Initialize workers
    this.initializeWorkers();
  }

  /**
   * Initialize BullMQ workers for processing sync jobs
   */
  private initializeWorkers(): void {
    const worker = new Worker(
      'cost-sync',
      async (job: Job) => {
        this.logger.info('Processing cost sync job', {
          jobId: job.id,
          provider: job.data.provider,
        });

        try {
          let result: SyncResult;

          switch (job.data.provider) {
            case 'aws':
              result = await this.syncAWSCosts(job.data);
              break;
            case 'azure':
              result = await this.syncAzureCosts(job.data);
              break;
            case 'gcp':
              result = await this.syncGCPCosts(job.data);
              break;
            case 'gl':
              result = await this.syncGLCostsInternal(job.data);
              break;
            case 'license':
              result = await this.syncLicenseCostsInternal(job.data);
              break;
            default:
              throw new Error(`Unknown provider: ${job.data.provider}`);
          }

          return result;
        } catch (error) {
          this.logger.error('Cost sync job failed', {
            jobId: job.id,
            error,
          });
          throw error;
        }
      },
      {
        connection: this.redisClient,
        concurrency: 5,
      }
    );

    worker.on('completed', (job, result) => {
      this.logger.info('Cost sync job completed', {
        jobId: job.id,
        provider: job.data.provider,
        recordsProcessed: result.recordsProcessed,
      });
    });

    worker.on('failed', (job, error) => {
      this.logger.error('Cost sync job failed', {
        jobId: job?.id,
        error,
      });
    });
  }

  /**
   * Synchronize AWS cloud costs
   */
  async syncCloudCosts(
    provider: 'aws' | 'azure' | 'gcp',
    options?: Partial<CostSyncOptions>
  ): Promise<SyncResult> {
    this.logger.info('Initiating cloud cost sync', { provider });

    // Queue the sync job
    const job = await this.syncQueue.add(
      `${provider}-sync`,
      {
        provider,
        ...options,
      },
      {
        jobId: `${provider}-sync-${Date.now()}`,
      }
    );

    // Wait for job completion
    const result = await job.waitUntilFinished(
      this.queueEvents,
      60000 // 60 second timeout
    );

    return result;
  }

  /**
   * Internal AWS cost sync implementation
   */
  private async syncAWSCosts(options: CostSyncOptions): Promise<SyncResult> {
    const syncStartTime = new Date();

    try {
      // Get credentials
      const credentials = await this.getCredentials(options.credentialId);
      const awsCredentials: AWSCredentials = {
        accessKeyId: credentials.access_key_id,
        secretAccessKey: credentials.secret_access_key,
        region: credentials.region,
      };

      const awsCostExplorer = new AWSCostExplorer(awsCredentials, this.logger);

      // Calculate date range
      const endDate = new Date();
      const startDate = subDays(endDate, options.lookbackDays || 7);

      // Fetch daily costs
      const dailyCosts = await awsCostExplorer.getDailyCosts(startDate, endDate);

      let recordsCreated = 0;
      let recordsUpdated = 0;
      let recordsFailed = 0;
      const errors: Array<{ error: string; timestamp: Date }> = [];

      // Batch insert costs
      const batchSize = options.batchSize || 100;
      for (let i = 0; i < dailyCosts.length; i += batchSize) {
        const batch = dailyCosts.slice(i, i + batchSize);

        for (const cost of batch) {
          try {
            const result = await this.dbClient.query(
              `
              INSERT INTO resource_costs (
                provider, service_name, cost_date, cost, currency,
                sync_id, created_at, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
              ON CONFLICT (provider, service_name, cost_date)
              DO UPDATE SET
                cost = EXCLUDED.cost,
                currency = EXCLUDED.currency,
                sync_id = EXCLUDED.sync_id,
                updated_at = NOW()
              RETURNING (xmax = 0) AS inserted
            `,
              [
                'aws',
                cost.service,
                cost.date,
                cost.amount,
                cost.currency,
                options.credentialId,
              ]
            );

            if (result.rows[0].inserted) {
              recordsCreated++;
            } else {
              recordsUpdated++;
            }
          } catch (error) {
            recordsFailed++;
            errors.push({
              error: String(error),
              timestamp: new Date(),
            });
          }
        }
      }

      await awsCostExplorer.close();

      const syncEndTime = new Date();

      return {
        success: recordsFailed === 0,
        provider: 'aws',
        recordsProcessed: dailyCosts.length,
        recordsCreated,
        recordsUpdated,
        recordsFailed,
        errors: errors.length > 0 ? errors : undefined,
        syncStartTime,
        syncEndTime,
        duration: syncEndTime.getTime() - syncStartTime.getTime(),
      };
    } catch (error) {
      this.logger.error('AWS cost sync failed', { error });
      throw error;
    }
  }

  /**
   * Internal Azure cost sync implementation
   */
  private async syncAzureCosts(options: CostSyncOptions): Promise<SyncResult> {
    const syncStartTime = new Date();

    try {
      // Get credentials
      const credentials = await this.getCredentials(options.credentialId);
      const azureCredentials: AzureCredentials = {
        clientId: credentials.client_id,
        clientSecret: credentials.client_secret,
        tenantId: credentials.tenant_id,
        subscriptionId: credentials.subscription_id,
      };

      const azureCostMgmt = new AzureCostManagement(
        azureCredentials,
        this.logger
      );

      // Calculate date range
      const endDate = new Date();
      const startDate = subDays(endDate, options.lookbackDays || 7);

      // Fetch daily costs
      const dailyCosts = await azureCostMgmt.getDailyCosts(
        credentials.subscription_id,
        startDate,
        endDate
      );

      let recordsCreated = 0;
      let recordsUpdated = 0;
      let recordsFailed = 0;
      const errors: Array<{ error: string; timestamp: Date }> = [];

      // Batch insert costs
      for (const cost of dailyCosts) {
        try {
          const result = await this.dbClient.query(
            `
            INSERT INTO resource_costs (
              provider, service_name, cost_date, cost, currency,
              sync_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (provider, service_name, cost_date)
            DO UPDATE SET
              cost = EXCLUDED.cost,
              currency = EXCLUDED.currency,
              sync_id = EXCLUDED.sync_id,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted
          `,
            [
              'azure',
              cost.service,
              cost.date,
              cost.amount,
              cost.currency,
              options.credentialId,
            ]
          );

          if (result.rows[0].inserted) {
            recordsCreated++;
          } else {
            recordsUpdated++;
          }
        } catch (error) {
          recordsFailed++;
          errors.push({
            error: String(error),
            timestamp: new Date(),
          });
        }
      }

      const syncEndTime = new Date();

      return {
        success: recordsFailed === 0,
        provider: 'azure',
        recordsProcessed: dailyCosts.length,
        recordsCreated,
        recordsUpdated,
        recordsFailed,
        errors: errors.length > 0 ? errors : undefined,
        syncStartTime,
        syncEndTime,
        duration: syncEndTime.getTime() - syncStartTime.getTime(),
      };
    } catch (error) {
      this.logger.error('Azure cost sync failed', { error });
      throw error;
    }
  }

  /**
   * Internal GCP cost sync implementation
   */
  private async syncGCPCosts(options: CostSyncOptions): Promise<SyncResult> {
    const syncStartTime = new Date();

    try {
      // Get credentials
      const credentials = await this.getCredentials(options.credentialId);
      const gcpCredentials: GCPCredentials = {
        projectId: credentials.project_id,
        credentials: JSON.parse(credentials.service_account_key),
      };

      const gcpBilling = new GCPBilling(gcpCredentials, this.logger);

      // Calculate date range
      const endDate = new Date();
      const startDate = subDays(endDate, options.lookbackDays || 7);

      // Fetch daily costs
      const dailyCosts = await gcpBilling.getDailyCosts(startDate, endDate);

      let recordsCreated = 0;
      let recordsUpdated = 0;
      let recordsFailed = 0;
      const errors: Array<{ error: string; timestamp: Date }> = [];

      // Batch insert costs
      for (const cost of dailyCosts) {
        try {
          const result = await this.dbClient.query(
            `
            INSERT INTO resource_costs (
              provider, service_name, cost_date, cost, currency,
              sync_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (provider, service_name, cost_date)
            DO UPDATE SET
              cost = EXCLUDED.cost,
              currency = EXCLUDED.currency,
              sync_id = EXCLUDED.sync_id,
              updated_at = NOW()
            RETURNING (xmax = 0) AS inserted
          `,
            [
              'gcp',
              cost.service,
              cost.date,
              cost.amount,
              cost.currency,
              options.credentialId,
            ]
          );

          if (result.rows[0].inserted) {
            recordsCreated++;
          } else {
            recordsUpdated++;
          }
        } catch (error) {
          recordsFailed++;
          errors.push({
            error: String(error),
            timestamp: new Date(),
          });
        }
      }

      const syncEndTime = new Date();

      return {
        success: recordsFailed === 0,
        provider: 'gcp',
        recordsProcessed: dailyCosts.length,
        recordsCreated,
        recordsUpdated,
        recordsFailed,
        errors: errors.length > 0 ? errors : undefined,
        syncStartTime,
        syncEndTime,
        duration: syncEndTime.getTime() - syncStartTime.getTime(),
      };
    } catch (error) {
      this.logger.error('GCP cost sync failed', { error });
      throw error;
    }
  }

  /**
   * Synchronize GL costs (monthly)
   */
  async syncGLCosts(): Promise<SyncResult> {
    this.logger.info('Initiating GL cost sync');

    // Queue the sync job
    const job = await this.syncQueue.add(
      'gl-sync',
      {
        provider: 'gl',
      },
      {
        jobId: `gl-sync-${Date.now()}`,
      }
    );

    // Wait for job completion
    const result = await job.waitUntilFinished(
      this.queueEvents,
      300000 // 5 minute timeout for GL sync
    );

    return result;
  }

  /**
   * Internal GL cost sync implementation
   */
  private async syncGLCostsInternal(options: any): Promise<SyncResult> {
    const syncStartTime = new Date();

    try {
      const glIntegration = new GLIntegration(this.logger);

      // Sync current month
      const currentMonth = startOfMonth(new Date());
      const glSyncResult = await glIntegration.syncMonthlyCosts(currentMonth);

      const syncEndTime = new Date();

      return {
        success: glSyncResult.status === 'completed',
        provider: 'gl',
        recordsProcessed: glSyncResult.accountsProcessed,
        recordsCreated: glSyncResult.accountsProcessed,
        recordsUpdated: 0,
        recordsFailed: glSyncResult.errors?.length || 0,
        errors: glSyncResult.errors?.map((err) => ({
          error: err,
          timestamp: new Date(),
        })),
        syncStartTime,
        syncEndTime,
        duration: syncEndTime.getTime() - syncStartTime.getTime(),
      };
    } catch (error) {
      this.logger.error('GL cost sync failed', { error });
      throw error;
    }
  }

  /**
   * Synchronize license costs
   */
  async syncLicenseCosts(): Promise<SyncResult> {
    this.logger.info('Initiating license cost sync');

    // Queue the sync job
    const job = await this.syncQueue.add(
      'license-sync',
      {
        provider: 'license',
      },
      {
        jobId: `license-sync-${Date.now()}`,
      }
    );

    // Wait for job completion
    const result = await job.waitUntilFinished(
      this.queueEvents,
      120000 // 2 minute timeout
    );

    return result;
  }

  /**
   * Internal license cost sync implementation
   */
  private async syncLicenseCostsInternal(options: any): Promise<SyncResult> {
    const syncStartTime = new Date();

    try {
      const licenseTracker = new LicenseTracker(this.logger);

      // Get all active licenses
      const licenses = await licenseTracker.getAllActiveLicenses();

      let recordsCreated = 0;
      let recordsUpdated = 0;
      let recordsFailed = 0;

      // Calculate costs for each license
      for (const license of licenses) {
        try {
          const usage = await licenseTracker.getLicenseUsage(license.id);

          if (usage) {
            const cost = await licenseTracker.calculateLicenseCost(
              license.id,
              usage
            );

            // Store license cost
            const result = await this.dbClient.query(
              `
              INSERT INTO license_costs (
                license_id, cost_date, cost, currency,
                quantity, utilization, created_at, updated_at
              ) VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, NOW(), NOW())
              ON CONFLICT (license_id, cost_date)
              DO UPDATE SET
                cost = EXCLUDED.cost,
                quantity = EXCLUDED.quantity,
                utilization = EXCLUDED.utilization,
                updated_at = NOW()
              RETURNING (xmax = 0) AS inserted
            `,
              [
                license.id,
                cost,
                license.currency,
                license.quantity,
                usage.utilizationPercentage,
              ]
            );

            if (result.rows[0].inserted) {
              recordsCreated++;
            } else {
              recordsUpdated++;
            }
          }
        } catch (error) {
          recordsFailed++;
          this.logger.error('Failed to sync license cost', {
            licenseId: license.id,
            error,
          });
        }
      }

      const syncEndTime = new Date();

      return {
        success: recordsFailed === 0,
        provider: 'license',
        recordsProcessed: licenses.length,
        recordsCreated,
        recordsUpdated,
        recordsFailed,
        syncStartTime,
        syncEndTime,
        duration: syncEndTime.getTime() - syncStartTime.getTime(),
      };
    } catch (error) {
      this.logger.error('License cost sync failed', { error });
      throw error;
    }
  }

  /**
   * Reconcile all costs for a given month
   */
  async reconcileCosts(month: Date): Promise<ReconciliationReport> {
    this.logger.info('Reconciling costs', { month });

    try {
      const glIntegration = new GLIntegration(this.logger);
      const glReconciliation = await glIntegration.reconcileCosts(month);

      // Get cloud costs
      const cloudCostsResult = await this.dbClient.query(
        `
        SELECT COALESCE(SUM(cost), 0) as total
        FROM resource_costs
        WHERE DATE_TRUNC('month', cost_date) = $1
          AND provider IN ('aws', 'azure', 'gcp')
      `,
        [startOfMonth(month)]
      );

      const totalCloudCosts = parseFloat(cloudCostsResult.rows[0].total);

      // Get license costs
      const licenseCostsResult = await this.dbClient.query(
        `
        SELECT COALESCE(SUM(cost), 0) as total
        FROM license_costs
        WHERE DATE_TRUNC('month', cost_date) = $1
      `,
        [startOfMonth(month)]
      );

      const totalLicenseCosts = parseFloat(licenseCostsResult.rows[0].total);

      // Calculate variance
      const totalGLCosts = glReconciliation.glTotalCost;
      const variance = totalGLCosts - (totalCloudCosts + totalLicenseCosts);
      const variancePercentage =
        totalCloudCosts + totalLicenseCosts > 0
          ? (variance / (totalCloudCosts + totalLicenseCosts)) * 100
          : 0;

      const reconciled = Math.abs(variancePercentage) < 5; // Within 5%

      const discrepancies = [
        {
          source: 'Cloud Costs (AWS + Azure + GCP)',
          expected: totalCloudCosts,
          actual: totalCloudCosts,
          difference: 0,
        },
        {
          source: 'License Costs',
          expected: totalLicenseCosts,
          actual: totalLicenseCosts,
          difference: 0,
        },
        {
          source: 'GL Costs',
          expected: totalGLCosts,
          actual: totalGLCosts,
          difference: variance,
          reason: variance > 0 ? 'GL costs exceed tracked costs' : 'Tracked costs exceed GL',
        },
      ];

      return {
        month,
        totalCloudCosts,
        totalGLCosts,
        totalLicenseCosts,
        variance,
        variancePercentage,
        reconciled,
        discrepancies,
        generatedAt: new Date(),
      };
    } catch (error) {
      this.logger.error('Cost reconciliation failed', { error });
      throw error;
    }
  }

  /**
   * Schedule automated cost syncs
   */
  async scheduleAutomatedSyncs(): Promise<void> {
    this.logger.info('Scheduling automated cost syncs');

    // Daily cloud cost syncs (run at 2 AM)
    await this.syncQueue.add(
      'aws-daily-sync',
      { provider: 'aws' },
      {
        repeat: {
          pattern: '0 2 * * *', // 2 AM every day
        },
      }
    );

    await this.syncQueue.add(
      'azure-daily-sync',
      { provider: 'azure' },
      {
        repeat: {
          pattern: '0 2 * * *',
        },
      }
    );

    await this.syncQueue.add(
      'gcp-daily-sync',
      { provider: 'gcp' },
      {
        repeat: {
          pattern: '0 2 * * *',
        },
      }
    );

    // Monthly GL sync (run on 5th of each month at 3 AM)
    await this.syncQueue.add(
      'gl-monthly-sync',
      { provider: 'gl' },
      {
        repeat: {
          pattern: '0 3 5 * *', // 3 AM on 5th of each month
        },
      }
    );

    // Daily license cost sync (run at 1 AM)
    await this.syncQueue.add(
      'license-daily-sync',
      { provider: 'license' },
      {
        repeat: {
          pattern: '0 1 * * *', // 1 AM every day
        },
      }
    );

    this.logger.info('Automated cost syncs scheduled');
  }

  /**
   * Get credentials from database
   */
  private async getCredentials(credentialId: string): Promise<any> {
    const result = await this.dbClient.query(
      'SELECT * FROM credentials WHERE id = $1',
      [credentialId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Credential ${credentialId} not found`);
    }

    // The `credentials` table stores provider-specific secret fields
    // (access_key_id, client_secret, service_account_key, etc.) nested
    // inside the JSONB `credentials` column, not as top-level columns.
    const row = result.rows[0];
    return { ...row, ...row.credentials };
  }
}
