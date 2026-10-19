// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { Job, Queue } from 'bullmq';
export const fullRefreshFailureWaitMs = 330_000; // 300s limiter window plus 30s scheduling/settlement slack

/** Diagnostic output is bounded and never contains job data, raw errors, or raw logs. */
async function settlementFailure(queue: Queue, job: Job, expected: string,
  states: string[], injected?: () => boolean): Promise<Error> {
  const persisted = await Job.fromId(queue, job.id!);
  const lastState = persisted ? await persisted.getState() : 'unknown';
  const logs = (await queue.getJobLogs(job.id!, 0, 20)).logs
    .filter(line => /^DEAD_LETTER:ERR_(INTERNAL|RESULT_SCHEMA|VALIDATION|NOT_FOUND|UNAVAILABLE)$/.test(line));
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
  const evidence = {
    queue: queue.name, jobId: /^\d+$/.test(job.id ?? '') ? job.id : '(non-numeric)',
    expected, states, lastState, paused: await queue.isPaused(), counts,
    attemptsMade: persisted?.attemptsMade, attemptsStarted: persisted?.attemptsStarted,
    processed: !!persisted?.processedOn, finished: !!persisted?.finishedOn,
    failedCode: /^ERR_(INTERNAL|RESULT_SCHEMA|VALIDATION|NOT_FOUND|UNAVAILABLE)$/.test(persisted?.failedReason ?? '')
      ? persisted?.failedReason : undefined,
    returnvaluePresent: persisted?.returnvalue != null, dataRetained: !!persisted && Object.keys(persisted.data).length > 0,
    codedLogs: logs,
    ...(injected && { faultInjected: injected() }),
  };
  return new Error(`N18 BullMQ settlement mismatch: ${JSON.stringify(evidence)}`);
}

export async function settled(queue: Queue, job: Job, expected: 'completed' | 'failed',
  timeoutMs = 370_000, injected?: () => boolean): Promise<Job> {
  const deadline = Date.now() + timeoutMs; // real BullMQ limiter: fake timers cannot advance Redis
  const states: string[] = [];
  let scrubDeadline: number | undefined;
  while (Date.now() < deadline) {
    const persisted = await Job.fromId(queue, job.id!);
    const state = persisted ? await persisted.getState() : 'unknown';
    if (states[states.length - 1] !== state && states.length < 16) states.push(state);
    if (persisted && state === expected) {
      // BullMQ commits completion before the worker's asynchronous scrub callback.
      if (expected === 'failed' || Object.keys(persisted.data).length === 0) return persisted;
      scrubDeadline ??= Date.now() + 5_000;
      if (Date.now() >= scrubDeadline) throw await settlementFailure(queue, job, expected, states, injected);
    } else if (state === 'completed' || state === 'failed') {
      throw await settlementFailure(queue, job, expected, states, injected);
    }
    // Real Redis timers cannot be advanced with Jest fake timers.
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw await settlementFailure(queue, job, expected, states, injected);
}
