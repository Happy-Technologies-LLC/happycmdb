// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { request, apiClient } = vi.hoisted(() => {
  const request = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  const apiClient = { ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } };
  return { request, apiClient };
});

vi.mock('axios', () => ({ default: { create: vi.fn(() => apiClient) } }));

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => toast }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mockNavigate,
}));

import { Inventory } from './Inventory';

const ci = {
  id: 'ci-1',
  name: 'web-server-01',
  type: 'server',
  status: 'active',
  environment: 'production',
  tags: [],
  confidence_score: 0.9,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const list = (rows: unknown[]) =>
  Promise.resolve({ data: { success: true, data: rows, pagination: { total: rows.length, page: 1, limit: 100, totalPages: 1 } } });

const forbidden = () =>
  Object.assign(new Error('Request failed with status code 403'), {
    response: { status: 403, data: { _error: 'Forbidden', _message: "Permission 'read' required" } },
  });

const renderInventory = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter>
        <Inventory />
      </MemoryRouter>
    </QueryClientProvider>
  );

const controls = async () => {
  await screen.findByText('web-server-01');
  return {
    create: screen.queryByRole('button', { name: /add ci/i }),
    edit: screen.queryByTitle('Edit'),
    del: screen.queryByTitle('Delete'),
    view: screen.queryByTitle('View Details'),
    peek: screen.queryByTitle('Quick view'),
  };
};

describe('Inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.role = 'viewer';
    request.get.mockImplementation((url: string) => {
      if (url === '/cis') return list([ci]);
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  // POST, PUT and DELETE /api/v1/cis need 'write' on the server (ci.routes.ts); read-only roles only look.
  it('a viewer can open and peek at a CI but sees no create, edit or delete, in the list or the grid', async () => {
    renderInventory();
    const c = await controls();
    expect(c.view).toBeInTheDocument();
    expect(c.peek).toBeInTheDocument();
    expect([c.create, c.edit, c.del]).toEqual([null, null, null]);

    await userEvent.click(screen.getByRole('tab', { name: /grid/i }));
    await screen.findByRole('heading', { name: 'web-server-01' });
    expect(screen.getByTitle('View Details')).toBeInTheDocument();
    expect(screen.queryByTitle('Edit')).toBeNull();
    expect(screen.queryByTitle('Delete')).toBeNull();
    expect(screen.queryByRole('button', { name: /add ci/i })).toBeNull();
  });

  it.each(['operator', 'admin'])('an %s sees create, edit and delete', async (role) => {
    auth.role = role;
    renderInventory();
    const c = await controls();
    expect(c.create).toBeInTheDocument();
    expect(c.edit).toBeInTheDocument();
    expect(c.del).toBeInTheDocument();
  });

  it('create: the dialog submits the form payload to POST /cis, closes, and confirms', async () => {
    auth.role = 'operator';
    request.post.mockResolvedValue({ data: { success: true, data: { ...ci, id: 'ci-2', name: 'new-box' } } });
    renderInventory();
    await screen.findByText('web-server-01');

    await userEvent.click(screen.getByRole('button', { name: /add ci/i }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Create Configuration Item' }));
    await userEvent.type(dialog.getByLabelText(/^name/i), 'new-box');
    await userEvent.click(dialog.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(request.post).toHaveBeenCalledWith('/cis', {
        name: 'new-box',
        type: 'server',
        status: 'active',
        environment: 'development',
        description: '',
        tags: [],
        attributes: {},
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.showToast).toHaveBeenCalledWith('Configuration item created successfully', 'success');
  });

  it('edit: opens the form on that CI and PUTs the change to its id', async () => {
    auth.role = 'operator';
    request.put.mockResolvedValue({ data: { success: true, data: ci } });
    renderInventory();
    await screen.findByText('web-server-01');

    await userEvent.click(screen.getByTitle('Edit'));
    const dialog = within(await screen.findByRole('dialog', { name: 'Edit Configuration Item' }));
    expect(dialog.getByLabelText(/^name/i)).toHaveValue('web-server-01');
    await userEvent.type(dialog.getByLabelText(/^name/i), '-b');
    await userEvent.click(dialog.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(request.put).toHaveBeenCalledTimes(1));
    expect(request.put.mock.calls[0][0]).toBe('/cis/ci-1');
    expect(request.put.mock.calls[0][1]).toMatchObject({ name: 'web-server-01-b' });
  });

  it('delete: asks first, Cancel deletes nothing, Delete sends DELETE once for that CI', async () => {
    auth.role = 'operator';
    request.delete.mockResolvedValue({ data: {} });
    renderInventory();
    await screen.findByText('web-server-01');

    await userEvent.click(screen.getByTitle('Delete'));
    let dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('web-server-01')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(request.delete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTitle('Delete'));
    dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(request.delete).toHaveBeenCalledTimes(1));
    expect(request.delete).toHaveBeenCalledWith('/cis/ci-1');
    expect(toast.showToast).toHaveBeenCalledWith('Configuration item deleted successfully', 'success');
  });

  it('a failed create keeps the dialog open and says why', async () => {
    auth.role = 'operator';
    request.post.mockRejectedValue(new Error('name already exists'));
    renderInventory();
    await screen.findByText('web-server-01');

    await userEvent.click(screen.getByRole('button', { name: /add ci/i }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/^name/i), 'web-server-01');
    await userEvent.click(dialog.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Failed to create CI: name already exists', 'error')
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  describe('grid view', () => {
    const grid = async () => {
      renderInventory();
      await userEvent.click(await screen.findByRole('tab', { name: /grid/i }));
    };

    it('an unreadable inventory says "No access" with the server reason, not a blank grid or a spinner', async () => {
      request.get.mockImplementation(() => Promise.reject(forbidden()));
      await grid();
      expect((await screen.findAllByText('No access to configuration items')).length).toBeGreaterThan(0);
      expect(screen.getAllByText("Permission 'read' required").length).toBeGreaterThan(0);
      expect(screen.queryByText(/loading configuration items/i)).toBeNull();
    });

    it('a failed read shows the error with a retry, not an empty grid', async () => {
      let attempts = 0;
      request.get.mockImplementation(() => (++attempts <= 2 ? Promise.reject(new Error('boom')) : list([ci])));
      await grid();
      expect((await screen.findAllByText('Could not load configuration items')).length).toBeGreaterThan(0);
      expect(screen.queryByText('No configuration items found')).toBeNull();
    });

    it('says so when there are no CIs', async () => {
      request.get.mockImplementation(() => list([]));
      await grid();
      expect(await screen.findByText('No configuration items found')).toBeInTheDocument();
    });

    it('a card peek opens the drawer for that CI', async () => {
      request.get.mockImplementation((url: string) => {
        if (url === '/cis') return list([ci]);
        if (url === '/cis/ci-1') return Promise.resolve({ data: { success: true, data: { ...ci, health: 'critical' } } });
        if (url.endsWith('/impact')) return Promise.resolve({ data: { success: true, data: { upstream: [], downstream: [] } } });
        return Promise.resolve({ data: { success: true, data: [] } });
      });
      await grid();
      await userEvent.click(await screen.findByRole('button', { name: 'Quick view web-server-01' }));
      const drawer = within(await screen.findByRole('dialog'));
      expect(await drawer.findByText('Critical')).toBeInTheDocument();
    });
  });
});
