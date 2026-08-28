// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Lookup Service
 * Fetches cost data from various sources (cloud providers, GL, asset database)
 */

import { getRedisClient, getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { CIType } from '@cmdb/unified-model';
import { DepreciationSchedule } from '@cmdb/unified-model';

/**
 * Purchase information for on-premise assets
 */
export interface PurchaseInfo {
  purchase_date: Date;
  purchase_cost: number;
  useful_life_months: number;
  residual_value: number;
  depreciation_method?: 'straight_line' | 'declining_balance';
}

/**
 * Cloud cost details
 */
export interface CloudCostDetails {
  monthlyCost: number;
  costBreakdown?: {
    compute?: number;
    storage?: number;
    network?: number;
    other?: number;
  };
  pricingModel?: 'on-demand' | 'reserved' | 'spot' | 'savings-plan';
  region?: string;
}

/**
 * Fetches cost data from various sources with caching
 */
export class CostLookupService {
  private redisClient = getRedisClient();
  private readonly CACHE_TTL = 86400; // 24 hours in seconds

  /**
   * Lookup cost for a cloud resource
   *
   * @param provider - Cloud provider (aws, azure, gcp)
   * @param resourceId - Resource identifier
   * @param resourceType - Type of resource (instance, volume, etc.)
   * @returns Monthly cost in USD
   */
  async lookupCloudResourceCost(
    provider: 'aws' | 'azure' | 'gcp',
    resourceId: string,
    resourceType: string,
    metadata?: Record<string, any>
  ): Promise<number> {
    const cacheKey = `tbm:cost:cloud:${provider}:${resourceId}`;

    try {
      // Check cache first
      const cached = await this.getCachedCost(cacheKey);
      if (cached !== null) {
        logger.debug('Cloud cost cache hit', { provider, resourceId, cost: cached });
        return cached;
      }

      // Fetch cost from cloud provider
      let cost: number;

      switch (provider) {
        case 'aws':
          cost = await this.lookupAWSCost(resourceId, resourceType, metadata);
          break;
        case 'azure':
          cost = await this.lookupAzureCost(resourceId, resourceType, metadata);
          break;
        case 'gcp':
          cost = await this.lookupGCPCost(resourceId, resourceType, metadata);
          break;
        default:
          logger.warn('Unknown cloud provider', { provider });
          cost = 0;
      }

      // Cache the result
      await this.cacheCost(cacheKey, cost);

      logger.info('Cloud cost lookup completed', {
        provider,
        resourceId,
        resourceType,
        cost,
      });

      return cost;
    } catch (error) {
      logger.error('Error looking up cloud resource cost', {
        provider,
        resourceId,
        error,
      });
      // Return 0 on error to avoid breaking enrichment
      return 0;
    }
  }

  /**
   * Lookup cost for on-premise assets
   *
   * @param ciId - Configuration item ID
   * @param ciType - Type of CI
   * @param metadata - CI metadata
   * @returns Monthly cost in USD (typically depreciation)
   */
  async lookupOnPremiseCost(
    ciId: string,
    ciType: CIType,
    metadata?: Record<string, any>
  ): Promise<number> {
    const cacheKey = `tbm:cost:onprem:${ciId}`;

    try {
      // Check cache first
      const cached = await this.getCachedCost(cacheKey);
      if (cached !== null) {
        logger.debug('On-premise cost cache hit', { ciId, cost: cached });
        return cached;
      }

      // Try to get purchase info from metadata or GL system
      const purchaseInfo = await this.getPurchaseInfo(ciId, metadata);

      let cost: number;

      if (purchaseInfo) {
        // Calculate depreciation
        cost = this.calculateDepreciation(purchaseInfo);
      } else {
        // Estimate based on CI type
        cost = this.estimateCostByCIType(ciType, metadata);
      }

      // Cache the result
      await this.cacheCost(cacheKey, cost);

      logger.info('On-premise cost lookup completed', {
        ciId,
        ciType,
        cost,
        source: purchaseInfo ? 'depreciation' : 'estimate',
      });

      return cost;
    } catch (error) {
      logger.error('Error looking up on-premise cost', {
        ciId,
        ciType,
        error,
      });
      return 0;
    }
  }

  /**
   * Calculate monthly depreciation from purchase info
   *
   * @param purchaseInfo - Purchase information
   * @returns Monthly depreciation amount
   */
  calculateDepreciation(purchaseInfo: PurchaseInfo): number {
    const method = purchaseInfo.depreciation_method || 'straight_line';

    if (method === 'straight_line') {
      // Straight-line depreciation: (Cost - Residual) / Useful Life
      const depreciableAmount = purchaseInfo.purchase_cost - purchaseInfo.residual_value;
      const monthlyDepreciation = depreciableAmount / purchaseInfo.useful_life_months;
      return Math.max(0, monthlyDepreciation);
    } else {
      // Declining balance (simplified - using 150% declining balance)
      const annualRate = 1.5 / (purchaseInfo.useful_life_months / 12);
      const monthlyRate = annualRate / 12;
      const currentValue = this.getCurrentAssetValue(purchaseInfo);
      return Math.max(0, currentValue * monthlyRate);
    }
  }

  /**
   * Get current asset value for declining balance
   */
  private getCurrentAssetValue(purchaseInfo: PurchaseInfo): number {
    const monthsElapsed = this.getMonthsElapsed(purchaseInfo.purchase_date);
    const annualRate = 1.5 / (purchaseInfo.useful_life_months / 12);

    let value = purchaseInfo.purchase_cost;
    for (let i = 0; i < monthsElapsed; i++) {
      value -= value * (annualRate / 12);
      if (value <= purchaseInfo.residual_value) {
        return purchaseInfo.residual_value;
      }
    }

    return Math.max(value, purchaseInfo.residual_value);
  }

  /**
   * Get months elapsed since purchase
   */
  private getMonthsElapsed(purchaseDate: Date): number {
    const now = new Date();
    const months =
      (now.getFullYear() - purchaseDate.getFullYear()) * 12 +
      (now.getMonth() - purchaseDate.getMonth());
    return Math.max(0, months);
  }

  /**
   * Lookup AWS resource cost from PostgreSQL tbm_cost_pools table
   * Falls back to estimation if not found
   */
  private async lookupAWSCost(
    resourceId: string,
    resourceType: string,
    metadata?: Record<string, any>
  ): Promise<number> {
    try {
      // Try to fetch from PostgreSQL tbm_cost_pools (populated by cost sync jobs)
      const pgClient = getPostgresClient();
      const pool = pgClient.pool;

      // Query for resource-specific cost
      const result = await pool.query(
        `
        SELECT monthly_cost, metadata
        FROM tbm_cost_pools
        WHERE source_system = 'aws'
          AND pool_name = $1
          AND fiscal_period = to_char(CURRENT_DATE, 'YYYY-MM')
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [`AWS-Resource-${resourceId}`]
      );

      if (result.rows.length > 0) {
        const cost = parseFloat(result.rows[0].monthly_cost);
        logger.debug('[CostLookupService] Found AWS cost in PostgreSQL', {
          resourceId,
          cost,
          source: 'tbm_cost_pools',
        });
        return cost;
      }

      // If resource-specific cost not found, try service-level cost
      if (metadata?.service) {
        const serviceResult = await pool.query(
          `
          SELECT monthly_cost
          FROM tbm_cost_pools
          WHERE source_system = 'aws'
            AND pool_name = $1
            AND fiscal_period = to_char(CURRENT_DATE, 'YYYY-MM')
          ORDER BY updated_at DESC
          LIMIT 1
          `,
          [`AWS-${metadata.service}`]
        );

        if (serviceResult.rows.length > 0) {
          const serviceCost = parseFloat(serviceResult.rows[0].monthly_cost);
          logger.debug('[CostLookupService] Found AWS service cost in PostgreSQL', {
            service: metadata.service,
            cost: serviceCost,
            source: 'tbm_cost_pools',
          });
          // Return a prorated portion (assuming 10 resources per service as default)
          return serviceCost / 10;
        }
      }

      logger.debug('[CostLookupService] No PostgreSQL cost found, using estimation', {
        resourceId,
        resourceType,
      });

      // Fall back to estimation if not found in PostgreSQL
      if (!metadata) {
        return 0;
      }

      // EC2 instances
      if (resourceType === 'instance' || resourceType === 'virtual-machine') {
        return this.estimateEC2Cost(metadata);
      }

      // EBS volumes
      if (resourceType === 'volume' || resourceType === 'storage') {
        return this.estimateEBSCost(metadata);
      }

      // RDS databases
      if (resourceType === 'database') {
        return this.estimateRDSCost(metadata);
      }

      // S3 buckets
      if (resourceType === 's3-bucket') {
        return this.estimateS3Cost(metadata);
      }

      return 0;
    } catch (error) {
      logger.warn('[CostLookupService] Error querying PostgreSQL for AWS cost, using estimation', {
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fall back to estimation on error
      if (!metadata) {
        return 0;
      }

      if (resourceType === 'instance' || resourceType === 'virtual-machine') {
        return this.estimateEC2Cost(metadata);
      }
      if (resourceType === 'volume' || resourceType === 'storage') {
        return this.estimateEBSCost(metadata);
      }
      if (resourceType === 'database') {
        return this.estimateRDSCost(metadata);
      }
      if (resourceType === 's3-bucket') {
        return this.estimateS3Cost(metadata);
      }

      return 0;
    }
  }

  /**
   * Estimate EC2 instance cost
   */
  private estimateEC2Cost(metadata: Record<string, any>): number {
    const instanceType = metadata.instanceType || 't3.medium';
    const region = metadata.region || 'us-east-1';
    const pricingModel = metadata.pricingModel || 'on-demand';

    // Simplified pricing table (actual prices would come from AWS Pricing API)
    const basePrices: Record<string, number> = {
      't3.micro': 7.5,
      't3.small': 15,
      't3.medium': 30,
      't3.large': 60,
      'm5.large': 70,
      'm5.xlarge': 140,
      'c5.large': 62,
      'r5.large': 92,
    };

    let cost = basePrices[instanceType] || 50; // Default $50/month

    // Adjust for reserved instances
    if (pricingModel === 'reserved') {
      cost *= 0.6; // 40% discount
    } else if (pricingModel === 'spot') {
      cost *= 0.3; // 70% discount
    }

    // Regional adjustments (simplified)
    if (region.startsWith('us-west')) {
      cost *= 1.05;
    } else if (region.startsWith('eu-')) {
      cost *= 1.1;
    } else if (region.startsWith('ap-')) {
      cost *= 1.15;
    }

    return Math.round(cost * 100) / 100;
  }

  /**
   * Estimate EBS volume cost
   */
  private estimateEBSCost(metadata: Record<string, any>): number {
    const sizeGB = metadata.size || metadata.volumeSize || 100;
    const volumeType = metadata.volumeType || 'gp3';

    // Price per GB per month
    const pricePerGB: Record<string, number> = {
      gp3: 0.08,
      gp2: 0.1,
      io1: 0.125,
      io2: 0.125,
      st1: 0.045,
      sc1: 0.025,
    };

    const priceRate = pricePerGB[volumeType] || 0.08;
    return Math.round(sizeGB * priceRate * 100) / 100;
  }

  /**
   * Estimate RDS database cost
   */
  private estimateRDSCost(metadata: Record<string, any>): number {
    const instanceType = metadata.instanceType || metadata.instanceClass || 'db.t3.medium';
    const engine = metadata.engine || 'postgres';
    const multiAZ = metadata.multiAZ || false;

    // Base RDS pricing (simplified)
    let cost = 50; // Default

    if (instanceType.includes('db.t3.small')) {
      cost = 25;
    } else if (instanceType.includes('db.t3.medium')) {
      cost = 50;
    } else if (instanceType.includes('db.t3.large')) {
      cost = 100;
    } else if (instanceType.includes('db.m5.large')) {
      cost = 120;
    }

    // Multi-AZ doubles the cost
    if (multiAZ) {
      cost *= 2;
    }

    // Add storage cost (100GB default)
    const storageGB = metadata.allocatedStorage || 100;
    cost += storageGB * 0.115; // GP2 storage

    return Math.round(cost * 100) / 100;
  }

  /**
   * Estimate S3 bucket cost
   */
  private estimateS3Cost(metadata: Record<string, any>): number {
    const sizeGB = metadata.sizeGB || metadata.totalSize || 0;
    const storageClass = metadata.storageClass || 'STANDARD';

    // S3 pricing per GB per month
    const pricePerGB: Record<string, number> = {
      STANDARD: 0.023,
      INTELLIGENT_TIERING: 0.023,
      STANDARD_IA: 0.0125,
      ONEZONE_IA: 0.01,
      GLACIER: 0.004,
      DEEP_ARCHIVE: 0.00099,
    };

    const priceRate = pricePerGB[storageClass] || 0.023;
    return Math.round(sizeGB * priceRate * 100) / 100;
  }

  /**
   * Lookup Azure resource cost from PostgreSQL tbm_cost_pools table
   * Falls back to estimation if not found
   */
  private async lookupAzureCost(
    resourceId: string,
    resourceType: string,
    metadata?: Record<string, any>
  ): Promise<number> {
    try {
      // Try to fetch from PostgreSQL tbm_cost_pools
      const pgClient = getPostgresClient();
      const pool = pgClient.pool;

      // Query for resource-specific cost
      const result = await pool.query(
        `
        SELECT monthly_cost, metadata
        FROM tbm_cost_pools
        WHERE source_system = 'azure'
          AND pool_name = $1
          AND fiscal_period = to_char(CURRENT_DATE, 'YYYY-MM')
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [`Azure-Resource-${resourceId}`]
      );

      if (result.rows.length > 0) {
        const cost = parseFloat(result.rows[0].monthly_cost);
        logger.debug('[CostLookupService] Found Azure cost in PostgreSQL', {
          resourceId,
          cost,
          source: 'tbm_cost_pools',
        });
        return cost;
      }

      // Try service-level cost
      if (metadata?.service || metadata?.type) {
        const serviceName = metadata.service || metadata.type;
        const serviceResult = await pool.query(
          `
          SELECT monthly_cost
          FROM tbm_cost_pools
          WHERE source_system = 'azure'
            AND pool_name = $1
            AND fiscal_period = to_char(CURRENT_DATE, 'YYYY-MM')
          ORDER BY updated_at DESC
          LIMIT 1
          `,
          [`Azure-${serviceName}`]
        );

        if (serviceResult.rows.length > 0) {
          const serviceCost = parseFloat(serviceResult.rows[0].monthly_cost);
          logger.debug('[CostLookupService] Found Azure service cost in PostgreSQL', {
            service: serviceName,
            cost: serviceCost,
            source: 'tbm_cost_pools',
          });
          return serviceCost / 10; // Prorated
        }
      }

      logger.debug('[CostLookupService] No PostgreSQL cost found for Azure, using estimation', {
        resourceId,
        resourceType,
      });

      // Fall back to estimation
      if (!metadata) {
        return 0;
      }

      // Virtual machines
      if (resourceType === 'virtual-machine') {
        const vmSize = metadata.vmSize || metadata.size || 'Standard_B2s';
        const vmPrices: Record<string, number> = {
          Standard_B1s: 7.5,
          Standard_B2s: 30,
          Standard_D2s_v3: 70,
          Standard_D4s_v3: 140,
        };
        return vmPrices[vmSize] || 50;
      }

      // Storage accounts
      if (resourceType === 'storage') {
        const sizeGB = metadata.size || 100;
        return Math.round(sizeGB * 0.02 * 100) / 100;
      }

      return 0;
    } catch (error) {
      logger.warn('[CostLookupService] Error querying PostgreSQL for Azure cost', {
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Lookup GCP resource cost from PostgreSQL tbm_cost_pools table
   * Falls back to estimation if not found
   */
  private async lookupGCPCost(
    resourceId: string,
    resourceType: string,
    metadata?: Record<string, any>
  ): Promise<number> {
    try {
      // Try to fetch from PostgreSQL tbm_cost_pools
      const pgClient = getPostgresClient();
      const pool = pgClient.pool;

      // Query for resource-specific cost
      const result = await pool.query(
        `
        SELECT monthly_cost, metadata
        FROM tbm_cost_pools
        WHERE source_system = 'gcp'
          AND pool_name = $1
          AND fiscal_period = to_char(CURRENT_DATE, 'YYYY-MM')
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [`GCP-Resource-${resourceId}`]
      );

      if (result.rows.length > 0) {
        const cost = parseFloat(result.rows[0].monthly_cost);
        logger.debug('[CostLookupService] Found GCP cost in PostgreSQL', {
          resourceId,
          cost,
          source: 'tbm_cost_pools',
        });
        return cost;
      }

      // Try SKU-level cost
      if (metadata?.skuId) {
        const skuResult = await pool.query(
          `
          SELECT monthly_cost
          FROM tbm_cost_pools
          WHERE source_system = 'gcp'
            AND pool_name = $1
            AND fiscal_period = to_char(CURRENT_DATE, 'YYYY-MM')
          ORDER BY updated_at DESC
          LIMIT 1
          `,
          [`GCP-SKU-${metadata.skuId}`]
        );

        if (skuResult.rows.length > 0) {
          const skuCost = parseFloat(skuResult.rows[0].monthly_cost);
          logger.debug('[CostLookupService] Found GCP SKU cost in PostgreSQL', {
            skuId: metadata.skuId,
            cost: skuCost,
            source: 'tbm_cost_pools',
          });
          return skuCost;
        }
      }

      // Try service-level cost
      if (metadata?.service) {
        const serviceResult = await pool.query(
          `
          SELECT monthly_cost
          FROM tbm_cost_pools
          WHERE source_system = 'gcp'
            AND pool_name = $1
            AND fiscal_period = to_char(CURRENT_DATE, 'YYYY-MM')
          ORDER BY updated_at DESC
          LIMIT 1
          `,
          [`GCP-${metadata.service}`]
        );

        if (serviceResult.rows.length > 0) {
          const serviceCost = parseFloat(serviceResult.rows[0].monthly_cost);
          logger.debug('[CostLookupService] Found GCP service cost in PostgreSQL', {
            service: metadata.service,
            cost: serviceCost,
            source: 'tbm_cost_pools',
          });
          return serviceCost / 10; // Prorated
        }
      }

      logger.debug('[CostLookupService] No PostgreSQL cost found for GCP, using estimation', {
        resourceId,
        resourceType,
      });

      // Fall back to estimation
      if (!metadata) {
        return 0;
      }

      // Compute instances
      if (resourceType === 'instance' || resourceType === 'virtual-machine') {
        const machineType = metadata.machineType || 'n1-standard-1';
        const machinePrices: Record<string, number> = {
          'f1-micro': 5,
          'g1-small': 18,
          'n1-standard-1': 25,
          'n1-standard-2': 50,
          'n1-standard-4': 100,
        };
        return machinePrices[machineType] || 40;
      }

      // Persistent disks
      if (resourceType === 'disk' || resourceType === 'storage') {
        const sizeGB = metadata.sizeGb || 100;
        const diskType = metadata.diskType || 'pd-standard';
        const pricePerGB = diskType === 'pd-ssd' ? 0.17 : 0.04;
        return Math.round(sizeGB * pricePerGB * 100) / 100;
      }

      return 0;
    } catch (error) {
      logger.warn('[CostLookupService] Error querying PostgreSQL for GCP cost', {
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Get purchase info from GL or metadata
   */
  private async getPurchaseInfo(
    ciId: string,
    metadata?: Record<string, any>
  ): Promise<PurchaseInfo | null> {
    // Check metadata first
    if (metadata?.purchase_info) {
      return metadata.purchase_info as PurchaseInfo;
    }

    // In production, query GL system or asset database
    // For now, return null to trigger estimation
    return null;
  }

  /**
   * Estimate cost based on CI type (fallback)
   */
  private estimateCostByCIType(ciType: CIType, metadata?: Record<string, any>): number {
    // Default cost estimates for common CI types
    const defaultCosts: Record<CIType, number> = {
      server: 150,              // Physical server monthly depreciation
      'virtual-machine': 50,    // VM monthly cost
      container: 10,            // Container monthly cost
      application: 100,         // Application monthly cost (licenses + maintenance)
      service: 50,              // Service monthly cost
      database: 100,            // Database monthly cost
      'network-device': 200,    // Network device monthly depreciation
      storage: 50,              // Storage monthly cost
      'load-balancer': 100,     // Load balancer monthly cost
      'cloud-resource': 50,     // Generic cloud resource
      software: 50,             // Software license monthly cost
      facility: 0,              // Facility costs handled separately
      documentation: 0,         // No direct cost
    };

    return defaultCosts[ciType] || 0;
  }

  /**
   * Get cost from cache
   */
  private async getCachedCost(key: string): Promise<number | null> {
    try {
      const cached = await this.redisClient.get(key);
      if (cached) {
        return parseFloat(cached);
      }
    } catch (error) {
      logger.warn('Error reading from cache', { key, error });
    }
    return null;
  }

  /**
   * Cache cost value
   */
  private async cacheCost(key: string, cost: number): Promise<void> {
    try {
      await this.redisClient.setex(key, this.CACHE_TTL, cost.toString());
    } catch (error) {
      logger.warn('Error writing to cache', { key, error });
    }
  }

  /**
   * Resolve a (possibly wildcarded) key pattern to concrete keys and delete them.
   * ioredis' DEL only accepts literal keys, not glob patterns, so wildcard
   * patterns must be resolved via KEYS (or SCAN) first.
   */
  private async deleteKeysMatching(pattern: string): Promise<number> {
    const matchedKeys = await this.redisClient.keys(pattern);
    if (matchedKeys.length === 0) {
      return 0;
    }
    await this.redisClient.del(...matchedKeys);
    return matchedKeys.length;
  }

  /**
   * Clear cost cache for a specific CI
   */
  async clearCostCache(ciId: string): Promise<void> {
    try {
      const patterns = [
        `tbm:cost:cloud:*:${ciId}`,
        `tbm:cost:onprem:${ciId}`,
      ];

      let deletedCount = 0;
      for (const pattern of patterns) {
        deletedCount += await this.deleteKeysMatching(pattern);
      }

      logger.info('Cost cache cleared', { ciId, deletedCount });
    } catch (error) {
      logger.error('Error clearing cost cache', { ciId, error });
    }
  }

  /**
   * Clear all cost cache entries (cloud and on-premise), across every CI.
   * Useful when cost data is refreshed in bulk.
   */
  async clearAllCostCache(): Promise<void> {
    try {
      const deletedCount = await this.deleteKeysMatching('tbm:cost:*');
      logger.info('All cost caches cleared', { deletedCount });
    } catch (error) {
      logger.error('Error clearing all cost caches', { error });
    }
  }
}
