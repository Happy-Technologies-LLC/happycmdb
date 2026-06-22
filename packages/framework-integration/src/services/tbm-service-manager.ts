// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * TBM Service Manager Wrapper
 * Wraps Phase 3 TBM v5.0.1 functionality for unified interface
 */

import {
  CostAllocationService,
  PoolAggregationService,
  TowerMappingService,
  TBMResourceTower,
  TBMCostPool,
  CostAllocationResult,
  CostTrendData
} from '@cmdb/tbm-cost-engine';
import { BusinessServiceRepository } from '@cmdb/itil-service-manager';
import { getPostgresClient, getNeo4jClient } from '@cmdb/database';
import { TBMCosts } from '../types/kpi-types';
import { CostEstimate } from '../types/unified-types';
import { ChangeRequest } from '@cmdb/itil-service-manager';

/**
 * TBM Service Manager
 * Provides TBM cost metrics and operations for unified interface
 */
export class TBMServiceManager {
  private costAllocationService: CostAllocationService;
  private poolAggregationService: PoolAggregationService;
  private towerMappingService: TowerMappingService;
  private businessServiceRepo: BusinessServiceRepository;

  constructor() {
    const pgClient = getPostgresClient();

    this.costAllocationService = CostAllocationService.getInstance();
    this.poolAggregationService = PoolAggregationService.getInstance();
    this.towerMappingService = TowerMappingService.getInstance();
    this.businessServiceRepo = new BusinessServiceRepository(pgClient);
  }

  /**
   * Get comprehensive TBM cost metrics for a service
   *
   * @param serviceId - Business service ID
   * @returns TBM cost metrics including towers, pools, trends
   */
  async getServiceCosts(serviceId: string): Promise<TBMCosts> {
    try {
      // Fetch business service
      const businessService = await this.businessServiceRepo.getBusinessServiceById(serviceId);
      if (!businessService) {
        throw new Error(`Business service not found: ${serviceId}`);
      }

      // Get cost aggregation
      const costAggregation = await this.poolAggregationService.aggregateCostsByService(
        serviceId,
        'business_service'
      );

      // Get cost trends
      const costTrends = await this.getCostTrends(serviceId, 12); // 12 months

      // Build cost by tower map
      const costByTower = new Map<TBMResourceTower, number>();
      Object.entries(costAggregation.costByTower).forEach(([tower, cost]) => {
        costByTower.set(tower as TBMResourceTower, cost);
      });

      // Build cost by pool map
      const costByPool = new Map<TBMCostPool, number>();
      Object.entries(costAggregation.costByPool).forEach(([pool, cost]) => {
        costByPool.set(pool as TBMCostPool, cost);
      });

      // Get budget info (from TBM attributes)
      const budgetedCost = businessService.tbm_attributes.monthly_it_cost_allocated || 0;
      const budgetVariance = budgetedCost - costAggregation.totalMonthlyCost;

      // Calculate allocation percentage
      const totalCost = costAggregation.totalMonthlyCost;
      const allocatedCost = costAggregation.contributingCIs.reduce(
        (sum, ci) => sum + ci.cost,
        0
      );
      const allocationPercentage = totalCost > 0 ? (allocatedCost / totalCost) * 100 : 0;

      // Get top cost drivers
      const topCostDrivers = costAggregation.contributingCIs
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10)
        .map(ci => ({
          ciId: ci.ciId,
          ciName: ci.ciName,
          cost: ci.cost,
          percentage: ci.percentage
        }));

      // Calculate cost changes
      const { yoyChange, momChange } = this.calculateCostChanges(costTrends);

      return {
        monthlyCost: costAggregation.totalMonthlyCost,
        costByTower,
        costByPool,
        costTrend: costTrends.trend,
        budgetVariance,
        allocationPercentage,
        topCostDrivers,
        yoyChange,
        momChange
      };
    } catch (error) {
      throw new Error(`Failed to get TBM costs for service ${serviceId}: ${error.message}`);
    }
  }

  /**
   * Calculate downtime cost for a CI or service
   *
   * @param ciId - CI or service ID
   * @param downtimeHours - Duration of downtime in hours
   * @returns Downtime cost in dollars
   */
  async calculateDowntimeCost(ciId: string, downtimeHours: number): Promise<number> {
    try {
      // Get business services supported by this CI
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();

      try {
        const result = await session.run(
          `
          MATCH (ci:CI {_id: $ciId})
          MATCH (ci)-[:SUPPORTS*1..3]->(bs:BusinessService)
          RETURN DISTINCT bs._id as serviceId, bs.name as serviceName
          `,
          { ciId }
        );

        const businessServices = result.records.map(record => ({
          serviceId: record.get('serviceId'),
          serviceName: record.get('serviceName')
        }));

        // Calculate total revenue impact
        let totalRevenueImpact = 0;
        for (const bs of businessServices) {
          const service = await this.businessServiceRepo.getBusinessServiceById(bs.serviceId);
          if (service) {
            const annualRevenue = service.bsm_attributes.annual_revenue_supported;
            const revenuePerHour = annualRevenue / 8760; // 365 days * 24 hours
            totalRevenueImpact += revenuePerHour * downtimeHours;
          }
        }

        // Apply criticality multiplier (higher criticality = higher cost)
        // This accounts for reputation damage, customer churn, SLA penalties
        const criticalityMultiplier = this.getCriticalityMultiplier(businessServices.length);
        const downtimeCost = totalRevenueImpact * criticalityMultiplier;

        return downtimeCost;
      } finally {
        await session.close();
      }
    } catch (error) {
      throw new Error(`Failed to calculate downtime cost: ${error.message}`);
    }
  }

  /**
   * Estimate cost for a change request
   *
   * @param change - Change request data
   * @returns Cost estimate with breakdown
   */
  async estimateChangeCost(change: ChangeRequest): Promise<CostEstimate> {
    try {
      // Estimate labor cost based on change type and complexity
      const laborCost = this.estimateLaborCost(change);

      // Estimate downtime
      const estimatedDowntimeMinutes = this.estimateDowntime(change);

      // Calculate downtime cost
      const downtimeCostPerHour = await this.calculateDowntimeCost(
        change.affectedCIIds[0],
        1 // per hour
      );
      const downtimeCost = (downtimeCostPerHour * estimatedDowntimeMinutes) / 60;

      // Estimate rollback cost (30% of implementation cost)
      const rollbackCost = laborCost * 0.3;

      // Estimate testing cost (20% of implementation cost)
      const testingCost = laborCost * 0.2;

      // Total cost
      const totalCost = laborCost + downtimeCost + rollbackCost + testingCost;

      // Get cost breakdown by tower
      const costByTower: Record<string, number> = {
        [TBMResourceTower.COMPUTE]: laborCost * 0.4,
        [TBMResourceTower.NETWORK]: laborCost * 0.2,
        [TBMResourceTower.APPLICATIONS]: laborCost * 0.3,
        [TBMResourceTower.SECURITY]: laborCost * 0.1
      };

      // Risk-adjusted cost (add 20% for uncertainty)
      const riskAdjustedCost = totalCost * 1.2;

      // Budget impact (placeholder - would query actual budgets)
      const budgetImpact = {
        currentBudgetUtilization: 75, // 75% utilized
        projectedUtilization: 75 + (totalCost / 100000) * 5, // Estimate impact
        budgetAvailable: true
      };

      // Confidence level based on change type
      const confidence = this.getEstimateConfidence(change.changeType);

      return {
        laborCost,
        estimatedDowntimeMinutes,
        downtimeCost,
        rollbackCost,
        testingCost,
        totalCost,
        costByTower,
        riskAdjustedCost,
        budgetImpact,
        confidence,
        assumptions: [
          'Labor cost based on average engineer hourly rate',
          'Downtime estimation based on change type and complexity',
          'Rollback cost estimated at 30% of implementation',
          'Testing cost estimated at 20% of implementation',
          'Risk adjustment factor of 20% applied'
        ]
      };
    } catch (error) {
      throw new Error(`Failed to estimate change cost: ${error.message}`);
    }
  }

  /**
   * Get cost trends over time
   *
   * @param serviceId - Service ID
   * @param months - Number of months to retrieve
   * @returns Cost trend data
   * @private
   */
  private async getCostTrends(serviceId: string, months: number): Promise<CostTrendData> {
    try {
      // In a real implementation, this would query historical cost data
      // For now, return mock trend data
      const monthlyData = [];
      const currentCost = 50000; // Placeholder

      for (let i = months - 1; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const month = date.toISOString().substring(0, 7);

        // Simulate some variance
        const variance = (Math.random() - 0.5) * 5000;
        const cost = currentCost + variance;
        const change = i < months - 1 ? cost - monthlyData[monthlyData.length - 1].cost : 0;
        const changePercentage = i < months - 1
          ? (change / monthlyData[monthlyData.length - 1].cost) * 100
          : 0;

        monthlyData.push({
          month,
          cost,
          change,
          changePercentage
        });
      }

      // Determine trend
      const firstHalfAvg = monthlyData.slice(0, Math.floor(months / 2))
        .reduce((sum, m) => sum + m.cost, 0) / Math.floor(months / 2);
      const secondHalfAvg = monthlyData.slice(Math.floor(months / 2))
        .reduce((sum, m) => sum + m.cost, 0) / Math.ceil(months / 2);

      const trend = secondHalfAvg > firstHalfAvg * 1.1 ? 'increasing' :
                    secondHalfAvg < firstHalfAvg * 0.9 ? 'decreasing' : 'stable';

      const averageMonthlyCost = monthlyData.reduce((sum, m) => sum + m.cost, 0) / months;

      return {
        entityId: serviceId,
        entityType: 'business_service',
        monthlyData,
        trend,
        averageMonthlyCost
      };
    } catch (error) {
      throw new Error(`Failed to get cost trends: ${error.message}`);
    }
  }

  /**
   * Calculate year-over-year and month-over-month cost changes
   *
   * @param costTrends - Cost trend data
   * @returns YoY and MoM changes
   * @private
   */
  private calculateCostChanges(costTrends: CostTrendData): {
    yoyChange: number;
    momChange: number;
  } {
    const monthlyData = costTrends.monthlyData;

    if (monthlyData.length < 2) {
      return { yoyChange: 0, momChange: 0 };
    }

    // Month-over-month: compare last 2 months
    const lastMonth = monthlyData[monthlyData.length - 1];
    const previousMonth = monthlyData[monthlyData.length - 2];
    const momChange = ((lastMonth.cost - previousMonth.cost) / previousMonth.cost) * 100;

    // Year-over-year: compare with 12 months ago if available
    let yoyChange = 0;
    if (monthlyData.length >= 12) {
      const yearAgo = monthlyData[monthlyData.length - 12];
      yoyChange = ((lastMonth.cost - yearAgo.cost) / yearAgo.cost) * 100;
    }

    return { yoyChange, momChange };
  }

  /**
   * Get criticality multiplier for downtime cost
   *
   * @param serviceCount - Number of business services affected
   * @returns Multiplier (1.0 - 3.0)
   * @private
   */
  private getCriticalityMultiplier(serviceCount: number): number {
    if (serviceCount === 0) return 1.0;
    if (serviceCount === 1) return 1.5;
    if (serviceCount <= 3) return 2.0;
    return 3.0; // Many services affected
  }

  /**
   * Estimate labor cost for change
   *
   * @param change - Change request
   * @returns Labor cost in dollars
   * @private
   */
  private estimateLaborCost(change: ChangeRequest): number {
    const hourlyRate = 150; // Average engineer hourly rate
    let estimatedHours = 0;

    switch (change.changeType) {
      case 'standard':
        estimatedHours = 2;
        break;
      case 'normal':
        estimatedHours = 8;
        break;
      case 'emergency':
        estimatedHours = 4;
        break;
      case 'major':
        estimatedHours = 40;
        break;
    }

    // Factor in number of affected CIs
    const complexityMultiplier = 1 + (change.affectedCIIds.length - 1) * 0.2;
    estimatedHours *= complexityMultiplier;

    return estimatedHours * hourlyRate;
  }

  /**
   * Estimate downtime for change
   *
   * @param change - Change request
   * @returns Downtime in minutes
   * @private
   */
  private estimateDowntime(change: ChangeRequest): number {
    switch (change.changeType) {
      case 'standard':
        return 15;
      case 'normal':
        return 60;
      case 'emergency':
        return 30;
      case 'major':
        return 240;
      default:
        return 60;
    }
  }

  /**
   * Get cost estimate confidence level
   *
   * @param changeType - Type of change
   * @returns Confidence level
   * @private
   */
  private getEstimateConfidence(changeType: string): 'high' | 'medium' | 'low' {
    switch (changeType) {
      case 'standard':
        return 'high'; // Well-understood, repeatable
      case 'normal':
        return 'medium';
      case 'emergency':
        return 'low'; // High uncertainty
      case 'major':
        return 'medium';
      default:
        return 'medium';
    }
  }
}
