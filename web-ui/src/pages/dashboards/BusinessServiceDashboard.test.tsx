// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Badge } from '@happy-technologies/design-system';
import { MemoryRouter } from 'react-router-dom';
import cytoscape from 'cytoscape';
import { BusinessServiceDashboard } from './BusinessServiceDashboard';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { brand } from '@/lib/brandColors';
import { EMPTY_VALUE } from '@/lib/dashboardValue';
import { attachSession } from '@/lib/session';
import { apiClient } from '@/services/api';
import type { BusinessServiceDashboardData } from '@/services/dashboard.service';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

// The hook only fetches once a service is chosen, and the service tiles it would
// fetch are the only way to choose one. Two modes replace that at the hook boundary:
//   stub: the per-section shape it builds from the dashboard payload, heat map
//         always populated, every other section only after a service is selected.
//   live: the real hook and service layer, with a service id forced so the first
//         request is sent (loading, empty, error and 403 are the real query states).
//   idle: the real hook as the app mounts it, before any service is chosen: no request.
// The export hook is replaced by spies; the export arguments are the contract.
const mocked = vi.hoisted(() => ({
  mode: 'stub' as 'stub' | 'live' | 'idle',
  payload: undefined as unknown,
  refetch: {} as Record<string, ReturnType<typeof vi.fn>>,
  exportToPDF: vi.fn(),
  exportToExcel: vi.fn(),
}));
vi.mock('@/hooks/useDashboardData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useDashboardData')>();
  return {
    ...actual,
    useExportDashboard: () => ({ exportToPDF: mocked.exportToPDF, exportToExcel: mocked.exportToExcel }),
    useBusinessServiceDashboard: (serviceId?: string, businessUnit?: string) => {
      if (mocked.mode === 'live') return actual.useBusinessServiceDashboard('bs-live', businessUnit);
      if (mocked.mode === 'idle') return actual.useBusinessServiceDashboard(serviceId, businessUnit);
      const payload = mocked.payload as BusinessServiceDashboardData;
      const section = <K extends keyof BusinessServiceDashboardData>(key: K) => ({
        data: key === 'serviceHealth' || serviceId ? payload[key] : undefined,
        loading: false,
        error: null,
        refetch: (mocked.refetch[key] ??= vi.fn()),
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
  vi.mocked(apiClient.get).mockReset();
  mocked.mode = 'stub';
  mocked.refetch = {};
  mocked.exportToPDF.mockClear();
  mocked.exportToExcel.mockClear();
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
  const complianceSection = screen.getByRole('region', { name: 'Compliance Status' });
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

// ---------------------------------------------------------------------------
// Page states, through the real hook and service layer (mode 'live').
// ---------------------------------------------------------------------------

function renderLive(mode: 'live' | 'idle' = 'live') {
  mocked.mode = mode;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ForbiddenHost />
        <BusinessServiceDashboard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function serve(payload: unknown) {
  vi.mocked(apiClient.get).mockResolvedValue({
    data: { success: true, data: payload },
  } as unknown as AxiosResponse);
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

const WRITE_CONTROL = /\b(create|add|new|edit|save|delete|remove|retire|update)\b/i;

describe('page states', () => {
  it('shows a labelled loading state while the first read is in flight, and no figures', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    const { container } = renderLive();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading service health…');
    expect(screen.getByRole('heading', { level: 1, name: 'Business Service Dashboard' })).toBeVisible();
    expect(container.textContent).not.toMatch(/NaN|\$0|0%/);
  });

  it('does not claim the server reported no services before it has been asked', async () => {
    renderLive('idle');

    expect(await screen.findByText('Select a business unit to view services')).toBeVisible();
    expect(screen.queryByText('No business services')).not.toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('says so when the server answers with no business services', async () => {
    serve({ ...serverPayload, serviceHealth: [], unavailable: [] });
    renderLive();

    expect(await screen.findByText('No business services')).toBeVisible();
    expect(screen.queryByText('Service health: Not available yet')).not.toBeInTheDocument();
  });

  it('shows a visible, retryable error for a failed read, never a blank page or a zero', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('upstream exploded'));
    const { container } = renderLive();

    expect(await screen.findByText('Could not load business service dashboard')).toBeVisible();
    expect(screen.getByText('upstream exploded')).toBeVisible();
    expect(container.textContent).not.toMatch(/NaN|\$0|0%/);

    serve(selectablePayload);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Quotes')).toBeVisible();
    expect(screen.queryByText('Could not load business service dashboard')).not.toBeInTheDocument();
  });

  it('shows its own not-permitted state on a 403 while the shell banner shows the server reason; a viewer is offered no write control', async () => {
    refuseReads(403, { _error: 'Forbidden', _message: "Permission 'read' required" });
    renderLive();

    expect(await screen.findByText('No access to business service dashboard')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

    const names = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    expect(names).toEqual(['Export PDF', 'Export Excel', 'Refresh']);
    expect(names.filter((name) => WRITE_CONTROL.test(name))).toEqual([]);
  });

  it('offers only read controls on a loaded dashboard', async () => {
    serve({ ...selectablePayload, unavailable: [] });
    renderLive();
    await screen.findByText('Quotes');

    const names = screen.getAllByRole('button').map((button) => button.getAttribute('title') ?? button.textContent ?? '');
    expect(names.filter((name) => WRITE_CONTROL.test(name))).toEqual([]);
  });

  it('refresh sends the query again', async () => {
    serve(selectablePayload);
    renderLive();
    await screen.findByText('Quotes');
    const before = vi.mocked(apiClient.get).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThan(before));
    expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toBe('/dashboards/business-service/bs-live');
  });
});

describe('controls', () => {
  it('refreshes the heat map alone until a service is selected, then every section', () => {
    renderDashboard(selectablePayload);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocked.refetch.serviceHealth).toHaveBeenCalledTimes(1);
    for (const key of ['revenueAtRisk', 'customerImpact', 'complianceStatus']) {
      expect(mocked.refetch[key]).not.toHaveBeenCalled();
    }

    fireEvent.click(screen.getByText('Quotes').closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(mocked.refetch.serviceHealth).toHaveBeenCalledTimes(2);
    for (const key of ['revenueAtRisk', 'customerImpact', 'complianceStatus']) {
      expect(mocked.refetch[key]).toHaveBeenCalledTimes(1);
    }
  });

  it('exports with the selected service and business unit', () => {
    renderDashboard(selectablePayload, 'Quotes');
    fireEvent.change(screen.getByRole('combobox', { name: 'Business unit' }), { target: { value: 'sales' } });

    fireEvent.click(screen.getByRole('button', { name: 'Export PDF' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' }));

    const args = ['business-service', { selectedService: 'bs-1', selectedBusinessUnit: 'sales' }];
    expect(mocked.exportToPDF).toHaveBeenCalledWith(...args);
    expect(mocked.exportToExcel).toHaveBeenCalledWith(...args);
  });

  it('titles the page and its sections with real headings', () => {
    renderDashboard(selectablePayload, 'Quotes');

    expect(screen.getByRole('heading', { level: 1, name: 'Business Service Dashboard' })).toBeVisible();
    for (const name of ['Service Health by Business Unit', 'Compliance Status', 'Service Dependency Map']) {
      expect(screen.getByRole('heading', { name })).toBeVisible();
    }
    expect(screen.getByRole('heading', { name: 'sales' })).toBeVisible();
  });
});

describe('health and genuine zeros', () => {
  /**
   * The design-system Badge shows its variant only through its colour classes (`bg-`/`text-`/`border-`
   * utilities over `--hh-*` tokens). The expected classes are read off a real Badge of that variant, so the
   * assertion follows the package. The base geometry classes (`rounded-[var(--hh-radius-pill)]`) also carry
   * `--hh-` but are the same for every variant, so only the colour utilities count.
   */
  const TONES = ['neutral', 'success', 'warning', 'danger'] as const;
  const toneClassCache = new Map<(typeof TONES)[number], string[]>();
  const badgeToneClasses = (variant: (typeof TONES)[number]) => {
    const cached = toneClassCache.get(variant);
    if (cached) return cached;
    const { unmount } = render(<Badge variant={variant}>reference</Badge>);
    const classes = screen
      .getByText('reference')
      .className.split(/\s+/)
      .filter(c => /^(bg|text|border)-/.test(c) && c.includes('--hh-'));
    unmount();
    expect(classes.length).toBeGreaterThan(0);
    toneClassCache.set(variant, classes);
    return classes;
  };

  it('the design-system Badge renders a distinct colour class set per tone', () => {
    const sets = TONES.map(tone => badgeToneClasses(tone).slice().sort().join(' '));
    expect(new Set(sets).size).toBe(TONES.length);
  });

  const expectTileBadgeTone = (
    tile: HTMLElement,
    text: string,
    tone: (typeof TONES)[number],
  ) => {
    const badge = within(tile).getByText(text);
    const expected = badgeToneClasses(tone);
    expect(badge).toHaveClass(...expected);
    for (const other of TONES) {
      if (other === tone) continue;
      for (const c of badgeToneClasses(other).filter(c => !expected.includes(c))) expect(badge).not.toHaveClass(c);
    }
  };

  it('marks a service of unknown health neutral and "unknown", and a scored one by its band', () => {
    renderDashboard({
      ...selectablePayload,
      serviceHealth: [
        {
          businessUnit: 'sales',
          businessServices: [
            { serviceId: 'a', serviceName: 'Quotes', healthScore: null, status: 'active' },
            { serviceId: 'b', serviceName: 'Checkout', healthScore: 92, status: 'active' },
            { serviceId: 'c', serviceName: 'Billing', healthScore: 65, status: 'active' },
            { serviceId: 'd', serviceName: 'Search', healthScore: 12, status: 'active' },
          ],
        },
      ],
    });

    const tile = (name: string) => screen.getByText(name).closest('button')!;
    expectTileBadgeTone(tile('Quotes'), EMPTY_VALUE, 'neutral');
    expect(tile('Quotes')).toHaveAccessibleName(/unknown/);
    expect(tile('Quotes')).not.toHaveAccessibleName(/healthy|warning|critical/);
    expectTileBadgeTone(tile('Checkout'), '92%', 'success');
    expect(tile('Checkout')).toHaveAccessibleName(/healthy/);
    expectTileBadgeTone(tile('Billing'), '65%', 'warning');
    expectTileBadgeTone(tile('Search'), '12%', 'danger');
    expect(tile('Search')).toHaveAccessibleName(/critical/);
  });

  it('renders a genuine zero as 0, not as unavailable', () => {
    renderDashboard({
      ...selectablePayload,
      serviceHealth: [
        {
          businessUnit: 'sales',
          businessServices: [{ serviceId: 'bs-1', serviceName: 'Quotes', healthScore: 0, status: 'active' }],
        },
      ],
      revenueAtRisk: { totalAnnualRevenue: 0, revenueAtRisk: 0, percentageAtRisk: 0, affectedIncidents: [] },
      customerImpact: { totalCustomers: 0, customersImpacted: 0, estimatedUserImpact: 0, incidents: [] },
      unavailable: [],
    }, 'Quotes');

    expect(screen.getByText('0%')).toBeVisible();
    expectTileBadgeTone(screen.getByText('Quotes').closest('button')!, '0%', 'danger');
    expect(within(kpiCard('Revenue at Risk')).getByText('$0')).toBeVisible();
    expect(within(kpiCard('Customers Impacted')).getByText('0')).toBeVisible();
    expect(within(kpiCard('Customers Impacted')).getByText('0 total customers')).toBeVisible();
    expect(within(kpiCard('Estimated User Impact')).getByText('0')).toBeVisible();
  });
});
