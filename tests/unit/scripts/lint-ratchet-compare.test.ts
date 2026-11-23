// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-1951: the pure compare / update rules of scripts/lint-ratchet.mjs (what the gate fails on and what
// `npm run lint:baseline` is allowed to write).

import { describe, expect, it } from '@jest/globals';
import { join } from 'path';

type Counts = Record<string, Record<string, number>>;
interface Compare {
  PARSE_ERROR: string;
  compareCounts(baseline: Counts, current: Counts, only?: string[]): {
    regressions: { file: string; rule: string; allowed: number; found: number }[];
    improved: number;
  };
  nextBaseline(baseline: Counts, current: Counts, allowRaise?: boolean): {
    next: Counts;
    refused: { file: string; rule: string; allowed: number; found: number }[];
  };
  total(counts: Counts): number;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PARSE_ERROR, compareCounts, nextBaseline, total } = require(join(__dirname, '../../../scripts/lint-ratchet-compare.cjs')) as Compare;

const A = 'packages/agent/src/a.ts';
const B = 'packages/common/src/b.ts';

describe('compareCounts', () => {
  const baseline: Counts = { [A]: { 'no-console': 3, curly: 2 } };

  it('fails a pair above its baseline', () => {
    const { regressions } = compareCounts(baseline, { [A]: { 'no-console': 4, curly: 2 } });
    expect(regressions).toEqual([{ file: A, rule: 'no-console', allowed: 3, found: 4 }]);
  });

  it('passes a pair equal to its baseline with nothing improved', () => {
    expect(compareCounts(baseline, { [A]: { 'no-console': 3, curly: 2 } })).toEqual({ regressions: [], improved: 0 });
  });

  it('passes a pair below its baseline and counts the difference, including a pair that vanished', () => {
    const { regressions, improved } = compareCounts(baseline, { [A]: { 'no-console': 1 } });
    expect(regressions).toEqual([]);
    expect(improved).toBe(2 + 2);
  });

  it('fails a (file, rule) pair that is not in the baseline, in a known file and in a new file', () => {
    const { regressions } = compareCounts(baseline, { [A]: { 'no-explicit-any': 1 }, [B]: { curly: 1 } });
    expect(regressions).toEqual([
      { file: A, rule: 'no-explicit-any', allowed: 0, found: 1 },
      { file: B, rule: 'curly', allowed: 0, found: 1 },
    ]);
  });

  it('fails a parse error (null ruleId) when the baseline has none for the file', () => {
    const { regressions } = compareCounts(baseline, { [A]: { [PARSE_ERROR]: 1 } });
    expect(regressions).toEqual([{ file: A, rule: PARSE_ERROR, allowed: 0, found: 1 }]);
  });

  it('does not read a package that was not linted as fixed when scoped with --package', () => {
    const both: Counts = { [A]: { curly: 2 }, [B]: { curly: 5 } };
    expect(compareCounts(both, {}, ['agent']).improved).toBe(2);
  });
});

describe('nextBaseline (--update)', () => {
  const baseline: Counts = { [A]: { 'no-console': 3, curly: 2 }, [B]: { curly: 1 } };

  it('writes min(baseline, current) per pair and drops pairs with no findings left', () => {
    const { next, refused } = nextBaseline(baseline, { [A]: { 'no-console': 1, curly: 2 } });
    expect(next).toEqual({ [A]: { 'no-console': 1, curly: 2 } });
    expect(refused).toEqual([]);
  });

  it('keeps the baseline count for a pair that went up and refuses to add a new pair or file', () => {
    const { next, refused } = nextBaseline(baseline, {
      [A]: { 'no-console': 7, curly: 2, 'no-explicit-any': 1 },
      [B]: { curly: 1 },
      'packages/agent/src/new.ts': { curly: 1 },
    });
    expect(next).toEqual({ [A]: { 'no-console': 3, curly: 2 }, [B]: { curly: 1 } });
    expect(refused).toEqual([
      { file: A, rule: 'no-console', allowed: 3, found: 7 },
      { file: A, rule: 'no-explicit-any', allowed: 0, found: 1 },
      { file: 'packages/agent/src/new.ts', rule: 'curly', allowed: 0, found: 1 },
    ]);
  });

  it('writes the current counts as they are with allowRaise (a renamed file)', () => {
    const current: Counts = { 'packages/agent/src/renamed.ts': { curly: 2 }, [A]: { 'no-console': 9 } };
    const { next, refused } = nextBaseline(baseline, current, true);
    expect(next).toEqual(current);
    expect(refused).toEqual([]);
  });

  it('a refused raise stays above the written baseline, so --update does not launder it', () => {
    const current: Counts = { [A]: { 'no-console': 7, curly: 1 }, [B]: { curly: 4 } };
    const { next } = nextBaseline(baseline, current);
    // Pairs that were refused stay above the written baseline, so they still fail: update does not launder them.
    expect(compareCounts(next, current).regressions.map((r) => `${r.file}:${r.rule}`)).toEqual([`${A}:no-console`, `${B}:curly`]);
    expect(total(next)).toBe(3 + 1 + 1);
  });
});
