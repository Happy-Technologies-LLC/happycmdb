// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { request, apiClient } = vi.hoisted(() => {
  const request = { get: vi.fn() };
  const apiClient = { ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } };
  return { request, apiClient };
});

vi.mock('axios', () => ({ default: { create: vi.fn(() => apiClient) } }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mockNavigate,
}));

import CIList from './CIList';

const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  type: 'server',
  status: 'active',
  environment: 'production',
  confidence_score: 0.85,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...over,
});

const page = (rows: unknown[]) => ({
  data: {
    success: true,
    data: rows,
    pagination: { total: rows.length, page: 1, limit: 10, totalPages: 1 },
  },
});

const forbidden = () =>
  Object.assign(new Error('Request failed with status code 403'), {
    response: { status: 403, data: { _error: 'Forbidden', _message: "Permission 'read' required" } },
  });

function serve(list: () => Promise<unknown>) {
  request.get.mockImplementation((url: string) => {
    if (url === '/cis') return list();
    if (url === '/cis/ci-1') return Promise.resolve({ data: { success: true, data: row('ci-1', 'web-server-01', { health: 'healthy' }) } });
    if (url === '/cis/ci-1/audit' || url === '/cis/ci-1/relationships')
      return Promise.resolve({ data: { success: true, data: [] } });
    if (url === '/cis/ci-1/impact')
      return Promise.resolve({ data: { success: true, data: { upstream: [], downstream: [] } } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

const renderList = (props: React.ComponentProps<typeof CIList> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter>
        <CIList {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );

const twoRows = () => Promise.resolve(page([row('ci-1', 'web-server-01'), row('ci-2', 'db-server-01')]));

describe('CIList quick view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve(twoRows);
  });

  it('has a quick-view control on every row, named after its CI, even when row actions are off', async () => {
    renderList({ showActions: false });
    expect(await screen.findByRole('button', { name: 'Quick view web-server-01' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick view db-server-01' })).toBeInTheDocument();
  });

  it('opens the drawer for that row only, without navigating, and requests nothing before the click', async () => {
    renderList();
    await screen.findByText('web-server-01');
    expect(request.get.mock.calls.map(([url]) => url)).toEqual(['/cis']);

    await userEvent.click(screen.getByRole('button', { name: 'Quick view web-server-01' }));
    const drawer = within(await screen.findByRole('dialog'));
    expect(await drawer.findByText('Healthy')).toBeInTheDocument();
    expect(request.get).toHaveBeenCalledWith('/cis/ci-1');
    expect(request.get).not.toHaveBeenCalledWith('/cis/ci-2');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a row click still opens the full record', async () => {
    renderList();
    await userEvent.click(await screen.findByText('db-server-01'));
    expect(mockNavigate).toHaveBeenCalledWith('/cis/ci-2');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape closes the drawer and focus goes back to the row control', async () => {
    renderList();
    const trigger = await screen.findByRole('button', { name: 'Quick view web-server-01' });
    await userEvent.click(trigger);
    await screen.findByRole('dialog');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('Open full record leaves through onView when the page supplies one', async () => {
    const onView = vi.fn();
    renderList({ onView });
    await userEvent.click(await screen.findByRole('button', { name: 'Quick view web-server-01' }));
    await userEvent.click(await screen.findByRole('button', { name: /open full record/i }));

    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ id: 'ci-1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('CIList states', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a failed list read keeps the filters, shows the error and retries on request', async () => {
    let attempts = 0;
    serve(() => (++attempts === 1 ? Promise.reject(new Error('list exploded')) : twoRows()));
    renderList();

    expect(await screen.findByText('Error loading CIs')).toBeInTheDocument();
    expect(screen.getByText('list exploded')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search items\u2026')).toBeInTheDocument();
    expect(screen.queryByText('No configuration items match this filter.')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('web-server-01')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('a refused list read says "No access" with the server reason and no spinner', async () => {
    serve(() => Promise.reject(forbidden()));
    renderList();

    expect(await screen.findByText('No access to configuration items')).toBeInTheDocument();
    expect(screen.getByText("Permission 'read' required")).toBeInTheDocument();
    expect(screen.queryByText('Error loading CIs')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('shows the empty state for a read that answered with no rows', async () => {
    serve(() => Promise.resolve(page([])));
    renderList();
    expect(await screen.findByText('No configuration items match this filter.')).toBeInTheDocument();
  });

  it('is busy while the read is in flight', async () => {
    serve(() => new Promise(() => undefined));
    renderList();
    const table = await screen.findByRole('table');
    expect(table.closest('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('a CI with no confidence score shows a dash, not 0%', async () => {
    serve(() =>
      Promise.resolve(page([row('ci-1', 'web-server-01', { confidence_score: null }), row('ci-2', 'db-server-01')]))
    );
    renderList();
    const unscored = (await screen.findByText('web-server-01')).closest('tr')!;
    expect(within(unscored).queryByText(/%/)).toBeNull();
    expect(within(unscored).getByText('-')).toBeInTheDocument();
    expect(within(screen.getByText('db-server-01').closest('tr')!).getByText('85%')).toBeInTheDocument();
  });
});
