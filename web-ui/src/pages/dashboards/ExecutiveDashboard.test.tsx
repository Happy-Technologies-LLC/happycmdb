// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { render, screen, within } from '@testing-library/react';
import { ExecutiveDashboard } from './ExecutiveDashboard';
import { apiClient } from '@/services/api';
import type { ExecutiveSummaryData } from '@/services/dashboard.service';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

function renderWith(payload: ExecutiveSummaryData) {
  vi.mocked(apiClient.get).mockResolvedValue(
    { data: { success: true, data: payload } } as unknown as AxiosResponse,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ExecutiveDashboard /></QueryClientProvider>);
}

// Shaped as the API returns it for an organization whose CIs carry no cost or revenue data.
const NO_DATA: ExecutiveSummaryData = {
  totalITSpend: null,
  costByCapability: [{ capability: 'Uncategorized', totalCost: null, businessServices: [] }],
  costTrends: [],
  serviceHealthByTier: ['tier_1', 'tier_2', 'tier_3', 'tier_4'].map(tier => (
    { tier, averageHealthScore: null, serviceCount: 0, trend: null }
  )),
  riskMatrix: { services: [] },
  topCostDrivers: [{
    serviceId: 'ci-1', serviceName: 'billing-db', monthlyCost: 2500, trend: null, changePercent: null,
  }],
  valueScorecard: [{
    serviceId: 'ci-2', serviceName: 'storefront', annualRevenue: null, monthlyCost: null, roi: null, customers: null,
  }],
  unavailable: ['totalITSpend', 'costTrends', 'serviceHealthByTier.averageHealthScore'],
};

describe('ExecutiveDashboard with no backing data', () => {
  it('shows dashes and "Not available yet", never 0 or NaN, for null figures', async () => {
    renderWith(NO_DATA);
    const spend = (await screen.findByText('Total IT Spend')).closest('div')!.parentElement!;
    expect(within(spend).getByText('—')).toBeVisible();

    const health = screen.getByText('Overall Health Score').closest('div')!.parentElement!;
    expect(within(health).getByText('—')).toBeVisible();
    const roi = screen.getByText('Average ROI').closest('div')!.parentElement!;
    expect(within(roi).getByText('—')).toBeVisible();

    expect(screen.getByText('Cost trends: Not available yet')).toBeVisible();
    expect(screen.getByText('Service health scores: Not available yet')).toBeVisible();

    const row = screen.getByText('storefront').closest('tr')!;
    expect(within(row).getAllByText('—')).toHaveLength(4);

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('$0');
    expect(text).not.toContain('0.0%');
    expect(text).not.toContain('0%');
  });

  it('keeps real figures next to unavailable ones', async () => {
    renderWith({ ...NO_DATA, totalITSpend: 1_500_000 });
    expect(await screen.findByText('$1.5M')).toBeVisible();
    expect(screen.getByText('$3K/mo')).toBeVisible();
  });
});
