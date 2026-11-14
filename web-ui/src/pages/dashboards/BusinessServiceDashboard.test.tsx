// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, within } from '@testing-library/react';
import cytoscape from 'cytoscape';
import { BusinessServiceDashboard } from './BusinessServiceDashboard';
import { brand } from '@/lib/brandColors';
import type { BusinessServiceDashboardData } from '@/services/dashboard.service';

// The hook only fetches once a service is chosen, so replace it at the data
// boundary with the per-section shape it builds from the dashboard payload.
// The heat map is always populated (a stand-in for the unreachable no-service
// state); every other section appears only after a service is selected.
const mocked = vi.hoisted(() => ({ payload: undefined as unknown }));
vi.mock('@/hooks/useDashboardData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useDashboardData')>();
  return {
    ...actual,
    useBusinessServiceDashboard: (serviceId?: string) => {
      const payload = mocked.payload as BusinessServiceDashboardData;
      const section = <K extends keyof BusinessServiceDashboardData>(key: K) => ({
        data: key === 'serviceHealth' || serviceId ? payload[key] : undefined,
        loading: false,
        error: null,
        refetch: vi.fn(),
      });
      return {
        unavailable: payload.unavailable,
        serviceHealth: section('serviceHealth'),
        revenueAtRisk: section('revenueAtRisk'),
        customerImpact: section('customerImpact'),
        complianceStatus: section('complianceStatus'),
        valueStreamHealth: section('valueStreamHealth'),
        serviceDependencies: section('serviceDependencies'),
      };
    },
  };
});
vi.mock('cytoscape', () => ({ default: vi.fn(() => ({ destroy: vi.fn() })) }));

/** The payload getBusinessServiceDashboard returns for a service today. */
const serverPayload: BusinessServiceDashboardData = {
  serviceHealth: [],
  revenueAtRisk: {
    totalAnnualRevenue: null, revenueAtRisk: null, percentageAtRisk: null, affectedIncidents: [],
  },
  customerImpact: {
    totalCustomers: null, customersImpacted: null, estimatedUserImpact: null, incidents: [],
  },
  complianceStatus: {
    pciCompliant: null, hipaaCompliant: null, soxCompliant: null, gdprCompliant: null,
    lastAuditDate: null, nonCompliantItems: [],
  },
  valueStreamHealth: { stages: [], flowRate: null, cycleTime: null },
  serviceDependencies: {
    nodes: [
      { id: 'a', label: 'Checkout', type: 'business-service', healthScore: null, status: 'active', layer: 0 },
      { id: 'b', label: 'Web', type: 'application', healthScore: null, status: 'active', layer: 1 },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b', type: 'DEPENDS_ON', healthImpact: null }],
  },
  unavailable: [
    'serviceHealth', 'revenueAtRisk', 'customerImpact', 'complianceStatus', 'valueStreamHealth',
    'serviceDependencies.healthScore', 'serviceDependencies.healthImpact',
  ],
};

/** Same payload with one selectable (unscored) tile so a service can be chosen. */
const selectablePayload: BusinessServiceDashboardData = {
  ...serverPayload,
  serviceHealth: [
    {
      businessUnit: 'sales',
      businessServices: [{ serviceId: 'bs-1', serviceName: 'Quotes', healthScore: null, status: 'active' }],
    },
  ],
};

function renderDashboard(payload: BusinessServiceDashboardData, selectService?: string) {
  mocked.payload = payload;
  const result = render(<BusinessServiceDashboard />);
  if (selectService) fireEvent.click(screen.getByText(selectService).closest('button')!);
  return result;
}

function kpiCard(title: string): HTMLElement {
  // The KPI card precedes any same-titled detail section in document order.
  return screen.getAllByText(title)[0].closest('div[class*="space-y-3"]') as HTMLElement;
}

beforeEach(() => {
  vi.mocked(cytoscape).mockClear();
});

it('shows an explicit empty state for the heat map and offers no selection', () => {
  const { container } = renderDashboard(serverPayload);

  expect(screen.getByText('Service health: Not available yet')).toBeVisible();
  expect(screen.getByText('Select a Business Service')).toBeVisible();
  expect(container.textContent).not.toMatch(/NaN|\$0|0\.0%|0%/);
});

it('renders null figures as explicit empty states, never zeros or non-compliance', () => {
  const { container } = renderDashboard(selectablePayload, 'Quotes');

  expect(screen.getByText('Revenue at risk details: Not available yet')).toBeVisible();
  expect(screen.getByText('Value stream stages: Not available yet')).toBeVisible();
  expect(screen.getByText('Last audit: Not available yet')).toBeVisible();
  expect(screen.getByText('Flow rate: — | Cycle time: —', { exact: false })).toBeVisible();

  for (const title of ['Revenue at Risk', 'Customers Impacted', 'Estimated User Impact', 'Compliance Score']) {
    const card = within(kpiCard(title));
    expect(card.getByText('—')).toBeVisible();
    expect(card.getByText('Not available yet')).toBeVisible();
  }

  // Four framework badges, none of them a verdict.
  const complianceSection = screen.getByText('Compliance Status').closest('div') as HTMLElement;
  expect(within(complianceSection).getAllByText('Not available yet')).toHaveLength(4);

  const text = container.textContent ?? '';
  expect(text).not.toMatch(/NaN|\$0|0\.0%|0%/);
  expect(text).not.toMatch(/Compliant/);
  expect(text).not.toMatch(/Healthy|Warning \(|Critical/);
});

it('colours unknown graph health neutrally and labels it unavailable', () => {
  renderDashboard(selectablePayload, 'Quotes');

  expect(screen.getByText('Health: Not available yet')).toBeVisible();
  expect(cytoscape).toHaveBeenCalledTimes(1);

  const config = vi.mocked(cytoscape).mock.calls[0][0] as unknown as {
    style: Array<{ selector: string; style: Record<string, unknown> }>;
  };
  const nodeColor = config.style.find((rule) => rule.selector === 'node')!
    .style['background-color'] as (ele: unknown) => string;
  const colorFor = (healthScore: number | null) => nodeColor({ data: () => healthScore });
  expect(colorFor(null)).toBe(brand.inkSoft);
  expect(colorFor(null)).not.toBe(brand.danger);
  expect(colorFor(95)).toBe(brand.success);
  expect(colorFor(10)).toBe(brand.danger);
});

it('still renders real values and verdicts when they are known', async () => {
  renderDashboard({
    ...serverPayload,
    serviceHealth: [
      {
        businessUnit: 'sales',
        businessServices: [
          { serviceId: 'bs-1', serviceName: 'Checkout', healthScore: 92, status: 'active' },
          { serviceId: 'bs-2', serviceName: 'Quotes', healthScore: null, status: 'active' },
        ],
      },
    ],
    revenueAtRisk: {
      totalAnnualRevenue: 12000000,
      revenueAtRisk: 1500000,
      percentageAtRisk: 12.5,
      affectedIncidents: [{ id: 'INC-1', priority: 'P1', estimatedImpact: 250000 }],
    },
    customerImpact: { totalCustomers: 5000, customersImpacted: 40, estimatedUserImpact: 1200, incidents: [] },
    complianceStatus: {
      pciCompliant: true, hipaaCompliant: false, soxCompliant: null, gdprCompliant: true,
      lastAuditDate: null, nonCompliantItems: [],
    },
    valueStreamHealth: {
      stages: [{ name: 'Build', healthScore: 88, throughput: 14, bottleneck: false }],
      flowRate: 120,
      cycleTime: 4.5,
    },
    unavailable: ['serviceDependencies.healthScore'],
  }, 'Checkout');

  expect(screen.getByText('92%')).toBeVisible();
  expect(screen.getByText('Quotes').parentElement).toHaveTextContent('Quotes—');

  expect(within(kpiCard('Revenue at Risk')).getByText('$1.5M')).toBeVisible();
  expect(within(kpiCard('Revenue at Risk')).getByText('12.5% of total revenue')).toBeVisible();
  expect(within(kpiCard('Customers Impacted')).getByText('40')).toBeVisible();
  expect(within(kpiCard('Customers Impacted')).getByText('5,000 total customers')).toBeVisible();
  expect(within(kpiCard('Compliance Score')).getByText('2/3')).toBeVisible();
  expect(within(kpiCard('Compliance Score')).getByText('3 of 4 frameworks reported')).toBeVisible();

  expect(screen.getByText('Total annual revenue: $12.0M')).toBeVisible();
  expect(screen.getByText('$250K at risk')).toBeVisible();
  expect(screen.getAllByText('Compliant')).toHaveLength(2);
  expect(screen.getAllByText('Non-Compliant')).toHaveLength(1);
  expect(screen.getAllByText('Not available yet').length).toBeGreaterThan(0);
  expect(screen.getByText('Flow rate: 120 requests/day | Cycle time: 4.5h')).toBeVisible();
  expect(screen.getByText('88%')).toBeVisible();
});
