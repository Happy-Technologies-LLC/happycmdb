// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Event Producer for HappyCMDB v3.0
 *
 * Publishes CI discovery, update, and relationship events to Kafka
 */

import { Producer } from 'kafkajs';
import { createProducer } from '../utils/kafka-client';
import { KAFKA_TOPICS } from '../config/topics';
import {
  CIDiscoveredEvent,
  CIUpdatedEvent,
  CIDeletedEvent,
  RelationshipCreatedEvent,
  RelationshipDeletedEvent,
} from '../events/discovery-events';
import { createKafkaMessage, validateEvent } from '../utils/serialization';
import { logger, logEventProduced, logEventError } from '../utils/logger';

/**
 * Discovery Event Producer
 */
export class DiscoveryProducer {
  private producer: Producer;
  private connected: boolean = false;

  constructor() {
    this.producer = createProducer();
  }

  /**
   * Connect to Kafka
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.producer.connect();
      this.connected = true;
      logger.info('Discovery producer connected');
    } catch (error) {
      logger.error('Failed to connect discovery producer', { error });
      throw error;
    }
  }

  /**
   * Disconnect from Kafka
   */
  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      await this.producer.disconnect();
      this.connected = false;
      logger.info('Discovery producer disconnected');
    } catch (error) {
      logger.error('Failed to disconnect discovery producer', { error });
      throw error;
    }
  }

  /**
   * Publish CI discovered event
   */
  async publishCIDiscovered(event: CIDiscoveredEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid CI discovered event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.ciId);

      await this.producer.send({
        topic: KAFKA_TOPICS.CI_DISCOVERED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.CI_DISCOVERED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.CI_DISCOVERED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish CI updated event
   */
  async publishCIUpdated(event: CIUpdatedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid CI updated event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.ciId);

      await this.producer.send({
        topic: KAFKA_TOPICS.CI_UPDATED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.CI_UPDATED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.CI_UPDATED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish CI deleted event
   */
  async publishCIDeleted(event: CIDeletedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid CI deleted event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.ciId);

      await this.producer.send({
        topic: KAFKA_TOPICS.CI_DELETED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.CI_DELETED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.CI_DELETED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish relationship created event
   */
  async publishRelationshipCreated(event: RelationshipCreatedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid relationship created event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.relationshipId);

      await this.producer.send({
        topic: KAFKA_TOPICS.RELATIONSHIP_CREATED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.RELATIONSHIP_CREATED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.RELATIONSHIP_CREATED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish relationship deleted event
   */
  async publishRelationshipDeleted(event: RelationshipDeletedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid relationship deleted event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.relationshipId);

      await this.producer.send({
        topic: KAFKA_TOPICS.RELATIONSHIP_DELETED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.RELATIONSHIP_DELETED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.RELATIONSHIP_DELETED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish multiple events in a batch
   */
  async publishBatch(events: Array<CIDiscoveredEvent | CIUpdatedEvent | CIDeletedEvent>): Promise<void> {
    const groupedMessages: Record<string, any[]> = {};

    // Group messages by topic
    for (const event of events) {
      if (!validateEvent(event)) {
        logger.warn('Skipping invalid event in batch', { eventId: event.eventId });
        continue;
      }

      let topic: string = '';
      let key: string = '';

      if (event.eventType === 'ci.discovered') {
        topic = KAFKA_TOPICS.CI_DISCOVERED;
        key = event.payload.ciId;
      } else if (event.eventType === 'ci.updated') {
        topic = KAFKA_TOPICS.CI_UPDATED;
        key = event.payload.ciId;
      } else if (event.eventType === 'ci.deleted') {
        topic = KAFKA_TOPICS.CI_DELETED;
        key = event.payload.ciId;
      } else {
        logger.warn('Unknown event type in batch', { eventType: (event as any).eventType });
        continue;
      }

      if (!groupedMessages[topic]) {
        groupedMessages[topic] = [];
      }

      groupedMessages[topic].push(createKafkaMessage(event, key));
    }

    // Send batched messages
    try {
      const promises = Object.entries(groupedMessages).map(([topic, messages]) =>
        this.producer.send({ topic, messages })
      );

      await Promise.all(promises);

      logger.info('Batch events published', {
        totalEvents: events.length,
        topics: Object.keys(groupedMessages),
      });
    } catch (error) {
      logger.error('Failed to publish batch events', { error });
      throw error;
    }
  }
}
