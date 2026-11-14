// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1951: the Dashboard page header offers "Run discovery" only to a role that can write (POST /discovery/*
// needs 'write'). The real page, services and RequirePermission run against a played server; only the signed-in
// role is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import { AxiosError } from 'axios';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'admin' as string }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const { default: axios } = await import('axios');
const ok = (body: unknown) => ({ status: 200, body });
const world: Record<string, { status: number; body: unknown }> = {};
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = String(config.url);
  const key = Object.keys(world).find((k) => url === k || url.startsWith(`${k}?`));
  const reply = key ? world[key] : { status: 404, body: { message: `unplayed ${url}` } };
  const response = { data: reply.body, status: reply.status, statusText: '', headers: {}, config, request: {} };
  if (reply.status < 400) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', config, {}, response);
};
const { Dashboard } = await import('./Dashboard');

function play() {
  // A non-empty estate: the hub's own empty-state "Run discovery" (its own gate, tested with the hub) is not drawn,
  // so the only such button on the page is the page header's.
  const cis = [
    {
      id: 'db-1',
      name: 'orders-db',
      type: 'database',
      status: 'active',
      environment: 'production',
      attributes: {},
      tags: [],
      created_at: '2026-11-01T10:00:00Z',
      updated_at: '2026-11-01T10:00:00Z',
    },
  ];
  Object.assign(world, {
    '/analytics/dashboard': ok({
      total_cis: 1,
      by_type: { database: 1 },
      by_status: { active: 1 },
      by_environment: { production: 1 },
      recent_discoveries: [],
      health_score: null,
      critical_relationships: 0,
    }),
    '/cis': ok({ success: true, data: cis, pagination: { total: 1, page: 1, limit: 150, totalPages: 1 } }),
    '/relationships': ok({ success: true, data: [], pagination: { total: 0, count: 0, offset: 0, limit: 400 } }),
    '/itil/incidents': ok({ success: true, data: [], pagination: { total: 0 } }),
  });
}

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>
  );

beforeEach(play);
afterEach(cleanup);

describe('Dashboard page header: Run discovery', () => {
  it.each(['admin', 'operator'])('is offered to %s, and opens Discovery', async (role) => {
    auth.role = role;
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: 'orders-db, database' });
    await user.click(screen.getByRole('button', { name: 'Run discovery' }));
    expect(screen.getByTestId('where').textContent).toBe('/discovery');
  });

  it('is not offered to a viewer, who still gets Inventory', async () => {
    auth.role = 'viewer';
    mount();
    await screen.findByRole('button', { name: 'orders-db, database' });
    expect(screen.getByRole('button', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run discovery' })).toBeNull();
  });
});
