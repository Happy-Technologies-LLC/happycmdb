// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Depreciation Calculator
 * Implements TBM v5.0.1 depreciation schedules
 */

import { DepreciationSchedule, DepreciationResult } from '../types/cost-types';
import { DepreciationMethod } from '../types/tbm-types';

/**
 * Calculate depreciation for a given CI
 *
 * @param ciId - Configuration Item ID
 * @param schedule - Depreciation schedule
 * @param asOfDate - Date to calculate depreciation as of (defaults to now)
 * @returns Depreciation calculation result
 *
 * @example
 * ```typescript
 * const result = calculateDepreciation('ci-server-001', {
 *   purchaseDate: new Date('2023-01-01'),
 *   purchasePrice: 36000,
 *   method: DepreciationMethod.STRAIGHT_LINE,
 *   depreciationYears: 3,
 *   residualValue: 0
 * });
 * console.log(result.monthlyDepreciation); // 1000
 * ```
 */
export function calculateDepreciation(
  ciId: string,
  schedule: DepreciationSchedule,
  asOfDate: Date = new Date()
): DepreciationResult {
  const monthsElapsed = getMonthsDifference(schedule.purchaseDate, asOfDate);
  const totalDepreciationMonths = schedule.depreciationYears * 12;

  let accumulatedDepreciation = 0;
  let monthlyDepreciation = 0;
  let currentBookValue = schedule.purchasePrice;

  if (schedule.method === DepreciationMethod.STRAIGHT_LINE) {
    const depreciableAmount = schedule.purchasePrice - schedule.residualValue;
    monthlyDepreciation = depreciableAmount / totalDepreciationMonths;
    accumulatedDepreciation = Math.min(monthlyDepreciation * monthsElapsed, depreciableAmount);
    currentBookValue = schedule.purchasePrice - accumulatedDepreciation;

    // Once the asset's useful life is exhausted, no further depreciation accrues
    if (monthsElapsed >= totalDepreciationMonths) {
      monthlyDepreciation = 0;
    }
  } else if (schedule.method === DepreciationMethod.DECLINING_BALANCE) {
    // Double-declining balance method
    const annualRate = 2 / schedule.depreciationYears;
    const monthlyRate = annualRate / 12;

    currentBookValue = schedule.purchasePrice;
    for (let month = 0; month < monthsElapsed; month++) {
      const monthlyDep = currentBookValue * monthlyRate;
      accumulatedDepreciation += monthlyDep;
      currentBookValue -= monthlyDep;

      // Don't depreciate below residual value
      if (currentBookValue < schedule.residualValue) {
        const overage = schedule.residualValue - currentBookValue;
        accumulatedDepreciation -= overage;
        currentBookValue = schedule.residualValue;
        break;
      }
    }

    // Calculate current monthly depreciation
    if (currentBookValue > schedule.residualValue) {
      monthlyDepreciation = currentBookValue * monthlyRate;
    } else {
      monthlyDepreciation = 0;
    }
  }

  const remainingLife = Math.max(0, totalDepreciationMonths - monthsElapsed);
  const isFullyDepreciated = remainingLife === 0 || currentBookValue <= schedule.residualValue;

  return {
    ciId,
    schedule,
    currentBookValue: roundToCents(currentBookValue),
    accumulatedDepreciation: roundToCents(accumulatedDepreciation),
    monthlyDepreciation: roundToCents(monthlyDepreciation),
    remainingLife,
    isFullyDepreciated
  };
}

/**
 * Calculate monthly cost including depreciation
 *
 * @param purchasePrice - Initial purchase price
 * @param depreciationYears - Years to depreciate over
 * @param residualValue - Residual/salvage value at end of life
 * @returns Monthly depreciation cost
 *
 * @example
 * ```typescript
 * const monthly = calculateMonthlyDepreciation(36000, 3, 0);
 * console.log(monthly); // 1000
 * ```
 */
export function calculateMonthlyDepreciation(
  purchasePrice: number,
  depreciationYears: number,
  residualValue: number = 0
): number {
  const depreciableAmount = purchasePrice - residualValue;
  const totalMonths = depreciationYears * 12;
  return roundToCents(depreciableAmount / totalMonths);
}

/**
 * Get default depreciation schedule for a CI type
 *
 * @param ciType - Type of CI
 * @param purchasePrice - Purchase price
 * @param purchaseDate - Purchase date
 * @returns Default depreciation schedule
 *
 * @example
 * ```typescript
 * const schedule = getDefaultDepreciationSchedule('server', 36000, new Date());
 * console.log(schedule.depreciationYears); // 3
 * ```
 */
export function getDefaultDepreciationSchedule(
  ciType: string,
  purchasePrice: number,
  purchaseDate: Date = new Date()
): DepreciationSchedule {
  const normalizedType = ciType.toLowerCase();

  // Hardware: 3-year straight-line
  const hardwareTypes = ['server', 'physical-server', 'storage', 'network-device', 'router', 'switch', 'workstation'];
  if (hardwareTypes.some(type => normalizedType.includes(type))) {
    return {
      purchaseDate,
      purchasePrice,
      method: DepreciationMethod.STRAIGHT_LINE,
      depreciationYears: 3,
      residualValue: 0
    };
  }

  // Software/Licenses: 1-year straight-line
  const softwareTypes = ['license', 'software', 'application'];
  if (softwareTypes.some(type => normalizedType.includes(type))) {
    return {
      purchaseDate,
      purchasePrice,
      method: DepreciationMethod.STRAIGHT_LINE,
      depreciationYears: 1,
      residualValue: 0
    };
  }

  // Cloud resources: No depreciation (operational expense)
  const cloudTypes = ['vm', 'virtual-machine', 'cloud', 'lambda', 'function', 'container'];
  if (cloudTypes.some(type => normalizedType.includes(type))) {
    return {
      purchaseDate,
      purchasePrice,
      method: DepreciationMethod.STRAIGHT_LINE,
      depreciationYears: 0, // Immediate expense
      residualValue: 0
    };
  }

  // Default: 3-year straight-line
  return {
    purchaseDate,
    purchasePrice,
    method: DepreciationMethod.STRAIGHT_LINE,
    depreciationYears: 3,
    residualValue: 0
  };
}

/**
 * Validate depreciation schedule
 *
 * @param schedule - Depreciation schedule to validate
 * @returns Validation errors (empty array if valid)
 */
export function validateDepreciationSchedule(schedule: DepreciationSchedule): string[] {
  const errors: string[] = [];

  if (schedule.purchasePrice <= 0) {
    errors.push('Purchase price must be greater than 0');
  }

  if (schedule.depreciationYears <= 0) {
    errors.push('Depreciation years must be greater than 0');
  }

  if (schedule.residualValue < 0) {
    errors.push('Residual value cannot be negative');
  }

  if (schedule.residualValue >= schedule.purchasePrice) {
    errors.push('Residual value must be less than purchase price');
  }

  if (schedule.purchaseDate > new Date()) {
    errors.push('Purchase date cannot be in the future');
  }

  return errors;
}

/**
 * Calculate total cost of ownership over asset lifetime
 *
 * @param schedule - Depreciation schedule
 * @param operationalCostPerMonth - Monthly operational costs (maintenance, support, etc.)
 * @returns Total cost of ownership
 */
export function calculateTotalCostOfOwnership(
  schedule: DepreciationSchedule,
  operationalCostPerMonth: number = 0
): number {
  const depreciableAmount = schedule.purchasePrice - schedule.residualValue;
  const totalMonths = schedule.depreciationYears * 12;
  const totalOperationalCost = operationalCostPerMonth * totalMonths;

  return roundToCents(depreciableAmount + totalOperationalCost);
}

/**
 * Helper: Get months difference between two dates
 */
function getMonthsDifference(startDate: Date, endDate: Date): number {
  const yearsDiff = endDate.getFullYear() - startDate.getFullYear();
  const monthsDiff = endDate.getMonth() - startDate.getMonth();
  return Math.max(0, yearsDiff * 12 + monthsDiff);
}

/**
 * Helper: Round to cents (2 decimal places)
 */
function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
