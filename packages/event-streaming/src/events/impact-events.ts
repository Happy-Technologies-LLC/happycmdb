// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Business Impact Event Types for HappyCMDB v3.0
 *
 * Events emitted during impact scoring and business service mapping
 */

import { BaseEvent } from './discovery-events';

/**
 * Event emitted when impact score is calculated for an entity
 */
export interface ImpactScoreCalculatedEvent extends BaseEvent {
  eventType: 'impact.calculated';
  payload: {
    entityId: string;
    entityType: 'ci' | 'application-service' | 'business-service';
    entityName: string;
    impactScore: number; // 0-100
    criticality: 'low' | 'medium' | 'high' | 'critical';
    factors: {
      dependencyCount: number;
      upstreamDependencies: number;
      downstreamDependencies: number;
      userCount?: number;
      revenue?: number;
      regulatoryCompliance?: boolean;
    };
    calculatedBy: string;
    calculatedAt: Date;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when business service is created or updated
 */
export interface BusinessServiceUpdatedEvent extends BaseEvent {
  eventType: 'business-service.updated';
  payload: {
    businessServiceId: string;
    businessServiceName: string;
    owner: string;
    department: string;
    criticality: 'low' | 'medium' | 'high' | 'critical';
    associatedCIs: string[];
    associatedApplications: string[];
    impactScore: number;
    updatedBy: string;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when application service is created or updated
 */
export interface ApplicationServiceUpdatedEvent extends BaseEvent {
  eventType: 'application-service.updated';
  payload: {
    applicationServiceId: string;
    applicationServiceName: string;
    owner: string;
    team: string;
    criticality: 'low' | 'medium' | 'high' | 'critical';
    associatedCIs: string[];
    associatedBusinessServices: string[];
    impactScore: number;
    updatedBy: string;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when impact analysis is triggered
 */
export interface ImpactAnalysisTriggeredEvent extends BaseEvent {
  eventType: 'impact.analysis.triggered';
  payload: {
    analysisId: string;
    triggerType: 'manual' | 'scheduled' | 'change-detected';
    triggerSource: string;
    scope: {
      entityIds: string[];
      entityTypes: string[];
      includeUpstream: boolean;
      includeDownstream: boolean;
      maxDepth: number;
    };
    triggeredBy: string;
    metadata?: Record<string, any>;
  };
}

/**
 * Event emitted when impact analysis is completed
 */
export interface ImpactAnalysisCompletedEvent extends BaseEvent {
  eventType: 'impact.analysis.completed';
  payload: {
    analysisId: string;
    results: {
      entitiesAnalyzed: number;
      highImpactEntities: string[];
      criticalDependencies: string[];
      riskScore: number;
      recommendations: string[];
    };
    duration: number; // milliseconds
    completedAt: Date;
    metadata?: Record<string, any>;
  };
}

/**
 * Union type of all impact events
 */
export type ImpactEvent =
  | ImpactScoreCalculatedEvent
  | BusinessServiceUpdatedEvent
  | ApplicationServiceUpdatedEvent
  | ImpactAnalysisTriggeredEvent
  | ImpactAnalysisCompletedEvent;
