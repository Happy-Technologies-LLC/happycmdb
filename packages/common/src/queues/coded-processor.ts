// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import {
  DelayedError, RateLimitError, UnrecoverableError, WaitingChildrenError,
  type Job, type Worker,
} from 'bullmq';
import { logger } from '../utils/logger';
import { getETLQueueNames } from './queue-config';

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
const SCRUBBED_QUEUES = new Set([
  ...getETLQueueNames(), 'etl-cis', 'etl-costs', 'etl-incidents',
  'cost-sync', 'cost-sync-aws', 'cost-sync-azure', 'cost-sync-gcp',
]);

function validResult(fields: Record<string, unknown>, schema: ResultShape): boolean {
  return Object.keys(fields).length === Object.keys(schema).length &&
    Object.entries(schema).every(([key, kind]) => {
      const value = fields[key];
      if (kind === 'count') return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (kind === 'flag') return typeof value === 'boolean';
      if (kind === 'timestamp') return typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
      if (kind === 'stages') return Array.isArray(value) &&
        value.every((stage: unknown) => typeof stage === 'string' && STAGES.has(stage));
      return !!value && typeof value === 'object' && !Array.isArray(value) &&
        Object.entries(value).every(([code, count]) => ERROR_CODES.has(code) &&
          typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
    });
}
/**
 * Scrub retained payloads only after BullMQ has durably moved the job to completed.
 * The state check and write are atomic: removed jobs cannot be recreated by HSET,
 * and jobs moved back to waiting by a manual retry retain their input.
 */
export function scrubCompletedJobs(worker: Worker): void {
  if (!SCRUBBED_QUEUES.has(worker.name)) return;
  worker.on('completed', job => {
    const id = job.id;
    if (!id) return;
    void worker.client.then(client => client.eval(
      `if redis.call('ZSCORE', KEYS[2], ARGV[1]) and redis.call('EXISTS', KEYS[1]) == 1 then
         return redis.call('HSET', KEYS[1], 'data', '{}')
       end
       return 0`,
      2, `${job.queueQualifiedName}:${id}`, `${job.queueQualifiedName}:completed`, id
    )).catch(() => logger.error('Completed job payload scrub failed', { queue: worker.name }));
  });
}
export function codedProcessor<Data, Result>(
  _name: string, schema: ResultShape | readonly ResultShape[],
  process: (job: Job<Data>, token?: string) => Promise<Result>
): (job: Job<Data>, token?: string) => Promise<Result> {
  return async (job, token) => {
    try {
      const result = await process(job, token);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CodedJobError('ERR_RESULT_SCHEMA');
      const fields = result as Record<string, unknown>;
      if (!(Array.isArray(schema) ? schema : [schema]).some(shape => validResult(fields, shape))) {
        throw new CodedJobError('ERR_RESULT_SCHEMA');
      }
      // The input must remain durable until BullMQ commits completion: a lock
      // loss here can cause a stalled retry even after the processor succeeds.
      return result;
    } catch (error) {
      if (error instanceof DelayedError || error instanceof WaitingChildrenError ||
        error instanceof RateLimitError || error instanceof UnrecoverableError) throw error;
      throw new CodedJobError(jobErrorCode(error));
    }
  };
}
