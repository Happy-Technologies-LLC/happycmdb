// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Queue Error Handler
 *
 * This module provides comprehensive error handling for BullMQ jobs:
 * - Error categorization
 * - Retry logic customization
 * - Dead letter queue management
 * - Error notifications
 */

import { Job } from 'bullmq';
import { logger } from '../utils/logger';
import { jobErrorCode, jobLog } from './coded-processor';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Error categories for job failures
 */
export enum ErrorCategory {
  TRANSIENT = 'transient', // Temporary errors (network, timeout) - retry
  PERMANENT = 'permanent', // Permanent errors (validation, auth) - no retry
  RESOURCE = 'resource', // Resource errors (rate limit, quota) - backoff
  SYSTEM = 'system', // System errors (database, service down) - retry
}

/**
 * Error classification result
 */
export interface ErrorClassification {
  _category: ErrorCategory;
  shouldRetry: boolean;
  retryDelay?: number;
  notifyAdmin?: boolean;
}

/**
 * Job Error Handler
 */
export class JobErrorHandler {
  /**
   * Classify error to determine retry strategy
   */
  static classifyError(error: Error): ErrorClassification {
    const errorMessage = error.message.toLowerCase();

    // Permanent errors - no retry
    if (
      errorMessage.includes('validation') ||
      errorMessage.includes('invalid') ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('forbidden') ||
      errorMessage.includes('not found')
    ) {
      return {
        _category: ErrorCategory.PERMANENT,
        shouldRetry: false,
        notifyAdmin: true,
      };
    }

    // Resource errors - retry with backoff
    if (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('quota exceeded') ||
      errorMessage.includes('too many requests')
    ) {
      return {
        _category: ErrorCategory.RESOURCE,
        shouldRetry: true,
        retryDelay: 60000, // 1 minute
        notifyAdmin: false,
      };
    }

    // System errors - retry
    if (
      errorMessage.includes('database') ||
      errorMessage.includes('connection') ||
      errorMessage.includes('service unavailable')
    ) {
      return {
        _category: ErrorCategory.SYSTEM,
        shouldRetry: true,
        retryDelay: 30000, // 30 seconds
        notifyAdmin: true,
      };
    }

    // Transient errors - retry (default)
    return {
      _category: ErrorCategory.TRANSIENT,
      shouldRetry: true,
      retryDelay: 5000, // 5 seconds
      notifyAdmin: false,
    };
  }

  /**
   * Handle job failure
   */
  static async handleJobFailure(job: Job, error: Error): Promise<void> {
    const classification = this.classifyError(error);

    logger.error('Job failed', {
      _jobName: job.queueName,
      _queueName: job.queueName,
      _code: jobErrorCode(error),
      _category: classification._category,
      _attemptsMade: job.attemptsMade,
    });

    // Log to dead letter queue if max attempts reached
    if (job.attemptsMade >= (job.opts.attempts || 3)) {
      await this.sendToDeadLetterQueue(job, error, classification);
    }

    // Notify admin if required
    if (classification.notifyAdmin) {
      await this.notifyAdmin(job, error, classification);
    }
  }

  /**
   * Send failed job to dead letter queue
   */
  private static async sendToDeadLetterQueue(
    _job: Job,
    _error: Error,
    _classification: ErrorClassification
  ): Promise<void> {
    logger.warn('Job moved to dead letter queue', {
      _jobName: _job.queueName,
      _queueName: _job.queueName,
      _category: _classification._category,
    });

    const code = jobErrorCode(_error);
    await jobLog(_job, `DEAD_LETTER:${code}`);
    const discovery = _job.queueName.startsWith('discovery-');
    const data = discovery
      ? typeof _job.data?._runId === 'string' && UUID.test(_job.data._runId) ? { _runId: _job.data._runId }
        : typeof _job.data?._definitionId === 'string' && UUID.test(_job.data._definitionId)
          ? { _definitionId: _job.data._definitionId }
          : { _legacy: true }
      : { _legacy: true };
    await _job.updateData({ ...data, __dlq: { _code: code } });
  }

  /**
   * Notify admin about critical errors
   */
  private static async notifyAdmin(
    _job: Job,
    _error: Error,
    _classification: ErrorClassification
  ): Promise<void> {
    // In a real implementation, this would send email/Slack/PagerDuty alerts
    logger.error('ADMIN NOTIFICATION: Job failed critically', {
      _jobName: _job.queueName,
      _queueName: _job.queueName,
      _code: jobErrorCode(_error),
      _category: _classification._category,
    });
  }

  /**
   * Custom retry logic based on error type
   */
  static getRetryDelay(
    _attemptsMade: number,
    _error: Error
  ): number | undefined {
    const classification = this.classifyError(_error);

    if (!classification.shouldRetry) {
      return undefined; // Don't retry
    }

    if (classification.retryDelay) {
      // Use classification-specific delay with exponential backoff
      return classification.retryDelay * Math.pow(2, _attemptsMade - 1);
    }

    // Default exponential backoff
    return Math.min(2000 * Math.pow(2, _attemptsMade - 1), 60000); // Max 1 minute
  }

  /**
   * Check if job should be retried
   */
  static shouldRetryJob(job: Job, error: Error): boolean {
    const classification = this.classifyError(error);

    // Don't retry if max attempts reached
    if (job.attemptsMade >= (job.opts.attempts || 3)) {
      return false;
    }

    return classification.shouldRetry;
  }
}

/**
 * Create error handler middleware for workers
 */
export function createErrorHandlerMiddleware() {
  return {
    _onFailed: async (job: Job | undefined, error: Error) => {
      if (!job) {
        logger.error('Job failed without job context', { code: jobErrorCode(error) });
        return;
      }

      await JobErrorHandler.handleJobFailure(job, error);
    },

    _onStalled: async (_jobId: string) => {
      logger.warn('Job stalled - may need manual intervention');
    },
  };
}
