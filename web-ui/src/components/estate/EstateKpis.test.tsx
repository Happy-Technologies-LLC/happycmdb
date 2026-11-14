// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DashboardStats } from '@/services/ci.service';
import { EstateKpis } from './EstateKpis';

afterEach(cleanup);

const stats = (health_score: number | null): DashboardStats => ({
  total_cis: 4,
  by_type: {} as DashboardStats['by_type'],
  by_status: { active: 4 } as DashboardStats['by_status'],
  by_environment: {} as DashboardStats['by_environment'],
  recent_discoveries: [],
  health_score,
  critical_relationships: 0,
});

function health(score: number | null) {
  render(<EstateKpis stats={stats(score)} loading={false} error={null} onRetry={vi.fn()} />);
  return screen.getByRole('group', { name: 'Health' });
}

describe('EstateKpis health card', () => {
  it('a null health_score is the explicit "Not available yet" state, never 0%', () => {
    const card = health(null);
    expect(within(card).getByText('Not available yet')).toBeInTheDocument();
    expect(within(card).queryByText(/%/)).toBeNull();
  });

  it('a measured health_score is shown as a percentage, including a measured 0', () => {
    expect(within(health(87)).getByText('87%')).toBeInTheDocument();
    cleanup();
    const zero = health(0);
    expect(within(zero).getByText('0%')).toBeInTheDocument();
    expect(within(zero).queryByText('Not available yet')).toBeNull();
  });
});
