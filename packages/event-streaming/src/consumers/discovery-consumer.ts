// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Event Consumer for HappyCMDB v3.0
 *
 * Consumes CI discovery, update, and relationship events from Kafka
 */

import { Consumer, EachMessagePayload } from 'kafkajs';
import { createConsumer } from '../utils/kafka-client';
import { CONSUMER_GROUPS } from '../config/kafka-config';
import { KAFKA_TOPICS } from '../config/topics';
import { DiscoveryEvent } from '../events/discovery-events';
import { deserializeEvent } from '../utils/serialization';
import { logger, logEventConsumed, logEventError } from '../utils/logger';

/**
 * Event handler type
 */
export type DiscoveryEventHandler = (event: DiscoveryEvent) => Promise<void>;

/**
 * Discovery Event Consumer
 */
export class DiscoveryConsumer {
  private consumer: Consumer;
  private connected: boolean = false;
  private handler: DiscoveryEventHandler | null = null;

  constructor(groupId: string = CONSUMER_GROUPS.DISCOVERY) {
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
      logger.info('Discovery consumer connected');

      await this.consumer.subscribe({
        topics: [
          KAFKA_TOPICS.CI_DISCOVERED,
          KAFKA_TOPICS.CI_UPDATED,
          KAFKA_TOPICS.CI_DELETED,
          KAFKA_TOPICS.RELATIONSHIP_CREATED,
          KAFKA_TOPICS.RELATIONSHIP_DELETED,
        ],
        fromBeginning: false,
      });

      logger.info('Discovery consumer subscribed to topics');
    } catch (error) {
      logger.error('Failed to connect discovery consumer', { error });
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
      logger.info('Discovery consumer disconnected');
    } catch (error) {
      logger.error('Failed to disconnect discovery consumer', { error });
      throw error;
    }
  }

  /**
   * Start consuming events
   */
  async startConsuming(handler: DiscoveryEventHandler): Promise<void> {
    this.handler = handler;

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      },
    });

    logger.info('Discovery consumer started');
  }

  /**
   * Handle individual message
   */
  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;

    try {
      const event = deserializeEvent(message);

      if (!event) {
        logger.warn('Failed to deserialize discovery event', {
          topic,
          partition,
          offset: message.offset,
        });
        return;
      }

      logEventConsumed(topic, event.eventId, event.eventType, partition, message.offset);

      if (this.handler) {
        await this.handler(event as DiscoveryEvent);
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
    ]);
    logger.info('Discovery consumer paused');
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
    ]);
    logger.info('Discovery consumer resumed');
  }
}
