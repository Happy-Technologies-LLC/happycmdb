// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * @cmdb/itil-service-manager
 *
 * ITIL v4 Service Management for HappyCMDB v3.0
 *
 * Provides comprehensive ITIL v4 service management capabilities:
 * - Configuration Management: CI lifecycle, audits, baselines
 * - Incident Management: Auto-calculated priority based on impact + urgency
 * - Change Management: Risk assessment and CAB approval workflows
 * - Baseline Management: Configuration drift detection and remediation
 *
 * @packageDocumentation
 */

// Export services
export { ConfigurationManagementService } from './services/configuration-management.service';
export { IncidentPriorityService } from './services/incident-priority.service';
export { ChangeRiskService } from './services/change-risk.service';
export { BaselineService } from './services/baseline.service';

// Export repositories
export { CIRepository } from './repositories/ci-repository';
export { IncidentRepository } from './repositories/incident-repository';
export { ChangeRepository } from './repositories/change-repository';
export { BaselineRepository } from './repositories/baseline-repository';
export { BusinessServiceRepository } from './repositories/business-service-repository';

// Export utilities
export { PriorityCalculator } from './utils/priority-calculator';
export { RiskAssessor } from './utils/risk-assessor';
export { LifecycleManager } from './utils/lifecycle-manager';

// Export types
export * from './types';

/**
 * Package version
 */
export const VERSION = '3.0.0';

/**
 * Supported ITIL version
 */
export const ITIL_VERSION = 'ITIL v4';
