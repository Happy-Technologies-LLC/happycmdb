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
    const { started } = holdSubprocesses();

    void Promise.all(Array.from({ length: 5 }, () => tool.execute({ host: 'public.example' })));
    await tick();

    expect(started()).toBe(2);
  });

  it.each(['0', '65', '-1', 'many', '2.5', ''])('falls back to 4 for the invalid override %p', async (value) => {
    const tool = loadTool(value);
    const { started } = holdSubprocesses();

    void Promise.all(Array.from({ length: 6 }, () => tool.execute({ host: 'public.example' })));
    await tick();

    expect(started()).toBe(4);
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
