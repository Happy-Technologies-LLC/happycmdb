// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, apiClient } from '@/services/api';
import { ITSMDashboard } from '@/pages/dashboards/ITSMDashboard';
import type { ITSMDashboardData } from '@/services/dashboard.service';
import type { User } from '@/types';
import { AuthProvider, useAuth } from './AuthContext';
import { OrganizationContext } from './OrganizationContext';

vi.mock('@/services/api', () => ({
  apiClient: { get: vi.fn() },
  api: { login: vi.fn(), logout: vi.fn(), refresh: vi.fn(), getCurrentUser: vi.fn() },
}));

const userOf = (organization_id: string | null) => ({ id: `u-${organization_id}`, role: 'admin', organization_id }) as unknown as User;

// Each organization's KPI response; a test holds one back with `hold` to look at the screen while it is in flight.
const OPEN_INCIDENTS: Record<string, number> = { 'org-a': 7, 'org-b': 9, 'org-c': 11 };
let servingOrg = 'org-a';
let hold: Promise<void> | null = null;

const kpis = (org: string) => ({
  openIncidents: [], openIncidentCount: OPEN_INCIDENTS[org], changesInProgress: [], changesInProgressCount: 0,
  ciStatus: [{ status: 'active', count: 1 }], topFailingCIs: [], slaCompliance: [], baselineCompliance: [], unavailable: [],
}) as ITSMDashboardData;

beforeEach(() => {
  vi.clearAllMocks();
  servingOrg = 'org-a';
  hold = null;
  vi.mocked(api.refresh).mockResolvedValue(undefined as never);
  vi.mocked(api.logout).mockResolvedValue(undefined);
  vi.mocked(apiClient.get).mockImplementation(async (path) => {
    // The org is fixed when the request goes out: the server answers for the caller who sent it.
    const org = servingOrg;
    if (path === '/dashboards/itsm') {
      await hold;
      return { data: { success: true, data: kpis(org) } } as unknown as AxiosResponse;
    }
    return { data: { success: true, pagination: { total: 1 } } } as unknown as AxiosResponse;
  });
});

const kpiRequests = () => vi.mocked(apiClient.get).mock.calls.filter(([path]) => path === '/dashboards/itsm').length;
const openIncidents = () => screen.queryByTestId('kpi-open-incidents')?.textContent ?? null;

const Session: React.FC = () => {
  const { user, isAuthenticated, isLoading, login, logout, refreshUser } = useAuth();
  if (isLoading) return <p>loading</p>;
  return (
    <>
      <button onClick={() => void logout()}>logout</button>
      <button onClick={() => void login({ email: 'b@example.test', password: 'x' })}>login</button>
      <button onClick={() => void refreshUser()}>refresh</button>
      {isAuthenticated && user ? <ITSMDashboard /> : <p>signed out</p>}
    </>
  );
};

const mount = async (client: QueryClient) => {
  vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-a'));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><AuthProvider><Session /></AuthProvider></MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(openIncidents()).toBe('7'));
};

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('dashboard data never crosses organizations', () => {
  it('logging out and in as another organization never renders the previous organization\'s data', async () => {
    const client = newClient();
    await mount(client);

    await act(async () => screen.getByText('logout').click());
    await screen.findByText('signed out');
    expect(client.getQueryCache().getAll()).toEqual([]);

    servingOrg = 'org-b';
    const gate = Promise.withResolvers<void>();
    hold = gate.promise;
    vi.mocked(api.login).mockResolvedValue({ access_token: 'x' } as never);
    vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-b'));
    await act(async () => screen.getByText('login').click());

    // The new organization's KPIs are still in flight: nothing of org-a may stand in for them.
    await waitFor(() => expect(kpiRequests()).toBe(2));
    expect(openIncidents()).toBeNull();
    await act(async () => gate.resolve());
    await waitFor(() => expect(openIncidents()).toBe('9'));
  });

  it('an organization change on a live session drops the cache, but a refresh within the same organization keeps it', async () => {
    const client = newClient();
    await mount(client);
    const cached = () => client.getQueryCache().getAll().length;
    const before = cached();
    expect(before).toBeGreaterThan(0);

    await act(async () => screen.getByText('refresh').click());
    expect(cached()).toBe(before);

    servingOrg = 'org-b';
    const gate = Promise.withResolvers<void>();
    hold = gate.promise;
    vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-b'));
    await act(async () => screen.getByText('refresh').click());

    await waitFor(() => expect(openIncidents()).toBeNull());
    await act(async () => gate.resolve());
    await waitFor(() => expect(openIncidents()).toBe('9'));
  });

  it('the same cache serves each organization its own entry: org-b never reads org-a\'s', async () => {
    const client = newClient();
    const view = (org: string) => (
      <QueryClientProvider client={client}>
        <OrganizationContext.Provider value={org}><ITSMDashboard /></OrganizationContext.Provider>
      </QueryClientProvider>
    );
    const { rerender } = render(view('org-a'));
    await waitFor(() => expect(openIncidents()).toBe('7'));

    servingOrg = 'org-b';
    const gate = Promise.withResolvers<void>();
    hold = gate.promise;
    rerender(view('org-b'));
    await waitFor(() => expect(openIncidents()).toBeNull());
    await act(async () => gate.resolve());
    await waitFor(() => expect(openIncidents()).toBe('9'));

    // Back to org-a: its own entry is still there, shown at once while it revalidates.
    hold = new Promise(() => undefined);
    servingOrg = 'org-a';
    rerender(view('org-a'));
    expect(openIncidents()).toBe('7');
  });
});

describe('an organization change renews the session before anything is cleared or refetched', () => {
  const cachedData = (client: QueryClient) => client.getQueryCache().getAll().map((query) => query.state.data);

  const mountHeld = async (client: QueryClient) => {
    // The first org-a KPI request is sent and held; later requests are not.
    const gate = Promise.withResolvers<void>();
    hold = gate.promise;
    vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-a'));
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><AuthProvider><Session /></AuthProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(kpiRequests()).toBe(1));
    hold = null;
    return gate;
  };

  it('an org-a request still open across logout never renders or caches when it answers', async () => {
    const client = newClient();
    const gate = await mountHeld(client);

    await act(async () => screen.getByText('logout').click());
    await screen.findByText('signed out');

    await act(async () => gate.resolve());
    await act(async () => undefined);
    expect(openIncidents()).toBeNull();
    expect(cachedData(client)).toEqual([]);

    // Signing in as org-b afterwards shows org-b only.
    servingOrg = 'org-b';
    vi.mocked(api.login).mockResolvedValue({ access_token: 'x' } as never);
    vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-b'));
    await act(async () => screen.getByText('login').click());
    await waitFor(() => expect(openIncidents()).toBe('9'));
    expect(JSON.stringify(cachedData(client))).not.toContain('"openIncidentCount":7');
  });

  it('an org-a request still open across an organization change never renders or caches when it answers', async () => {
    const client = newClient();
    const gate = await mountHeld(client);

    servingOrg = 'org-b';
    vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-b'));
    await act(async () => screen.getByText('refresh').click());
    await waitFor(() => expect(openIncidents()).toBe('9'));

    await act(async () => gate.resolve());
    await act(async () => undefined);
    expect(openIncidents()).toBe('9');
    expect(JSON.stringify(cachedData(client))).not.toContain('"openIncidentCount":7');
  });

  it('renews first: the old organization stays cached and no new-organization request goes out until the renewal answers', async () => {
    const client = newClient();
    await mount(client);
    const events: string[] = [];
    const renewal = Promise.withResolvers<void>();
    vi.mocked(api.refresh).mockImplementation(async () => { events.push('renew'); await renewal.promise; });
    vi.mocked(api.getCurrentUser).mockImplementation(async () => { events.push('me'); return userOf('org-b'); });
    const before = kpiRequests();
    const cachedBefore = client.getQueryCache().getAll().length;
    servingOrg = 'org-b';
    vi.mocked(apiClient.get).mockImplementation(async (path) => {
      events.push(`get:${servingOrg}:${path}`);
      return { data: { success: true, data: kpis(servingOrg), pagination: { total: 1 } } } as unknown as AxiosResponse;
    });

    await act(async () => screen.getByText('refresh').click());
    // Org change seen, renewal pending: the cache is intact and shows org-a, nothing was fetched for org-b.
    expect(events).toEqual(['me', 'renew']);
    expect(client.getQueryCache().getAll()).toHaveLength(cachedBefore);
    expect(openIncidents()).toBe('7');
    expect(kpiRequests()).toBe(before);

    await act(async () => renewal.resolve());
    await waitFor(() => expect(openIncidents()).toBe('9'));
    expect(events.slice(0, 3)).toEqual(['me', 'renew', 'me']);
    expect(events.indexOf('get:org-b:/dashboards/itsm')).toBeGreaterThan(events.lastIndexOf('renew'));
  });

  it('a failed renewal signs out and clears the cache instead of adopting the new organization', async () => {
    const client = newClient();
    await mount(client);
    vi.mocked(api.refresh).mockRejectedValue(new Error('refused'));
    vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-b'));
    servingOrg = 'org-b';
    const before = kpiRequests();

    await act(async () => screen.getByText('refresh').click());
    await screen.findByText('signed out');
    expect(client.getQueryCache().getAll()).toEqual([]);
    expect(kpiRequests()).toBe(before);
  });

  it('adopts the identity /auth/me reports after the renewal when it differs from the one that triggered it', async () => {
    const client = newClient();
    await mount(client);
    vi.mocked(api.getCurrentUser).mockResolvedValueOnce(userOf('org-b')).mockResolvedValueOnce(userOf('org-c'));
    servingOrg = 'org-c';
    const before = kpiRequests();

    await act(async () => screen.getByText('refresh').click());
    await waitFor(() => expect(openIncidents()).toBe('11'));
    expect(kpiRequests()).toBe(before + 1);
    expect(JSON.stringify(cachedData(client))).not.toContain('"openIncidentCount":7');
    // Everything cached is keyed to the identity the renewed token speaks for, never to the one read before it.
    const keys = JSON.stringify(client.getQueryCache().getAll().map((query) => query.queryKey));
    expect(keys).toContain('org-c');
    expect(keys).not.toContain('org-b');
  });

  it('a failed identity check after the renewal signs out', async () => {
    const client = newClient();
    await mount(client);
    vi.mocked(api.getCurrentUser).mockResolvedValueOnce(userOf('org-b')).mockRejectedValueOnce(new Error('down'));

    await act(async () => screen.getByText('refresh').click());
    await screen.findByText('signed out');
    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it('a logout during the renewal wins: the renewed organization is never published', async () => {
    const client = newClient();
    await mount(client);
    const renewal = Promise.withResolvers<void>();
    vi.mocked(api.refresh).mockImplementation(() => renewal.promise as Promise<never>);
    vi.mocked(api.getCurrentUser).mockResolvedValue(userOf('org-b'));

    await act(async () => screen.getByText('refresh').click());
    await act(async () => screen.getByText('logout').click());
    await screen.findByText('signed out');
    const requests = kpiRequests();
    await act(async () => renewal.resolve());
    await act(async () => undefined);
    expect(screen.getByText('signed out')).toBeTruthy();
    expect(kpiRequests()).toBe(requests);
  });
});
