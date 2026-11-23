// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Common Types - Central export for all type definitions
 *
 * This module exports all TypeScript types and interfaces used across
 * the CMDB platform packages.
 */

// CI Types
export type {
  CI,
  CIType,
  CIStatus,
  Environment,
  CIInput,
  Relationship,
  RelationshipType,
  SourceOwnedCIType,
  AuthoritativeSource,
  AILifecycle,
} from './ci.types';
export { SOURCE_OWNED_CI_TYPES, isSourceOwnedCIType, SourceOwnedError, RELATIONSHIP_TYPES } from './ci.types';

// Estate topology summary (HAP-1924)
export type {
  TopologyCategory,
  TopologyCategoryCounts,
  TopologyNode,
  TopologyEdge,
  TopologySummary,
} from './topology.types';
export {
  TOPOLOGY_CATEGORY_BY_TYPE,
  topologyCategoryOf,
  TOPOLOGY_NODE_LIMIT_DEFAULT,
  TOPOLOGY_NODE_LIMIT_MAX,
  TOPOLOGY_EDGE_LIMIT_DEFAULT,
  TOPOLOGY_EDGE_LIMIT_MAX,
} from './topology.types';

// Discovery Types
export type {
  DiscoveryJob,
  DiscoveryProvider,
  DiscoveryMethod,
  JobStatus,
  DiscoveryConfig,
  DiscoveredCI,
  DiscoveryDefinition,
  DiscoveryDefinitionInput,
  DiscoveryAgent,
  DiscoveryAgentRegistration,
  AgentHeartbeat,
  AgentStatus,
} from './discovery.types';

// Relationship Types
export type {
  RelationshipDetails,
  RelationshipInput,
  RelationshipQuery,
  DependencyPath,
  ImpactAnalysisResult,
  ImpactedCI,
} from './relationship.types';

// Data Mart Types
export type {
  CIDimensionInput,
  LocationDimensionInput,
  OwnerDimensionInput,
  DiscoveryFactInput,
  ChangesFactInput,
  RelationshipFactInput,
  CurrentCIInventoryRow,
  CIDiscoverySummaryRow,
  CIChangeHistoryRow,
  CIRelationshipRow,
  TimeDimensionRow,
} from './datamart.types';

// Job Types
export type {
  BaseJobData,
  DiscoveryJobData,
  DiscoveryJobConfig,
  ETLJobData,
  ETLJobType,
  ETLJobConfig,
  JobResult,
  JobResultStatus,
  JobProgress,
  QueueConfig,
  JobOptions,
  WorkerConfig,
  QueueStats,
  WorkerStatus,
  JobEvent,
  JobEventType,
} from './job.types';

// Audit Types
export type {
  AuditAction,
  AuditEntityType,
  AuditLogEntry,
  AuditChange,
  AuditLogQuery,
  AuditLogResponse,
} from './audit.types';

// Unified Credential Types (Protocol-based system)
export {
  CredentialNotFoundError,
  CredentialSetNotFoundError,
  DuplicateCredentialSetNameError,
  DuplicateCredentialNameError,
  CredentialIdsNotFoundError,
  CredentialSetInUseError,
  CredentialInUseError,
} from './unified-credential.types';
export type {
  AuthProtocol,
  CredentialScope,
  ValidationStatus,
  CredentialAffinity,
  UnifiedCredential,
  UnifiedCredentialInput,
  UnifiedCredentialUpdateInput,
  UnifiedCredentialSummary,
  CredentialSetStrategy,
  CredentialSet,
  CredentialSetInput,
  CredentialSetUpdateInput,
  CredentialSetSummary,
  CredentialMatchResult,
  CredentialMatchContext,
  CredentialValidationResult,
} from './unified-credential.types';
