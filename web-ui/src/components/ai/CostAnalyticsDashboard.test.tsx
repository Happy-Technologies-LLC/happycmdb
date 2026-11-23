// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CostAnalytics } from '@/services/ai-pattern.service';
import { CostAnalyticsDashboard } from './CostAnalyticsDashboard';

const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/useDiscoverySessions', () => ({ useDiscoverySessions: () => hook.value }));

const analytics = (overrides: Record<string, unknown> = {}) =>
  ({
    totalCost: 12.345,
    totalSessions: 42,
    avgCostPerSession: 0.294,
    costByModel: [{ aiModel: 'claude-sonnet-4', cost: 10, sessions: 20 }],
    costByDay: [{ date: '2026-10-01', cost: 1.5, sessions: 4 }],
    savingsFromPatterns: { totalSaved: 5.5, percentSaved: 31, patternHits: 120, aiDiscoveries: 42 },
    ...overrides,
  }) as unknown as CostAnalytics;

const loadCostAnalytics = vi.fn();
const state = (costAnalytics: CostAnalytics | null, loading = false) => {
  hook.value = { costAnalytics, loading, loadCostAnalytics };
};

beforeEach(() => {
  loadCostAnalytics.mockReset();
  state(analytics());
});
afterEach(cleanup);

describe('CostAnalyticsDashboard states', () => {
  it('says what is loading while the sessions load', () => {
    state(null, true);
    render(<CostAnalyticsDashboard />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading cost analytics');
  });

  it('shows the empty message with a retry that asks for the same date range again', async () => {
    state(null);
    const user = userEvent.setup();
    render(<CostAnalyticsDashboard />);
    expect(screen.getByText('No cost data available')).toBeInTheDocument();
    expect(loadCostAnalytics).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(loadCostAnalytics).toHaveBeenCalledTimes(2);
    const [from, to] = loadCostAnalytics.mock.calls[1];
    const days = (Date.parse(to) - Date.parse(from)) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);
  });
});

describe('CostAnalyticsDashboard figures', () => {
  it('reads cost figures that are null as unavailable, never $0, and real zero figures as 0', () => {
    state(analytics({ totalCost: null, avgCostPerSession: null, savingsFromPatterns: null, totalSessions: null }));
    render(<CostAnalyticsDashboard />);
    expect(screen.getAllByText('Not available yet')).toHaveLength(3);
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.queryByText('$0.0000')).toBeNull();
    expect(screen.queryByText('0% saved')).toBeNull();
    expect(screen.queryByText(/null sessions/)).toBeNull();

    cleanup();
    state(
      analytics({
        totalCost: 0,
        avgCostPerSession: 0,
        totalSessions: 0,
        costByModel: [],
        savingsFromPatterns: { totalSaved: 0, percentSaved: 0, patternHits: 0, aiDiscoveries: 0 },
      }),
    );
    render(<CostAnalyticsDashboard />);
    expect(screen.getAllByText('$0.00')).toHaveLength(2);
    expect(screen.getByText('$0.0000')).toBeInTheDocument();
    expect(screen.getByText('0% saved')).toBeInTheDocument();
    expect(screen.queryByText('Not available yet')).toBeNull();
  });

  it('lists a model with an unknown cost as unavailable and never divides by zero sessions', () => {
    state(
      analytics({
        costByModel: [
          { aiModel: 'model-priced', cost: 3, sessions: 0 },
          { aiModel: 'model-unpriced', cost: null, sessions: 5 },
        ],
      }),
    );
    render(<CostAnalyticsDashboard />);
    expect(screen.getByText('model-unpriced')).toBeInTheDocument();
    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('$3.0000')).toBeInTheDocument();
    expect(screen.queryByText(/Infinity|NaN/)).toBeNull();
    expect(screen.queryByText(/\/session$/)).toBeNull();
  });

  it('shows the pattern learning impact "Total Saved" as money, with its dollar sign', () => {
    render(<CostAnalyticsDashboard />);
    const label = screen.getByText('Total Saved');
    expect(label.previousElementSibling).toHaveTextContent(/^\$5\.50$/);
  });
});
