// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type AxiosResponse } from 'axios';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import { EMPTY_VALUE } from '@/lib/dashboardValue';
import { ExecutiveDashboard } from './ExecutiveDashboard';
import { apiClient } from '@/services/api';
import type { ExecutiveSummaryData } from '@/services/dashboard.service';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <ForbiddenHost />
      <QueryClientProvider client={client}><ExecutiveDashboard /></QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderWith(payload: ExecutiveSummaryData) {
  vi.mocked(apiClient.get).mockResolvedValue(
    { data: { success: true, data: payload } } as unknown as AxiosResponse,
  );
  return mount();
}

/** The app's real axios client wiring (session interceptors, which report a 403 to the shell) against a server that refuses every read. */
function refusingClient() {
  const client = axios.create({
    adapter: async (config) => {
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, {
        status: 403, statusText: 'Forbidden', headers: {}, config,
        data: { _error: 'Forbidden', _message: "Permission 'read' required" },
      });
    },
  });
  attachSession(client);
  return client;
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

const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

const KNOWN: ExecutiveSummaryData = {
  ...NO_DATA,
  totalITSpend: 0,
  serviceHealthByTier: [{ tier: 'tier_1', averageHealthScore: 0, serviceCount: 2, trend: null }],
  topCostDrivers: [],
  valueScorecard: [
    { serviceId: 'a', serviceName: 'checkout', annualRevenue: 0, monthlyCost: 1200, roi: 0, customers: 0 },
    { serviceId: 'b', serviceName: 'storefront', annualRevenue: null, monthlyCost: null, roi: null, customers: null },
  ],
  unavailable: ['costTrends', 'valueScorecard.annualRevenue', 'valueScorecard.monthlyCost', 'valueScorecard.roi'],
};

describe('ExecutiveDashboard honesty: a real zero is a number, an unavailable figure is not', () => {
  it('renders genuine zeros as zeros next to dashes for exactly the null figures', async () => {
    renderWith(KNOWN);
    const spend = (await screen.findByText('Total IT Spend')).closest('div')!.parentElement!;
    expect(within(spend).getByText('$0')).toBeVisible();
    const health = screen.getByText('Overall Health Score').closest('div')!.parentElement!;
    expect(within(health).getByText('0%')).toBeVisible();

    const known = screen.getByText('checkout').closest('tr')!;
    expect(within(known).getByText('$1K')).toBeVisible();
    expect(within(known).getByText('0.0%')).toBeVisible();
    expect(within(known).getAllByText('$0')).toHaveLength(1);
    expect(within(known).getByText('0')).toBeVisible();

    const unknown = screen.getByText('storefront').closest('tr')!;
    expect(within(unknown).getAllByText(EMPTY_VALUE)).toHaveLength(4);
    expect(within(unknown).queryByText(/\$0|0%|^0$|NaN/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NaN');
  });
});

describe('ExecutiveDashboard states', () => {
  it('names what is loading while the request is pending', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading executive dashboard');
  });

  it('says so when a read fails, offers a retry, and recovers when the retry succeeds', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('upstream 500'));
    mount();
    expect(await screen.findByText('Could not load executive dashboard')).toBeVisible();
    expect(screen.getByText('upstream 500')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\$0|NaN/);
    const calls = vi.mocked(apiClient.get).mock.calls.length;

    vi.mocked(apiClient.get).mockResolvedValue(
      { data: { success: true, data: KNOWN } } as unknown as AxiosResponse,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Executive Dashboard' })).toBeVisible();
    expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThan(calls);
  });

  it('shows explicit empty text, not an empty chart or table, when there are no cost drivers or scorecard rows', async () => {
    renderWith({ ...NO_DATA, topCostDrivers: [], valueScorecard: [] });
    expect(await screen.findByText('Top cost drivers: Not available yet')).toBeVisible();
    expect(screen.getByText('Value scorecard: Not available yet')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a refused read reaches the shell banner and the page says it is not permitted instead of spinning', async () => {
    const refusing = refusingClient();
    vi.mocked(apiClient.get).mockImplementation((...args) => refusing.get(...args));
    mount();
    expect(await screen.findByText('No access to executive dashboard')).toBeVisible();
    expect(screen.getAllByText(/Permission 'read' required/)).toHaveLength(2);
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('ExecutiveDashboard controls', () => {
  it('offers only read actions: the range, two exports and a refresh (there is no write control)', async () => {
    renderWith(KNOWN);
    await screen.findByRole('heading', { level: 1, name: 'Executive Dashboard' });
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Export PDF', 'Export Excel', 'Refresh']);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('re-queries with the chosen range, and Refresh re-queries again', async () => {
    renderWith(KNOWN);
    const range = await screen.findByRole('combobox', { name: 'Time range' });
    expect(range).toHaveValue('1y');
    expect(vi.mocked(apiClient.get)).toHaveBeenLastCalledWith('/dashboards/executive?days=365');

    await userEvent.selectOptions(range, '90d');
    await waitFor(() => expect(vi.mocked(apiClient.get)).toHaveBeenLastCalledWith('/dashboards/executive?days=90'));
    expect(await screen.findByRole('combobox', { name: 'Time range' })).toHaveValue('90d');

    const before = vi.mocked(apiClient.get).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThan(before));
  });

  it('exports the current time range as a JSON download', async () => {
    renderWith(KNOWN);
    const blobs: Blob[] = [];
    window.URL.createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:export'; });
    window.URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Time range' }), '30d');
    await userEvent.click(await screen.findByRole('button', { name: 'Export PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }));
    await waitFor(() => expect(blobs).toHaveLength(2));
    expect(click).toHaveBeenCalledTimes(2);
    for (const blob of blobs) {
      expect(JSON.parse(await readBlob(blob))).toEqual({ timeRange: { start: '30d', end: 'now', label: 'Last 30 days' } });
    }
    click.mockRestore();
  });
});

describe('ExecutiveDashboard structure', () => {
  it('keeps real headings and the scorecard as a table with its column headers', async () => {
    renderWith(KNOWN);
    expect(await screen.findByRole('heading', { level: 1, name: 'Executive Dashboard' })).toBeVisible();
    for (const name of ['Service Health Scores by Tier', 'Top 5 Cost Drivers', 'Value Scorecard']) {
      expect(screen.getByRole('heading', { name })).toBeVisible();
    }
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map(h => h.textContent))
      .toEqual(['Service', 'Annual Revenue', 'Monthly Cost', 'ROI', 'Customers']);
    // ROI order: checkout (0) before the unknown row.
    expect(within(table).getAllByRole('row').slice(1).map(r => r.textContent?.slice(0, 8)))
      .toEqual(['checkout', 'storefro']);
  });

  it('orders the scorecard by ROI, highest first, with an unknown ROI last, whatever order the API lists them', async () => {
    const row = (serviceId: string, serviceName: string, roi: number | null) =>
      ({ serviceId, serviceName, annualRevenue: null, monthlyCost: null, roi, customers: null });
    renderWith({
      ...KNOWN,
      valueScorecard: [row('u', 'unrated', null), row('l', 'lowroi', 20), row('z', 'zeroroi', 0), row('h', 'highroi', 250), row('m', 'midroi', 90)],
    });
    const table = await screen.findByRole('table');
    const names = within(table).getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(['highroi', 'midroi', 'lowroi', 'zeroroi', 'unrated']);
  });
});
