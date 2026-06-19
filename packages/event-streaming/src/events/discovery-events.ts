// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Event Types for HappyCMDB v3.0
 *
 * Events emitted during CI discovery, updates, and deletion
 */

export interface BaseEvent {
  eventId: string;
  timestamp: Date;
  version: string;
}

/**
 * Event emitted when a new CI is discovered
 */
export interface CIDiscoveredEvent extends BaseEvent {
  eventType: 'ci.discovered';
  payload: {
    ciId: string;
    ciType: string;
    name: string;
    discoveredBy: string;
    connectorId?: string;
    agentId?: string;
    confidence: number; // 0-1 score
    environment?: string;
    location?: string;
    metadata: Record<string, any>;
  };
}

/**
 * Event emitted when a CI is updated
 */
export interface CIUpdatedEvent extends BaseEvent {
  eventType: 'ci.updated';
  payload: {
    ciId: string;
    ciType: string;
    name: string;
    updatedBy: string;
    changes: {
      field: string;
      oldValue: any;
      newValue: any;
    }[];
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when a CI is deleted
 */
export interface CIDeletedEvent extends BaseEvent {
  eventType: 'ci.deleted';
  payload: {
    ciId: string;
    ciType: string;
    name: string;
    deletedBy: string;
    reason?: string;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when a relationship between CIs is created
 */
export interface RelationshipCreatedEvent extends BaseEvent {
  eventType: 'relationship.created';
  payload: {
    relationshipId: string;
    relationshipType: string;
    sourceCiId: string;
    targetCiId: string;
    createdBy: string;
    properties?: Record<string, any>;
  };
}

/**
 * Event emitted when a relationship is deleted
 */
export interface RelationshipDeletedEvent extends BaseEvent {
  eventType: 'relationship.deleted';
  payload: {
    relationshipId: string;
    relationshipType: string;
    sourceCiId: string;
    targetCiId: string;
    deletedBy: string;
    reason?: string;
  };
}

/**
 * Union type of all discovery events
 */
export type DiscoveryEvent =
  | CIDiscoveredEvent
  | CIUpdatedEvent
  | CIDeletedEvent
  | RelationshipCreatedEvent
  | RelationshipDeletedEvent;
