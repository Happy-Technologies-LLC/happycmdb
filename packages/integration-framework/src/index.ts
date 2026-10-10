// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Framework - Main Exports (v3.0)
 * Multi-resource connector management system
 */

// Core classes
export { BaseIntegrationConnector } from './core/base-connector';

// Registry
export { ConnectorRegistry, getConnectorRegistry } from './registry/connector-registry';

// connector-core 0.2.0 descriptor bridge: map a CMDB connector.json
// (ConnectorMetadata) onto the shared ConnectorDescriptor contract.
export { mapConnectorMetadataToDescriptor } from './descriptor-mapper';
export type {
  ConnectorDescriptorMappingResult,
  UnsupportedDescriptorField,
} from './descriptor-mapper';

// Types
export * from './types/connector.types';
