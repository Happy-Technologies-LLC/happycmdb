// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';

export const JOB_NOT_FOUND = { success: false, error: 'Not Found', message: 'Job not found' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Admin output never includes old BullMQ payloads, errors, or CI-bearing results. */
const COUNT_FIELDS = new Set([
  '_refused', 'discovered', 'created', 'updated', 'failed',
  'cisProcessed', 'relationshipsProcessed', 'recordsInserted', 'recordsUpdated',
  'errors', 'durationMs', '_cisChecked', '_conflictsDetected', '_conflictsResolved',
  '_manualReviewRequired', '_durationMs', 'cisChecked', 'changesDetected',
  'changesRecorded', 'dimensionsCreated', 'factsCreated',
]);
export async function publicJob(job: Job, queueName: string): Promise<object> {
  const discovery = queueName.startsWith('discovery-');
  const data = job.data;
  const discoveryData = data && typeof data === 'object' &&
    Object.keys(data).length === 1 && typeof data._runId === 'string' && UUID.test(data._runId)
      ? { _runId: data._runId }
      : data && typeof data === 'object' && Object.keys(data).length === 1 &&
        typeof data._definitionId === 'string' && UUID.test(data._definitionId)
        ? { _definitionId: data._definitionId }
        : { _legacy: true };
  const result = job.returnvalue;
  const counts = result && typeof result === 'object' && !Array.isArray(result)
    ? Object.fromEntries(Object.entries(result).filter(([key, value]) =>
      COUNT_FIELDS.has(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
    : {};
  const safeResult = Object.keys(counts).length ? counts : { _legacy: true };
  return {
    id: job.id, name: queueName, queueName, state: await job.getState(),
    attemptsMade: job.attemptsMade, maxAttempts: job.opts?.attempts ?? 1,
    timestamp: job.timestamp, processedOn: job.processedOn, finishedOn: job.finishedOn,
    data: discovery ? discoveryData : { _legacy: true },
    returnvalue: safeResult,
    failedReason: job.failedReason ? discovery ? 'ERR_DISCOVERY_FAILED' : 'ERR_JOB_FAILED' : undefined,
  };
}
