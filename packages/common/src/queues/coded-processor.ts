// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import {
  DelayedError, RateLimitError, UnrecoverableError, WaitingChildrenError,
  type Job,
} from 'bullmq';

const CONTROL_ERRORS = new Set(['DelayedError', 'WaitingChildrenError', 'RateLimitError', 'UnrecoverableError']);
export type JobErrorCode = 'ERR_INTERNAL' | 'ERR_RESULT_SCHEMA' | 'ERR_VALIDATION' | 'ERR_NOT_FOUND' | 'ERR_UNAVAILABLE';
const ERROR_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  'ERR_INTERNAL', 'ERR_RESULT_SCHEMA', 'ERR_VALIDATION', 'ERR_NOT_FOUND', 'ERR_UNAVAILABLE',
]);

export class CodedJobError extends Error {
  constructor(code: string) {
    super(ERROR_CODES.has(code) ? code : 'ERR_INTERNAL');
    this.name = 'CodedJobError';
  }
}

export function jobErrorCode(error: unknown): JobErrorCode {
  if (error instanceof CodedJobError && ERROR_CODES.has(error.message)) {
    return error.message as JobErrorCode;
  }
  return 'ERR_INTERNAL';
}

export function jobLog(job: Job, eventCode: `DEAD_LETTER:${JobErrorCode}`): Promise<number> {
  return job.log(eventCode);
}

/** Only data-free primitives and classified counts may become BullMQ returnvalue. */
export type ResultShape = Record<string, 'count' | 'flag' | 'timestamp' | 'errorCounts' | 'stages'>;
const STAGES: ReadonlySet<string> = new Set([
  'truncate', 'extract-cis', 'load-dimensions', 'load-relationships', 'rebuild-indexes',
]);

export function codedProcessor<Data, Result>(
  _name: string, schema: ResultShape,
  process: (job: Job<Data>, token?: string) => Promise<Result>
): (job: Job<Data>, token?: string) => Promise<Result> {
  return async (job, token) => {
    try {
      const result = await process(job, token);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CodedJobError('ERR_RESULT_SCHEMA');
      const fields = result as Record<string, unknown>;
      if (Object.keys(fields).length !== Object.keys(schema).length ||
        Object.entries(schema).some(([key, kind]) => {
          const value = fields[key];
          if (kind === 'count') return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0;
          if (kind === 'flag') return typeof value !== 'boolean';
          if (kind === 'timestamp') return typeof value !== 'string' || !Number.isFinite(Date.parse(value));
          if (kind === 'stages') return !Array.isArray(value) ||
            value.some((stage: unknown) => typeof stage !== 'string' || !STAGES.has(stage));
          return !value || typeof value !== 'object' || Array.isArray(value) ||
            Object.entries(value).some(([code, count]) => !ERROR_CODES.has(code) ||
              typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0);
        })) throw new CodedJobError('ERR_RESULT_SCHEMA');
      return result;
    } catch (error) {
      if (error instanceof DelayedError || error instanceof WaitingChildrenError ||
        error instanceof RateLimitError || error instanceof UnrecoverableError ||
        (error instanceof Error && CONTROL_ERRORS.has(error.name))) throw error;
      throw new CodedJobError(jobErrorCode(error));
    }
  };
}
