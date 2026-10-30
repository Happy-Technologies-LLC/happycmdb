// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-444 K3 (proposal §4.2): withRetry's optional `retryable` predicate ends the loop on a terminal failure.
import { withRetry } from '../retry';
import { logger } from '../logger';

class Terminal extends Error {}

async function run(retryable?: (error: unknown) => boolean) {
  const [warn, error] = (['warn', 'error'] as const).map(level => jest.spyOn(logger, level).mockImplementation(() => logger));
  const failures = [new Error('transient'), new Terminal('terminal')];
  const operation = jest.fn().mockRejectedValueOnce(failures[0]).mockRejectedValueOnce(failures[1]).mockResolvedValue('ok');
  jest.useFakeTimers();
  const settled = withRetry(operation, { initialDelay: 1000, operationName: 'probe', retryable }).catch((e: unknown) => e);
  await jest.runAllTimersAsync();
  jest.useRealTimers();
  return { result: await settled, attempts: operation.mock.calls.length, failures, warn, error };
}

it('(d) without retryable, every failure is still retried exactly as before', async () => {
  const { result, attempts, warn, error } = await run();
  expect([result, attempts, warn.mock.calls.length, error.mock.calls.length]).toEqual(['ok', 3, 2, 0]);
});

it('stops at the first failure the predicate rejects and rethrows it, logging the class only', async () => {
  const predicate = jest.fn((failure: unknown) => !(failure instanceof Terminal));
  const { result, attempts, failures, warn, error } = await run(predicate);
  expect(result).toBe(failures[1]);
  expect([attempts, predicate.mock.calls, warn.mock.calls.length]).toEqual([2, [[failures[0]], [failures[1]]], 1]);
  expect(error.mock.calls).toEqual([['probe failed after 2 attempts', { _errorClass: 'Terminal' }]]);
});
