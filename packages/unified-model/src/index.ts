// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * @cmdb/unified-model
 *
 * Unified data model for HappyCMDB v3.0
 * Provides TypeScript types and validators for ITIL + TBM + BSM integration
 *
 * @packageDocumentation
 */

// Export all types
export * from './types';

// Export all service interfaces
export * from './services';

// Export all validators
export * from './validators';

/**
 * Package version
 */
export const VERSION = '3.0.0';

/**
 * Supported frameworks
 */
export const SUPPORTED_FRAMEWORKS = ['ITIL v4', 'TBM v5.0.1', 'BSM'] as const;
