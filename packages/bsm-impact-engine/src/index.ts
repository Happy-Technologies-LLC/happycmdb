// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * @cmdb/bsm-impact-engine
 *
 * Business Service Mapping Impact Engine for HappyCMDB v3.0 Phase 4
 * Provides impact scoring, blast radius analysis, and risk assessment
 *
 * @packageDocumentation
 */

// Export all types
export * from './types';

// Export services
export {
  CriticalityCalculatorService,
  getCriticalityCalculatorService,
} from './services/criticality-calculator.service';

export {
  ImpactScoringService,
  getImpactScoringService,
} from './services/impact-scoring.service';

export {
  RiskRatingService,
  getRiskRatingService,
} from './services/risk-rating.service';

export {
  BlastRadiusService,
  getBlastRadiusService,
} from './services/blast-radius.service';

// Export calculators
export {
  RevenueImpactCalculator,
  getRevenueImpactCalculator,
} from './calculators/revenue-impact-calculator';

export {
  UserImpactCalculator,
  getUserImpactCalculator,
} from './calculators/user-impact-calculator';

export {
  ComplianceImpactCalculator,
  getComplianceImpactCalculator,
} from './calculators/compliance-impact-calculator';

// Export utilities
export {
  GraphTraversal,
  getGraphTraversal,
} from './utils/graph-traversal';

/**
 * Package version
 */
export const VERSION = '3.0.0';

/**
 * Package description
 */
export const PACKAGE_NAME = '@cmdb/bsm-impact-engine';
