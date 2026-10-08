// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Retry Utility - Exponential backoff retry logic
 *
 * Provides exponential backoff retry capability for operations that may fail
 * transiently (network requests, API calls, etc.)
 */

import { logger } from './logger';
import { DISCOVERY_TARGET_REFUSED } from '../security/discovery-egress';

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 2000) */
  initialDelay?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelay?: number;
  /** Backoff multiplier (default: 2 for exponential) */
  backoffMultiplier?: number;
  /** Operation name for logging */
  operationName?: string;
}

/**
 * Executes an operation with exponential backoff retry
 *
 * @param operation The async operation to retry
 * @param options Retry configuration options
 * @returns Promise resolving to the operation result
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 2000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    operationName = 'operation',
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.debug(`Executing ${operationName}`, { attempt, maxAttempts });
      const result = await operation();

      if (attempt > 1) {
        logger.info(`${operationName} succeeded after ${attempt} attempts`);
      }

      return result;
    } catch (error) {
      lastError = error as Error;
      // A denied discovery destination is a terminal security decision, not a
      // transient failure: later DNS answers must not erase this refusal.
      if (lastError instanceof Error && lastError.message === DISCOVERY_TARGET_REFUSED) {
        throw new Error(DISCOVERY_TARGET_REFUSED);
      }

      if (attempt < maxAttempts) {
        // Calculate delay with exponential backoff
        const delay = Math.min(
          initialDelay * Math.pow(backoffMultiplier, attempt - 1),
          maxDelay
        );

        logger.warn(`${operationName} failed (attempt ${attempt}/${maxAttempts})`, {
          _error: lastError.message,
          _retryIn: `${delay}ms`,
        });

        await sleep(delay);
      } else {
        logger.error(`${operationName} failed after ${maxAttempts} attempts`, {
          _error: lastError.message,
        });
      }
    }
  }

  throw lastError;
}

/**
 * Sleep utility for delays
 * @param ms Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
