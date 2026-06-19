// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Kafka Topics Configuration for HappyCMDB v3.0
 *
 * Defines all Kafka topics used across the platform
 */

/**
 * Topic naming convention: cmdb.{domain}.{action}
 */
export const KAFKA_TOPICS = {
  // Discovery topics
  CI_DISCOVERED: 'cmdb.ci.discovered',
  CI_UPDATED: 'cmdb.ci.updated',
  CI_DELETED: 'cmdb.ci.deleted',
  RELATIONSHIP_CREATED: 'cmdb.relationship.created',
  RELATIONSHIP_DELETED: 'cmdb.relationship.deleted',

  // Cost topics
  COST_ALLOCATED: 'cmdb.cost.allocated',
  COST_UPDATED: 'cmdb.cost.updated',
  COST_ANOMALY_DETECTED: 'cmdb.cost.anomaly.detected',
  COST_BUDGET_EXCEEDED: 'cmdb.cost.budget.exceeded',

  // Impact topics
  IMPACT_CALCULATED: 'cmdb.impact.calculated',
  BUSINESS_SERVICE_UPDATED: 'cmdb.business-service.updated',
  APPLICATION_SERVICE_UPDATED: 'cmdb.application-service.updated',
  IMPACT_ANALYSIS_TRIGGERED: 'cmdb.impact.analysis.triggered',
  IMPACT_ANALYSIS_COMPLETED: 'cmdb.impact.analysis.completed',

  // Analytics topics
  ANALYTICS_RAW: 'cmdb.analytics.raw',
  ANALYTICS_AGGREGATED: 'cmdb.analytics.aggregated',

  // Dead letter queue
  DLQ: 'cmdb.dlq',
} as const;

/**
 * Topic configuration for creation
 */
export interface TopicConfig {
  topic: string;
  numPartitions: number;
  replicationFactor: number;
  configEntries?: Array<{
    name: string;
    value: string;
  }>;
}

/**
 * Default topic configurations
 */
export const TOPIC_CONFIGS: TopicConfig[] = [
  // Discovery topics - higher throughput
  {
    topic: KAFKA_TOPICS.CI_DISCOVERED,
    numPartitions: 6,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '604800000' }, // 7 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.CI_UPDATED,
    numPartitions: 6,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '604800000' }, // 7 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.CI_DELETED,
    numPartitions: 3,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.RELATIONSHIP_CREATED,
    numPartitions: 3,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '604800000' }, // 7 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.RELATIONSHIP_DELETED,
    numPartitions: 3,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },

  // Cost topics - medium throughput
  {
    topic: KAFKA_TOPICS.COST_ALLOCATED,
    numPartitions: 3,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.COST_UPDATED,
    numPartitions: 3,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.COST_ANOMALY_DETECTED,
    numPartitions: 2,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.COST_BUDGET_EXCEEDED,
    numPartitions: 2,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },

  // Impact topics - lower throughput
  {
    topic: KAFKA_TOPICS.IMPACT_CALCULATED,
    numPartitions: 3,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '1209600000' }, // 14 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED,
    numPartitions: 2,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED,
    numPartitions: 2,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '2592000000' }, // 30 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED,
    numPartitions: 2,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '604800000' }, // 7 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED,
    numPartitions: 2,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '604800000' }, // 7 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },

  // Analytics topics - high volume
  {
    topic: KAFKA_TOPICS.ANALYTICS_RAW,
    numPartitions: 12,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '86400000' }, // 24 hours
      { name: 'compression.type', value: 'snappy' },
    ],
  },
  {
    topic: KAFKA_TOPICS.ANALYTICS_AGGREGATED,
    numPartitions: 6,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '604800000' }, // 7 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },

  // Dead letter queue - low volume, long retention
  {
    topic: KAFKA_TOPICS.DLQ,
    numPartitions: 1,
    replicationFactor: 1,
    configEntries: [
      { name: 'retention.ms', value: '7776000000' }, // 90 days
      { name: 'compression.type', value: 'snappy' },
    ],
  },
];

/**
 * Get topic by event type
 */
export function getTopicForEventType(eventType: string): string {
  const topicMap: Record<string, string> = {
    'ci.discovered': KAFKA_TOPICS.CI_DISCOVERED,
    'ci.updated': KAFKA_TOPICS.CI_UPDATED,
    'ci.deleted': KAFKA_TOPICS.CI_DELETED,
    'relationship.created': KAFKA_TOPICS.RELATIONSHIP_CREATED,
    'relationship.deleted': KAFKA_TOPICS.RELATIONSHIP_DELETED,
    'cost.allocated': KAFKA_TOPICS.COST_ALLOCATED,
    'cost.updated': KAFKA_TOPICS.COST_UPDATED,
    'cost.anomaly.detected': KAFKA_TOPICS.COST_ANOMALY_DETECTED,
    'cost.budget.exceeded': KAFKA_TOPICS.COST_BUDGET_EXCEEDED,
    'impact.calculated': KAFKA_TOPICS.IMPACT_CALCULATED,
    'business-service.updated': KAFKA_TOPICS.BUSINESS_SERVICE_UPDATED,
    'application-service.updated': KAFKA_TOPICS.APPLICATION_SERVICE_UPDATED,
    'impact.analysis.triggered': KAFKA_TOPICS.IMPACT_ANALYSIS_TRIGGERED,
    'impact.analysis.completed': KAFKA_TOPICS.IMPACT_ANALYSIS_COMPLETED,
  };

  return topicMap[eventType] || KAFKA_TOPICS.DLQ;
}
