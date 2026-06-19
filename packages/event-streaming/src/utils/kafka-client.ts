// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Kafka Client Utilities for HappyCMDB v3.0
 *
 * Singleton Kafka client and admin utilities
 */

import { Kafka, Admin, Producer, Consumer } from 'kafkajs';
import { getKafkaConfig, buildKafkaConfig, DEFAULT_PRODUCER_CONFIG, getDefaultConsumerConfig } from '../config/kafka-config';
import { TOPIC_CONFIGS } from '../config/topics';
import { logger } from './logger';

/**
 * Singleton Kafka client instance
 */
let kafkaClient: Kafka | null = null;

/**
 * Get or create Kafka client instance
 */
export function getKafkaClient(): Kafka {
  if (!kafkaClient) {
    const envConfig = getKafkaConfig();
    const config = buildKafkaConfig(envConfig);

    kafkaClient = new Kafka(config);
    logger.info('Kafka client initialized', {
      brokers: envConfig.brokers,
      clientId: envConfig.clientId,
    });
  }

  return kafkaClient;
}

/**
 * Create Kafka admin client
 */
export function createAdminClient(): Admin {
  const kafka = getKafkaClient();
  return kafka.admin();
}

/**
 * Create Kafka producer
 */
export function createProducer(): Producer {
  const kafka = getKafkaClient();
  return kafka.producer(DEFAULT_PRODUCER_CONFIG);
}

/**
 * Create Kafka consumer
 */
export function createConsumer(groupId: string): Consumer {
  const kafka = getKafkaClient();
  const config = getDefaultConsumerConfig(groupId);
  return kafka.consumer(config);
}

/**
 * Initialize Kafka topics
 */
export async function initializeTopics(): Promise<void> {
  const admin = createAdminClient();

  try {
    await admin.connect();
    logger.info('Connected to Kafka admin client');

    // Get existing topics
    const existingTopics = await admin.listTopics();
    logger.info('Existing topics', { topics: existingTopics });

    // Filter topics that need to be created
    const topicsToCreate = TOPIC_CONFIGS.filter(
      (config) => !existingTopics.includes(config.topic)
    );

    if (topicsToCreate.length > 0) {
      logger.info('Creating topics', {
        count: topicsToCreate.length,
        topics: topicsToCreate.map((t) => t.topic),
      });

      await admin.createTopics({
        topics: topicsToCreate.map((config) => ({
          topic: config.topic,
          numPartitions: config.numPartitions,
          replicationFactor: config.replicationFactor,
          configEntries: config.configEntries,
        })),
        waitForLeaders: true,
      });

      logger.info('Topics created successfully');
    } else {
      logger.info('All topics already exist');
    }

    await admin.disconnect();
  } catch (error) {
    logger.error('Failed to initialize topics', { error });
    throw error;
  }
}

/**
 * Delete a topic (for testing/cleanup)
 */
export async function deleteTopic(topic: string): Promise<void> {
  const admin = createAdminClient();

  try {
    await admin.connect();
    await admin.deleteTopics({ topics: [topic] });
    logger.info('Topic deleted', { topic });
    await admin.disconnect();
  } catch (error) {
    logger.error('Failed to delete topic', { topic, error });
    throw error;
  }
}

/**
 * Get topic metadata
 */
export async function getTopicMetadata(topics: string[]): Promise<any> {
  const admin = createAdminClient();

  try {
    await admin.connect();
    const metadata = await admin.fetchTopicMetadata({ topics });
    await admin.disconnect();
    return metadata;
  } catch (error) {
    logger.error('Failed to fetch topic metadata', { topics, error });
    throw error;
  }
}

/**
 * List all consumer groups
 */
export async function listConsumerGroups(): Promise<any> {
  const admin = createAdminClient();

  try {
    await admin.connect();
    const groups = await admin.listGroups();
    await admin.disconnect();
    return groups;
  } catch (error) {
    logger.error('Failed to list consumer groups', { error });
    throw error;
  }
}

/**
 * Check Kafka connection health
 */
export async function checkKafkaHealth(): Promise<boolean> {
  const admin = createAdminClient();

  try {
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    return true;
  } catch (error) {
    logger.error('Kafka health check failed', { error });
    return false;
  }
}

/**
 * Graceful shutdown of Kafka connections
 */
export async function shutdownKafka(): Promise<void> {
  logger.info('Shutting down Kafka connections');
  // Kafka clients handle their own cleanup
  kafkaClient = null;
}
