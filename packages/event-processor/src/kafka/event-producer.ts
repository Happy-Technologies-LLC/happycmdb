// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Kafka Event Producer
 */

import { Kafka, Producer, RecordMetadata } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@cmdb/common';
import { CMDBEvent, EventType, BaseEvent } from '../types/events';
import { KAFKA_TOPICS } from './topics';

export class EventProducer {
  /** Null when no brokers are configured: the producer is disabled and never touches the network. */
  private readonly producer: Producer | null = null;
  private isConnected: boolean = false;

  constructor(brokers: string[] = ['localhost:9092'], clientId: string = 'cmdb-event-producer') {
    if (brokers.length === 0) {
      logger.warn('Kafka brokers not configured (KAFKA_BROKERS); event notification disabled');
      return;
    }

    const kafka = new Kafka({
      clientId,
      brokers,
      retry: {
        initialRetryTime: 100,
        retries: 8,
      },
    });

    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      transactionalId: `${clientId}-${uuidv4()}`,
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected || !this.producer) {
      return;
    }

    try {
      await this.producer.connect();
      this.isConnected = true;
      logger.info('Kafka producer connected');
    } catch (error) {
      logger.error('Failed to connect Kafka producer', { error });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnected || !this.producer) {
      return;
    }

    try {
      await this.producer.disconnect();
      this.isConnected = false;
      logger.info('Kafka producer disconnected');
    } catch (error) {
      logger.error('Failed to disconnect Kafka producer', { error });
      throw error;
    }
  }

  /**
   * Publish a CMDB event to appropriate topic
   */
  async publishEvent(event: CMDBEvent): Promise<RecordMetadata[]> {
    if (!this.producer) {
      return [];
    }

    if (!this.isConnected) {
      await this.connect();
    }

    const topic = this.getTopicForEvent(event.event_type);
    const key = this.getEventKey(event);

    try {
      const result = await this.producer.send({
        topic,
        messages: [
          {
            key,
            value: JSON.stringify(event),
            timestamp: event.timestamp.getTime().toString(),
            headers: {
              event_type: event.event_type,
              event_id: event.event_id,
              source: event.source,
            },
          },
        ],
      });

      logger.debug('Event published', {
        event_id: event.event_id,
        event_type: event.event_type,
        topic,
      });

      return result;
    } catch (error) {
      logger.error('Failed to publish event', {
        event_id: event.event_id,
        event_type: event.event_type,
        error,
      });

      // Try to send to DLQ
      await this.sendToDLQ(event, error as Error);
      throw error;
    }
  }

  /**
   * Publish multiple events in a batch
   */
  async publishBatch(events: CMDBEvent[]): Promise<RecordMetadata[]> {
    if (!this.producer) {
      return [];
    }

    if (!this.isConnected) {
      await this.connect();
    }

    // Group events by topic
    const eventsByTopic = new Map<string, CMDBEvent[]>();

    for (const event of events) {
      const topic = this.getTopicForEvent(event.event_type);
      if (!eventsByTopic.has(topic)) {
        eventsByTopic.set(topic, []);
      }
      eventsByTopic.get(topic)!.push(event);
    }

    // Send to each topic
    const results: RecordMetadata[] = [];

    try {
      for (const [topic, topicEvents] of eventsByTopic.entries()) {
        const result = await this.producer.send({
          topic,
          messages: topicEvents.map(event => ({
            key: this.getEventKey(event),
            value: JSON.stringify(event),
            timestamp: event.timestamp.getTime().toString(),
            headers: {
              event_type: event.event_type,
              event_id: event.event_id,
              source: event.source,
            },
          })),
        });

        results.push(...result);
      }

      logger.info('Event batch published', {
        total_events: events.length,
        topics: Array.from(eventsByTopic.keys()),
      });

      return results;
    } catch (error) {
      logger.error('Failed to publish event batch', { error });
      throw error;
    }
  }

  /**
   * Send failed event to Dead Letter Queue
   */
  private async sendToDLQ(event: CMDBEvent, error: Error): Promise<void> {
    if (!this.producer) {
      return;
    }

    try {
      await this.producer.send({
        topic: KAFKA_TOPICS.DLQ,
        messages: [
          {
            key: event.event_id,
            value: JSON.stringify({
              original_event: event,
              error_message: error.message,
              error_stack: error.stack,
              failed_at: new Date().toISOString(),
            }),
            headers: {
              original_event_type: event.event_type,
              original_topic: this.getTopicForEvent(event.event_type),
            },
          },
        ],
      });

      logger.warn('Event sent to DLQ', {
        event_id: event.event_id,
        event_type: event.event_type,
        error: error.message,
      });
    } catch (dlqError) {
      logger.error('Failed to send event to DLQ', {
        event_id: event.event_id,
        error: dlqError,
      });
    }
  }

  /**
   * Determine topic based on event type
   */
  private getTopicForEvent(eventType: EventType): string {
    if (eventType.startsWith('ci.')) {
      if (eventType === EventType.CI_UPDATED) {
        return KAFKA_TOPICS.CI_CHANGES;
      }
      return KAFKA_TOPICS.CI_EVENTS;
    }

    if (eventType.startsWith('relationship.')) {
      return KAFKA_TOPICS.RELATIONSHIP_EVENTS;
    }

    if (eventType.startsWith('reconciliation.')) {
      if (eventType === EventType.RECONCILIATION_CONFLICT) {
        return KAFKA_TOPICS.RECONCILIATION_CONFLICTS;
      }
      return KAFKA_TOPICS.RECONCILIATION_EVENTS;
    }

    if (eventType.startsWith('connector.')) {
      if (eventType.includes('.run.')) {
        return KAFKA_TOPICS.CONNECTOR_METRICS;
      }
      return KAFKA_TOPICS.CONNECTOR_EVENTS;
    }

    if (eventType.startsWith('transformation.')) {
      return KAFKA_TOPICS.TRANSFORMATION_EVENTS;
    }

    // Default to general events topic
    return KAFKA_TOPICS.CI_EVENTS;
  }

  /**
   * Get partition key for event (ensures events for same CI go to same partition)
   */
  private getEventKey(event: CMDBEvent): string {
    // Use CI ID as key for CI events
    if ('ci_id' in event && event.ci_id) {
      return event.ci_id;
    }

    // Use relationship ID for relationship events
    if ('relationship_id' in event && event.relationship_id) {
      return event.relationship_id;
    }

    // Use connector name for connector events
    if ('connector_name' in event && event.connector_name) {
      return event.connector_name;
    }

    // Use conflict ID for reconciliation events
    if ('conflict_id' in event && event.conflict_id) {
      return event.conflict_id;
    }

    // Default to event ID
    return event.event_id;
  }

  /**
   * Create and publish an event (helper method)
   */
  async emit<T extends CMDBEvent>(
    eventType: T['event_type'],
    source: string,
    payload: Omit<T, keyof BaseEvent>
  ): Promise<RecordMetadata[]> {
    const event: BaseEvent = {
      event_id: uuidv4(),
      event_type: eventType as EventType,
      timestamp: new Date(),
      source,
      ...payload,
    };

    return this.publishEvent(event as CMDBEvent);
  }
}

// Singleton instance
let producerInstance: EventProducer | null = null;

export function getEventProducer(): EventProducer {
  if (!producerInstance) {
    const brokersEnv = process.env['KAFKA_BROKERS'];
    // Absent, empty or whitespace-only means Kafka is not configured: run disabled.
    const brokers = brokersEnv?.trim() ? brokersEnv.split(',') : [];
    producerInstance = new EventProducer(brokers);
  }
  return producerInstance;
}
