// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AIPattern } from '@/services/ai-pattern.service';
import { PatternLearningOverview } from './PatternLearningOverview';

const sessions = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const patternList = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('@/hooks/useDiscoverySessions', () => ({ useDiscoverySessions: () => sessions.value }));
vi.mock('@/hooks/useAIPatterns', () => ({
  useAIPatterns: () => ({ patterns: patternList.value, loading: false, error: null, loadPatterns: vi.fn() }),
}));
// recharts needs a layout engine jsdom does not have; the figures under test are not drawn by it.
vi.mock('recharts', () => {
  const Empty = () => null;
  return {
    ResponsiveContainer: Empty,
    AreaChart: Empty,
    Area: Empty,
    XAxis: Empty,
    YAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: Empty,
    PieChart: Empty,
    Pie: Empty,
    Cell: Empty,
  };
});

const pattern = (overrides: Partial<AIPattern> = {}): AIPattern => ({
  patternId: 'pattern-1',
  name: 'Pattern one',
  category: 'database',
  detectionCode: 'return true;',
  discoveryCode: 'return [];',
  author: 'test-author',
  confidenceScore: 0.9,
  status: 'active',
  isActive: true,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  usageCount: 0,
  successCount: 0,
  failureCount: 0,
  ...overrides,
});

const withSavings = (savingsFromPatterns: unknown) => {
  patternList.value = [];
  sessions.value = {
    loading: false,
    learningStats: { totalSessions: 3 },
    costAnalytics: { savingsFromPatterns },
  };
};

/** The big figure of a labelled tile (MetricCard header label, or Stat label under its value). */
const figureOf = (label: string): string => {
  const el = screen.getByText(label);
  const tile = el.previousElementSibling?.classList.contains('hh-display') ? el.parentElement : el.parentElement?.parentElement;
  const figure = tile?.querySelector('.hh-display');
  if (!figure) throw new Error(`no figure found for ${label}`);
  return figure.textContent ?? '';
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

describe('PatternLearningOverview unknown figures', () => {
  it('reads figures with no backing data as unavailable, never 0 or 0%', () => {
    // No stats, no savings, one pattern that was never used and has no confidence score.
    patternList.value = [pattern({ confidenceScore: null as unknown as number, usageCount: 0, isActive: false, status: 'draft' })];
    sessions.value = { loading: false, learningStats: null, costAnalytics: null };
    render(<PatternLearningOverview />);

    expect(figureOf('Discovery Sessions')).toBe('—');
    expect(figureOf('Avg Confidence')).toBe('—');
    expect(figureOf('Cost Savings')).toBe('—');
    expect(figureOf('Auto-Approved')).toBe('—');
    expect(figureOf('Success Rate')).toBe('—');
    expect(figureOf('Pattern Hits')).toBe('—');
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText('Learning active')).toBeNull();
  });

  it('shows real zeros as 0 and 0%, not as unavailable', () => {
    // A used pattern with no successes and a zero confidence score: known, and zero.
    patternList.value = [pattern({ confidenceScore: 0, usageCount: 5, successCount: 0, failureCount: 5 })];
    sessions.value = {
      loading: false,
      learningStats: { totalSessions: 0, autoApproved: 0 },
      costAnalytics: { savingsFromPatterns: { totalSaved: 0, percentSaved: 0, patternHits: 0, aiDiscoveries: 0 } },
    };
    render(<PatternLearningOverview />);

    expect(figureOf('Discovery Sessions')).toBe('0');
    expect(figureOf('Avg Confidence')).toBe('0%');
    expect(figureOf('Auto-Approved')).toBe('0');
    expect(figureOf('Success Rate')).toBe('0%');
    expect(figureOf('Pattern Hits')).toBe('0');
    expect(screen.queryByText('Not available yet')).toBeNull();
  });
});
