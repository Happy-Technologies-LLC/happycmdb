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
import { CIODashboard } from './CIODashboard';
import { apiClient } from '@/services/api';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

// Shaped exactly as packages/api-server getCIOMetrics returns it with no backing data.
const unavailablePayload = {
  serviceAvailability: ['tier_1', 'tier_2', 'tier_3', 'tier_4'].map(tier => ({
    tier,
    averageAvailability: null,
    slaTarget: null,
    complianceStatus: null,
  })),
  changeSuccessRates: { successful: null, failed: null, rollbacks: null, total: null, successRate: null },
  incidentResponseTimes: [],
  configurationAccuracy: {
    totalCIs: 1234,
    accurateCIs: null,
    accuracyPercentage: null,
    driftDetected: null,
    lastAuditDate: null,
  },
  costByCapability: [
    { capability: 'Payments', cost: 1500000, budgetAllocated: null, variance: null },
    { capability: 'Search', cost: null, budgetAllocated: null, variance: null },
  ],
  capacityPlanning: [],
  unavailable: [
    'serviceAvailability',
    'changeSuccessRates',
    'incidentResponseTimes',
    'configurationAccuracy.accurateCIs',
    'configurationAccuracy.accuracyPercentage',
    'configurationAccuracy.driftDetected',
    'configurationAccuracy.lastAuditDate',
    'costByCapability.budgetAllocated',
    'costByCapability.variance',
    'capacityPlanning',
    'costByCapability.cost',
  ],
};

const knownPayload = {
  serviceAvailability: [
    { tier: 'tier_1', averageAvailability: 99.95, slaTarget: 99.9, complianceStatus: 'compliant' },
    { tier: 'tier_2', averageAvailability: 99.85, slaTarget: 99.5, complianceStatus: 'compliant' },
  ],
  changeSuccessRates: { successful: 90, failed: 6, rollbacks: 4, total: 100, successRate: 90 },
  incidentResponseTimes: [{ priority: 'P1', mttr: 2.5, target: 4, count: 7 }],
  configurationAccuracy: {
    totalCIs: 1234,
    accurateCIs: 1200,
    accuracyPercentage: 97.2,
    driftDetected: 34,
    lastAuditDate: '2026-01-02T03:04:05.000Z',
  },
  costByCapability: [
    { capability: 'Payments', cost: 1200000, budgetAllocated: 1000000, variance: -200000 },
    { capability: 'Search', cost: 400000, budgetAllocated: 500000, variance: 100000 },
  ],
  capacityPlanning: [
    { month: 'Jan', computeUtilization: 60, storageUtilization: 50, networkUtilization: 40, forecast: 65 },
  ],
  unavailable: [],
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <ForbiddenHost />
      <QueryClientProvider client={client}><CIODashboard /></QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderDashboard(payload: unknown) {
  vi.mocked(apiClient.get).mockResolvedValue({
    data: { success: true, data: payload },
  } as unknown as AxiosResponse);
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

const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

it('renders null and empty CIO figures as explicit empty states, never zeros', async () => {
  renderDashboard(unavailablePayload);
  expect(await screen.findByText('CIO Dashboard')).toBeVisible();

  // Sections whose arrays are empty / all-null and named in `unavailable`
  expect(screen.getByText('Service availability: Not available yet')).toBeVisible();
  expect(screen.getByText('Change success rates: Not available yet')).toBeVisible();
  expect(screen.getByText('Incident response times: Not available yet')).toBeVisible();
  expect(screen.getByText('Capacity planning: Not available yet')).toBeVisible();
  expect(screen.getByText('Accuracy: Not available yet')).toBeVisible();
  expect(screen.getByText('Budget and variance: Not available yet')).toBeVisible();

  // Tier rows stay but with no invented SLA verdict
  expect(screen.getAllByText('Not available yet').length).toBeGreaterThanOrEqual(4);
  expect(screen.queryByText('Within SLA')).not.toBeInTheDocument();
  expect(screen.queryByText('Below SLA')).not.toBeInTheDocument();

  // KPI cards: nothing is known -> "—"
  const avail = screen.getByText('Average Availability').closest('div')!.parentElement!.parentElement!;
  expect(within(avail).getByText('—')).toBeVisible();
  const budget = screen.getByText('Total IT Budget').closest('div')!.parentElement!.parentElement!;
  expect(within(budget).getByText('—')).toBeVisible();
  expect(screen.getByText('Last audit: —')).toBeVisible();

  // totalCIs is real and still rendered
  expect(screen.getByText('1,234')).toBeVisible();

  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/NaN/);
  expect(text).not.toMatch(/\$0/);
  expect(text).not.toMatch(/0\.0%/);
  expect(text).not.toMatch(/0\.00%/);
  expect(text).not.toMatch(/1970/);
  expect(text).not.toMatch(/undefined/);
});

it('still renders real CIO values', async () => {
  renderDashboard(knownPayload);
  expect(await screen.findByText('CIO Dashboard')).toBeVisible();

  // Total budget = 1.0M + 0.5M
  const budget = screen.getByText('Total IT Budget').closest('div')!.parentElement!.parentElement!;
  expect(within(budget).getByText('$1.5M')).toBeVisible();
  // Mean of known tier availabilities
  const avail = screen.getByText('Average Availability').closest('div')!.parentElement!.parentElement!;
  expect(within(avail).getByText('99.90%')).toBeVisible();
  const change = screen.getByText('Change Success Rate').closest('div')!.parentElement!.parentElement!;
  expect(within(change).getByText('90.0%')).toBeVisible();
  expect(screen.getByText('100 changes (Last 30 days)')).toBeVisible();
  expect(screen.getAllByText('Within SLA')).toHaveLength(2);
  expect(screen.getByText('MTTR: 2.5h / Target: 4.0h')).toBeVisible();
  expect(screen.getByText('34')).toBeVisible();
  expect(screen.queryByText(/Not available yet/)).not.toBeInTheDocument();
});

// Real zeros: a tier with 0% availability, no change succeeded, no CI is accurate. Other figures are unknown.
const zeroPayload = {
  ...unavailablePayload,
  serviceAvailability: [{ tier: 'tier_1', averageAvailability: 0, slaTarget: 99.9, complianceStatus: 'non_compliant' }],
  changeSuccessRates: { successful: 0, failed: 3, rollbacks: 0, total: 3, successRate: 0 },
  configurationAccuracy: {
    totalCIs: 10, accurateCIs: 0, accuracyPercentage: 0, driftDetected: null, lastAuditDate: null,
  },
  unavailable: ['configurationAccuracy.driftDetected', 'configurationAccuracy.lastAuditDate'],
};

describe('CIODashboard honesty: a real zero is a number, an unavailable figure is not', () => {
  it('renders genuine zeros as zeros and only the null figures as unavailable', async () => {
    renderDashboard(zeroPayload);
    const avail = (await screen.findByText('Average Availability')).closest('div')!.parentElement!.parentElement!;
    expect(within(avail).getByText('0.00%')).toBeVisible();
    const change = screen.getByText('Change Success Rate').closest('div')!.parentElement!.parentElement!;
    expect(within(change).getByText('0.0%')).toBeVisible();
    const accuracy = screen.getByText('Config Accuracy').closest('div')!.parentElement!.parentElement!;
    expect(within(accuracy).getByText('0.0%')).toBeVisible();
    expect(within(accuracy).getByText(`Drift: Not available yet`)).toBeVisible();

    // A measured 0% accuracy draws an empty meter; the unknown case (below) draws none.
    expect(screen.getByRole('progressbar', { name: 'Configuration accuracy' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('Below SLA')).toBeVisible();
    // Drift is the one unknown tile.
    const drift = screen.getByText('Drift Detected').previousElementSibling!;
    expect(drift).toHaveTextContent(EMPTY_VALUE);
    expect(screen.getByText('Accurate CIs').previousElementSibling).toHaveTextContent(/^0$/);
    expect(screen.getByText(`Last audit: ${EMPTY_VALUE}`)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it('draws no accuracy meter when accuracy is unknown', async () => {
    renderDashboard(unavailablePayload);
    expect(await screen.findByText('Accuracy: Not available yet')).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('CIODashboard states', () => {
  it('names what is loading while the request is pending', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading CIO dashboard');
  });

  it('says so when a read fails, offers a retry, and recovers when the retry succeeds', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('upstream 500'));
    mount();
    expect(await screen.findByText('Could not load CIO dashboard')).toBeVisible();
    expect(screen.getByText('upstream 500')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\$0|NaN/);

    vi.mocked(apiClient.get).mockResolvedValue(
      { data: { success: true, data: knownPayload } } as unknown as AxiosResponse,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'CIO Dashboard' })).toBeVisible();
    expect(screen.getByText('$1.5M')).toBeVisible();
  });

  it('shows explicit empty text for every section when the organization has no data at all', async () => {
    renderDashboard({
      ...unavailablePayload,
      serviceAvailability: [],
      costByCapability: [],
      configurationAccuracy: { ...unavailablePayload.configurationAccuracy, totalCIs: 0 },
    });
    expect(await screen.findByText('Cost by capability: Not available yet')).toBeVisible();
    expect(screen.getByText('Service availability: Not available yet')).toBeVisible();
    expect(screen.getByText('Capacity planning: Not available yet')).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('a refused read reaches the shell banner and the page says it is not permitted instead of spinning', async () => {
    const refusing = refusingClient();
    vi.mocked(apiClient.get).mockImplementation((...args) => refusing.get(...args));
    mount();
    expect(await screen.findByText('No access to CIO dashboard')).toBeVisible();
    expect(screen.getAllByText(/Permission 'read' required/)).toHaveLength(2);
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('CIODashboard controls', () => {
  it('offers only read actions: the range, two exports and a refresh (there is no write control)', async () => {
    renderDashboard(knownPayload);
    await screen.findByRole('heading', { level: 1, name: 'CIO Dashboard' });
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Export PDF', 'Export Excel', 'Refresh']);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('re-queries with the chosen range, and Refresh re-queries again', async () => {
    renderDashboard(knownPayload);
    const range = await screen.findByRole('combobox', { name: 'Time range' });
    expect(range).toHaveValue('30d');
    expect(vi.mocked(apiClient.get)).toHaveBeenLastCalledWith('/dashboards/cio?days=30');

    await userEvent.selectOptions(range, '7d');
    await waitFor(() => expect(vi.mocked(apiClient.get)).toHaveBeenLastCalledWith('/dashboards/cio?days=7'));
    expect(await screen.findByRole('combobox', { name: 'Time range' })).toHaveValue('7d');

    const before = vi.mocked(apiClient.get).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThan(before));
  });

  it('exports the current time range as a JSON download', async () => {
    renderDashboard(knownPayload);
    const blobs: Blob[] = [];
    window.URL.createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:export'; });
    window.URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Time range' }), '90d');
    await userEvent.click(await screen.findByRole('button', { name: 'Export PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export Excel' }));
    await waitFor(() => expect(blobs).toHaveLength(2));
    expect(click).toHaveBeenCalledTimes(2);
    for (const blob of blobs) {
      expect(JSON.parse(await readBlob(blob))).toEqual({ timeRange: { start: '90d', end: 'now', label: 'Last 90 days' } });
    }
    click.mockRestore();
  });
});

describe('CIODashboard structure', () => {
  it('keeps real headings for each section', async () => {
    renderDashboard(knownPayload);
    expect(await screen.findByRole('heading', { level: 1, name: 'CIO Dashboard' })).toBeVisible();
    for (const name of [
      'Service Availability by Tier', 'Change Success Rates', 'Incident Response Times (MTTR)',
      'Configuration Accuracy', 'Cost by Business Capability', 'Capacity Planning',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeVisible();
    }
  });
});
