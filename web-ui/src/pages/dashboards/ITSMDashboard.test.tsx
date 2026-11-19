// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type AxiosResponse } from 'axios';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import type { ITSMDashboardData } from '@/services/dashboard.service';
import { ITSMDashboard } from './ITSMDashboard';
import { apiClient } from '@/services/api';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

// Shaped as the API returns it; overrides model the organization's data.
const kpiPayload = (over: Partial<ITSMDashboardData> = {}): ITSMDashboardData => ({
  openIncidents: [], openIncidentCount: 7, changesInProgress: [], changesInProgressCount: 4,
  ciStatus: [{ status: 'active', count: 11 }], topFailingCIs: [], slaCompliance: [], baselineCompliance: [],
  unavailable: ['slaCompliance', 'baselineCompliance'], ...over,
});

function mockApi(kpis: ITSMDashboardData | Error, records = { incidents: 2, changes: 3 }) {
  vi.mocked(apiClient.get).mockImplementation(async (path) => {
    if (path === '/dashboards/itsm') {
      if (kpis instanceof Error) throw kpis;
      return { data: { success: true, data: kpis } } as unknown as AxiosResponse;
    }
    return { data: { success: true, pagination: { total: path === '/itil/incidents' ? records.incidents : records.changes } } } as unknown as AxiosResponse;
  });
}

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <ForbiddenHost />
      <QueryClientProvider client={client}><ITSMDashboard /></QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The app's real axios client wiring (session interceptors, which report a 403 to the shell) against a server that refuses the ITIL record routes. */
function clientRefusingRecords(ok: (url: string) => AxiosResponse) {
  const client = axios.create({
    adapter: async (config) => {
      if (String(config.url).startsWith('/itil/')) {
        throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, {
          status: 403, statusText: 'Forbidden', headers: {}, config,
          data: { _error: 'Forbidden', _message: "Permission 'read' required" },
        });
      }
      return ok(String(config.url));
    },
  });
  attachSession(client);
  return client;
}

it('shows only totals from scoped record endpoints', async () => {
  mockApi(kpiPayload());
  renderDashboard();
  expect(await screen.findByText('2')).toBeVisible();
  expect(screen.getByText('3')).toBeVisible();
  expect(apiClient.get).toHaveBeenCalledWith('/itil/incidents', { params: { limit: 1 } });
  expect(apiClient.get).toHaveBeenCalledWith('/itil/changes', { params: { limit: 1 } });
});

it('does not render partial totals when record tables are unavailable', async () => {
  vi.mocked(apiClient.get).mockImplementation(async (path) => {
    if (path === '/itil/changes') throw new Error('503');
    if (path === '/dashboards/itsm') return { data: { success: true, data: kpiPayload() } } as unknown as AxiosResponse;
    return { data: { success: true, pagination: { total: 42 } } } as unknown as AxiosResponse;
  });
  renderDashboard();
  expect(await screen.findByRole('alert')).toHaveTextContent('ITIL records unavailable');
  expect(screen.queryByText('42')).not.toBeInTheDocument();
});

it('shows computed KPIs with status colour and flags SLA compliance as not available', async () => {
  mockApi(kpiPayload());
  renderDashboard();
  expect(await screen.findByTestId('kpi-open-incidents')).toHaveTextContent('7');
  expect(screen.getByTestId('kpi-open-incidents')).toHaveClass('text-warning');
  expect(screen.getByTestId('kpi-changes-in-progress')).toHaveTextContent('4');
  expect(screen.getByTestId('kpi-active-cis')).toHaveTextContent('11');
  expect(screen.getByRole('status')).toHaveTextContent('SLA compliance: Not available yet');
});

it('renders a dash in a neutral colour, never 0, for ITIL KPIs when the ITIL records are not available; graph CIs still count', async () => {
  mockApi(kpiPayload({
    openIncidentCount: null, changesInProgressCount: null, ciStatus: [{ status: 'active', count: 11 }],
    unavailable: ['openIncidents', 'openIncidentCount', 'changesInProgress', 'changesInProgressCount',
      'topFailingCIs', 'slaCompliance', 'baselineCompliance'],
  }));
  renderDashboard();
  const open = await screen.findByTestId('kpi-open-incidents');
  expect(open).toHaveTextContent('—');
  expect(open).toHaveClass('text-muted-foreground');
  expect(open).not.toHaveClass('text-success');
  expect(screen.getByTestId('kpi-changes-in-progress')).toHaveTextContent('—');
  expect(screen.getByTestId('kpi-active-cis')).toHaveTextContent('11');
});

it.each([
  ['no CIs at all', []],
  ['CIs but none active', [{ status: 'retired', count: 3 }]],
])('an organization with %s has 0 active CIs, not a dash', async (_name, ciStatus) => {
  mockApi(kpiPayload({ ciStatus }));
  renderDashboard();
  expect(await screen.findByTestId('kpi-active-cis')).toHaveTextContent(/^0$/);
});

it('a genuine zero is shown as 0 and green, distinct from unavailable', async () => {
  mockApi(kpiPayload({ openIncidentCount: 0, unavailable: ['slaCompliance', 'baselineCompliance'] }));
  renderDashboard();
  const open = await screen.findByTestId('kpi-open-incidents');
  expect(open).toHaveTextContent('0');
  expect(open).toHaveClass('text-success');
});

it('keeps the record totals when only the KPI aggregate fails', async () => {
  mockApi(new Error('503'));
  renderDashboard();
  expect(await screen.findByText('2')).toBeVisible();
  expect(await screen.findByText('ITSM KPIs unavailable.')).toBeVisible();
});

const okResponse = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config: {} }) as AxiosResponse;

describe('ITSM dashboard states', () => {
  it('names what is loading while the requests are pending', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    renderDashboard();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading ITIL records');
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('offers a retry when the record totals fail, and shows the totals once it succeeds', async () => {
    vi.mocked(apiClient.get).mockImplementation(async (path) => {
      if (path === '/dashboards/itsm') return { data: { success: true, data: kpiPayload() } } as unknown as AxiosResponse;
      throw new Error('503');
    });
    renderDashboard();
    expect(await screen.findByRole('alert')).toHaveTextContent('ITIL records unavailable');
    mockApi(kpiPayload(), { incidents: 5, changes: 6 });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('5')).toBeVisible();
    expect(screen.getByText('6')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers a retry on its own when only the KPI aggregate fails', async () => {
    mockApi(new Error('503'));
    renderDashboard();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ITSM KPIs unavailable.');
    mockApi(kpiPayload());
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('kpi-open-incidents')).toHaveTextContent('7');
  });

  it('shows empty record tables as 0 incidents and 0 changes, not as missing', async () => {
    mockApi(kpiPayload({ ciStatus: [] }), { incidents: 0, changes: 0 });
    renderDashboard();
    const incidents = (await screen.findByRole('heading', { name: 'Incidents' })).closest('section')!;
    expect(within(incidents).getByText('0')).toBeVisible();
    const changes = screen.getByRole('heading', { name: 'Changes' }).closest('section')!;
    expect(within(changes).getByText('0')).toBeVisible();
  });

  it('a refused read reaches the shell banner and the page says it is not permitted instead of spinning; KPIs still show', async () => {
    const refusing = clientRefusingRecords(() => okResponse({ success: true, data: kpiPayload() }));
    vi.mocked(apiClient.get).mockImplementation((...args) => refusing.get(...args));
    renderDashboard();
    expect(await screen.findByText('No access to ITIL records')).toBeVisible();
    expect(screen.getAllByText(/Permission 'read' required/)).toHaveLength(2);
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(await screen.findByTestId('kpi-open-incidents')).toHaveTextContent('7');
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument();
    expect(screen.queryByText('ITIL records unavailable. No incident or change totals can be shown.')).not.toBeInTheDocument();
  });
});

describe('ITSM dashboard controls and structure', () => {
  it('offers no write control, only the retry on a failed read', async () => {
    mockApi(kpiPayload());
    renderDashboard();
    await screen.findByTestId('kpi-open-incidents');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('keeps a real h1 and a heading per record section', async () => {
    mockApi(kpiPayload());
    renderDashboard();
    expect(await screen.findByRole('heading', { level: 1, name: 'ITSM Dashboard' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Incidents' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeVisible();
  });
});
