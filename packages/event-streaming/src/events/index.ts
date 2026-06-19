// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Event Types Index
 *
 * Exports all event types for HappyCMDB v3.0 event streaming
 */

export * from './discovery-events';
export * from './cost-events';
export * from './impact-events';

import { DiscoveryEvent } from './discovery-events';
import { CostEvent } from './cost-events';
import { ImpactEvent } from './impact-events';

/**
 * Union type of all CMDB events
 */
export type CMDBEvent = DiscoveryEvent | CostEvent | ImpactEvent;

/**
 * Helper function to create event ID
 */
export function createEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Helper function to create base event metadata
 */
export function createBaseEvent(eventType: string): { eventId: string; timestamp: Date; version: string } {
  return {
    eventId: createEventId(),
    timestamp: new Date(),
    version: '3.0.0',
  };
}
