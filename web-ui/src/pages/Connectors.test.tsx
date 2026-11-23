// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Final cycle-10 live-component retest. F-014: /connectors route (tab
// query-param persistence + help-dialog navigation to /discovery).

import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import { ToastProvider } from '@/contexts/ToastContext';

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../lib/api-client', () => ({ apiClient }));

import Connectors from './Connectors';
// These screens gate their write controls on the signed-in role (HAP-1252 S1); this test is about the writes, so the user may write.
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => true }));

function renderConnectors(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Routes>
            <Route path="/connectors" element={<Connectors />} />
            <Route path="/discovery" element={<div>Discovery Page</div>} />
          </Routes>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('Connectors page (F-014)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((url: string) => {
      if (url === '/connector-configs') return Promise.resolve({ success: true, data: [] });
      if (url === '/connectors/installed') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
  });

  it('defaults to the dashboard tab and switches to the URL-supplied ?tab= value', async () => {
    renderConnectors('/connectors?tab=jobs');

    await waitFor(() => {
      // The Jobs tab trigger should be the selected tab, driven by tabValue
      // synced from the ?tab= search param.
      const jobsTrigger = screen.getByRole('tab', { name: 'Jobs' });
      expect(jobsTrigger).toHaveAttribute('aria-selected', 'true');
    });

    const dashboardTrigger = screen.getByRole('tab', { name: 'Dashboard' });
    expect(dashboardTrigger).toHaveAttribute('aria-selected', 'false');
  });

  it('persists a tab click to the ?tab= URL query param via handleTabChange', async () => {
    const user = userEvent.setup();
    renderConnectors('/connectors');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('aria-selected', 'true');
    });

    await user.click(screen.getByRole('tab', { name: 'Definitions' }));

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Definitions' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('help dialog navigates to /discovery', async () => {
    const user = userEvent.setup();
    renderConnectors('/connectors');

    await user.click(screen.getByTitle('Help'));
    expect(await screen.findByText('Looking for Cloud Infrastructure Discovery?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Go to Discovery/i }));

    await waitFor(() => {
      expect(screen.getByText('Discovery Page')).toBeInTheDocument();
    });
  });
});

// HAP-1922 S8j: dialog behaviour and the page's read states on the DS shell.
describe('Connectors page states', () => {
  function renderWithShell(initialEntry: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <ForbiddenHost />
            <Routes>
              <Route path="/connectors" element={<Connectors />} />
              <Route path="/discovery" element={<div>Discovery Page</div>} />
            </Routes>
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  /** The real session client (its 403 interceptor reports to ForbiddenHost) answering every read with a refusal. */
  function refuseReads() {
    const client = axios.create({
      adapter: async (cfg: InternalAxiosRequestConfig) => {
        const response = {
          data: { _error: 'Forbidden', _message: "Permission 'read' required" },
          status: 403, statusText: '', headers: {}, config: cfg, request: {},
        };
        throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', cfg, {}, response);
      },
    });
    attachSession(client);
    apiClient.get.mockImplementation((url: string, cfg?: unknown) => client.get(url, cfg as never));
  }

  const CONFIG = {
    id: 'cfg-1', name: 'Deployed one', connector_type: 'servicenow', enabled: true,
    schedule_enabled: false, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T12:00:00Z',
  };
  const NO_RUNS = { success: true, data: [], pagination: { total: 0, count: 0, limit: 100, offset: 0 } };

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation(async (url: string) => {
      if (url === '/connector-configs') return { success: true, data: [CONFIG] };
      return NO_RUNS;
    });
  });

  it('closes the help dialog on Escape and returns focus to the Help control', async () => {
    const user = userEvent.setup();
    renderWithShell('/connectors');

    await user.click(screen.getByTitle('Help'));
    expect(await screen.findByRole('dialog', { name: 'Looking for Cloud Infrastructure Discovery?' })).toBeVisible();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTitle('Help')).toHaveFocus();
  });

  it('mounts only the selected tab panel, under the page heading', async () => {
    renderWithShell('/connectors');

    expect(await screen.findByText('Deployed one')).toBeVisible();
    expect(screen.getByRole('tabpanel')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Integration Connectors' })).toBeVisible();
    expect(screen.queryByText('Connector runs')).not.toBeInTheDocument();
  });

  it('shows a visible, retryable error when the dashboard cannot load its connectors', async () => {
    const user = userEvent.setup();
    apiClient.get.mockImplementation(async (url: string) => {
      if (url === '/connector-configs') throw new Error('upstream exploded');
      return NO_RUNS;
    });
    renderWithShell('/connectors');

    expect(await screen.findByText('Could not load connectors')).toBeVisible();

    apiClient.get.mockImplementation(async (url: string) => {
      if (url === '/connector-configs') return { success: true, data: [CONFIG] };
      return NO_RUNS;
    });
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Deployed one')).toBeVisible();
    expect(screen.queryByText('Could not load connectors')).not.toBeInTheDocument();
  });

  it('shows the page its own not-permitted state on a 403 while the shell banner shows the server reason', async () => {
    refuseReads();
    renderWithShell('/connectors?tab=jobs');

    expect(await screen.findByText('No access to connector runs')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
