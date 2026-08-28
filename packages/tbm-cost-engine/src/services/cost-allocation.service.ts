// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Allocation Service
 * Implements TBM v5.0.1 cost allocation methods
 */

import {
  CostAllocationMethod,
  AllocationTarget,
  CostAllocationResult
} from '../types/tbm-types';
import {
  DirectCostItem,
  UsageBasedParams,
  EqualSplitParams,
  CostValidationResult
} from '../types/cost-types';
import { calculateDirectCosts } from '../calculators/direct-cost-calculator';
import { calculateUsageBasedAllocation } from '../calculators/usage-based-calculator';
import { calculateEqualSplit } from '../calculators/equal-split-calculator';
import { getTowerMappingService } from './tower-mapping.service';

/**
 * Cost Allocation Service
 * Singleton service for allocating CI costs to consumers
 */
export class CostAllocationService {
  private static instance: CostAllocationService;
  private towerMappingService = getTowerMappingService();

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): CostAllocationService {
    if (!CostAllocationService.instance) {
      CostAllocationService.instance = new CostAllocationService();
    }
    return CostAllocationService.instance;
  }

  /**
   * Allocate CI costs using direct allocation method
   *
   * @param ciId - Configuration Item ID
   * @param ciName - CI name
   * @param ciType - CI type
   * @param directCosts - Direct cost items
   * @param targets - Allocation targets (consumers)
   * @returns Cost allocation result
   *
   * @example
   * ```typescript
   * const result = service.allocateDirectCosts(
   *   'ci-001',
   *   'Production Server',
   *   'server',
   *   [{ ciId: 'ci-001', costType: 'purchase', amount: 36000, frequency: 'one_time', startDate: new Date() }],
   *   [{ targetId: 'app-001', targetType: 'application_service', targetName: 'E-commerce', allocatedAmount: 1000, allocationBasis: 'direct', allocationPercentage: 100 }]
   * );
   * ```
   */
  public allocateDirectCosts(
    ciId: string,
    ciName: string,
    ciType: string,
    directCosts: DirectCostItem[],
    targets: AllocationTarget[]
  ): CostAllocationResult {
    // Calculate total monthly cost
    const costResult = calculateDirectCosts(ciId, directCosts);
    const monthlyCost = costResult.totalMonthlyCost;

    // Get tower mapping
    const towerMapping = this.towerMappingService.mapCIToTower(ciId, ciType);

    // Calculate allocated and unallocated costs
    const totalAllocated = targets.reduce((sum, t) => sum + t.allocatedAmount, 0);
    const unallocatedCost = Math.max(0, monthlyCost - totalAllocated);

    return {
      ciId,
      ciName,
      tower: towerMapping.tower,
      subTower: towerMapping.subTower,
      costPool: towerMapping.costPool,
      monthlyCost,
      allocationMethod: CostAllocationMethod.DIRECT,
      allocatedTo: targets,
      unallocatedCost,
      timestamp: new Date()
    };
  }

  /**
   * Allocate CI costs using usage-based allocation
   *
   * @param ciId - Configuration Item ID
   * @param ciName - CI name
   * @param ciType - CI type
   * @param totalCost - Total monthly cost
   * @param usageMetrics - Usage metrics for allocation
   * @returns Cost allocation result
   *
   * @example
   * ```typescript
   * const result = service.allocateUsageBasedCosts(
   *   'ci-001',
   *   'Shared Database',
   *   'database',
   *   3000,
   *   [
   *     { ciId: 'app-001', metricType: 'cpu_hours', value: 600 },
   *     { ciId: 'app-002', metricType: 'cpu_hours', value: 300 },
   *     { ciId: 'app-003', metricType: 'cpu_hours', value: 100 }
   *   ]
   * );
   * ```
   */
  public allocateUsageBasedCosts(
    ciId: string,
    ciName: string,
    ciType: string,
    totalCost: number,
    usageMetrics: Array<{ consumerId: string; metricType: string; value: number }>
  ): CostAllocationResult {
    // Get tower mapping
    const towerMapping = this.towerMappingService.mapCIToTower(ciId, ciType);

    // Calculate total usage
    const totalUsage = usageMetrics.reduce((sum, m) => sum + m.value, 0);
    const unitCost = totalUsage > 0 ? totalCost / totalUsage : 0;

    // Build consumer usage map
    const consumerUsage = new Map<string, number>();
    for (const metric of usageMetrics) {
      consumerUsage.set(metric.consumerId, metric.value);
    }

    // Calculate allocation
    const params: UsageBasedParams = {
      ciId,
      unitCost,
      usageMetric: 'cpu_hours', // Default, should be passed as parameter
      totalUsage,
      consumerUsage
    };

    const allocationResult = calculateUsageBasedAllocation(params);

    // Convert to allocation targets
    const allocatedTo: AllocationTarget[] = allocationResult.allocations.map(a => ({
      targetId: a.consumerId,
      targetType: 'application_service', // Should be determined from consumer type
      targetName: a.consumerId, // Should be looked up
      allocatedAmount: a.allocatedCost,
      allocationBasis: `${a.usage} ${params.usageMetric}`,
      allocationPercentage: a.usagePercentage
    }));

    // Calculate allocated and unallocated costs
    const totalAllocated = allocatedTo.reduce((sum, t) => sum + t.allocatedAmount, 0);
    const unallocatedCost = Math.max(0, totalCost - totalAllocated);

    return {
      ciId,
      ciName,
      tower: towerMapping.tower,
      subTower: towerMapping.subTower,
      costPool: towerMapping.costPool,
      monthlyCost: totalCost,
      allocationMethod: CostAllocationMethod.USAGE_BASED,
      allocatedTo,
      unallocatedCost,
      timestamp: new Date()
    };
  }

  /**
   * Allocate CI costs using equal split allocation
   *
   * @param ciId - Configuration Item ID
   * @param ciName - CI name
   * @param ciType - CI type
   * @param totalCost - Total monthly cost
   * @param consumers - Array of consumer IDs
   * @returns Cost allocation result
   *
   * @example
   * ```typescript
   * const result = service.allocateEqualSplit(
   *   'ci-001',
   *   'Shared Network Device',
   *   'network-device',
   *   1500,
   *   ['app-001', 'app-002', 'app-003']
   * );
   * ```
   */
  public allocateEqualSplit(
    ciId: string,
    ciName: string,
    ciType: string,
    totalCost: number,
    consumers: string[]
  ): CostAllocationResult {
    // Get tower mapping
    const towerMapping = this.towerMappingService.mapCIToTower(ciId, ciType);

    // Calculate equal split
    const params: EqualSplitParams = {
      ciId,
      totalCost,
      consumers
    };

    const splitResult = calculateEqualSplit(params);

    // Convert to allocation targets
    const allocatedTo: AllocationTarget[] = splitResult.allocations.map(a => ({
      targetId: a.consumerId,
      targetType: 'application_service',
      targetName: a.consumerId,
      allocatedAmount: a.allocatedCost,
      allocationBasis: 'Equal split',
      allocationPercentage: a.percentage
    }));

    // Calculate allocated and unallocated costs
    const totalAllocated = allocatedTo.reduce((sum, t) => sum + t.allocatedAmount, 0);
    const unallocatedCost = Math.max(0, totalCost - totalAllocated);

    return {
      ciId,
      ciName,
      tower: towerMapping.tower,
      subTower: towerMapping.subTower,
      costPool: towerMapping.costPool,
      monthlyCost: totalCost,
      allocationMethod: CostAllocationMethod.EQUAL_SPLIT,
      allocatedTo,
      unallocatedCost,
      timestamp: new Date()
    };
  }

  /**
   * Validate cost allocation
   *
   * @param allocation - Cost allocation result
   * @returns Validation result
   */
  public validateAllocation(allocation: CostAllocationResult): CostValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if total allocated matches monthly cost
    const totalAllocated = allocation.allocatedTo.reduce((sum, t) => sum + t.allocatedAmount, 0);
    const expectedTotal = allocation.monthlyCost - allocation.unallocatedCost;

    if (Math.abs(totalAllocated - expectedTotal) > 0.01) {
      errors.push(
        `Total allocated (${totalAllocated}) does not match expected (${expectedTotal})`
      );
    }

    // Check for negative allocations
    for (const target of allocation.allocatedTo) {
      if (target.allocatedAmount < 0) {
        errors.push(`Negative allocation to ${target.targetId}: ${target.allocatedAmount}`);
      }
    }

    // Warn if unallocated cost is high
    const unallocatedPercentage = (allocation.unallocatedCost / allocation.monthlyCost) * 100;
    if (unallocatedPercentage > 10) {
      warnings.push(
        `High unallocated cost: ${allocation.unallocatedCost} (${unallocatedPercentage.toFixed(2)}%)`
      );
    }

    // Warn if no allocations
    if (allocation.allocatedTo.length === 0) {
      warnings.push('No allocations defined for this CI');
    }

    const allocationPercentage = (totalAllocated / allocation.monthlyCost) * 100;

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      totalCost: allocation.monthlyCost,
      allocatedCost: totalAllocated,
      unallocatedCost: allocation.unallocatedCost,
      allocationPercentage: this.roundToDecimal(allocationPercentage, 2)
    };
  }

  /**
   * Get allocation summary by method
   *
   * @param allocations - Array of allocation results
   * @returns Summary statistics
   */
  public getAllocationSummary(allocations: CostAllocationResult[]): {
    totalCost: number;
    totalAllocated: number;
    totalUnallocated: number;
    byMethod: Record<
      CostAllocationMethod,
      {
        count: number;
        totalCost: number;
        avgCost: number;
      }
    >;
  } {
    let totalCost = 0;
    let totalAllocated = 0;
    let totalUnallocated = 0;

    const byMethod = {
      [CostAllocationMethod.DIRECT]: { count: 0, totalCost: 0, avgCost: 0 },
      [CostAllocationMethod.USAGE_BASED]: { count: 0, totalCost: 0, avgCost: 0 },
      [CostAllocationMethod.EQUAL_SPLIT]: { count: 0, totalCost: 0, avgCost: 0 }
    };

    for (const allocation of allocations) {
      totalCost += allocation.monthlyCost;
      totalUnallocated += allocation.unallocatedCost;

      const allocated = allocation.allocatedTo.reduce((sum, t) => sum + t.allocatedAmount, 0);
      totalAllocated += allocated;

      byMethod[allocation.allocationMethod].count++;
      byMethod[allocation.allocationMethod].totalCost += allocation.monthlyCost;
    }

    // Calculate averages
    for (const method of Object.values(CostAllocationMethod)) {
      if (byMethod[method].count > 0) {
        byMethod[method].avgCost = byMethod[method].totalCost / byMethod[method].count;
      }
    }

    return {
      totalCost: this.roundToCents(totalCost),
      totalAllocated: this.roundToCents(totalAllocated),
      totalUnallocated: this.roundToCents(totalUnallocated),
      byMethod
    };
  }

  /**
   * Reallocate unallocated costs proportionally
   *
   * @param allocation - Cost allocation with unallocated cost
   * @returns Updated allocation with distributed unallocated cost
   */
  public reallocateUnallocatedCosts(allocation: CostAllocationResult): CostAllocationResult {
    if (allocation.unallocatedCost <= 0 || allocation.allocatedTo.length === 0) {
      return allocation;
    }

    const totalCurrentlyAllocated = allocation.allocatedTo.reduce(
      (sum, t) => sum + t.allocatedAmount,
      0
    );

    const updatedTargets = allocation.allocatedTo.map(target => {
      const proportion =
        totalCurrentlyAllocated > 0
          ? target.allocatedAmount / totalCurrentlyAllocated
          : 1 / allocation.allocatedTo.length;

      const additionalCost = allocation.unallocatedCost * proportion;

      return {
        ...target,
        allocatedAmount: this.roundToCents(target.allocatedAmount + additionalCost),
        allocationPercentage: this.roundToDecimal(
          ((target.allocatedAmount + additionalCost) / allocation.monthlyCost) * 100,
          2
        )
      };
    });

    return {
      ...allocation,
      allocatedTo: updatedTargets,
      unallocatedCost: 0
    };
  }

  /**
   * Helper: Round to cents
   */
  private roundToCents(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * Helper: Round to decimal places
   */
  private roundToDecimal(value: number, decimals: number): number {
    const multiplier = Math.pow(10, decimals);
    return Math.round(value * multiplier) / multiplier;
  }
}

/**
 * Get singleton instance
 */
export function getCostAllocationService(): CostAllocationService {
  return CostAllocationService.getInstance();
}
