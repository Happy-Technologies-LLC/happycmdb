// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * TBM Cost Engine
 * Technology Business Management v5.0.1 implementation for HappyCMDB v3.0
 */

// Export enums (values)
export { TBMResourceTower, TBMCostPool, CostAllocationMethod, DepreciationMethod } from './types/tbm-types';

// Export types (type-only to satisfy isolatedModules)
export type {
  TBMSubTower,
  TowerMappingResult,
  AllocationTarget,
  CostAllocationResult,
  UsageMetrics,
  CostAggregationResult,
  CostTrendData
} from './types/tbm-types';

export type {
  DepreciationSchedule,
  DepreciationResult,
  DirectCostItem,
  DirectCostResult,
  UsageBasedParams,
  UsageBasedResult,
  EqualSplitParams,
  EqualSplitResult,
  CostCalculationOptions,
  CostValidationResult
} from './types/cost-types';

// Utilities
export * from './utils/tbm-taxonomy';

// Calculators
export * from './calculators/depreciation.calculator';
export * from './calculators/direct-cost-calculator';
export * from './calculators/usage-based-calculator';
export * from './calculators/equal-split-calculator';

// Services
export * from './services/tower-mapping.service';
export * from './services/depreciation.service';
export * from './services/cost-allocation.service';
export * from './services/pool-aggregation.service';
