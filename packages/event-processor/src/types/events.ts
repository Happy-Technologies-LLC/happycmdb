// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Event Types for Kafka Streaming
 */

export enum EventType {
  // CI Lifecycle Events
  CI_DISCOVERED = 'ci.discovered',
  CI_UPDATED = 'ci.updated',
  CI_DELETED = 'ci.deleted',

  // Relationship Events
  RELATIONSHIP_CREATED = 'relationship.created',
  RELATIONSHIP_UPDATED = 'relationship.updated',
  RELATIONSHIP_DELETED = 'relationship.deleted',

  // Identity Resolution Events
  RECONCILIATION_CONFLICT = 'reconciliation.conflict',
  RECONCILIATION_RESOLVED = 'reconciliation.resolved',
  RECONCILIATION_MERGED = 'reconciliation.merged',

  // Connector Events
  CONNECTOR_RUN_STARTED = 'connector.run.started',
  CONNECTOR_RUN_COMPLETED = 'connector.run.completed',
  CONNECTOR_RUN_FAILED = 'connector.run.failed',

  // Transformation Events
  TRANSFORMATION_EXECUTED = 'transformation.executed',
  TRANSFORMATION_FAILED = 'transformation.failed',
}

export interface BaseEvent {
  event_id: string;
  event_type: EventType;
  timestamp: Date;
  source: string;
  metadata?: Record<string, any>;
}

export interface CIDiscoveredEvent extends BaseEvent {
  event_type: EventType.CI_DISCOVERED;
  ci_id: string;
  ci_name: string;
  ci_type: string;
  source_system: string;
  confidence_score: number;
  identifiers: Record<string, any>;
  /** Organization the CI belongs to, when the writer is organization-scoped. */
  organization_id?: string;
}

export interface CIUpdatedEvent extends BaseEvent {
  event_type: EventType.CI_UPDATED;
  ci_id: string;
  ci_name: string;
  changed_fields: string[];
  previous_values: Record<string, any>;
  new_values: Record<string, any>;
  source_system: string;
  /** Organization the CI belongs to, when the writer is organization-scoped. */
  organization_id?: string;
}

export interface CIDeletedEvent extends BaseEvent {
  event_type: EventType.CI_DELETED;
  ci_id: string;
  ci_name: string;
  ci_type: string;
  reason: string;
}

export interface RelationshipCreatedEvent extends BaseEvent {
  event_type: EventType.RELATIONSHIP_CREATED;
  relationship_id: string;
  source_ci_id: string;
  target_ci_id: string;
  relationship_type: string;
  properties?: Record<string, any>;
}

export interface RelationshipUpdatedEvent extends BaseEvent {
  event_type: EventType.RELATIONSHIP_UPDATED;
  relationship_id: string;
  changed_properties: string[];
  previous_values: Record<string, any>;
  new_values: Record<string, any>;
}

export interface RelationshipDeletedEvent extends BaseEvent {
  event_type: EventType.RELATIONSHIP_DELETED;
  relationship_id: string;
  source_ci_id: string;
  target_ci_id: string;
  relationship_type: string;
}

export interface ReconciliationConflictEvent extends BaseEvent {
  event_type: EventType.RECONCILIATION_CONFLICT;
  conflict_id: string;
  ci_id?: string;
  conflict_type: 'duplicate' | 'field_mismatch' | 'ambiguous_match';
  source_data: Record<string, any>[];
  conflicting_fields?: string[];
}

export interface ReconciliationResolvedEvent extends BaseEvent {
  event_type: EventType.RECONCILIATION_RESOLVED;
  conflict_id: string;
  ci_id: string;
  resolution_method: 'manual' | 'automatic' | 'rule_based';
  resolved_by?: string;
}

export interface ReconciliationMergedEvent extends BaseEvent {
  event_type: EventType.RECONCILIATION_MERGED;
  primary_ci_id: string;
  merged_ci_ids: string[];
  merge_strategy: string;
  confidence_score: number;
}

export interface ConnectorRunStartedEvent extends BaseEvent {
  event_type: EventType.CONNECTOR_RUN_STARTED;
  run_id: string;
  connector_name: string;
  connector_type: string;
  scheduled: boolean;
}

export interface ConnectorRunCompletedEvent extends BaseEvent {
  event_type: EventType.CONNECTOR_RUN_COMPLETED;
  run_id: string;
  connector_name: string;
  duration_ms: number;
  records_extracted: number;
  records_transformed: number;
  records_loaded: number;
}

export interface ConnectorRunFailedEvent extends BaseEvent {
  event_type: EventType.CONNECTOR_RUN_FAILED;
  run_id: string;
  connector_name: string;
  error_message: string;
  error_stack?: string;
  retry_count: number;
}

export interface TransformationExecutedEvent extends BaseEvent {
  event_type: EventType.TRANSFORMATION_EXECUTED;
  rule_id: string;
  rule_name: string;
  connector_type: string;
  records_processed: number;
  execution_time_ms: number;
}

export interface TransformationFailedEvent extends BaseEvent {
  event_type: EventType.TRANSFORMATION_FAILED;
  rule_id: string;
  rule_name: string;
  error_message: string;
  failed_record?: any;
  validation_errors?: any[];
}

export type CMDBEvent =
  | CIDiscoveredEvent
  | CIUpdatedEvent
  | CIDeletedEvent
  | RelationshipCreatedEvent
  | RelationshipUpdatedEvent
  | RelationshipDeletedEvent
  | ReconciliationConflictEvent
  | ReconciliationResolvedEvent
  | ReconciliationMergedEvent
  | ConnectorRunStartedEvent
  | ConnectorRunCompletedEvent
  | ConnectorRunFailedEvent
  | TransformationExecutedEvent
  | TransformationFailedEvent;
