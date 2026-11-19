// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FinOpsDashboard } from './FinOpsDashboard';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import { apiClient } from '@/services/api';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

// The export hook is replaced by spies: the arguments it is called with are the contract.
const exports = vi.hoisted(() => ({ exportToPDF: vi.fn(), exportToExcel: vi.fn() }));
vi.mock('@/hooks/useDashboardData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useDashboardData')>();
  return { ...actual, useExportDashboard: () => exports };
});

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  exports.exportToPDF.mockClear();
  exports.exportToExcel.mockClear();
});

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

// ---------------------------------------------------------------------------
// Page states, controls and genuine figures.
// ---------------------------------------------------------------------------

function renderWithShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ForbiddenHost />
        <FinOpsDashboard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** The real session client (its 403 interceptor reports to ForbiddenHost) answering every read with `status`. */
function refuseReads(status: number, body: unknown) {
  const client = axios.create({
    adapter: async (config: InternalAxiosRequestConfig) => {
      const response = { data: body, status, statusText: '', headers: {}, config, request: {} };
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
    },
  });
  attachSession(client);
  vi.mocked(apiClient.get).mockImplementation((url, config) => client.get(url, config));
}

const emptyPayload = {
  cloudCosts: [],
  onPremVsCloud: { onPremCost: null, cloudCost: null, totalCost: null, tcoComparison: [] },
  costByTower: [],
  budgetVariance: [],
  unitEconomics: [],
  costOptimization: { recommendations: [], totalPotentialSavings: null },
  unavailable: [],
};

const WRITE_CONTROL = /\b(create|add|new|edit|save|delete|remove|retire|update)\b/i;

describe('page states', () => {
  it('shows a labelled loading state while the read is in flight, and no figures', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    const { container } = renderWithShell();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading FinOps dashboard…');
    expect(container.textContent).not.toMatch(/NaN|\$0|0%/);
  });

  it('says so when the server answers with no cost data at all', async () => {
    servePayload(emptyPayload);
    const { container } = renderWithShell();

    expect(await screen.findByText('No FinOps data')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'FinOps Dashboard' })).toBeVisible();
    expect(container.textContent).not.toMatch(/NaN|\$0|0%/);
  });

  it('shows a visible, retryable error for a failed read, never a blank page or a zero', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('upstream exploded'));
    const { container } = renderWithShell();

    expect(await screen.findByText('Could not load FinOps dashboard')).toBeVisible();
    expect(screen.getByText('upstream exploded')).toBeVisible();
    expect(container.textContent).not.toMatch(/NaN|\$0|0%/);

    servePayload({ ...noBackingData });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Cloud spend by provider: Not available yet')).toBeVisible();
    expect(screen.queryByText('Could not load FinOps dashboard')).not.toBeInTheDocument();
  });

  it('shows its own not-permitted state on a 403 while the shell banner shows the server reason; a viewer is offered no write control', async () => {
    refuseReads(403, { _error: 'Forbidden', _message: "Permission 'read' required" });
    renderWithShell();

    expect(await screen.findByText('No access to FinOps dashboard')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    const names = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    expect(names).toEqual(['Export PDF', 'Export Excel', 'Refresh']);
    expect(names.filter((name) => WRITE_CONTROL.test(name))).toEqual([]);
  });
});

describe('controls', () => {
  it('refresh sends the query again', async () => {
    servePayload(noBackingData);
    renderWithShell();
    await screen.findByRole('heading', { name: 'FinOps Dashboard' });
    const before = vi.mocked(apiClient.get).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThan(before));
    expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toBe('/dashboards/finops?days=90');
  });

  it('re-queries with the selected range', async () => {
    servePayload(noBackingData);
    renderWithShell();
    await screen.findByRole('heading', { name: 'FinOps Dashboard' });
    expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toBe('/dashboards/finops?days=90');

    fireEvent.change(screen.getByRole('combobox', { name: 'Time range' }), { target: { value: '30d' } });

    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toBe('/dashboards/finops?days=30'));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Time range' }), { target: { value: '1y' } });
    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toBe('/dashboards/finops?days=365'));
  });

  it('exports with the selected range', async () => {
    servePayload(noBackingData);
    renderWithShell();
    await screen.findByRole('heading', { name: 'FinOps Dashboard' });

    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' }));

    const args = ['finops', { timeRange: { start: '90d', end: 'now', label: 'Last 90 days' } }];
    expect(exports.exportToPDF).toHaveBeenCalledWith(...args);
    expect(exports.exportToExcel).toHaveBeenCalledWith(...args);
  });

  it('titles the page and its sections with real headings', async () => {
    servePayload(noBackingData);
    renderWithShell();

    expect(await screen.findByRole('heading', { level: 1, name: 'FinOps Dashboard' })).toBeVisible();
    for (const name of [
      'On-Premise vs Cloud',
      'TCO Comparison',
      'Budget Variance by Capability',
      'Unit Economics',
      'Cost Optimization Recommendations',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeVisible();
    }
  });
});

describe('uncosted and genuinely zero figures', () => {
  it('renders an uncosted cloud segment as unavailable, not as a zero-width slice labelled 0%', async () => {
    servePayload({
      ...noBackingData,
      onPremVsCloud: { onPremCost: 1000000, cloudCost: null, totalCost: null, tcoComparison: [] },
      unavailable: ['onPremVsCloud.cloudCost', 'onPremVsCloud.totalCost'],
    });
    renderWithShell();

    expect(await screen.findByText('On-premise vs cloud cost: Not available yet')).toBeVisible();
    expect(screen.getByText('$1.0M')).toBeVisible();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/NaN|\$0|0\.0%|0%/);
  });

  it('renders a costed segment of exactly zero as $0, not as unavailable', async () => {
    servePayload({
      ...noBackingData,
      onPremVsCloud: { onPremCost: 1000000, cloudCost: 0, totalCost: 1000000, tcoComparison: [] },
      unitEconomics: [{ metric: 'Cost per VM', value: 0, unit: 'per month', trend: null, changePercent: null }],
      unavailable: ['unitEconomics'],
    });
    renderWithShell();

    // The cloud row and the unit metric, each a costed zero.
    expect(await screen.findAllByText('$0')).toHaveLength(2);
    expect(screen.queryByText('On-premise vs cloud cost: Not available yet')).not.toBeInTheDocument();
    expect(screen.getByText('Cost per VM').parentElement).toHaveTextContent('$0');
  });
});
