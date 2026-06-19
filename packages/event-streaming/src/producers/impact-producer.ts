// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Event Producer for HappyCMDB v3.0
 *
 * Publishes impact scoring and business service events to Kafka
 */

import { Producer } from 'kafkajs';
import { createProducer } from '../utils/kafka-client';
import { KAFKA_TOPICS } from '../config/topics';
import {
  ImpactScoreCalculatedEvent,
  BusinessServiceUpdatedEvent,
  ApplicationServiceUpdatedEvent,
  ImpactAnalysisTriggeredEvent,
  ImpactAnalysisCompletedEvent,
} from '../events/impact-events';
import { createKafkaMessage, validateEvent } from '../utils/serialization';
import { logger, logEventProduced, logEventError } from '../utils/logger';

/**
 * Impact Event Producer
 */
export class ImpactProducer {
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
      logger.info('Impact producer connected');
    } catch (error) {
      logger.error('Failed to connect impact producer', { error });
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
      logger.info('Impact producer disconnected');
    } catch (error) {
      logger.error('Failed to disconnect impact producer', { error });
      throw error;
    }
  }

  /**
   * Publish impact score calculated event
   */
  async publishImpactScore(event: ImpactScoreCalculatedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid impact score event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.entityId);

      await this.producer.send({
        topic: KAFKA_TOPICS.IMPACT_CALCULATED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.IMPACT_CALCULATED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.IMPACT_CALCULATED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish business service updated event
   */
  async publishBusinessServiceUpdated(event: BusinessServiceUpdatedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid business service event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.businessServiceId);

      await this.producer.send({
        topic: KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish application service updated event
   */
  async publishApplicationServiceUpdated(event: ApplicationServiceUpdatedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid application service event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.applicationServiceId);

      await this.producer.send({
        topic: KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish impact analysis triggered event
   */
  async publishImpactAnalysisTriggered(event: ImpactAnalysisTriggeredEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid impact analysis triggered event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.analysisId);

      await this.producer.send({
        topic: KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED, event.eventId, error as Error);
      throw error;
    }
  }

  /**
   * Publish impact analysis completed event
   */
  async publishImpactAnalysisCompleted(event: ImpactAnalysisCompletedEvent): Promise<void> {
    if (!validateEvent(event)) {
      throw new Error('Invalid impact analysis completed event');
    }

    try {
      const message = createKafkaMessage(event, event.payload.analysisId);

      await this.producer.send({
        topic: KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED,
        messages: [message],
      });

      logEventProduced(KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED, event.eventId, event.eventType);
    } catch (error) {
      logEventError(KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED, event.eventId, error as Error);
      throw error;
    }
  }
}
