// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * TBM Enricher
 * Enriches discovered CIs with TBM (Technology Business Management) cost attributes
 */

import { TBMCIAttributes } from '@cmdb/unified-model';
import { TowerMapper } from '../utils/tower-mapper';
import { AllocationMethodSelector } from '../utils/allocation-method-selector';
import { CostLookupService } from '../services/cost-lookup.service';
import { logger } from '@cmdb/common';

/**
 * Partial CI interface for enrichment
 * Matches the structure of discovered CIs
 */
interface CIForEnrichment {
  _id?: string;
  id?: string;
  name?: string;
  _type?: string;
  type?: string;
  status?: string;
  environment?: string;
  metadata?: Record<string, any>;
  discovery_provider?: string;
  tbm_attributes?: Partial<TBMCIAttributes>;
}

export class TBMEnricher {
  private towerMapper: TowerMapper;
  private allocationMethodSelector: AllocationMethodSelector;
  private costLookupService: CostLookupService;

  constructor() {
    this.towerMapper = new TowerMapper();
    this.allocationMethodSelector = new AllocationMethodSelector();
    this.costLookupService = new CostLookupService();
  }

  /**
   * Enrich discovered CIs with TBM attributes
   *
   * Sets:
   * - resource_tower (mapped from CI type)
   * - sub_tower (refined from metadata)
   * - cost_pool (determined by tower)
   * - monthly_cost (looked up from cloud providers or GL)
   * - cost_allocation_method (determined by resource characteristics)
   * - depreciation_schedule (for on-premise assets)
   *
   * @param cis - Array of discovered CIs to enrich
   * @returns Array of enriched CIs with TBM attributes
   */
  async enrichWithTBM<T extends CIForEnrichment>(cis: T[]): Promise<T[]> {
    logger.info(`Enriching ${cis.length} CIs with TBM attributes`);

    const startTime = Date.now();

    // Process CIs in batches for performance
    const batchSize = 100;
    const enrichedCIs: T[] = [];

    for (let i = 0; i < cis.length; i += batchSize) {
      const batch = cis.slice(i, i + batchSize);
      const enrichedBatch = await Promise.all(
        batch.map((ci) => this.enrichSingleCI(ci))
      );
      enrichedCIs.push(...enrichedBatch);

      logger.debug(`Enriched batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(cis.length / batchSize)}`, {
        batchSize: batch.length,
      });
    }

    const duration = Date.now() - startTime;
    const avgTimePerCI = duration / cis.length;

    logger.info(
      `Successfully enriched ${enrichedCIs.length} CIs with TBM attributes`,
      {
        totalDuration: `${duration}ms`,
        avgTimePerCI: `${avgTimePerCI.toFixed(2)}ms`,
      }
    );

    return enrichedCIs;
  }

  /**
   * Enrich a single CI with TBM attributes
   * @param ci - The CI to enrich
   * @returns The enriched CI
   */
  private async enrichSingleCI<T extends CIForEnrichment>(ci: T): Promise<T> {
    const ciType = (ci._type || ci.type) as any;
    const ciId = ci._id || ci.id || 'unknown';
    const metadata = ci.metadata || {};
    const discoveryProvider = ci.discovery_provider || 'unknown';

    try {
      // 1. Map to TBM resource tower
      const towerMapping = this.towerMapper.mapCIToTower(ciType, metadata);

      // 2. Lookup actual cost
      const monthlyCost = await this.lookupCost(
        ciId,
        ciType,
        discoveryProvider,
        metadata
      );

      // 3. Determine allocation method
      const allocationMethod = this.allocationMethodSelector.determineAllocationMethod(
        { type: ciType, environment: ci.environment as any, metadata },
        towerMapping.tower
      );

      // 4. Get depreciation schedule (if applicable)
      const depreciationSchedule = this.getDepreciationSchedule(metadata);

      // Build TBM attributes
      const tbmAttributes: TBMCIAttributes = {
        resource_tower: towerMapping.tower,
        sub_tower: towerMapping.subTower,
        cost_pool: towerMapping.costPool,
        monthly_cost: monthlyCost,
        cost_allocation_method: allocationMethod,
        depreciation_schedule: depreciationSchedule,
      };

      logger.debug('Enriched CI with TBM attributes', {
        ciId: ciId,
        ciName: ci.name,
        ciType: ciType,
        tower: towerMapping.tower,
        subTower: towerMapping.subTower,
        costPool: towerMapping.costPool,
        monthlyCost: monthlyCost,
        allocationMethod: allocationMethod,
      });

      // Return enriched CI with TBM attributes
      return {
        ...ci,
        tbm_attributes: tbmAttributes,
      };
    } catch (error) {
      logger.error('Error enriching CI with TBM attributes', {
        ciId: ciId,
        ciName: ci.name,
        ciType: ciType,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return CI with default TBM attributes on error
      return {
        ...ci,
        tbm_attributes: this.getDefaultTBMAttributes(ciType),
      };
    }
  }

  /**
   * Lookup cost for a CI
   */
  private async lookupCost(
    ciId: string,
    ciType: any,
    discoveryProvider: string,
    metadata: Record<string, any>
  ): Promise<number> {
    try {
      // Determine if cloud or on-premise
      const isCloudResource = this.isCloudResource(discoveryProvider, metadata);

      if (isCloudResource) {
        // Lookup cloud resource cost
        const provider = this.getCloudProvider(discoveryProvider, metadata);
        const resourceId = metadata.resourceId || metadata.arn || metadata.id || ciId;
        const resourceType = metadata.resourceType || ciType;

        if (provider) {
          return await this.costLookupService.lookupCloudResourceCost(
            provider,
            resourceId,
            resourceType,
            metadata
          );
        }
      }

      // Lookup on-premise cost
      return await this.costLookupService.lookupOnPremiseCost(
        ciId,
        ciType,
        metadata
      );
    } catch (error) {
      logger.warn('Error looking up cost, using default', {
        ciId,
        error,
      });
      return 0;
    }
  }

  /**
   * Check if CI is a cloud resource
   */
  private isCloudResource(discoveryProvider: string, metadata: Record<string, any>): boolean {
    // Check discovery provider
    const cloudProviders = ['aws', 'azure', 'gcp', 'alibaba', 'oracle-cloud'];
    if (cloudProviders.includes(discoveryProvider.toLowerCase())) {
      return true;
    }

    // Check metadata
    if (metadata.cloudProvider || metadata.provider) {
      return true;
    }

    // Check for cloud-specific identifiers
    if (metadata.arn || metadata.resourceId || metadata.subscriptionId) {
      return true;
    }

    return false;
  }

  /**
   * Get cloud provider from discovery provider or metadata
   */
  private getCloudProvider(
    discoveryProvider: string,
    metadata: Record<string, any>
  ): 'aws' | 'azure' | 'gcp' | null {
    // Map discovery provider
    const provider = discoveryProvider.toLowerCase();
    if (provider.includes('aws')) return 'aws';
    if (provider.includes('azure')) return 'azure';
    if (provider.includes('gcp') || provider.includes('google')) return 'gcp';

    // Check metadata
    const metadataProvider = (metadata.cloudProvider || metadata.provider || '').toLowerCase();
    if (metadataProvider.includes('aws')) return 'aws';
    if (metadataProvider.includes('azure')) return 'azure';
    if (metadataProvider.includes('gcp') || metadataProvider.includes('google')) return 'gcp';

    // Check for provider-specific fields
    if (metadata.arn) return 'aws';
    if (metadata.subscriptionId || metadata.resourceGroup) return 'azure';
    if (metadata.projectId && metadata.zone) return 'gcp';

    return null;
  }

  /**
   * Get depreciation schedule from metadata
   */
  private getDepreciationSchedule(metadata: Record<string, any>): any {
    if (!metadata.purchase_info) {
      return undefined;
    }

    const purchaseInfo = metadata.purchase_info;

    return {
      purchase_date: new Date(purchaseInfo.purchase_date),
      purchase_cost: purchaseInfo.purchase_cost,
      useful_life_months: purchaseInfo.useful_life_months || 60, // Default 5 years
      residual_value: purchaseInfo.residual_value || 0,
      depreciation_method: purchaseInfo.depreciation_method || 'straight_line',
    };
  }

  /**
   * Get default TBM attributes (fallback)
   */
  private getDefaultTBMAttributes(ciType: any): TBMCIAttributes {
    const towerMapping = this.towerMapper.mapCIToTower(ciType, {});

    return {
      resource_tower: towerMapping.tower,
      sub_tower: towerMapping.subTower,
      cost_pool: towerMapping.costPool,
      monthly_cost: 0,
      cost_allocation_method: 'usage_based',
    };
  }

  /**
   * Get enrichment statistics for monitoring
   * @returns Object with enrichment stats
   */
  getEnrichmentStats() {
    return {
      towerMapper: this.towerMapper.getTowerMappingStats(),
      allocationMethods: this.allocationMethodSelector.getAllocationStats(),
      costSources: {
        cloud: ['AWS Cost Explorer', 'Azure Cost Management', 'GCP Cloud Billing'],
        onPremise: ['General Ledger', 'Asset Database', 'Depreciation Calculation'],
      },
      cacheSettings: {
        ttl: '24 hours',
        provider: 'Redis',
      },
    };
  }

  /**
   * Clear cost cache for all CIs
   * Useful when cost data is refreshed
   */
  async clearAllCostCache(): Promise<void> {
    logger.info('Clearing all cost caches');
    await this.costLookupService.clearAllCostCache();
  }
}
