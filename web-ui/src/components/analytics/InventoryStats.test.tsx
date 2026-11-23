// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DashboardStats } from '@/services/analytics.service';

const overview = vi.hoisted(() => ({ dashboardStats: undefined as unknown }));

vi.mock('../../hooks/useAnalytics', () => ({
  useAnalyticsOverview: () => ({
    dashboardStats: overview.dashboardStats,
    ciCountsByType: [],
    ciCountsByStatus: [],
    discoveryStats: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('./TypeDistribution', () => ({ TypeDistribution: () => null }));
vi.mock('./StatusBreakdown', () => ({ StatusBreakdown: () => null }));
vi.mock('./EnvironmentStats', () => ({ EnvironmentStats: () => null }));

import { InventoryStats } from './InventoryStats';

afterEach(cleanup);

const stats = (health_score: number | null): DashboardStats => ({
  total_cis: 10,
  by_type: {},
  by_status: { active: 9 },
  by_environment: {},
  recent_discoveries: [],
  health_score,
  critical_relationships: 3,
});

function healthCard(score: number | null): HTMLElement {
  overview.dashboardStats = stats(score);
  render(<InventoryStats />);
  const card = screen.getByText('Health Score').closest('.h-full');
  if (!(card instanceof HTMLElement)) throw new Error('Health Score card not found');
  return card;
}

describe('InventoryStats health card', () => {
  it('a null health_score reads "Not available yet", with no percentage and no trend', () => {
    const card = healthCard(null);
    expect(within(card).getByText('Not available yet')).toBeInTheDocument();
    expect(within(card).queryByText(/%/)).toBeNull();
  });

  it('a measured health_score is shown as a percentage', () => {
    const card = healthCard(0);
    expect(within(card).getByText('0%')).toBeInTheDocument();
    expect(within(card).queryByText('Not available yet')).toBeNull();
  });
});
