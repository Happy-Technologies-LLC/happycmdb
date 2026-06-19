// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Event Producer for HappyCMDB v3.0
 *
 * Publishes cost allocation, update, and anomaly events to Kafka
 */

import { Producer } from 'kafkajs';
import { createProducer } from '../utils/kafka-client';
import { KAFKA_TOPICS } from '../config/topics';
import {
  CostAllocationEvent,
  CostAllocationUpdatedEvent,
  CostAnomalyDetectedEvent,
  CostBudgetExceededEvent,
} from '../events/cost-events';
import { createKafkaMessage, validateEvent } from '../utils/serialization';
import { logger, logEventProduced, logEventError } from '../utils/logger';

/**
 * Cost Event Producer
 */
export class CostProducer {
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
      logger.info('Cost producer connected');
    } catch (error) {
      logger.error('Failed to connect cost producer', { error });
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
      logger.info('Cost producer disconnected');
    } catch (error) {
      logger.error('Failed to disconnect cost producer', { error });
      throw error;
    }
  }

  /**
   * Publish cost allocation event
   */
  async publishCostAllocation(event: CostAllocationEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid cost allocation event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.ciId);

      await this.producer.send({
        topic: KAFKA_TOPICS.COST_ALLOCATED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.COST_ALLOCATED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.COST_ALLOCATED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish cost update event
   */
  async publishCostUpdate(event: CostAllocationUpdatedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid cost update event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.ciId);

      await this.producer.send({
        topic: KAFKA_TOPICS.COST_UPDATED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.COST_UPDATED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.COST_UPDATED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish cost anomaly detected event
   */
  async publishCostAnomaly(event: CostAnomalyDetectedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid cost anomaly event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.ciId);

      await this.producer.send({
        topic: KAFKA_TOPICS.COST_ANOMALY_DETECTED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.COST_ANOMALY_DETECTED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.COST_ANOMALY_DETECTED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish budget exceeded event
   */
  async publishBudgetExceeded(event: CostBudgetExceededEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid budget exceeded event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.budgetId);

      await this.producer.send({
        topic: KAFKA_TOPICS.COST_BUDGET_EXCEEDED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.COST_BUDGET_EXCEEDED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.COST_BUDGET_EXCEEDED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish multiple cost events in a batch
   */
  async publishBatch(events: Array<CostAllocationEvent | CostAllocationUpdatedEvent>): Promise<void> {
    const groupedMessages: Record<string, any[]> = {};

    // Group messages by topic
    for (const event of events) {
      if (!validateEvent(event)) {
        logger.warn('Skipping invalid event in batch', { eventId: event.eventId });
        continue;
      }

      let topic: string = '';
      const key = event.payload.ciId;

      if (event.eventType === 'cost.allocated') {
        topic = KAFKA_TOPICS.COST_ALLOCATED;
      } else if (event.eventType === 'cost.updated') {
        topic = KAFKA_TOPICS.COST_UPDATED;
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

      logger.info('Batch cost events published', {
        totalEvents: events.length,
        topics: Object.keys(groupedMessages),
      });
    } catch (error) {
      logger.error('Failed to publish batch cost events', { error });
      throw error;
    }
  }
}
