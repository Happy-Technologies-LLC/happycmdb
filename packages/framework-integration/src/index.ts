// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * @cmdb/framework-integration
 *
 * Unified Interface for HappyCMDB v3.0
 * Combines ITIL + TBM + BSM frameworks for complete service views
 *
 * @packageDocumentation
 */

// Main unified interface
export { UnifiedServiceInterface } from './unified-service-interface';

// Framework managers
export { ITILServiceManager } from './services/itil-service-manager';
export { TBMServiceManager } from './services/tbm-service-manager';
export { BSMServiceManager } from './services/bsm-service-manager';

// Export all types
export * from './types';

/**
 * Package version
 */
export const VERSION = '3.0.0';

/**
 * Supported frameworks
 */
export const SUPPORTED_FRAMEWORKS = ['ITIL v4', 'TBM v5.0.1', 'BSM'] as const;
