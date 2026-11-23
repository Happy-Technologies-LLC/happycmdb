// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CI health is read under a PostgreSQL statement_timeout (CI_HEALTH_TIMEOUT_MS) and a timeout degrades the CI read to
 * `health: null` instead of failing or stalling it. The connection is a recording fake: PGlite does not enforce
 * statement_timeout, so the "server" raises 57014 on the aggregate the way PostgreSQL would. The derivation of the
 * states from real SQL is covered by `ci-org-scope.test.ts`.
 */

import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn() }));

import { withCIHealth } from '../ci-health';

type Entry = { text: string; params?: unknown[] };

/** A transactional client whose catalog probe says the ITIL tables exist and whose aggregate returns `aggregate`. */
function fakePg(aggregate: () => Promise<{ rows: any[] }>) {
  const trace: Entry[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      trace.push({ text, params });
      if (text.includes('pg_attribute')) return { rows: [{ available: true }] };
      if (text.startsWith('SELECT affected_ci_id')) return aggregate();
      return { rows: [] };
    },
  };
  const pg = {
    transaction: async <T>(callback: (c: typeof client) => Promise<T>): Promise<T> => {
      trace.push({ text: 'BEGIN' });
      try {
        const result = await callback(client);
        trace.push({ text: 'COMMIT' });
        return result;
      } catch (error) {
        trace.push({ text: 'ROLLBACK' });
        throw error;
      }
    },
  };
  return { pg, trace };
}

const cis = [{ id: 'ci-1', name: 'a' }, { id: 'ci-2', name: 'b' }, { id: 'ci-3', name: 'c' }];
const timeoutError = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

async function withEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const before = process.env['CI_HEALTH_TIMEOUT_MS'];
  if (value === undefined) delete process.env['CI_HEALTH_TIMEOUT_MS']; else process.env['CI_HEALTH_TIMEOUT_MS'] = value;
  try { await run(); } finally {
    if (before === undefined) delete process.env['CI_HEALTH_TIMEOUT_MS']; else process.env['CI_HEALTH_TIMEOUT_MS'] = before;
  }
}

describe('withCIHealth statement timeout', () => {
  it('answers health null for every CI, keeps their other keys, and reports the failure once, when the aggregate times out', async () => {
    const { pg, trace } = fakePg(async () => { throw timeoutError(); });
    const onError = jest.fn();
    const out = await withCIHealth(pg, 'org-a', cis, onError);
    expect(out).toEqual(cis.map(ci => ({ ...ci, health: null })));
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as { code?: string }).code).toBe('57014');
    expect(trace.at(-1)).toEqual({ text: 'ROLLBACK' });
  });

  it('reads healthy, degraded and critical as before when nothing times out', async () => {
    const { pg, trace } = fakePg(async () => ({ rows: [
      { affected_ci_id: 'ci-1', top_priority: 1 }, { affected_ci_id: 'ci-2', top_priority: 4 }] }));
    const onError = jest.fn();
    const out = await withCIHealth(pg, 'org-a', cis, onError);
    expect(out.map(ci => [ci.id, ci.health])).toEqual([['ci-1', 'critical'], ['ci-2', 'degraded'], ['ci-3', 'healthy']]);
    expect(onError).not.toHaveBeenCalled();
    expect(trace.at(-1)).toEqual({ text: 'COMMIT' });
  });

  it('sets a transaction-local statement_timeout before the probe and the aggregate: 3000 by default, CI_HEALTH_TIMEOUT_MS when valid', async () => {
    await withEnv(undefined, async () => {
      const { pg, trace } = fakePg(async () => ({ rows: [] }));
      await withCIHealth(pg, 'org-a', cis, jest.fn());
      expect(trace[0]).toEqual({ text: 'BEGIN' });
      expect(trace[1]).toEqual({ text: `SELECT set_config('statement_timeout', $1, true)`, params: ['3000'] });
      expect(trace[2]!.text).toContain('pg_attribute');
      expect(trace[3]!.text).toMatch(/^SELECT affected_ci_id/);
    });
    await withEnv('750', async () => {
      const { pg, trace } = fakePg(async () => ({ rows: [] }));
      await withCIHealth(pg, 'org-a', cis, jest.fn());
      expect(trace[1]!.params).toEqual(['750']);
    });
  });

  it('falls back to 3000 for an invalid CI_HEALTH_TIMEOUT_MS', async () => {
    for (const invalid of ['abc', '0', '-1', '1.5', '2147483648', '']) {
      await withEnv(invalid, async () => {
        const { pg, trace } = fakePg(async () => ({ rows: [] }));
        await withCIHealth(pg, 'org-a', cis, jest.fn());
        expect(trace[1]!.params).toEqual(['3000']);
      });
    }
  });

  it('degrades to null, reported once, when the timeout fires on the first statement of the transaction', async () => {
    const trace: Entry[] = [];
    const pg = { transaction: async (callback: (c: any) => Promise<unknown>) => callback({
      query: async (text: string, params?: unknown[]) => { trace.push({ text, params }); throw timeoutError(); } }) };
    const onError = jest.fn();
    const out = await withCIHealth(pg as any, 'org-a', cis, onError);
    expect(out.every(ci => ci.health === null)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
