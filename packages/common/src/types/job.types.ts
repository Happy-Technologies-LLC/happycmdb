// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Job Type Definitions
 *
 * This module contains all TypeScript types and interfaces for BullMQ job scheduling
 * and orchestration in the CMDB platform.
 */

import { DiscoveryProvider } from './discovery.types';

/**
 * Job Data - Base interface for all job data
 */
export interface BaseJobData {
  /** Unique identifier for tracking */
  _jobId: string;
  /** Verified tenant for API-triggered jobs. Jobs without it are inaccessible via tenant APIs. */
  organizationId?: string;
  /** User or system that triggered the job */
  triggeredBy?: string;
  /** Timestamp when job was created */
  _createdAt: string;
}

/**
 * Discovery Job Data - Data for discovery jobs
 */
export interface DiscoveryJobData extends BaseJobData {
  /** Provider to discover */
  _provider: DiscoveryProvider;
  /** Configuration for discovery */
  _config: DiscoveryJobConfig;
  /** Optional: Discovery definition ID (if triggered from a definition) */
  definition_id?: string;
}

/**
 * Discovery Job Configuration
 */
export interface DiscoveryJobConfig {
  /** Regions to discover (cloud providers) */
  regions?: string[];
  /** Resource types to discover */
  resourceTypes?: string[];
  /** Filters to apply */
  filters?: Record<string, any>;
  /** Target hosts (SSH/Nmap) */
  targets?: string[];
  /** Credentials reference (stored securely) */
  credentialsId?: string;
}

/**
 * ETL Job Data - Data for ETL jobs
 */
export interface ETLJobData extends BaseJobData {
  /** Type of ETL job */
  _type: ETLJobType;
  /** Configuration for ETL job */
  _config: ETLJobConfig;
}

/**
 * ETL Job Type
 */
export type ETLJobType =
  | 'sync'              // Incremental sync from Neo4j to PostgreSQL
  | 'full-refresh'      // Full data refresh
  | 'change-detection'  // Detect and process changes
  | 'reconciliation';   // Data reconciliation

/**
 * ETL Job Configuration
 */
export interface ETLJobConfig {
  /** Source database */
  source?: 'neo4j' | 'postgres';
  /** Target database */
  target?: 'neo4j' | 'postgres';
  /** Batch size for processing */
  batchSize?: number;
  /** Date range for incremental jobs */
  dateRange?: {
    _from: string;
    _to: string;
  };
  /** Tables/collections to process */
  tables?: string[];
}

/**
 * Job Result - Result data from completed jobs
 */
export interface JobResult {
  /** Job ID */
  _jobId: string;
  /** Job status */
  _status: JobResultStatus;
  /** Number of items processed */
  _itemsProcessed: number;
  /** Number of items created */
  _itemsCreated: number;
  /** Number of items updated */
  _itemsUpdated: number;
  /** Number of items failed */
  _itemsFailed: number;
  /** Start timestamp */
  _startedAt: string;
  /** Completion timestamp */
  _completedAt: string;
  /** Duration in milliseconds */
  _durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Job Result Status
 */
export type JobResultStatus = 'completed' | 'failed' | 'partial';

/**
 * Job Progress - Progress tracking data
 */
export interface JobProgress {
  /** Current progress (0-100) */
  _percent: number;
  /** Current step/phase */
  _currentStep: string;
  /** Total steps */
  _totalSteps: number;
  /** Items processed so far */
  _itemsProcessed: number;
  /** Total items to process */
  totalItems?: number;
  /** Start timestamp */
  _startedAt: string;
  /** Last update timestamp */
  _updatedAt: string;
}

/**
 * Queue Configuration
 */
export interface QueueConfig {
  /** Queue name */
  name: string;
  /** Default job options */
  _defaultJobOptions: JobOptions;
  /** Rate limiter configuration */
  limiter?: {
    _max: number;      // Max jobs per duration
    _duration: number; // Duration in milliseconds
  };
}

/**
 * Job Options - BullMQ job options
 */
export interface JobOptions {
  /** Number of attempts */
  _attempts: number;
  /** Backoff strategy */
  _backoff: {
    _type: 'exponential' | 'fixed';
    _delay: number;
  };
  /** Job timeout in milliseconds */
  _timeout: number;
  /** Remove on complete */
  removeOnComplete?: boolean | number;
  /** Remove on fail */
  removeOnFail?: boolean | number;
  /** Job priority (higher = more priority) */
  priority?: number;
}

/**
 * Worker Configuration
 */
export interface WorkerConfig {
  /** Worker name/type */
  name: string;
  /** Queue name to process */
  _queueName: string;
  /** Concurrency level */
  _concurrency: number;
  /** Enable graceful shutdown */
  gracefulShutdown?: boolean;
  /** Shutdown timeout in milliseconds */
  shutdownTimeout?: number;
}

/**
 * Queue Statistics
 */
export interface QueueStats {
  /** Queue name */
  _queueName: string;
  /** Number of waiting jobs */
  _waiting: number;
  /** Number of active jobs */
  _active: number;
  /** Number of completed jobs */
  _completed: number;
  /** Number of failed jobs */
  _failed: number;
  /** Number of delayed jobs */
  _delayed: number;
  /** Number of paused jobs */
  _paused: number;
  /** Latest job timestamp */
  latestJobTimestamp?: string;
}

/**
 * Worker Status
 */
export interface WorkerStatus {
  /** Worker name */
  _workerName: string;
  /** Is worker running */
  _isRunning: boolean;
  /** Number of active jobs */
  _activeJobs: number;
  /** Worker start time */
  startedAt?: string;
  /** Last processed job timestamp */
  lastJobProcessedAt?: string;
  /** Total jobs processed */
  _totalJobsProcessed: number;
  /** Total jobs failed */
  _totalJobsFailed: number;
}

/**
 * Job Event - Event emitted during job lifecycle
 */
export interface JobEvent {
  /** Event type */
  _type: JobEventType;
  /** Job ID */
  _jobId: string;
  /** Queue name */
  _queueName: string;
  /** Event timestamp */
  _timestamp: string;
  /** Event data */
  data?: any;
}

/**
 * Job Event Type
 */
export type JobEventType =
  | 'added'
  | 'active'
  | 'progress'
  | 'completed'
  | 'failed'
  | 'stalled'
  | 'removed';
