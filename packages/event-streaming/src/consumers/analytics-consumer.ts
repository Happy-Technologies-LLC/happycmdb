// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Analytics Event Consumer for HappyCMDB v3.0
 *
 * Consumes all events for analytics and aggregation
 */

import { Consumer, EachMessagePayload } from 'kafkajs';
import { createConsumer } from '../utils/kafka-client';
import { CONSUMER_GROUPS } from '../config/kafka-config';
import { KAFKA_TOPICS } from '../config/topics';
import { CMDBEvent } from '../events';
import { deserializeEvent } from '../utils/serialization';
import { logger, logEventConsumed, logEventError } from '../utils/logger';

/**
 * Event handler type
 */
export type AnalyticsEventHandler = (event: CMDBEvent) => Promise<void>;

/**
 * Analytics Event Consumer
 *
 * Subscribes to all CMDB event topics for analytics processing
 */
export class AnalyticsConsumer {
  private consumer: Consumer;
  private connected: boolean = false;
  private handler: AnalyticsEventHandler | null = null;

  constructor(groupId: string = CONSUMER_GROUPS.ANALYTICS) {
    this.consumer = createConsumer(groupId);
  }

  /**
   * Connect to Kafka and subscribe to all topics
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.consumer.connect();
      this.connected = true;
      logger.info('Analytics consumer connected');

      // Subscribe to all CMDB topics
      await this.consumer.subscribe({
        topics: [
          // Discovery topics
          KAFKA_TOPICS.CI_DISCOVERED,
          KAFKA_TOPICS.CI_UPDATED,
          KAFKA_TOPICS.CI_DELETED,
          KAFKA_TOPICS.RELATIONSHIP_CREATED,
          KAFKA_TOPICS.RELATIONSHIP_DELETED,
          // Cost topics
          KAFKA_TOPICS.COST_ALLOCATED,
          KAFKA_TOPICS.COST_UPDATED,
          KAFKA_TOPICS.COST_ANOMALY_DETECTED,
          KAFKA_TOPICS.COST_BUDGET_EXCEEDED,
          // Impact topics
          KAFKA_TOPICS.IMPACT_CALCULATED,
          KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED,
          KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED,
          KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED,
          KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED,
        ],
        fromBeginning: true, // For analytics, process historical data
      });

      logger.info('Analytics consumer subscribed to all topics');
    } catch (error) {
      logger.error('Failed to connect analytics consumer', { error });
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
      await this.consumer.disconnect();
      this.connected = false;
      logger.info('Analytics consumer disconnected');
    } catch (error) {
      logger.error('Failed to disconnect analytics consumer', { error });
      throw error;
    }
  }

  /**
   * Start consuming events
   */
  async startConsuming(handler: AnalyticsEventHandler): Promise<void> {
    this.handler = handler;

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      },
    });

    logger.info('Analytics consumer started');
  }

  /**
   * Handle individual message
   */
  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;

    try {
      const event = deserializeEvent(message);

      if (!event) {
        logger.warn('Failed to deserialize event for analytics', {
          topic,
          partition,
          offset: message.offset,
        });
        return;
      }

      logEventConsumed(topic, event.eventId, event.eventType, partition, message.offset);

      if (this.handler) {
        await this.handler(event as CMDBEvent);
      }
    } catch (error) {
      logEventError(topic, 'unknown', error as Error);
      // Don't throw - let consumer continue processing other messages
    }
  }

  /**
   * Pause consumption
   */
  async pause(): Promise<void> {
    this.consumer.pause([
      { topic: KAFKA_TOPICS.CI_DISCOVERED },
      { topic: KAFKA_TOPICS.CI_UPDATED },
      { topic: KAFKA_TOPICS.CI_DELETED },
      { topic: KAFKA_TOPICS.RELATIONSHIP_CREATED },
      { topic: KAFKA_TOPICS.RELATIONSHIP_DELETED },
      { topic: KAFKA_TOPICS.COST_ALLOCATED },
      { topic: KAFKA_TOPICS.COST_UPDATED },
      { topic: KAFKA_TOPICS.COST_ANOMALY_DETECTED },
      { topic: KAFKA_TOPICS.COST_BUDGET_EXCEEDED },
      { topic: KAFKA_TOPICS.IMPACT_CALCULATED },
      { topic: KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED },
      { topic: KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED },
      { topic: KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED },
      { topic: KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED },
    ]);
    logger.info('Analytics consumer paused');
  }

  /**
   * Resume consumption
   */
  async resume(): Promise<void> {
    this.consumer.resume([
      { topic: KAFKA_TOPICS.CI_DISCOVERED },
      { topic: KAFKA_TOPICS.CI_UPDATED },
      { topic: KAFKA_TOPICS.CI_DELETED },
      { topic: KAFKA_TOPICS.RELATIONSHIP_CREATED },
      { topic: KAFKA_TOPICS.RELATIONSHIP_DELETED },
      { topic: KAFKA_TOPICS.COST_ALLOCATED },
      { topic: KAFKA_TOPICS.COST_UPDATED },
      { topic: KAFKA_TOPICS.COST_ANOMALY_DETECTED },
      { topic: KAFKA_TOPICS.COST_BUDGET_EXCEEDED },
      { topic: KAFKA_TOPICS.IMPACT_CALCULATED },
      { topic: KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED },
      { topic: KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED },
      { topic: KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED },
      { topic: KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED },
    ]);
    logger.info('Analytics consumer resumed');
  }
}
