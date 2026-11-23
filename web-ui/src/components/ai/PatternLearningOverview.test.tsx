// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PatternLearningOverview } from './PatternLearningOverview';

const sessions = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useDiscoverySessions', () => ({ useDiscoverySessions: () => sessions.value }));
vi.mock('@/hooks/useAIPatterns', () => ({
  useAIPatterns: () => ({ patterns: [], loading: false, error: null, loadPatterns: vi.fn() }),
}));

const withSavings = (savingsFromPatterns: unknown) => {
  sessions.value = {
    loading: false,
    learningStats: { totalSessions: 3 },
    costAnalytics: { savingsFromPatterns },
  };
};

afterEach(cleanup);

describe('PatternLearningOverview cost savings', () => {
  it('shows the saved amount as money, with its dollar sign', () => {
    withSavings({ totalSaved: 5.5, percentSaved: 31, patternHits: 120, aiDiscoveries: 42 });
    render(<PatternLearningOverview />);
    expect(screen.getByText('$5.50 saved')).toBeInTheDocument();
  });

  it('shows a real zero saving as $0.00 saved', () => {
    withSavings({ totalSaved: 0, percentSaved: 0, patternHits: 0, aiDiscoveries: 0 });
    render(<PatternLearningOverview />);
    expect(screen.getByText('$0.00 saved')).toBeInTheDocument();
  });
});
