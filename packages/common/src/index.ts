// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CMDB Common Package
 *
 * Shared TypeScript types, utilities, and constants for the CMDB platform.
 * This package is used across all other packages in the monorepo.
 *
 * @packageDocumentation
 */

// Export all types
export * from './types';

// Export logger utilities
export { createLogger, createChildLogger, logger, log } from './utils/logger';
export type { LoggerOptions, LogLevel } from './utils/logger';

// Export validation utilities
export { validate, validators, schemas } from './utils/validators';
export type { ValidationResult } from './utils/validators';
export {
  ciSchema,
  ciInputSchema,
  ciUpdateSchema,
  relationshipSchema,
  discoveryJobSchema,
  discoveredCISchema,
  paginationSchema,
  queryFiltersSchema,
} from './utils/validators';

// Export retry utilities
export { withRetry } from './utils/retry';
export {
  DISCOVERY_TARGET_REFUSED, assertDiscoveryAddress, assertDiscoveryHostname,
  assertDiscoveryRange, resolveDiscoveryHost, connectDiscoveryHost,
} from './security/discovery-egress';
export type { RetryOptions } from './utils/retry';

// Export queue management
export * from './queues';
export { getQueueManager } from './queues/queue-manager';
export { QUEUE_NAMES } from './queues/queue-config';
export type { EnhancedQueueManager } from './queues/queue-manager';

// Export metrics
export * from './metrics';

// Export config
export type { ConfigSchema } from './config/config.schema';
export { getConfigLoader, getConfig, loadConfig, ConfigurationLoader } from './config/config.loader';

// Export secrets
export { SecretsManager, getSecretsManager, initializeSecretsManager } from './secrets/secrets-manager';
export type { SecretsProvider } from './secrets/secrets-manager';

// Export logging
export * from './logging';

// Export tracing (TEMPORARILY DISABLED due to OpenTelemetry API version issues)
// export * from './tracing';

// Export encryption service
export { EncryptionService, getEncryptionService, resetEncryptionService } from './services/encryption.service';

// Export credential protocol adapter
export {
  CredentialProtocolAdapter,
  type AwsCredentialIdentity,
  type AzureClientSecretConfig,
  type GCPServiceAccountCredentials,
  type SSHConfig,
  type SNMPConfig,
  type WinRMConfig,
  type KubernetesConfig,
  type LDAPConfig,
  type RedfishConfig,
  type ProxmoxConfig,
} from './services/credential-protocol-adapter';

// Export security validators (SQL/Cypher injection prevention)
export {
  validateTableName,
  validateTableNames,
  validateCISortField,
  validateConnectorSortField,
  validateConnectorConfigSortField,
  validateConnectorRunSortField,
  validateSortDirection,
  escapePostgresIdentifier,
  containsSQLInjectionPatterns,
  VALID_TABLE_NAMES,
  VALID_CI_SORT_FIELDS,
  VALID_CONNECTOR_SORT_FIELDS,
  VALID_CONNECTOR_CONFIG_SORT_FIELDS,
  VALID_CONNECTOR_RUN_SORT_FIELDS,
  VALID_SORT_DIRECTIONS,
} from './security/sql-validators';

export {
  validateNodeLabel,
  validateRelationshipType,
  validateCIProperty,
  sanitizeCITypeForLabel,
  buildSafeCypherLabel,
  escapeCypherIdentifier,
  containsCypherInjectionPatterns,
  VALID_NODE_LABELS,
  VALID_RELATIONSHIP_TYPES,
  VALID_CI_PROPERTIES,
} from './security/cypher-validators';
