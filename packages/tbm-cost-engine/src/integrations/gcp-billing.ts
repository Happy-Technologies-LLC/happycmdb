// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GCP Billing Integration
 * Fetches cost and usage data from GCP Cloud Billing API
 */

import { CloudBillingClient } from '@google-cloud/billing';
import { BigQuery } from '@google-cloud/bigquery';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { Logger } from 'winston';
import {
  CostBreakdown,
  DailyCostData,
  GCPCostData,
  GCPBillingParams,
} from './types/cloud-cost-types';

export interface GCPCredentials {
  projectId: string;
  keyFilename?: string; // Path to service account key file
  credentials?: any; // Service account credentials object
}

export class GCPBilling {
  private billingClient: CloudBillingClient;
  private bigQueryClient: BigQuery;
  private projectId: string;
  private logger: Logger;
  private readonly maxRetries = 3;
  private readonly retryDelay = 2000; // ms

  constructor(credentials: GCPCredentials, logger: Logger) {
    this.projectId = credentials.projectId;
    this.logger = logger;

    const clientConfig = credentials.keyFilename
      ? { keyFilename: credentials.keyFilename }
      : { credentials: credentials.credentials };

    this.billingClient = new CloudBillingClient(clientConfig);
    this.bigQueryClient = new BigQuery({
      projectId: this.projectId,
      ...clientConfig,
    });
  }

  /**
   * Get costs by project using BigQuery export data
   * Note: Requires billing export to BigQuery to be configured
   */
  async getCostsByProject(
    projectId: string,
    startDate: Date,
    endDate: Date
  ): Promise<number> {
    this.logger.info('Fetching GCP costs by project', {
      projectId,
      startDate,
      endDate,
    });

    try {
      const query = `
        SELECT
          SUM(cost) as total_cost
        FROM
          \`${this.projectId}.billing_export.gcp_billing_export_v1_*\`
        WHERE
          project.id = @projectId
          AND _TABLE_SUFFIX BETWEEN @startDate AND @endDate
          AND cost > 0
      `;

      const options = {
        query,
        params: {
          projectId,
          startDate: format(startDate, 'yyyyMMdd'),
          endDate: format(endDate, 'yyyyMMdd'),
        },
      };

      const [rows] = await this.retryWithBackoff(async () => {
        return await this.bigQueryClient.query(options);
      });

      const totalCost = parseFloat(rows[0]?.total_cost) || 0;

      this.logger.info('Successfully fetched costs by project', {
        projectId,
        totalCost,
      });

      return totalCost;
    } catch (error) {
      this.logger.error('Failed to fetch costs by project', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * Get costs by service with breakdown
   */
  async getCostsByService(
    serviceName: string,
    startDate: Date,
    endDate: Date
  ): Promise<CostBreakdown> {
    this.logger.info('Fetching GCP costs by service', {
      serviceName,
      startDate,
      endDate,
    });

    try {
      const query = `
        SELECT
          sku.description as sku_description,
          SUM(cost) as total_cost,
          currency
        FROM
          \`${this.projectId}.billing_export.gcp_billing_export_v1_*\`
        WHERE
          service.description = @serviceName
          AND _TABLE_SUFFIX BETWEEN @startDate AND @endDate
          AND cost > 0
        GROUP BY
          sku.description, currency
        ORDER BY
          total_cost DESC
      `;

      const options = {
        query,
        params: {
          serviceName,
          startDate: format(startDate, 'yyyyMMdd'),
          endDate: format(endDate, 'yyyyMMdd'),
        },
      };

      const [rows] = await this.retryWithBackoff(async () => {
        return await this.bigQueryClient.query(options);
      });

      let total = 0;
      const breakdown: Array<{
        category: string;
        amount: number;
        currency: string;
        percentage?: number;
      }> = [];

      const currency = rows[0]?.currency || 'USD';

      for (const row of rows) {
        const cost = parseFloat(row.total_cost) || 0;
        total += cost;

        breakdown.push({
          category: row.sku_description,
          amount: cost,
          currency: row.currency,
        });
      }

      // Calculate percentages
      if (total > 0) {
        breakdown.forEach((item) => {
          item.percentage = (item.amount / total) * 100;
        });
      }

      this.logger.info('Successfully fetched costs by service', {
        serviceName,
        total,
        skuCount: breakdown.length,
      });

      return {
        total,
        currency,
        breakdown,
      };
    } catch (error) {
      this.logger.error('Failed to fetch costs by service', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * Get daily cost data
   */
  async getDailyCosts(
    startDate: Date,
    endDate: Date,
    projectId?: string
  ): Promise<DailyCostData[]> {
    this.logger.info('Fetching GCP daily costs', {
      startDate,
      endDate,
      projectId,
    });

    try {
      const projectFilter = projectId
        ? 'AND project.id = @projectId'
        : '';

      const query = `
        SELECT
          PARSE_DATE('%Y%m%d', _TABLE_SUFFIX) as date,
          service.description as service_name,
          SUM(cost) as total_cost,
          currency
        FROM
          \`${this.projectId}.billing_export.gcp_billing_export_v1_*\`
        WHERE
          _TABLE_SUFFIX BETWEEN @startDate AND @endDate
          AND cost > 0
          ${projectFilter}
        GROUP BY
          date, service_name, currency
        ORDER BY
          date, total_cost DESC
      `;

      const params: any = {
        startDate: format(startDate, 'yyyyMMdd'),
        endDate: format(endDate, 'yyyyMMdd'),
      };

      if (projectId) {
        params.projectId = projectId;
      }

      const options = { query, params };

      const [rows] = await this.retryWithBackoff(async () => {
        return await this.bigQueryClient.query(options);
      });

      const dailyCosts: DailyCostData[] = rows.map((row) => ({
        date: new Date(row.date.value),
        amount: parseFloat(row.total_cost) || 0,
        currency: row.currency,
        service: row.service_name,
      }));

      this.logger.info('Successfully fetched daily costs', {
        daysProcessed: dailyCosts.length,
      });

      return dailyCosts;
    } catch (error) {
      this.logger.error('Failed to fetch daily costs', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * Get costs by location
   */
  async getCostsByLocation(
    location: string,
    startDate: Date,
    endDate: Date
  ): Promise<number> {
    this.logger.info('Fetching GCP costs by location', {
      location,
      startDate,
      endDate,
    });

    try {
      const query = `
        SELECT
          SUM(cost) as total_cost
        FROM
          \`${this.projectId}.billing_export.gcp_billing_export_v1_*\`
        WHERE
          location.location = @location
          AND _TABLE_SUFFIX BETWEEN @startDate AND @endDate
          AND cost > 0
      `;

      const options = {
        query,
        params: {
          location,
          startDate: format(startDate, 'yyyyMMdd'),
          endDate: format(endDate, 'yyyyMMdd'),
        },
      };

      const [rows] = await this.retryWithBackoff(async () => {
        return await this.bigQueryClient.query(options);
      });

      const totalCost = parseFloat(rows[0]?.total_cost) || 0;

      this.logger.info('Successfully fetched costs by location', {
        location,
        totalCost,
      });

      return totalCost;
    } catch (error) {
      this.logger.error('Failed to fetch costs by location', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * Get costs by labels (GCP's version of tags)
   */
  async getCostsByLabel(
    labelKey: string,
    labelValue: string,
    startDate: Date,
    endDate: Date
  ): Promise<number> {
    this.logger.info('Fetching GCP costs by label', {
      labelKey,
      labelValue,
      startDate,
      endDate,
    });

    try {
      const query = `
        SELECT
          SUM(cost) as total_cost
        FROM
          \`${this.projectId}.billing_export.gcp_billing_export_v1_*\`,
          UNNEST(labels) as label
        WHERE
          label.key = @labelKey
          AND label.value = @labelValue
          AND _TABLE_SUFFIX BETWEEN @startDate AND @endDate
          AND cost > 0
      `;

      const options = {
        query,
        params: {
          labelKey,
          labelValue,
          startDate: format(startDate, 'yyyyMMdd'),
          endDate: format(endDate, 'yyyyMMdd'),
        },
      };

      const [rows] = await this.retryWithBackoff(async () => {
        return await this.bigQueryClient.query(options);
      });

      const totalCost = parseFloat(rows[0]?.total_cost) || 0;

      this.logger.info('Successfully fetched costs by label', {
        labelKey,
        labelValue,
        totalCost,
      });

      return totalCost;
    } catch (error) {
      this.logger.error('Failed to fetch costs by label', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * Get all services with costs for a project
   */
  async getServiceBreakdown(
    startDate: Date,
    endDate: Date,
    projectId?: string
  ): Promise<CostBreakdown> {
    this.logger.info('Fetching GCP service breakdown', {
      startDate,
      endDate,
      projectId,
    });

    try {
      const projectFilter = projectId
        ? 'AND project.id = @projectId'
        : '';

      const query = `
        SELECT
          service.description as service_name,
          SUM(cost) as total_cost,
          currency
        FROM
          \`${this.projectId}.billing_export.gcp_billing_export_v1_*\`
        WHERE
          _TABLE_SUFFIX BETWEEN @startDate AND @endDate
          AND cost > 0
          ${projectFilter}
        GROUP BY
          service_name, currency
        ORDER BY
          total_cost DESC
      `;

      const params: any = {
        startDate: format(startDate, 'yyyyMMdd'),
        endDate: format(endDate, 'yyyyMMdd'),
      };

      if (projectId) {
        params.projectId = projectId;
      }

      const options = { query, params };

      const [rows] = await this.retryWithBackoff(async () => {
        return await this.bigQueryClient.query(options);
      });

      let total = 0;
      const breakdown: Array<{
        category: string;
        amount: number;
        currency: string;
        percentage?: number;
      }> = [];

      const currency = rows[0]?.currency || 'USD';

      for (const row of rows) {
        const cost = parseFloat(row.total_cost) || 0;
        total += cost;

        breakdown.push({
          category: row.service_name,
          amount: cost,
          currency: row.currency,
        });
      }

      // Calculate percentages
      if (total > 0) {
        breakdown.forEach((item) => {
          item.percentage = (item.amount / total) * 100;
        });
      }

      this.logger.info('Successfully fetched service breakdown', {
        total,
        services: breakdown.length,
      });

      return {
        total,
        currency,
        breakdown,
      };
    } catch (error) {
      this.logger.error('Failed to fetch service breakdown', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * Get current month costs
   */
  async getCurrentMonthCosts(projectId?: string): Promise<CostBreakdown> {
    const startDate = startOfMonth(new Date());
    const endDate = new Date();

    return this.getServiceBreakdown(startDate, endDate, projectId);
  }

  /**
   * Get custom cost data with flexible parameters
   */
  async getCustomCostData(params: GCPBillingParams): Promise<GCPCostData[]> {
    this.logger.info('Fetching custom GCP cost data', { params });

    try {
      const projectFilter = params.projectId
        ? 'AND project.id = @projectId'
        : '';

      const servicesFilter = params.services && params.services.length > 0
        ? 'AND service.description IN UNNEST(@services)'
        : '';

      const locationsFilter = params.locations && params.locations.length > 0
        ? 'AND location.location IN UNNEST(@locations)'
        : '';

      const query = `
        SELECT
          project.id as project_id,
          project.name as project_name,
          service.description as service_name,
          sku.description as sku_description,
          location.location as location,
          SUM(cost) as total_cost,
          currency,
          ARRAY_AGG(STRUCT(label.key, label.value)) as labels
        FROM
          \`${this.projectId}.billing_export.gcp_billing_export_v1_*\`,
          UNNEST(labels) as label
        WHERE
          _TABLE_SUFFIX BETWEEN @startDate AND @endDate
          AND cost > 0
          ${projectFilter}
          ${servicesFilter}
          ${locationsFilter}
        GROUP BY
          project_id, project_name, service_name, sku_description, location, currency
        ORDER BY
          total_cost DESC
      `;

      const queryParams: any = {
        startDate: format(params.startDate, 'yyyyMMdd'),
        endDate: format(params.endDate, 'yyyyMMdd'),
      };

      if (params.projectId) {
        queryParams.projectId = params.projectId;
      }
      if (params.services) {
        queryParams.services = params.services;
      }
      if (params.locations) {
        queryParams.locations = params.locations;
      }

      const options = { query, params: queryParams };

      const [rows] = await this.retryWithBackoff(async () => {
        return await this.bigQueryClient.query(options);
      });

      const costData: GCPCostData[] = rows.map((row) => {
        const labels: Record<string, string> = {};
        if (row.labels) {
          for (const label of row.labels) {
            labels[label.key] = label.value;
          }
        }

        return {
          projectId: row.project_id,
          projectName: row.project_name,
          serviceName: row.service_name,
          skuDescription: row.sku_description,
          cost: parseFloat(row.total_cost) || 0,
          currency: row.currency,
          location: row.location,
          labels,
        };
      });

      this.logger.info('Successfully fetched custom cost data', {
        recordCount: costData.length,
      });

      return costData;
    } catch (error) {
      this.logger.error('Failed to fetch custom cost data', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * List billing accounts
   */
  async listBillingAccounts(): Promise<Array<{ name: string; displayName: string }>> {
    this.logger.info('Listing GCP billing accounts');

    try {
      const [accounts] = await this.retryWithBackoff(async () => {
        return await this.billingClient.listBillingAccounts();
      });

      const billingAccounts = accounts.map((account) => ({
        name: account.name || '',
        displayName: account.displayName || '',
      }));

      this.logger.info('Successfully listed billing accounts', {
        count: billingAccounts.length,
      });

      return billingAccounts;
    } catch (error) {
      this.logger.error('Failed to list billing accounts', { error });
      throw new Error(`GCP Billing error: ${error}`);
    }
  }

  /**
   * Retry logic with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    attempt: number = 1
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (attempt >= this.maxRetries) {
        throw error;
      }

      // Check if error is retryable
      const isRetryable =
        error.code === 429 ||
        error.code === 503 ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' ||
        (error.message && error.message.includes('quota'));

      if (isRetryable) {
        const delay = this.retryDelay * Math.pow(2, attempt - 1);
        this.logger.warn(`Retrying GCP Billing request after ${delay}ms`, {
          attempt,
          error: error.message,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.retryWithBackoff(fn, attempt + 1);
      }

      throw error;
    }
  }
}
