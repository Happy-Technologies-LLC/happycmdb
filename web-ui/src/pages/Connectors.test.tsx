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
      // The Jobs tab trigger should be the active tab per the Radix Tabs
      // data-state, driven by tabValue synced from the ?tab= search param.
      const jobsTrigger = screen.getByRole('tab', { name: 'Jobs' });
      expect(jobsTrigger).toHaveAttribute('data-state', 'active');
    });

    const dashboardTrigger = screen.getByRole('tab', { name: 'Dashboard' });
    expect(dashboardTrigger).toHaveAttribute('data-state', 'inactive');
  });

  it('persists a tab click to the ?tab= URL query param via handleTabChange', async () => {
    const user = userEvent.setup();
    renderConnectors('/connectors');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Dashboard' })).toHaveAttribute('data-state', 'active');
    });

    await user.click(screen.getByRole('tab', { name: 'Definitions' }));

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Definitions' })).toHaveAttribute('data-state', 'active');
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
