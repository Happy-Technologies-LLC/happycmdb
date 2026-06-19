// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Event Serialization Utilities for HappyCMDB v3.0
 *
 * Handles serialization and deserialization of events
 */

import { Message } from 'kafkajs';
import { CMDBEvent } from '../events';
import { logger } from './logger';

/**
 * Serialize event to Kafka message
 */
export function serializeEvent(event: CMDBEvent): string {
  try {
    return JSON.stringify(event, (key, value) => {
      // Convert Date objects to ISO strings
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value;
    });
  } catch (error) {
    logger.error('Failed to serialize event', { event, error });
    throw new Error(`Event serialization failed: ${error}`);
  }
}

/**
 * Deserialize Kafka message to event
 */
export function deserializeEvent(message: Message): CMDBEvent | null {
  try {
    if (!message.value) {
      logger.warn('Received message with no value');
      return null;
    }

    const eventStr = message.value.toString();
    const event = JSON.parse(eventStr, (key, value) => {
      // Convert ISO strings back to Date objects
      if (key === 'timestamp' || key === 'effectiveDate' || key === 'detectedAt' || key === 'calculatedAt' || key === 'completedAt') {
        return new Date(value);
      }
      return value;
    });

    return event as CMDBEvent;
  } catch (error) {
    logger.error('Failed to deserialize event', { message, error });
    return null;
  }
}

/**
 * Create Kafka message from event
 */
export function createKafkaMessage(event: CMDBEvent, key?: string): { key?: string; value: string; timestamp?: string } {
  const serialized = serializeEvent(event);

  return {
    key: key || event.eventId,
    value: serialized,
    timestamp: event.timestamp.getTime().toString(),
  };
}

/**
 * Validate event structure
 */
export function validateEvent(event: any): boolean {
  if (!event) {
    logger.warn('Event is null or undefined');
    return false;
  }

  if (!event.eventId || !event.eventType || !event.timestamp || !event.version) {
    logger.warn('Event missing required fields', { event });
    return false;
  }

  if (!event.payload) {
    logger.warn('Event missing payload', { event });
    return false;
  }

  return true;
}

/**
 * Extract event metadata for logging
 */
export function extractEventMetadata(event: CMDBEvent): {
  eventId: string;
  eventType: string;
  timestamp: Date;
  version: string;
} {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
    version: event.version,
  };
}

/**
 * Create dead letter queue message
 */
export function createDLQMessage(
  originalMessage: Message,
  error: Error,
  topic: string,
  partition: number,
  offset: string
): string {
  return JSON.stringify({
    originalMessage: {
      key: originalMessage.key?.toString(),
      value: originalMessage.value?.toString(),
      headers: originalMessage.headers,
      timestamp: originalMessage.timestamp,
      offset,
    },
    error: {
      message: error.message,
      stack: error.stack,
    },
    metadata: {
      topic,
      partition,
      failedAt: new Date().toISOString(),
    },
  });
}
