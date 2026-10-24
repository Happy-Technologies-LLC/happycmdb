// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { withRetry } from '../retry';
import { logger } from '../logger';
import { DISCOVERY_TARGET_REFUSED } from '../../security/discovery-egress';

const MARKERS = [
  'error-host.invalid',
  '192.0.2.77',
  'cn=svc-synthetic,ou=people,dc=example,dc=invalid',
];

class SyntheticFailure extends Error {}

function spyOnLogger() {
  return {
    debug: jest.spyOn(logger, 'debug').mockImplementation(() => logger),
    info: jest.spyOn(logger, 'info').mockImplementation(() => logger),
    warn: jest.spyOn(logger, 'warn').mockImplementation(() => logger),
    error: jest.spyOn(logger, 'error').mockImplementation(() => logger),
  };
}

function expectNoMarkers(calls: unknown[][]): void {
  const serialized = JSON.stringify(calls);
  for (const marker of MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

describe('withRetry error logging', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('logs only the error class on a per-retry warning', async () => {
    const log = spyOnLogger();
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new SyntheticFailure(`connect ${MARKERS.join(' ')}`))
      .mockResolvedValue('ok');

    const result = withRetry(operation, { maxAttempts: 3, initialDelay: 1000, operationName: 'probe' });
    await jest.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('probe failed (attempt 1/3)', {
      _errorClass: 'SyntheticFailure',
      _retryIn: '1000ms',
    });
    expect(log.error).not.toHaveBeenCalled();
    expectNoMarkers(log.warn.mock.calls);
  });

  it('logs only the error class on final failure and rethrows the identical original error', async () => {
    const log = spyOnLogger();
    const original = new SyntheticFailure(`connect ${MARKERS.join(' ')}`);
    const operation = jest.fn<Promise<string>, []>().mockRejectedValue(original);

    const result = withRetry(operation, { maxAttempts: 2, initialDelay: 500, operationName: 'probe' });
    const settled = result.then(
      () => ({ error: undefined as unknown }),
      (error: unknown) => ({ error })
    );
    await jest.runAllTimersAsync();

    const { error } = await settled;
    expect(error).toBe(original);
    expect((error as Error).message).toBe(`connect ${MARKERS.join(' ')}`);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith('probe failed after 2 attempts', {
      _errorClass: 'SyntheticFailure',
    });
    expectNoMarkers(log.warn.mock.calls);
    expectNoMarkers(log.error.mock.calls);
  });

  it('logs only the type for a non-Error rejection', async () => {
    const log = spyOnLogger();
    const thrown = { detail: MARKERS.join(' ') };
    const operation = jest.fn<Promise<string>, []>().mockRejectedValue(thrown);

    const result = withRetry(operation, { maxAttempts: 1, operationName: 'probe' });

    await expect(result).rejects.toBe(thrown);
    expect(log.error).toHaveBeenCalledWith('probe failed after 1 attempts', { _errorClass: 'object' });
    expectNoMarkers(log.error.mock.calls);
  });

  it('stops immediately on a refused discovery target without retry or sleep', async () => {
    const log = spyOnLogger();
    const operation = jest.fn<Promise<string>, []>().mockRejectedValue(new Error(DISCOVERY_TARGET_REFUSED));

    const result = withRetry(operation, { maxAttempts: 3, initialDelay: 1000 });

    await expect(result).rejects.toThrow(DISCOVERY_TARGET_REFUSED);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
