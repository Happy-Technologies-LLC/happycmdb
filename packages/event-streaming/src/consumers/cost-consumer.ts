// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost Event Consumer for HappyCMDB v3.0
 *
 * Consumes cost allocation, update, and anomaly events from Kafka
 */

import { Consumer, EachMessagePayload } from 'kafkajs';
import { createConsumer } from '../utils/kafka-client';
import { CONSUMER_GROUPS } from '../config/kafka-config';
import { KAFKA_TOPICS } from '../config/topics';
import { CostEvent } from '../events/cost-events';
import { deserializeEvent } from '../utils/serialization';
import { logger, logEventConsumed, logEventError } from '../utils/logger';

/**
 * Event handler type
 */
export type CostEventHandler = (event: CostEvent) => Promise<void>;

/**
 * Cost Event Consumer
 */
export class CostConsumer {
  private consumer: Consumer;
  private connected: boolean = false;
  private handler: CostEventHandler | null = null;

  constructor(groupId: string = CONSUMER_GROUPS.COST) {
    this.consumer = createConsumer(groupId);
  }

  /**
   * Connect to Kafka and subscribe to topics
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.consumer.connect();
      this.connected = true;
      logger.info('Cost consumer connected');

      await this.consumer.subscribe({
        topics: [
          KAFKA_TOPICS.COST_ALLOCATED,
          KAFKA_TOPICS.COST_UPDATED,
          KAFKA_TOPICS.COST_ANOMALY_DETECTED,
          KAFKA_TOPICS.COST_BUDGET_EXCEEDED,
        ],
        fromBeginning: false,
      });

      logger.info('Cost consumer subscribed to topics');
    } catch (error) {
      logger.error('Failed to connect cost consumer', { error });
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
      logger.info('Cost consumer disconnected');
    } catch (error) {
      logger.error('Failed to disconnect cost consumer', { error });
      throw error;
    }
  }

  /**
   * Start consuming events
   */
  async startConsuming(handler: CostEventHandler): Promise<void> {
    this.handler = handler;

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      },
    });

    logger.info('Cost consumer started');
  }

  /**
   * Handle individual message
   */
  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;

    try {
      const event = deserializeEvent(message);

      if (!event) {
        logger.warn('Failed to deserialize cost event', {
          topic,
          partition,
          offset: message.offset,
        });
        return;
      }

      logEventConsumed(topic, event.eventId, event.eventType, partition, message.offset);

      if (this.handler) {
        await this.handler(event as CostEvent);
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
      { topic: KAFKA_TOPICS.COST_ALLOCATED },
      { topic: KAFKA_TOPICS.COST_UPDATED },
      { topic: KAFKA_TOPICS.COST_ANOMALY_DETECTED },
      { topic: KAFKA_TOPICS.COST_BUDGET_EXCEEDED },
    ]);
    logger.info('Cost consumer paused');
  }

  /**
   * Resume consumption
   */
  async resume(): Promise<void> {
    this.consumer.resume([
      { topic: KAFKA_TOPICS.COST_ALLOCATED },
      { topic: KAFKA_TOPICS.COST_UPDATED },
      { topic: KAFKA_TOPICS.COST_ANOMALY_DETECTED },
      { topic: KAFKA_TOPICS.COST_BUDGET_EXCEEDED },
    ]);
    logger.info('Cost consumer resumed');
  }
}
