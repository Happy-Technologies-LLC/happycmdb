// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Allocation Event Types for HappyCMDB v3.0
 *
 * Events emitted during cost calculation and allocation
 */

import { BaseEvent } from './discovery-events';

/**
 * Event emitted when cost is allocated to a CI
 */
export interface CostAllocationEvent extends BaseEvent {
  eventType: 'cost.allocated';
  payload: {
    ciId: string;
    ciType: string;
    ciName: string;
    monthlyCost: number;
    currency: string;
    tower: string; // Infrastructure, Application, Data, Security
    allocationMethod: string; // direct, proportional, tag-based, rule-based
    allocationDetails?: {
      sourceService?: string;
      tagKey?: string;
      tagValue?: string;
      allocationRule?: string;
    };
    effectiveDate: Date;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when cost allocation is updated
 */
export interface CostAllocationUpdatedEvent extends BaseEvent {
  eventType: 'cost.updated';
  payload: {
    ciId: string;
    ciType: string;
    ciName: string;
    previousCost: number;
    newCost: number;
    currency: string;
    reason: string;
    updatedBy: string;
    effectiveDate: Date;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when cost anomaly is detected
 */
export interface CostAnomalyDetectedEvent extends BaseEvent {
  eventType: 'cost.anomaly.detected';
  payload: {
    ciId: string;
    ciType: string;
    ciName: string;
    expectedCost: number;
    actualCost: number;
    deviationPercent: number;
    currency: string;
    anomalyType: 'spike' | 'drop' | 'trend';
    severity: 'low' | 'medium' | 'high' | 'critical';
    detectedAt: Date;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when cost budget threshold is exceeded
 */
export interface CostBudgetExceededEvent extends BaseEvent {
  eventType: 'cost.budget.exceeded';
  payload: {
    budgetId: string;
    budgetName: string;
    tower: string;
    budgetAmount: number;
    currentSpend: number;
    currency: string;
    exceedancePercent: number;
    period: string; // monthly, quarterly, yearly
    affectedCIs: string[];
    metadata?: Record<string, any>;
  };
}

/**
 * Union type of all cost events
 */
export type CostEvent =
  | CostAllocationEvent
  | CostAllocationUpdatedEvent
  | CostAnomalyDetectedEvent
  | CostBudgetExceededEvent;
