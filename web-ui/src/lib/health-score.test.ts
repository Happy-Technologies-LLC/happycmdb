// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { formatHealthScore } from './health-score';

describe('formatHealthScore', () => {
  it('is null (unavailable) for a missing score, never a 0%', () => {
    expect(formatHealthScore(null)).toBeNull();
    expect(formatHealthScore(undefined)).toBeNull();
    expect(formatHealthScore(Number.NaN)).toBeNull();
  });

  it('renders a measured score as a rounded percentage, including a measured 0', () => {
    expect(formatHealthScore(92.4)).toBe('92%');
    expect(formatHealthScore(0)).toBe('0%');
  });
});
