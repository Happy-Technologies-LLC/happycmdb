// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { lookup } from 'dns/promises';
import { execFile } from 'child_process';
import type { DiscoveryTool } from '../../types';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('child_process', () => ({ execFile: jest.fn() }));

const XML = '<nmaprun><host><status state="up"/></host></nmaprun>';

interface Pending { finish: (error?: Error) => void }

/** Load a fresh nmap tool (fresh process-wide semaphore) under the given env override. */
function loadTool(envValue?: string): DiscoveryTool {
  if (envValue === undefined) delete process.env.AI_DISCOVERY_NMAP_CONCURRENCY;
  else process.env.AI_DISCOVERY_NMAP_CONCURRENCY = envValue;
  let tool: DiscoveryTool | undefined;
  jest.isolateModules(() => {
    tool = require('../nmap-tool').nmapTool;
  });
  return tool as DiscoveryTool;
}

/** Every started nmap subprocess waits in `pending` until a test finishes it. */
function holdSubprocesses(): { pending: Pending[]; started: () => number } {
  const pending: Pending[] = [];
  let started = 0;
  jest.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    started++;
    pending.push({ finish: (error) => cb(error ?? null, { stdout: XML, stderr: '' }) });
  }) as never);
  return { pending, started: () => started };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Finish every held subprocess until all scans settle. A scan left queued would
 * keep its real 60 s wait timer and reject unhandled inside a later test.
 */
async function drain(pending: Pending[], scans: Array<Promise<unknown>>): Promise<void> {
  let settled = false;
  const all = Promise.allSettled(scans).then(() => {
    settled = true;
  });
  while (!settled) {
    pending.splice(0).forEach((p) => p.finish());
    await tick();
  }
  await all;
}

beforeEach(() => {
  jest.mocked(lookup).mockReset();
  jest.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
  jest.mocked(execFile).mockReset();
});
afterAll(() => {
  delete process.env.AI_DISCOVERY_NMAP_CONCURRENCY;
});

describe('nmap subprocess concurrency', () => {
  it('runs at most 4 nmap processes at once by default and starts the rest as slots free', async () => {
    const tool = loadTool();
    const { pending, started } = holdSubprocesses();

    const scans = Array.from({ length: 10 }, () => tool.execute({ host: 'public.example' }));
    await tick();
    expect(started()).toBe(4);

    pending.splice(0, 2).forEach((p) => p.finish());
    await tick();
    expect(started()).toBe(6);

    while (pending.length > 0 || started() < 10) {
      pending.splice(0).forEach((p) => p.finish());
      await tick();
    }
    const results = await Promise.all(scans);
    expect(results).toHaveLength(10);
    expect(started()).toBe(10);
  });

  it('honours the environment override', async () => {
    const tool = loadTool('2');
    const { pending, started } = holdSubprocesses();

    const scans = Array.from({ length: 5 }, () => tool.execute({ host: 'public.example' }));
    await tick();

    expect(started()).toBe(2);
    await drain(pending, scans);
  });

  it.each(['0', '65', '-1', 'many', '2.5', ''])('falls back to 4 for the invalid override %p', async (value) => {
    const tool = loadTool(value);
    const { pending, started } = holdSubprocesses();

    const scans = Array.from({ length: 6 }, () => tool.execute({ host: 'public.example' }));
    await tick();

    expect(started()).toBe(4);
    await drain(pending, scans);
  });

  it('releases the slot when a scan fails', async () => {
    const tool = loadTool('1');
    const { pending, started } = holdSubprocesses();

    const first = tool.execute({ host: 'public.example' });
    const second = tool.execute({ host: 'public.example' });
    await tick();
    expect(started()).toBe(1);

    pending.shift()!.finish(new Error('boom'));
    await expect(first).rejects.toThrow('NMAP scan failed');
    await tick();
    expect(started()).toBe(2);

    pending.shift()!.finish();
    await expect(second).resolves.toMatchObject({ status: 'up' });
  });
});

describe('nmap queue wait deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.AI_DISCOVERY_NMAP_QUEUE_TIMEOUT_MS;
  });

  it('fails a waiter that stays queued for 60 seconds by default, without starting nmap for it', async () => {
    const tool = loadTool('1');
    const { pending, started } = holdSubprocesses();

    const running = tool.execute({ host: 'public.example' });
    const waiting = tool.execute({ host: 'public.example' });
    const outcome = waiting.then(() => 'resolved', (error: Error) => error.message);
    await tick();
    expect(started()).toBe(1);

    jest.advanceTimersByTime(59_999);
    await tick();
    await expect(Promise.race([outcome, 'still waiting'])).resolves.toBe('still waiting');

    jest.advanceTimersByTime(1);
    await expect(outcome).resolves.toBe('nmap scan queue timeout');
    expect(started()).toBe(1);

    // The expired waiter is gone: the next freed slot is not handed to it.
    pending.shift()!.finish();
    await expect(running).resolves.toMatchObject({ status: 'up' });
    const next = tool.execute({ host: 'public.example' });
    await tick();
    expect(started()).toBe(2);
    pending.shift()!.finish();
    await expect(next).resolves.toMatchObject({ status: 'up' });
  });

  it('hands a slot freed before the deadline to the waiter, and the deadline no longer applies to it', async () => {
    const tool = loadTool('1');
    const { pending, started } = holdSubprocesses();

    const first = tool.execute({ host: 'public.example' });
    const second = tool.execute({ host: 'public.example' });
    await tick();

    jest.advanceTimersByTime(30_000);
    pending.shift()!.finish();
    await expect(first).resolves.toMatchObject({ status: 'up' });
    await tick();
    expect(started()).toBe(2);

    // Running longer than the wait deadline is not a queue timeout.
    jest.advanceTimersByTime(120_000);
    pending.shift()!.finish();
    await expect(second).resolves.toMatchObject({ status: 'up' });
  });

  it('serves the remaining waiters in order when an earlier one times out', async () => {
    process.env.AI_DISCOVERY_NMAP_QUEUE_TIMEOUT_MS = '5000';
    const tool = loadTool('1');
    const { pending, started } = holdSubprocesses();

    const first = tool.execute({ host: 'public.example' });
    const expired = tool.execute({ host: 'public.example' });
    const expiredOutcome = expired.then(() => 'resolved', (error: Error) => error.message);
    await tick();
    jest.advanceTimersByTime(3_000);
    const late = tool.execute({ host: 'public.example' });
    await tick();

    jest.advanceTimersByTime(2_000);
    await expect(expiredOutcome).resolves.toBe('nmap scan queue timeout');

    pending.shift()!.finish();
    await expect(first).resolves.toMatchObject({ status: 'up' });
    await tick();
    expect(started()).toBe(2);
    pending.shift()!.finish();
    await expect(late).resolves.toMatchObject({ status: 'up' });
  });

  it('honours the environment override', async () => {
    process.env.AI_DISCOVERY_NMAP_QUEUE_TIMEOUT_MS = '2000';
    const tool = loadTool('1');
    holdSubprocesses();

    void tool.execute({ host: 'public.example' });
    const waiting = tool.execute({ host: 'public.example' });
    const outcome = waiting.then(() => 'resolved', (error: Error) => error.message);
    await tick();

    jest.advanceTimersByTime(2_000);
    await expect(outcome).resolves.toBe('nmap scan queue timeout');
  });

  it.each(['0', '999', '600001', 'soon', '1.5e3', ''])('falls back to 60 seconds for the invalid override %p', async (value) => {
    process.env.AI_DISCOVERY_NMAP_QUEUE_TIMEOUT_MS = value;
    const tool = loadTool('1');
    holdSubprocesses();

    void tool.execute({ host: 'public.example' });
    const waiting = tool.execute({ host: 'public.example' });
    const outcome = waiting.then(() => 'resolved', (error: Error) => error.message);
    await tick();

    jest.advanceTimersByTime(59_999);
    await tick();
    await expect(Promise.race([outcome, 'still waiting'])).resolves.toBe('still waiting');
    jest.advanceTimersByTime(1);
    await expect(outcome).resolves.toBe('nmap scan queue timeout');
  });
});
