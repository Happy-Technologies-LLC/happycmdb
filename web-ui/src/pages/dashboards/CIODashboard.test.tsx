// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { render, screen, within } from '@testing-library/react';
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

function renderDashboard(payload: unknown) {
  vi.mocked(apiClient.get).mockResolvedValue({
    data: { success: true, data: payload },
  } as unknown as AxiosResponse);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><CIODashboard /></QueryClientProvider>);
}

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
