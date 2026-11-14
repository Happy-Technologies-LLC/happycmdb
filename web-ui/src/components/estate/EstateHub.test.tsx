// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1252 S2 (HAP-1916): the estate hub against a played server. The real services and their real session
// interceptors talk to an axios adapter; nothing below the hub is mocked except who is signed in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'admin' as string }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

type Reply =
  | { status: number; body: unknown }
  | 'pending'
  | ((params: Record<string, unknown>) => { status: number; body: unknown });
const world: { routes: Record<string, Reply>; requests: string[] } = { routes: {}, requests: [] };

const { default: axios } = await import('axios');
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = String(config.url);
  world.requests.push(
    `${config.method} ${url}${config.params ? `?${new URLSearchParams(config.params).toString()}` : ''}`
  );
  const key = Object.keys(world.routes).find((k) => url === k || url.startsWith(`${k}?`));
  const played = key ? world.routes[key] : { status: 404, body: { message: `unplayed ${url}` } };
  if (played === 'pending') return new Promise(() => undefined);
  const reply = typeof played === 'function' ? played(config.params ?? {}) : played;
  const response = {
    data: reply.body,
    status: reply.status,
    statusText: '',
    headers: {},
    config,
    request: {},
  };
  if (reply.status < 400) return response;
  throw new AxiosError(
    `Request failed with status code ${reply.status}`,
    'ERR_BAD_REQUEST',
    config,
    {},
    response
  );
};
const { EstateHub } = await import('./EstateHub');
const { ForbiddenHost } = await import('../layout/ForbiddenHost');

const ci = (id: string, type: string, name = id) => ({
  id,
  name,
  type,
  status: 'active',
  environment: 'production',
  attributes: {},
  tags: [],
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-01T10:00:00Z',
});
const CIS = [
  ci('svc-1', 'service', 'checkout'),
  ci('app-1', 'application', 'payments-api'),
  ci('db-1', 'database', 'orders-db'),
  ci('srv-1', 'server', 'host-1'),
];
const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (message: string): Reply => ({
  status: 403,
  body: { _error: 'Forbidden', _message: message },
});
const incident = (over: Record<string, unknown>) => ({
  id: 'i1',
  incident_number: 'INC-20481',
  title: 'Orders database primary failing',
  priority: 1,
  status: 'new',
  affected_ci_id: 'db-1',
  reported_at: new Date(Date.now() - 14 * 60000).toISOString(),
  business_impact: { estimated_user_impact: 0, estimated_revenue_impact: 0 },
  ...over,
});

function play(over: Record<string, Reply> = {}) {
  world.routes = {
    '/analytics/dashboard': ok({
      total_cis: 4,
      by_type: { service: 1, application: 1, database: 1, server: 1 },
      by_status: { active: 4 },
      by_environment: { production: 4 },
      recent_discoveries: [],
      // The server sends null until a CI health state exists (BW1, BW4): the hub must show it as unavailable.
      health_score: null,
      critical_relationships: 12,
    }),
    '/cis': ok({
      success: true,
      data: CIS,
      pagination: { total: 4, page: 1, limit: 150, totalPages: 1 },
    }),
    '/relationships': ok({
      success: true,
      data: [
        {
          from_id: 'app-1',
          from_name: 'payments-api',
          from_type: 'application',
          to_id: 'db-1',
          to_name: 'orders-db',
          to_type: 'database',
          type: 'DEPENDS_ON',
        },
      ],
      pagination: { total: 1, count: 1, offset: 0, limit: 400 },
    }),
    '/itil/incidents': ok({ success: true, data: [], pagination: { total: 0 } }),
    ...over,
  };
}

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

const mount = (url = '/') =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <MemoryRouter initialEntries={[url]}>
        <ForbiddenHost />
        <Routes>
          <Route path="/" element={<EstateHub />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(() => {
  auth.role = 'admin';
  world.requests = [];
  play();
});
afterEach(cleanup);

describe('estate hub: Stage views', () => {
  it('draws the orbit from the CI list and the relationship endpoints, and opens a CI from its dot (ME6, ME16)', async () => {
    const user = userEvent.setup();
    mount();
    const dot = await screen.findByRole('button', { name: 'orders-db, database' });
    expect(
      screen.getAllByRole('button', { name: /, (service|application|database|server)$/ })
    ).toHaveLength(4);
    await user.click(dot);
    expect(screen.getByTestId('where').textContent).toBe('/cis/db-1');
  });

  it('shows the Graph view for ?view=graph, and says so when the browser has no canvas (ME7)', async () => {
    const user = userEvent.setup();
    mount('/?view=graph');
    const stage = await screen.findByRole('region', { name: 'Live topology' });
    expect(within(stage).getByRole('heading', { name: 'Dependency graph' })).toBeInTheDocument();
    // jsdom has no canvas: Cytoscape cannot start, the Stage points at the List instead of staying blank.
    expect(await within(stage).findByRole('status')).toHaveTextContent(/Use the List view/);
    expect(within(stage).getByRole('button', { name: 'Graph' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await user.click(within(stage).getByRole('button', { name: 'List' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('keeps the chosen view in the address and shows the CI table in List view (ME2, ME3, ME8)', async () => {
    const user = userEvent.setup();
    mount('/?view=list');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(5); // header + 4 CIs
    expect(within(table).getByText('payments-api')).toBeInTheDocument();
    // Provider, owner and health are not columns: they have no source yet.
    expect(
      within(table).queryByRole('columnheader', { name: /health|owner|provider/i })
    ).toBeNull();
    expect(
      screen.getByText(/Provider, owner and health are not available yet/)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Orbit' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/?view=orbit');
    expect(
      await screen.findByRole('group', { name: 'Orbit view of the estate' })
    ).toBeInTheDocument();
  });

  it('narrows the List to the chosen category (ME4)', async () => {
    const user = userEvent.setup();
    mount('/?view=list');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Data' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText('orders-db')).toBeInTheDocument();
  });

  it('dims the dots outside a category chosen on the Stage legend (ME4)', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: 'orders-db, database' });
    await user.click(screen.getByRole('button', { name: /^Data/ }));
    expect(screen.getByRole('button', { name: 'orders-db, database' })).toHaveAttribute(
      'opacity',
      '1'
    );
    expect(screen.getByRole('button', { name: 'host-1, server' })).toHaveAttribute(
      'opacity',
      '0.18'
    );
  });

  it('labels the sample honestly: the estate total, the relationship total and how many are drawn (ME5)', async () => {
    play({
      '/cis': ok({
        success: true,
        data: CIS,
        pagination: { total: 12840, page: 1, limit: 150, totalPages: 86 },
      }),
    });
    mount();
    await screen.findByRole('button', { name: 'orders-db, database' });
    const stage = screen.getByRole('region', { name: 'Live topology' });
    expect(within(stage).getByText('12,840 CIs · 1 relationship · 4 shown')).toBeInTheDocument();
    expect(within(stage).getByText(/Critical · not available yet/)).toBeInTheDocument();
  });

  it('still draws the CIs when relationships are refused, and says so on the Stage (side read)', async () => {
    play({ '/relationships': refused("Permission 'read' required") });
    mount();
    await screen.findByRole('button', { name: 'orders-db, database' });
    expect(
      screen.getByText(/Relationships not shown: Permission 'read' required/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Access denied/)).toBeNull();
  });
});

describe('estate hub: KPI stack (N2)', () => {
  it('shows the real CI count and a named "Not available yet" for health, drift and coverage; never a 0% health', async () => {
    mount();
    expect(await screen.findByText('CIs managed')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('4 active')).toBeInTheDocument());
    expect(within(screen.getByRole('group', { name: 'CIs managed' })).getByText('4')).toBeInTheDocument();
    for (const [label, missing] of [
      ['Health', 'BW1'],
      ['Config drift', 'BW5'],
      ['Coverage', 'BW6'],
    ]) {
      const card = screen.getByRole('group', { name: label });
      expect(within(card).getByText('Not available yet')).toBeInTheDocument();
      expect(within(card).getByText(new RegExp(missing))).toBeInTheDocument();
    }
    expect(screen.queryByText(/^0%$/)).toBeNull();
  });

  it('shows the counts as a refused read, with the server reason, when the dashboard counts are 403', async () => {
    play({ '/analytics/dashboard': refused("Permission 'read' required") });
    mount();
    expect(await screen.findByText('No access to the estate counts')).toBeInTheDocument();
    expect(screen.getAllByText("Permission 'read' required").length).toBeGreaterThan(0);
  });
});

describe('estate hub: incident ribbon (ME1)', () => {
  it('leads with the highest-priority open incident and counts the rest', async () => {
    // The route takes one status per request: each status answers its own rows and its own total, as the server does.
    const byStatus: Record<string, unknown[]> = {
      NEW: [
        incident({
          id: 'i2',
          incident_number: 'INC-30000',
          title: 'Minor slowdown',
          priority: 3,
        }),
        incident({}),
      ],
      ASSIGNED: [
        incident({ id: 'i3', incident_number: 'INC-40000', title: 'Disk filling', priority: 2 }),
      ],
      IN_PROGRESS: [],
    };
    play({
      '/itil/incidents': (params) => {
        const data = byStatus[String(params.status)] ?? [];
        return ok({ success: true, data, pagination: { total: data.length } });
      },
    });
    mount();
    expect(await screen.findByText('INC-20481')).toBeInTheDocument();
    expect(screen.getByText(/Orders database primary failing/)).toBeInTheDocument();
    expect(screen.getByText(/P1 · opened 14 min ago · 2 more open$/)).toBeInTheDocument();
    expect(screen.queryByText('INC-30000')).toBeNull();
    expect(screen.queryByText('INC-40000')).toBeNull();
    // One request per open status, the list route takes one at a time.
    expect(
      world.requests
        .filter((r) => r.startsWith('get /itil/incidents'))
        .map((r) => /status=(\w+)/.exec(r)?.[1])
        .sort()
    ).toEqual(['ASSIGNED', 'IN_PROGRESS', 'NEW']);
  });

  it('says nothing about others when the lead incident is the only open one', async () => {
    play({
      '/itil/incidents': (params) =>
        ok({
          success: true,
          data: params.status === 'NEW' ? [incident({})] : [],
          pagination: { total: params.status === 'NEW' ? 1 : 0 },
        }),
    });
    mount();
    expect(await screen.findByText('INC-20481')).toBeInTheDocument();
    expect(screen.queryByText(/more open/)).toBeNull();
  });

  it('omits users and revenue when they are the stored zeros, shows them when estimated', async () => {
    play({
      '/itil/incidents': ok({ success: true, data: [incident({})], pagination: { total: 1 } }),
    });
    mount();
    await screen.findByText('INC-20481');
    expect(screen.queryByText(/users affected/)).toBeNull();
    cleanup();
    play({
      '/itil/incidents': ok({
        success: true,
        data: [
          incident({
            business_impact: { estimated_user_impact: 18420, estimated_revenue_impact: 0 },
          }),
        ],
        pagination: { total: 1 },
      }),
    });
    mount();
    expect(await screen.findByText(/18,420 users affected/)).toBeInTheDocument();
  });

  it('opens the affected CI from the ribbon', async () => {
    play({
      '/itil/incidents': ok({ success: true, data: [incident({})], pagination: { total: 1 } }),
    });
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /Open affected CI/ }));
    expect(screen.getByTestId('where').textContent).toBe('/cis/db-1');
  });

  it('says so when nothing is open', async () => {
    mount();
    expect(await screen.findByText('No open incidents.')).toBeInTheDocument();
  });

  it('shows a refused incident feed on the ribbon only: the page-level banner stays down (sideRead)', async () => {
    play({ '/itil/incidents': refused('Incidents need the ITSM role') });
    mount();
    expect(
      await screen.findByText(/Incidents are not available to you: Incidents need the ITSM role/)
    ).toBeInTheDocument();
    expect(screen.queryByText('Access denied.')).toBeNull();
    expect(await screen.findByRole('button', { name: 'orders-db, database' })).toBeInTheDocument();
  });

  it('shows a failed incident feed with Try again', async () => {
    const user = userEvent.setup();
    play({ '/itil/incidents': { status: 500, body: { message: 'x' } } });
    mount();
    expect(await screen.findByText(/Could not load open incidents/)).toBeInTheDocument();
    play({ '/itil/incidents': ok({ success: true, data: [], pagination: { total: 0 } }) });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No open incidents.')).toBeInTheDocument();
  });
});

describe('estate hub: states of the topology surface', () => {
  it('shows loading while the CI list is pending', async () => {
    play({ '/cis': 'pending' });
    mount();
    expect(await screen.findByText('Loading configuration items…')).toBeInTheDocument();
  });

  it('shows a refused CI list with the server reason, and the shell banner (a primary read)', async () => {
    play({ '/cis': refused("Permission 'read' required") });
    mount();
    expect(await screen.findByText('No access to configuration items')).toBeInTheDocument();
    expect(await screen.findByText('Access denied.')).toBeInTheDocument();
  });

  it('shows a failed CI list with Try again that reloads it', async () => {
    const user = userEvent.setup();
    play({ '/cis': { status: 500, body: { message: 'neo4j down' } } });
    mount();
    expect(await screen.findByText('Could not load configuration items')).toBeInTheDocument();
    play();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'orders-db, database' })).toBeInTheDocument();
  });

  it('shows the empty estate with Run discovery for a role that can write', async () => {
    play({
      '/cis': ok({
        success: true,
        data: [],
        pagination: { total: 0, page: 1, limit: 150, totalPages: 0 },
      }),
    });
    mount();
    expect(await screen.findByText('No configuration items yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run discovery' })).toBeInTheDocument();
  });

  it('hides Run discovery from a viewer (RequirePermission write)', async () => {
    auth.role = 'viewer';
    play({
      '/cis': ok({
        success: true,
        data: [],
        pagination: { total: 0, page: 1, limit: 150, totalPages: 0 },
      }),
    });
    mount();
    expect(await screen.findByText('No configuration items yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run discovery' })).toBeNull();
  });
});

describe('estate hub: functions without a backend (BW9, BW10)', () => {
  it('names the missing capability for Live changes and Top services and shows no rows or numbers', async () => {
    mount();
    const changes = await screen.findByRole('region', { name: 'Live changes' });
    expect(within(changes).getByText('No tenant-wide change feed')).toBeInTheDocument();
    expect(within(changes).getByText(/BW9/)).toBeInTheDocument();
    const services = screen.getByRole('region', { name: 'Top services' });
    expect(within(services).getByText('No service availability')).toBeInTheDocument();
    expect(within(services).getByText(/BW10/)).toBeInTheDocument();
    expect(within(services).queryByRole('listitem')).toBeNull();
    expect(world.requests.some((r) => /change|availability/.test(r))).toBe(false);
  });
});
