// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { render, screen } from '@testing-library/react';
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
  return render(<QueryClientProvider client={client}><ITSMDashboard /></QueryClientProvider>);
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
