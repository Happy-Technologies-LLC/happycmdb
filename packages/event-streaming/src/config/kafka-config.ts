// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Kafka Configuration for HappyCMDB v3.0
 *
 * Centralized Kafka client configuration
 */

import { KafkaConfig, ProducerConfig, ConsumerConfig, logLevel } from 'kafkajs';

/**
 * Environment variable configuration
 */
export interface KafkaEnvConfig {
  brokers: string[];
  clientId: string;
  connectionTimeout?: number;
  requestTimeout?: number;
  ssl?: boolean;
  sasl?: {
    mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
    username: string;
    password: string;
  };
}

/**
 * Get Kafka configuration from environment variables
 */
export function getKafkaConfig(): KafkaEnvConfig {
  const brokers = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
  const clientId = process.env.KAFKA_CLIENT_ID || 'cmdb-event-streaming';

  const config: KafkaEnvConfig = {
    brokers,
    clientId,
    connectionTimeout: parseInt(process.env.KAFKA_CONNECTION_TIMEOUT || '30000', 10),
    requestTimeout: parseInt(process.env.KAFKA_REQUEST_TIMEOUT || '30000', 10),
  };

  // SSL configuration
  if (process.env.KAFKA_SSL_ENABLED === 'true') {
    config.ssl = true;
  }

  // SASL authentication
  if (process.env.KAFKA_SASL_ENABLED === 'true') {
    const mechanism = process.env.KAFKA_SASL_MECHANISM || 'plain';
    const username = process.env.KAFKA_SASL_USERNAME || '';
    const password = process.env.KAFKA_SASL_PASSWORD || '';

    if (mechanism === 'plain') {
      config.sasl = { mechanism: 'plain', username, password };
    } else if (mechanism === 'scram-sha-256') {
      config.sasl = { mechanism: 'scram-sha-256', username, password };
    } else if (mechanism === 'scram-sha-512') {
      config.sasl = { mechanism: 'scram-sha-512', username, password };
    }
  }

  return config;
}

/**
 * Build KafkaJS configuration
 */
export function buildKafkaConfig(envConfig: KafkaEnvConfig): KafkaConfig {
  const config: KafkaConfig = {
    clientId: envConfig.clientId,
    brokers: envConfig.brokers,
    connectionTimeout: envConfig.connectionTimeout || 30000,
    requestTimeout: envConfig.requestTimeout || 30000,
    retry: {
      initialRetryTime: 100,
      retries: 8,
      maxRetryTime: 30000,
      multiplier: 2,
      factor: 0.2,
    },
    logLevel: logLevel.INFO,
  };

  if (envConfig.ssl) {
    config.ssl = envConfig.ssl;
  }

  if (envConfig.sasl) {
    config.sasl = envConfig.sasl as any;
  }

  return config;
}

/**
 * Default producer configuration
 */
export const DEFAULT_PRODUCER_CONFIG: ProducerConfig = {
  allowAutoTopicCreation: true,
  transactionTimeout: 30000,
  retry: {
    initialRetryTime: 100,
    retries: 8,
    maxRetryTime: 30000,
    multiplier: 2,
    factor: 0.2,
  },
  idempotent: true, // Exactly-once semantics
  maxInFlightRequests: 5,
};

/**
 * Default consumer configuration
 */
export function getDefaultConsumerConfig(groupId: string): ConsumerConfig {
  return {
    groupId,
    sessionTimeout: 30000,
    rebalanceTimeout: 60000,
    heartbeatInterval: 3000,
    maxBytesPerPartition: 1048576, // 1MB
    retry: {
      initialRetryTime: 100,
      retries: 8,
      maxRetryTime: 30000,
      multiplier: 2,
      factor: 0.2,
    },
  };
}

/**
 * Consumer group IDs
 */
export const CONSUMER_GROUPS = {
  ANALYTICS: 'cmdb-analytics-group',
  DISCOVERY: 'cmdb-discovery-group',
  COST: 'cmdb-cost-group',
  IMPACT: 'cmdb-impact-group',
  DATA_MART: 'cmdb-data-mart-group',
  AUDIT: 'cmdb-audit-group',
} as const;
