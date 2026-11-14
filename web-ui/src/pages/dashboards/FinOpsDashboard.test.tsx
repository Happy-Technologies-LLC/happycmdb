// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { render, screen } from '@testing-library/react';
import { FinOpsDashboard } from './FinOpsDashboard';
import { apiClient } from '@/services/api';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

function servePayload(payload: unknown) {
  vi.mocked(apiClient.get).mockResolvedValue({
    data: { success: true, data: payload },
  } as unknown as AxiosResponse);
}

async function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FinOpsDashboard />
    </QueryClientProvider>
  );
  await screen.findByRole('heading', { name: 'FinOps Dashboard' });
}

function expectNoFabricatedFigures() {
  const text = document.body.textContent ?? '';
  expect(text).not.toContain('NaN');
  expect(text).not.toContain('$0');
  expect(text).not.toContain('0.0%');
}

// Shape the server returns when nothing has backing data.
const noBackingData = {
  cloudCosts: [],
  onPremVsCloud: { onPremCost: null, cloudCost: null, totalCost: null, tcoComparison: [] },
  costByTower: [{ tower: 'Compute', cost: null, subTowers: [] }],
  budgetVariance: [
    { capability: 'Compute', budgetAllocated: null, actualSpend: null, variance: null, variancePercent: null },
  ],
  unitEconomics: [],
  costOptimization: { recommendations: [], totalPotentialSavings: null },
  unavailable: [
    'cloudCosts', 'onPremVsCloud.tcoComparison',
    'budgetVariance.budgetAllocated', 'budgetVariance.variance', 'budgetVariance.variancePercent',
    'unitEconomics', 'costOptimization',
    'onPremVsCloud.onPremCost', 'onPremVsCloud.cloudCost', 'onPremVsCloud.totalCost',
    'costByTower.cost', 'budgetVariance.actualSpend',
  ],
};

it('renders every unbacked figure as an explicit empty state, never as zero', async () => {
  servePayload(noBackingData);
  await renderDashboard();

  for (const label of [
    'Cloud spend by provider',
    'On-premise vs cloud cost',
    'TCO comparison',
    'Cost allocation by resource tower',
    'Actual spend by capability',
    'Budget and variance',
    'Unit economics',
    'Cost optimization recommendations',
  ]) {
    expect(screen.getByText(`${label}: Not available yet`)).toBeVisible();
  }

  // KPI cards, the on-prem/cloud rows and the savings line show "—".
  expect(screen.getByText('Potential savings: —')).toBeVisible();
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(7);
  // The per-capability budget row has no variance badge.
  expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  expectNoFabricatedFigures();
});

it('shows known spend and omits the unknown budget and variance', async () => {
  servePayload({
    ...noBackingData,
    onPremVsCloud: { onPremCost: 1000000, cloudCost: 500000, totalCost: 1500000, tcoComparison: [] },
    costByTower: [
      { tower: 'Compute', cost: 1200000, subTowers: [] },
      { tower: 'Storage', cost: null, subTowers: [] },
    ],
    budgetVariance: [
      { capability: 'Compute', budgetAllocated: null, actualSpend: 250000, variance: null, variancePercent: null },
    ],
    unavailable: [
      'cloudCosts', 'onPremVsCloud.tcoComparison',
      'budgetVariance.budgetAllocated', 'budgetVariance.variance', 'budgetVariance.variancePercent',
      'unitEconomics', 'costOptimization',
      'costByTower.cost',
    ],
  });
  await renderDashboard();

  expect(screen.getAllByText('$1.5M').length).toBeGreaterThanOrEqual(2); // KPI + total row
  expect(screen.getByText('$1.0M')).toBeVisible();
  expect(screen.getByText('$500K')).toBeVisible();
  expect(screen.getByText('$250K')).toBeVisible();
  expect(screen.getByText('Budget and variance: Not available yet')).toBeVisible();
  expect(screen.getByText('Cost for Storage: Not available yet')).toBeVisible();
  expect(screen.queryByText('On-premise vs cloud cost: Not available yet')).not.toBeInTheDocument();
  expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  expectNoFabricatedFigures();
});

it('still renders real cloud spend, budgets, unit economics and recommendations', async () => {
  servePayload({
    cloudCosts: [
      { month: '2026-01', aws: 600000, azure: 300000, gcp: 100000, total: 1000000, forecast: 1000000 },
      { month: '2026-02', aws: 1200000, azure: 600000, gcp: 200000, total: 2000000, forecast: 2000000 },
    ],
    onPremVsCloud: {
      onPremCost: 1000000,
      cloudCost: 2000000,
      totalCost: 3000000,
      tcoComparison: [{ category: 'Compute', onPrem: 100, cloud: 200 }],
    },
    costByTower: [{ tower: 'Compute', cost: 900000, subTowers: [] }],
    budgetVariance: [
      { capability: 'Compute', budgetAllocated: 1000000, actualSpend: 1100000, variance: 100000, variancePercent: 10 },
    ],
    unitEconomics: [{ metric: 'Cost per VM', value: 120, unit: 'per month', trend: 'up', changePercent: 5 }],
    costOptimization: {
      recommendations: [
        {
          id: 'r1', type: 'rightsizing', resource: 'vm-1', currentCost: 900,
          potentialSavings: 400, description: 'Downsize', priority: 'high',
        },
      ],
      totalPotentialSavings: 40000,
    },
    unavailable: [],
  });
  await renderDashboard();

  expect(screen.getAllByText('$3.0M').length).toBeGreaterThanOrEqual(2); // total cloud spend + total IT cost
  expect(screen.getByText('$1.5M')).toBeVisible(); // monthly average
  expect(screen.getByText('+100%')).toBeVisible(); // month-over-month trend
  expect(screen.getByText('$1.1M / $1.0M')).toBeVisible();
  expect(screen.getByText('+10.0%')).toBeVisible();
  expect(screen.getByText('Cost per VM')).toBeVisible();
  expect(screen.getByText('$120')).toBeVisible();
  expect(screen.getByText('+5.0%')).toBeVisible();
  expect(screen.getByText('Potential savings: $40K')).toBeVisible();
  expect(screen.getByText('Save $400/mo')).toBeVisible();
  expect(screen.queryByText(/Not available yet/)).not.toBeInTheDocument();
});
