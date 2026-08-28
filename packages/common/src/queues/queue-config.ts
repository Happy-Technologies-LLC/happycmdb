// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Queue Configuration Definitions
 *
 * This module defines all queue configurations for the CMDB platform,
 * including job options, rate limiting, and retry strategies.
 */

import { QueueConfig, JobOptions } from '../types/job.types';

/**
 * Default job options for all queues
 */
const DEFAULT_JOB_OPTIONS: JobOptions = {
  _attempts: 3,
  _backoff: {
    _type: 'exponential',
    _delay: 2000, // 2 seconds initial delay
  },
  _timeout: 300000, // 5 minutes default timeout
  removeOnComplete: 100, // Keep last 100 completed jobs
  removeOnFail: 500, // Keep last 500 failed jobs
};

/**
 * Discovery job options - longer timeout for cloud API calls
 */
const DISCOVERY_JOB_OPTIONS: JobOptions = {
  ...DEFAULT_JOB_OPTIONS,
  _timeout: 900000, // 15 minutes for discovery jobs
  _attempts: 3,
  _backoff: {
    _type: 'exponential',
    _delay: 5000, // 5 seconds initial delay
  },
};

/**
 * ETL job options - optimized for batch processing
 */
const ETL_JOB_OPTIONS: JobOptions = {
  ...DEFAULT_JOB_OPTIONS,
  _timeout: 1800000, // 30 minutes for ETL jobs
  _attempts: 2,
  _backoff: {
    _type: 'exponential',
    _delay: 10000, // 10 seconds initial delay
  },
};

/**
 * Queue configurations for all job types
 */
export const QUEUE_CONFIGS: Record<string, QueueConfig> = {
  // Discovery queues
  'discovery-aws': {
    name: 'discovery-aws',
    _defaultJobOptions: DISCOVERY_JOB_OPTIONS,
    limiter: {
      _max: 10, // Max 10 jobs per minute (AWS API rate limits)
      _duration: 60000,
    },
  },
  'discovery-azure': {
    name: 'discovery-azure',
    _defaultJobOptions: DISCOVERY_JOB_OPTIONS,
    limiter: {
      _max: 10, // Max 10 jobs per minute
      _duration: 60000,
    },
  },
  'discovery-gcp': {
    name: 'discovery-gcp',
    _defaultJobOptions: DISCOVERY_JOB_OPTIONS,
    limiter: {
      _max: 10, // Max 10 jobs per minute
      _duration: 60000,
    },
  },
  'discovery-ssh': {
    name: 'discovery-ssh',
    _defaultJobOptions: {
      ...DISCOVERY_JOB_OPTIONS,
      _timeout: 600000, // 10 minutes for SSH discovery
    },
    limiter: {
      _max: 20, // Max 20 SSH connections per minute
      _duration: 60000,
    },
  },
  'discovery-nmap': {
    name: 'discovery-nmap',
    _defaultJobOptions: {
      ...DISCOVERY_JOB_OPTIONS,
      _timeout: 1800000, // 30 minutes for network scans
    },
    limiter: {
      _max: 5, // Max 5 scans per minute (resource intensive)
      _duration: 60000,
    },
  },

  // ETL queues
  'etl-sync': {
    name: 'etl-sync',
    _defaultJobOptions: ETL_JOB_OPTIONS,
    limiter: {
      _max: 20, // Max 20 sync jobs per minute
      _duration: 60000,
    },
  },
  'etl-full-refresh': {
    name: 'etl-full-refresh',
    _defaultJobOptions: {
      ...ETL_JOB_OPTIONS,
      _timeout: 3600000, // 1 hour for full refresh
      priority: 1, // Lower priority
    },
    limiter: {
      _max: 2, // Max 2 full refresh jobs per hour
      _duration: 3600000,
    },
  },
  'etl-change-detection': {
    name: 'etl-change-detection',
    _defaultJobOptions: ETL_JOB_OPTIONS,
    limiter: {
      _max: 30, // Max 30 change detection jobs per minute
      _duration: 60000,
    },
  },
  'etl-reconciliation': {
    name: 'etl-reconciliation',
    _defaultJobOptions: {
      ...ETL_JOB_OPTIONS,
      _timeout: 2400000, // 40 minutes for reconciliation
    },
    limiter: {
      _max: 10, // Max 10 reconciliation jobs per minute
      _duration: 60000,
    },
  },
};

/**
 * Queue names constants for easy reference
 *
 * NOTE: BullMQ v5's Queue/Worker constructor rejects names containing ':'
 * ("Queue name cannot contain :"), so these use hyphens instead of colons,
 * matching the convention already used in packages/database/src/bullmq/queue-manager.ts.
 */
export const QUEUE_NAMES = {
  // Discovery queues
  _DISCOVERY_AWS: 'discovery-aws',
  _DISCOVERY_AZURE: 'discovery-azure',
  _DISCOVERY_GCP: 'discovery-gcp',
  _DISCOVERY_SSH: 'discovery-ssh',
  _DISCOVERY_NMAP: 'discovery-nmap',

  // ETL queues
  _ETL_SYNC: 'etl-sync',
  _ETL_FULL_REFRESH: 'etl-full-refresh',
  _ETL_CHANGE_DETECTION: 'etl-change-detection',
  _ETL_RECONCILIATION: 'etl-reconciliation',
} as const;

/**
 * Get queue configuration by name
 */
export function getQueueConfig(queueName: string): QueueConfig {
  const config = QUEUE_CONFIGS[queueName];
  if (!config) {
    throw new Error(`Queue configuration not found for: ${queueName}`);
  }
  return config;
}

/**
 * Get all discovery queue names
 */
export function getDiscoveryQueueNames(): string[] {
  return Object.values(QUEUE_NAMES).filter((name) => name.startsWith('discovery-'));
}

/**
 * Get all ETL queue names
 */
export function getETLQueueNames(): string[] {
  return Object.values(QUEUE_NAMES).filter((name) => name.startsWith('etl-'));
}
